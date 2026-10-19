use crate::providers::ttl_cache::InFlight;
use crate::providers::{build_provider_http_client, lock_or_recover, read_bounded_body};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
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
    downloaded_bytes: Option<Vec<u8>>,
    download_operation_id: Option<String>,
    last_error: Option<String>,
    /// Prevents parallel downloads or installs, including after a webview reload.
    install_in_progress: bool,
}

impl PendingUpdateState {
    fn take_update(&mut self, version: &str) -> Result<tauri_plugin_updater::Update, String> {
        if self.install_in_progress {
            return Err("An update install is already in progress.".to_string());
        }
        match self.update.as_ref() {
            Some(pending) if pending.version == version.trim() => {
                self.install_in_progress = true;
                Ok(self.update.take().expect("update checked above"))
            }
            Some(_) => Err(
                "The pending update changed. Run another update check before installing."
                    .to_string(),
            ),
            None => Err(no_pending_update_message(self.last_error.as_deref())),
        }
    }
}

impl PendingAppUpdate {
    fn lock(&self) -> std::sync::MutexGuard<'_, PendingUpdateState> {
        lock_or_recover(&self.state)
    }

    fn fail_install(&self, message: String) -> String {
        let mut state = self.lock();
        state.install_in_progress = false;
        state.download_operation_id = None;
        state.last_error = Some(message.clone());
        format!(
            "{} Run another update check before retrying installation.",
            message
        )
    }
}

/// A stalled connection otherwise wedges `check()` (and the check lock every
/// later check queues behind) for the rest of the session.
const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const RELEASE_NOTES_TIMEOUT: Duration = Duration::from_secs(15);
const RELEASE_VERSION_MAX_LENGTH: usize = 128;
const RELEASE_NOTES_MAX_BYTES: usize = 512 * 1024;
const RELEASE_NOTES_CACHE_CAPACITY: usize = 8;
const RELEASE_NOTES_FAILURE_COOLDOWN: Duration = Duration::from_secs(5 * 60);
const RELEASE_NOTES_UNAVAILABLE: &str = "Release notes are unavailable right now.";
const RELEASE_NOTES_RATE_LIMITED: &str = "GitHub rate limit reached; try again later.";
static RELEASE_NOTES_CLIENT: LazyLock<reqwest::Client> =
    LazyLock::new(|| build_provider_http_client(None));
static RELEASE_NOTES_CACHE: LazyLock<tokio::sync::Mutex<HashMap<String, ReleaseNotesCacheEntry>>> =
    LazyLock::new(|| tokio::sync::Mutex::new(HashMap::new()));
static RELEASE_NOTES_IN_FLIGHT: LazyLock<InFlight> =
    LazyLock::new(|| InFlight::new(RELEASE_NOTES_CACHE_CAPACITY));
/// reqwest's timeout is total-duration and can't bound a legit long download —
/// instead a watchdog aborts when no chunk has arrived for this long.
const UPDATE_DOWNLOAD_STALL_LIMIT: Duration = Duration::from_secs(120);
const UPDATE_DOWNLOAD_WATCHDOG_TICK: Duration = Duration::from_secs(15);
const UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);

pub(crate) const APP_UPDATE_PROGRESS_EVENT: &str = "app-update-progress";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReleaseNoteBlockKind {
    Heading,
    Bullet,
    Text,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNoteBlock {
    pub kind: ReleaseNoteBlockKind,
    pub text: String,
    pub key: String,
}

/// Markdown-lite normalization happens once per update check, not per UI render.
fn parse_release_notes(body: Option<&str>) -> Vec<ReleaseNoteBlock> {
    let mut blocks = Vec::new();
    for line in body.unwrap_or_default().lines().map(str::trim) {
        if line.is_empty()
            || (line.len() >= 3
                && line
                    .bytes()
                    .all(|byte| matches!(byte, b'-' | b'=' | b'*' | b'_' | b'#')))
        {
            continue;
        }
        let heading_length = line.bytes().take_while(|byte| *byte == b'#').count();
        let bullet_length = match line.chars().next() {
            Some(character @ ('-' | '*' | '•' | '‣' | '·')) => character.len_utf8(),
            _ => {
                let digits = line.bytes().take_while(u8::is_ascii_digit).count();
                if (1..=2).contains(&digits)
                    && matches!(line.as_bytes().get(digits), Some(b'.' | b')'))
                {
                    digits + 1
                } else {
                    0
                }
            }
        };
        let has_separator = |length: usize| {
            line[length..]
                .chars()
                .next()
                .is_some_and(char::is_whitespace)
        };
        let (kind, content, kind_str) =
            if (1..=6).contains(&heading_length) && has_separator(heading_length) {
                (
                    ReleaseNoteBlockKind::Heading,
                    &line[heading_length..],
                    "heading",
                )
            } else if bullet_length > 0 && has_separator(bullet_length) {
                (
                    ReleaseNoteBlockKind::Bullet,
                    &line[bullet_length..],
                    "bullet",
                )
            } else {
                (ReleaseNoteBlockKind::Text, line, "text")
            };
        let text = strip_inline_markup(content);
        if !text.is_empty() {
            blocks.push(ReleaseNoteBlock {
                kind,
                text,
                key: format!("{}-{}", kind_str, blocks.len()),
            });
        }
    }
    blocks
}

fn unwrap_inline_delimiter(text: String, delimiter: &str, word_bounded: bool) -> String {
    if !text.contains(delimiter) {
        return text;
    }
    let mut result = String::with_capacity(text.len());
    let mut cursor = 0;
    let is_word = |character: char| character.is_alphanumeric() || character == '_';
    while let Some(relative_start) = text[cursor..].find(delimiter) {
        let start = cursor + relative_start;
        let content_start = start + delimiter.len();
        let Some(relative_end) = text[content_start..].find(delimiter) else {
            break;
        };
        let end = content_start + relative_end;
        let after = end + delimiter.len();
        let bounded = !word_bounded
            || (!text[..start].chars().next_back().is_some_and(is_word)
                && !text[after..].chars().next().is_some_and(is_word));
        if bounded && (end > content_start || delimiter == "`") {
            result.push_str(&text[cursor..start]);
            result.push_str(&text[content_start..end]);
            cursor = after;
        } else {
            result.push_str(&text[cursor..content_start]);
            cursor = content_start;
        }
    }
    result.push_str(&text[cursor..]);
    result
}

fn strip_html_tags(text: String) -> String {
    if !text.contains('<') {
        return text;
    }
    let mut result = String::with_capacity(text.len());
    let mut cursor = 0;
    while let Some(relative_start) = text[cursor..].find('<') {
        let start = cursor + relative_start;
        result.push_str(&text[cursor..start]);
        match text[start..].find('>') {
            Some(end) if end > 1 => {
                result.push(' ');
                cursor = start + end + 1;
            }
            Some(_) => {
                result.push('<');
                cursor = start + 1;
            }
            None => {
                cursor = start;
                break;
            }
        }
    }
    result.push_str(&text[cursor..]);
    result
}

fn strip_markdown_links(text: String, images: bool) -> String {
    let marker = if images { "![" } else { "[" };
    if !text.contains(marker) {
        return text;
    }
    let mut result = String::with_capacity(text.len());
    let mut cursor = 0;
    while let Some(relative_start) = text[cursor..].find(marker) {
        let start = cursor + relative_start;
        let label_start = start + marker.len();
        result.push_str(&text[cursor..start]);
        let Some(label_end) = text[label_start..].find(']').map(|end| end + label_start) else {
            cursor = start;
            break;
        };
        if let Some(url) = text[label_end + 1..].strip_prefix('(') {
            let Some(url_end) = url.find(')') else {
                cursor = start;
                break;
            };
            if !images {
                result.push_str(&text[label_start..label_end]);
            }
            cursor = label_end + 2 + url_end + 1;
            continue;
        }
        result.push_str(&text[start..=label_end]);
        cursor = label_end + 1;
    }
    result.push_str(&text[cursor..]);
    result
}

fn strip_inline_markup(text: &str) -> String {
    // Images go first, including badges nested inside links.
    let mut plain = strip_markdown_links(text.to_string(), true);
    plain = strip_markdown_links(plain, false);
    // Strip tags after links so HTML inside a link label is normalized too.
    plain = strip_html_tags(plain);
    for delimiter in ["**", "__", "~~", "*", "_", "`"] {
        plain = unwrap_inline_delimiter(plain, delimiter, delimiter == "_");
    }
    let mut result = String::with_capacity(plain.len());
    let mut whitespace = None;
    let mut multiple_whitespace = false;
    for character in plain.chars() {
        if character.is_whitespace() {
            multiple_whitespace |= whitespace.is_some();
            whitespace.get_or_insert(character);
        } else {
            if !result.is_empty() {
                if let Some(first) = whitespace {
                    result.push(if multiple_whitespace { ' ' } else { first });
                }
            }
            result.push(character);
            whitespace = None;
            multiple_whitespace = false;
        }
    }
    result
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateMetadata {
    pub version: String,
    pub notification_eligible: bool,
    pub notes: Vec<ReleaseNoteBlock>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateCheckError {
    message: String,
    retry_on_reconnect: bool,
}

impl From<tauri_plugin_updater::Error> for AppUpdateCheckError {
    fn from(error: tauri_plugin_updater::Error) -> Self {
        let retry_on_reconnect = match &error {
            tauri_plugin_updater::Error::Reqwest(error) => {
                !error.is_builder() && !error.is_redirect() && !error.is_decode()
            }
            tauri_plugin_updater::Error::Network(_) => true,
            _ => false,
        };
        Self {
            message: if retry_on_reconnect {
                "Could not reach the update server. Check your connection and try again."
                    .to_string()
            } else {
                error.to_string()
            },
            retry_on_reconnect,
        }
    }
}

#[derive(Deserialize)]
struct GitHubRelease {
    body: Option<String>,
    published_at: Option<String>,
}

enum ReleaseNotesCacheEntry {
    Found(AppUpdateMetadata),
    Missing,
    Failed {
        message: &'static str,
        retry_at: Instant,
    },
}

impl ReleaseNotesCacheEntry {
    fn unavailable() -> Self {
        Self::Failed {
            message: RELEASE_NOTES_UNAVAILABLE,
            retry_at: Instant::now() + RELEASE_NOTES_FAILURE_COOLDOWN,
        }
    }

    fn result(&self) -> Result<Option<AppUpdateMetadata>, String> {
        match self {
            Self::Found(metadata) => Ok(Some(metadata.clone())),
            Self::Missing => Ok(None),
            Self::Failed { message, .. } => Err((*message).to_string()),
        }
    }
}

fn release_notes_rate_limit_cooldown(response: &reqwest::Response) -> Option<Duration> {
    let headers = response.headers();
    let header_seconds = |name| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<u64>().ok())
    };
    let exhausted = header_seconds("x-ratelimit-remaining") == Some(0);
    if response.status() != reqwest::StatusCode::TOO_MANY_REQUESTS
        && !(response.status() == reqwest::StatusCode::FORBIDDEN
            && (exhausted || headers.contains_key(reqwest::header::RETRY_AFTER)))
    {
        return None;
    }

    let reset_delay = if exhausted {
        header_seconds("x-ratelimit-reset").and_then(|reset| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .ok()
                .map(|now| reset.saturating_sub(now.as_secs()))
        })
    } else {
        None
    };
    let seconds = reset_delay
        .max(header_seconds("retry-after"))
        .unwrap_or(RELEASE_NOTES_FAILURE_COOLDOWN.as_secs());
    Some(Duration::from_secs(seconds.clamp(60, 60 * 60)))
}

async fn fetch_app_release_notes(version: &str) -> ReleaseNotesCacheEntry {
    let response = match RELEASE_NOTES_CLIENT
        .get(format!(
            "https://api.github.com/repos/stremiro/stremiro/releases/tags/v{}",
            urlencoding::encode(version)
        ))
        .header(
            reqwest::header::USER_AGENT,
            concat!("Stremiro/", env!("CARGO_PKG_VERSION")),
        )
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .timeout(RELEASE_NOTES_TIMEOUT)
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return ReleaseNotesCacheEntry::unavailable(),
    };
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return ReleaseNotesCacheEntry::Missing;
    }
    if let Some(cooldown) = release_notes_rate_limit_cooldown(&response) {
        return ReleaseNotesCacheEntry::Failed {
            message: RELEASE_NOTES_RATE_LIMITED,
            retry_at: Instant::now() + cooldown,
        };
    }
    if !response.status().is_success() {
        return ReleaseNotesCacheEntry::unavailable();
    }
    let bytes = match read_bounded_body(response, RELEASE_NOTES_MAX_BYTES, |_| {
        RELEASE_NOTES_UNAVAILABLE.to_string()
    })
    .await
    {
        Ok(bytes) => bytes,
        Err(_) => return ReleaseNotesCacheEntry::unavailable(),
    };
    let release: GitHubRelease = match serde_json::from_slice(&bytes) {
        Ok(release) => release,
        Err(_) => return ReleaseNotesCacheEntry::unavailable(),
    };
    let date = release
        .published_at
        .as_deref()
        .and_then(|timestamp| timestamp.split_once('T'))
        .map(|(date, _)| date)
        .filter(|date| super::calendar_commands::date_ordinal(date).is_some())
        .map(str::to_string);

    ReleaseNotesCacheEntry::Found(AppUpdateMetadata {
        version: version.to_string(),
        notification_eligible: false,
        notes: parse_release_notes(release.body.as_deref()),
        date,
    })
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateProgressEvent<'a> {
    operation_id: &'a str,
    #[serde(flatten)]
    progress: AppUpdateProgress,
}

fn emit_progress(app: &AppHandle, operation_id: &str, progress: AppUpdateProgress) {
    let _ = app.emit(
        APP_UPDATE_PROGRESS_EVENT,
        AppUpdateProgressEvent {
            operation_id,
            progress,
        },
    );
}

#[command]
pub fn get_current_app_version(app: AppHandle) -> Result<String, String> {
    Ok(app.package_info().version.to_string())
}

#[command]
pub async fn get_app_release_notes(version: String) -> Result<Option<AppUpdateMetadata>, String> {
    if version.is_empty()
        || version.len() > RELEASE_VERSION_MAX_LENGTH
        || !version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
    {
        return Err("Invalid application release version.".to_string());
    }

    let key_lock = RELEASE_NOTES_IN_FLIGHT.claim(&version);
    let result = {
        let _fetch_permit = key_lock.lock().await;
        let cached = {
            let cache = RELEASE_NOTES_CACHE.lock().await;
            cache
                .get(&version)
                .filter(|entry| {
                    !matches!(entry, ReleaseNotesCacheEntry::Failed { retry_at, .. } if *retry_at <= Instant::now())
                })
                .map(ReleaseNotesCacheEntry::result)
        };
        if let Some(result) = cached {
            result
        } else {
            let entry = fetch_app_release_notes(&version).await;
            let result = entry.result();
            let mut cache = RELEASE_NOTES_CACHE.lock().await;
            if cache.len() >= RELEASE_NOTES_CACHE_CAPACITY && !cache.contains_key(&version) {
                if let Some(victim) = cache.keys().next().cloned() {
                    cache.remove(&victim);
                }
            }
            cache.insert(version.clone(), entry);
            result
        }
    };
    RELEASE_NOTES_IN_FLIGHT.release(&version, &key_lock);
    result
}

#[command]
pub async fn check_for_app_update(
    app: AppHandle,
    pending_update: State<'_, PendingAppUpdate>,
) -> Result<Option<AppUpdateMetadata>, AppUpdateCheckError> {
    let _check_guard = pending_update.check_lock.lock().await;

    // Replacing the pending handle mid-install would race the take.
    {
        let mut state = pending_update.lock();
        if state.install_in_progress {
            return Err(AppUpdateCheckError {
                message: "An update install is already in progress.".to_string(),
                retry_on_reconnect: false,
            });
        }
        state.downloaded_bytes = None;
        state.download_operation_id = None;
    }

    let update = tokio::time::timeout(
        UPDATE_CHECK_TIMEOUT,
        app.updater().map_err(AppUpdateCheckError::from)?.check(),
    )
    .await
    .map_err(|_| AppUpdateCheckError {
        message: "Update check timed out. Check your connection and try again.".to_string(),
        retry_on_reconnect: true,
    })?
    .map_err(AppUpdateCheckError::from)?;

    let notification_eligible = if let Some(update) = update.as_ref() {
        super::config_commands::get_last_notified_app_update_version(app.clone())
            .await
            .is_ok_and(|last| last.as_deref() != Some(update.version.as_str()))
    } else {
        false
    };
    let metadata = update.as_ref().map(|update| AppUpdateMetadata {
        version: update.version.clone(),
        notification_eligible,
        notes: parse_release_notes(update.body.as_deref()),
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

fn no_pending_update_message(last_error: Option<&str>) -> String {
    match last_error {
        Some(previous) => format!(
            "No pending update is available to install (last install failed: {}). Run another update check before retrying installation.",
            previous
        ),
        None => "No pending update is available to install. Run another update check before retrying installation.".to_string(),
    }
}

#[command]
pub async fn download_app_update(
    app: AppHandle,
    pending_update: State<'_, PendingAppUpdate>,
    version: String,
    operation_id: String,
) -> Result<(), String> {
    // Take the handle under check_lock so a remote check can't swap it.
    let update = {
        let _check_guard = pending_update.check_lock.lock().await;
        let mut state = pending_update.lock();
        let update = state.take_update(&version)?;
        state.downloaded_bytes = None;
        state.download_operation_id = None;
        update
    };

    let progress_app = app.clone();
    let progress_operation_id = operation_id.clone();
    let mut downloaded_bytes = 0_u64;
    let mut last_reported_percent = None::<u64>;
    let last_activity_at = Arc::new(Mutex::new(Instant::now()));
    let chunk_activity_at = last_activity_at.clone();

    let download_result = {
        let download = update.download(
            move |chunk_length, content_length| {
                *lock_or_recover(&chunk_activity_at) = Instant::now();
                downloaded_bytes = downloaded_bytes
                    .saturating_add(u64::try_from(chunk_length).unwrap_or(u64::MAX));

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
                        &progress_operation_id,
                        AppUpdateProgress::Downloading {
                            downloaded_bytes: clamped_downloaded,
                            total_bytes,
                        },
                    );
                }
            },
            || {},
        );
        tokio::pin!(download);
        let deadline = tokio::time::sleep(UPDATE_DOWNLOAD_TIMEOUT);
        tokio::pin!(deadline);

        loop {
            tokio::select! {
                outcome = &mut download => break outcome.map_err(|error| error.to_string()),
                _ = &mut deadline => {
                    break Err("Update download timed out after 30 minutes. Try again on a faster connection.".to_string());
                }
                _ = tokio::time::sleep(UPDATE_DOWNLOAD_WATCHDOG_TICK) => {
                    let stalled_for = lock_or_recover(&last_activity_at).elapsed();
                    if stalled_for >= UPDATE_DOWNLOAD_STALL_LIMIT {
                        break Err(format!(
                            "Update download stalled — no data received for {}s.",
                            UPDATE_DOWNLOAD_STALL_LIMIT.as_secs()
                        ));
                    }
                }
            }
        }
    };
    let bytes = download_result.map_err(|message| pending_update.fail_install(message))?;
    let mut state = pending_update.lock();
    state.update = Some(update);
    state.downloaded_bytes = Some(bytes);
    state.download_operation_id = Some(operation_id);
    state.install_in_progress = false;
    Ok(())
}

#[command]
pub async fn install_app_update(
    app: AppHandle,
    pending_update: State<'_, PendingAppUpdate>,
    version: String,
    operation_id: String,
) -> Result<(), String> {
    let (update, bytes) = {
        let _check_guard = pending_update.check_lock.lock().await;
        let mut state = pending_update.lock();
        if state.downloaded_bytes.is_none() {
            return Err(no_pending_update_message(state.last_error.as_deref()));
        }
        if state.download_operation_id.as_deref() != Some(operation_id.as_str()) {
            return Err(
                "The update download changed. Run another update check before installing."
                    .to_string(),
            );
        }
        let update = state.take_update(&version)?;
        let bytes = state
            .downloaded_bytes
            .take()
            .expect("download checked above");
        state.download_operation_id = None;
        (update, bytes)
    };

    super::run_blocking_store_op({
        let app = app.clone();
        move || app.state::<super::DurableStoreRegistry>().flush_dirty()
    })
    .await
    .map_err(|message| pending_update.fail_install(message))?;
    // Keep install outside the timed flush task: a timed-out flush must never launch the installer later.
    tauri::async_runtime::spawn_blocking(move || {
        emit_progress(&app, &operation_id, AppUpdateProgress::Installing);
        update.install(bytes).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|result| result)
    .map_err(|message| pending_update.fail_install(message))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_update_progress_and_check_errors_match_frontend_contract() {
        assert_eq!(
            serde_json::to_value(AppUpdateProgressEvent {
                operation_id: "attempt-1",
                progress: AppUpdateProgress::Downloading {
                    downloaded_bytes: 25,
                    total_bytes: Some(100),
                },
            })
            .unwrap(),
            serde_json::json!({
                "operationId": "attempt-1",
                "phase": "downloading",
                "downloadedBytes": 25,
                "totalBytes": 100,
            })
        );
        let network_error =
            AppUpdateCheckError::from(tauri_plugin_updater::Error::Network("offline".into()));
        assert_eq!(
            serde_json::to_value(network_error).unwrap()["retryOnReconnect"],
            true
        );
        let config_error = AppUpdateCheckError::from(tauri_plugin_updater::Error::EmptyEndpoints);
        assert!(!config_error.retry_on_reconnect);
        assert!(!config_error.message.is_empty());
    }

    #[test]
    fn release_notes_shape_headings_bullets_and_numbered_lists() {
        let notes = parse_release_notes(Some(
            "# Heading\n###### Small\n####### Not a heading\n#No separator\n\
             - One\n* Two\n• Three\n‣ Four\n· Five\n1. Six\n02) Seven\n\
             100. Not a bullet\n2.No separator\nPlain text",
        ));
        let kinds: Vec<_> = notes.iter().map(|block| block.kind).collect();
        assert_eq!(
            kinds,
            [
                ReleaseNoteBlockKind::Heading,
                ReleaseNoteBlockKind::Heading,
                ReleaseNoteBlockKind::Text,
                ReleaseNoteBlockKind::Text,
                ReleaseNoteBlockKind::Bullet,
                ReleaseNoteBlockKind::Bullet,
                ReleaseNoteBlockKind::Bullet,
                ReleaseNoteBlockKind::Bullet,
                ReleaseNoteBlockKind::Bullet,
                ReleaseNoteBlockKind::Bullet,
                ReleaseNoteBlockKind::Bullet,
                ReleaseNoteBlockKind::Text,
                ReleaseNoteBlockKind::Text,
                ReleaseNoteBlockKind::Text,
            ]
        );
        assert_eq!(notes[0].text, "Heading");
        assert_eq!(notes[1].text, "Small");
        assert_eq!(notes[4].text, "One");
        assert_eq!(notes[10].text, "Seven");
        assert_eq!(notes[0].key, "heading-0");
        assert_eq!(notes[4].key, "bullet-4");
        assert_eq!(notes[13].key, "text-13");
    }

    #[test]
    fn release_notes_strip_links_images_html_and_inline_markup() {
        assert_eq!(
            strip_inline_markup(
                " [**Docs**](https://example.test) ![badge](image.png) <b>Ready</b> \
                 **bold** __strong__ ~~old~~ *italic* _emphasis_ `code` "
            ),
            "Docs Ready bold strong old italic emphasis code"
        );
        assert_eq!(
            strip_inline_markup("word_with_underscores and _words_"),
            "word_with_underscores and words"
        );
        assert_eq!(
            strip_inline_markup("Été **日本語** and [café](url)"),
            "Été 日本語 and café"
        );
        assert_eq!(strip_inline_markup("[<b>**Docs**</b>](url)"), "Docs");
        assert_eq!(strip_inline_markup("[![badge](image)](url)"), "");
        let brackets = format!("{}]", "[".repeat(4096));
        assert_eq!(strip_inline_markup(&brackets), brackets);
        assert_eq!(
            strip_inline_markup("[a [b](c)] ![a ![b] plain"),
            "a [b] ![a ![b] plain"
        );
        assert_eq!(strip_inline_markup("  a\t \n b  "), "a b");
        assert_eq!(strip_inline_markup("a\tb"), "a\tb");
        assert_eq!(
            strip_inline_markup("[broken](url **open <tag"),
            "[broken](url **open <tag"
        );
        assert_eq!(strip_inline_markup("``"), "");
    }

    #[test]
    fn release_notes_skip_empty_bodies_rules_and_markup_only_lines() {
        assert!(parse_release_notes(None).is_empty());
        assert!(parse_release_notes(Some("")).is_empty());
        assert!(parse_release_notes(Some(" \r\n\t\n---\n===\n***\n___\n###\n-_*#=")).is_empty());
        let notes = parse_release_notes(Some(
            "# ![heading](url)\n- <br>\n![only](url)\nRepeated\nRepeated",
        ));
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0].key, "text-0");
        assert_eq!(notes[1].key, "text-1");
        assert_eq!(parse_release_notes(Some("--\n==")).len(), 2);
    }

    #[test]
    fn release_note_blocks_serialize_for_the_frontend() {
        let notes = parse_release_notes(Some("# Notes\n- Fixed\nDetails"));
        assert_eq!(
            serde_json::to_value(notes).unwrap(),
            serde_json::json!([
                { "kind": "heading", "text": "Notes", "key": "heading-0" },
                { "kind": "bullet", "text": "Fixed", "key": "bullet-1" },
                { "kind": "text", "text": "Details", "key": "text-2" }
            ])
        );
    }
}
