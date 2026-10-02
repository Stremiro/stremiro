use crate::providers::lock_or_recover;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{command, AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::UpdaterExt;

/// In-flight update download shared by the check/install commands; owned
/// here rather than in `commands.rs` since nothing else touches it.
#[derive(Default)]
pub(crate) struct PendingAppUpdate {
    state: Mutex<PendingUpdateState>,
    /// Serializes `check()` calls so racing invokes cannot interleave a
    /// remote fetch with a pending-handle swap.
    check_lock: tokio::sync::Mutex<()>,
}

#[derive(Default)]
struct PendingUpdateState {
    update: Option<tauri_plugin_updater::Update>,
    last_error: Option<String>,
    /// Held for the whole download+install span: a second invoke (e.g. after
    /// a webview reload) fails fast instead of running a parallel install.
    install_in_progress: bool,
}

impl PendingAppUpdate {
    fn lock(&self) -> std::sync::MutexGuard<'_, PendingUpdateState> {
        lock_or_recover(&self.state)
    }
}

/// A stalled connection otherwise wedges `check()` (and the check lock every
/// later check queues behind) for the rest of the session.
const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// reqwest's per-request timeout is total-duration, so it cannot bound a
/// legitimately long download — instead a watchdog aborts when no chunk has
/// arrived for this long.
const UPDATE_DOWNLOAD_STALL_LIMIT_MS: u64 = 120_000;
const UPDATE_DOWNLOAD_WATCHDOG_TICK: Duration = Duration::from_secs(15);

pub(crate) const APP_UPDATE_PROGRESS_EVENT: &str = "app-update-progress";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateMetadata {
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
}

/// Typed install progress for the frontend state machine; user-facing
/// labels and byte formatting stay in TypeScript.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
enum AppUpdateProgress {
    #[serde(rename_all = "camelCase")]
    Downloading {
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
    },
    Installing,
}

fn emit_progress(app: &AppHandle, progress: AppUpdateProgress) {
    let _ = app.emit(APP_UPDATE_PROGRESS_EVENT, progress);
}

#[command]
pub fn get_current_app_version(app: AppHandle) -> Result<String, String> {
    Ok(app.package_info().version.to_string())
}

#[command]
pub async fn check_for_app_update(
    app: AppHandle,
    pending_update: State<'_, PendingAppUpdate>,
) -> Result<Option<AppUpdateMetadata>, String> {
    let _check_guard = pending_update.check_lock.lock().await;

    // Replacing the pending handle mid-install would race the take.
    if pending_update.lock().install_in_progress {
        return Err("An update install is already in progress.".to_string());
    }

    let update = tokio::time::timeout(
        UPDATE_CHECK_TIMEOUT,
        app.updater().map_err(|error| error.to_string())?.check(),
    )
    .await
    .map_err(|_| "Update check timed out.".to_string())?
    .map_err(|error| error.to_string())?;

    let metadata = update.as_ref().map(|update| AppUpdateMetadata {
        version: update.version.clone(),
        body: update.body.clone(),
        // ISO date only ("2026-09-15"): parseable by `new Date()` in the UI.
        date: update.date.map(|date| date.date().to_string()),
    });

    // A fresh check replaces the pending handle and clears the last install
    // failure: retry always requires this fresh handle, never a stale one.
    let mut state = pending_update.lock();
    state.update = update;
    state.last_error = None;

    Ok(metadata)
}

fn no_pending_update_message(last_error: Option<String>) -> String {
    match last_error {
        Some(previous) => format!(
            "No pending update is available to install (last install failed: {}). Run another update check before retrying installation.",
            previous
        ),
        None => "No pending update is available to install. Run another update check before retrying installation.".to_string(),
    }
}

#[command]
pub async fn install_app_update(
    app: AppHandle,
    pending_update: State<'_, PendingAppUpdate>,
    version: String,
) -> Result<(), String> {
    // Take the handle under check_lock so a remote check can't swap it.
    let update = {
        let _check_guard = pending_update.check_lock.lock().await;
        let mut state = pending_update.lock();
        if state.install_in_progress {
            return Err("An update install is already in progress.".to_string());
        }
        match state.update.as_ref() {
            // The install must land on the version the UI presented, not a
            // different handle a racing check swapped in.
            Some(pending) if pending.version == version.trim() => {
                state.install_in_progress = true;
                state.update.take().expect("update checked above")
            }
            Some(_) => {
                return Err(
                    "The pending update changed. Run another update check before installing."
                        .to_string(),
                );
            }
            None => return Err(no_pending_update_message(state.last_error.clone())),
        }
    };

    let progress_app = app.clone();
    let finish_app = app.clone();
    let mut downloaded_bytes = 0_u64;
    let mut last_reported_percent = None::<u64>;
    let last_chunk_at = Arc::new(AtomicU64::new(crate::commands::now_unix_millis()));
    let watchdog_last_chunk_at = last_chunk_at.clone();
    let install_phase_clock = last_chunk_at.clone();

    let download = update.download_and_install(
        move |chunk_length, content_length| {
            last_chunk_at.store(crate::commands::now_unix_millis(), Ordering::Relaxed);
            downloaded_bytes =
                downloaded_bytes.saturating_add(u64::try_from(chunk_length).unwrap_or(u64::MAX));

            let total_bytes = content_length.filter(|length| *length > 0);
            let clamped_downloaded = match total_bytes {
                Some(total) => downloaded_bytes.min(total),
                None => downloaded_bytes,
            };

            // One event per whole percent keeps the progress bar smooth
            // without per-chunk IPC bursts.
            let percent = total_bytes
                .map(|total| clamped_downloaded.saturating_mul(100) / total)
                .unwrap_or(0);

            if last_reported_percent != Some(percent) {
                last_reported_percent = Some(percent);
                emit_progress(
                    &progress_app,
                    AppUpdateProgress::Downloading {
                        downloaded_bytes: clamped_downloaded,
                        total_bytes,
                    },
                );
            }
        },
        move || {
            // Download is done: reset the stall clock so the watchdog below
            // measures install-time silence from here, not from the last
            // downloaded byte.
            install_phase_clock.store(crate::commands::now_unix_millis(), Ordering::Relaxed);
            // On Windows the process exits inside `download_and_install`, so
            // RunEvent::Exit may never run — retry any failed durable-store
            // saves here while the app is still alive.
            if let Some(registry) = finish_app.try_state::<crate::commands::DurableStoreRegistry>()
            {
                if let Err(error) = registry.flush_dirty() {
                    crate::operational_log::log_warn(
                        "update",
                        "durable-store-flush",
                        "failed",
                        &[crate::operational_log::field("error", error)],
                    );
                }
            }
            emit_progress(&finish_app, AppUpdateProgress::Installing);
        },
    );
    tokio::pin!(download);

    let install_result = loop {
        tokio::select! {
            outcome = &mut download => break outcome.map_err(|error| error.to_string()),
            _ = tokio::time::sleep(UPDATE_DOWNLOAD_WATCHDOG_TICK) => {
                let idle_ms = crate::commands::now_unix_millis()
                    .saturating_sub(watchdog_last_chunk_at.load(Ordering::Relaxed));
                if idle_ms >= UPDATE_DOWNLOAD_STALL_LIMIT_MS {
                    break Err(format!(
                        "Update download stalled — no data received for {}s.",
                        UPDATE_DOWNLOAD_STALL_LIMIT_MS / 1000
                    ));
                }
            }
        }
    };

    install_result.map_err(|message| {
        // The consumed handle is gone: record the failure so a stale frontend
        // handle cannot be re-installed without a fresh check.
        let mut state = pending_update.lock();
        state.install_in_progress = false;
        state.last_error = Some(message.clone());
        format!(
            "{} Run another update check before retrying installation.",
            message
        )
    })?;

    // On Windows `download_and_install` never returns on success: the plugin
    // spawns the NSIS installer and exits the process (the installer's
    // restart-after-install flag owns relaunch).
    Ok(())
}
