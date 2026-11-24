use super::app_links::{find_app_link, AppLink};
use super::config_store::{
    load_app_ui_preferences, normalize_start_minimized, save_app_ui_preferences_to_store,
    AppUiPreferences,
};
use crate::providers::{
    addon_resource::AddonResourceClient, addons::AddonTransport, enrichment::EnrichmentClient,
    lock_or_recover, skip_times::SkipTimesProvider,
};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::async_runtime::JoinHandle;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;

const BACKGROUND_SETTLE_DELAY: Duration = Duration::from_secs(2);
const BACKGROUND_SWEEP_INTERVAL: Duration = Duration::from_secs(60);

/// Kept out of `AppShellState` so unit tests do not link `tauri::Wry` menu drops,
/// and lock-free so main-thread dispatch inside `MenuItem::set_text` can never deadlock.
struct TrayToggleState {
    item: MenuItem<tauri::Wry>,
    app_name: String,
}

struct BackgroundMaintenanceEntry {
    id: u64,
    handle: JoinHandle<()>,
}

struct BackgroundMaintenanceGuard {
    app: AppHandle,
    id: u64,
}

impl Drop for BackgroundMaintenanceGuard {
    fn drop(&mut self) {
        let state = self.app.state::<AppShellState>();
        let mut slot = lock_or_recover(&state.maintenance_task);
        if slot.as_ref().is_some_and(|entry| entry.id == self.id) {
            *slot = None;
        }
    }
}

#[derive(Default)]
pub(crate) struct AppShellState {
    close_to_tray: AtomicBool,
    minimize_to_tray: AtomicBool,
    preferences_hydrated: AtomicBool,
    start_hidden: AtomicBool,
    initial_reveal_pending: AtomicBool,
    quit_forwarded_at: Mutex<Option<Instant>>,
    frontend_quit_ready: AtomicBool,
    exit_pending: AtomicBool,
    exit_ready: AtomicBool,
    webview_memory_low: AtomicBool,
    background_epoch: AtomicU64,
    maintenance_task: Mutex<Option<BackgroundMaintenanceEntry>>,
    pending_app_link: Mutex<Option<AppLink>>,
}

impl AppShellState {
    fn take_initial_reveal(&self) -> bool {
        !self.start_hidden.load(Ordering::Relaxed)
            && self.initial_reveal_pending.swap(false, Ordering::Relaxed)
    }

    fn set_preferences(&self, preferences: &AppUiPreferences) {
        self.close_to_tray
            .store(preferences.close_to_tray, Ordering::Relaxed);
        self.minimize_to_tray
            .store(preferences.minimize_to_tray, Ordering::Relaxed);
    }

    fn forward_quit_to_frontend(&self, now: Instant) -> bool {
        if !self.frontend_quit_ready.load(Ordering::Relaxed) {
            return false;
        }
        let mut forwarded_at = lock_or_recover(&self.quit_forwarded_at);
        // Allow the renderer's bounded save and teardown, with a manual escape for a hung renderer.
        now.duration_since(*forwarded_at.get_or_insert(now)) < Duration::from_secs(30)
    }

    fn next_background_epoch(&self) -> u64 {
        self.background_epoch.fetch_add(1, Ordering::AcqRel) + 1
    }

    fn is_background_epoch_current(&self, epoch: u64) -> bool {
        self.background_epoch.load(Ordering::Acquire) == epoch
    }
}

fn is_background_epoch_current(app: &AppHandle, epoch: u64) -> bool {
    app.state::<AppShellState>()
        .is_background_epoch_current(epoch)
        && app
            .get_webview_window("main")
            .is_some_and(|window| is_background_window(&window))
}

pub(crate) fn frontend_loading(app: &AppHandle) {
    let state = app.state::<AppShellState>();
    state.frontend_quit_ready.store(false, Ordering::Relaxed);
    *lock_or_recover(&state.quit_forwarded_at) = None;
}

fn request_quit(app: &AppHandle) {
    // The renderer coalesces repeat requests while its write barrier is active.
    if app
        .state::<AppShellState>()
        .forward_quit_to_frontend(Instant::now())
        && app
            .get_webview_window("main")
            .is_some_and(|window| window.emit("app://quit-requested", ()).is_ok())
    {
        return;
    }
    // A missing renderer or failed event delivery must not strand the tray app.
    app.exit(0);
}

pub(crate) fn handle_run_event(app: &AppHandle, event: tauri::RunEvent) {
    let tauri::RunEvent::ExitRequested { api, code, .. } = event else {
        return;
    };
    let state = app.state::<AppShellState>();
    if state.exit_ready.load(Ordering::Relaxed) {
        return;
    }
    api.prevent_exit();
    if state.exit_pending.swap(true, Ordering::Relaxed) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = super::flush_stores_on_exit(app.clone()).await {
            crate::operational_log::log_warn(
                "shutdown",
                "durable-store-flush",
                "failed",
                &[crate::operational_log::field("error", error)],
            );
        }
        app.state::<AppShellState>()
            .exit_ready
            .store(true, Ordering::Relaxed);
        app.exit(code.unwrap_or(0));
    });
}

pub(crate) fn setup(app: &AppHandle) -> tauri::Result<()> {
    let preferences = super::open_store(app, super::SETTINGS_STORE_FILE)
        .map(|store| load_app_ui_preferences(&store));
    let state = app.state::<AppShellState>();
    state
        .preferences_hydrated
        .store(preferences.is_ok(), Ordering::Relaxed);
    let preferences = preferences.unwrap_or_default();
    let start_hidden =
        std::env::args_os().any(|arg| arg == "--autostart") && preferences.start_minimized;
    state.set_preferences(&preferences);
    state.initial_reveal_pending.store(true, Ordering::Relaxed);

    let app_name = app.config().product_name.as_deref().unwrap_or("Stremiro");
    let toggle = MenuItem::with_id(
        app,
        "toggle",
        format!("Show {app_name}"),
        true,
        None::<&str>,
    )?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", format!("Quit {app_name}"), true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &settings, &separator, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip(app_name)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => toggle_main_window(app),
            "settings" => {
                reveal_main_window(app);
                queue_app_link(app, AppLink::Settings);
            }
            "quit" => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                reveal_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let tray = builder.build(app)?;
    tray.set_visible(preferences.close_to_tray || preferences.minimize_to_tray || start_hidden)?;
    app.manage(TrayToggleState {
        item: toggle,
        app_name: app_name.to_string(),
    });
    // Only start hidden once the tray exists to bring the window back.
    state.start_hidden.store(start_hidden, Ordering::Relaxed);
    Ok(())
}

pub(crate) fn sync_preferences(app: &AppHandle, preferences: &AppUiPreferences, action: &str) {
    let state = app.state::<AppShellState>();
    state.set_preferences(preferences);
    state.preferences_hydrated.store(true, Ordering::Relaxed);
    if let Err(error) = sync_tray_state(app) {
        crate::operational_log::log_warn(
            "window",
            action,
            "failed",
            &[crate::operational_log::field("error", error)],
        );
    }
}

pub(crate) fn hydrate_preferences(app: &AppHandle, preferences: &AppUiPreferences) {
    if !app
        .state::<AppShellState>()
        .preferences_hydrated
        .swap(true, Ordering::Relaxed)
    {
        sync_preferences(app, preferences, "hydrate-preferences-tray-sync");
    }
}

fn sync_tray_state(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppShellState>();
    let hidden_or_minimized = app
        .get_webview_window("main")
        .is_none_or(|window| is_background_window(&window));
    if let Some(toggle) = app.try_state::<TrayToggleState>() {
        let label = if hidden_or_minimized {
            format!("Show {}", toggle.app_name)
        } else {
            "Hide to Tray".to_string()
        };
        let _ = toggle.item.set_text(label);
    }
    if let Some(tray) = app.tray_by_id("main") {
        let hidden = app
            .get_webview_window("main")
            .is_none_or(|window| !window.is_visible().unwrap_or(false));
        tray.set_visible(
            state.close_to_tray.load(Ordering::Relaxed)
                || state.minimize_to_tray.load(Ordering::Relaxed)
                || hidden,
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn toggle_main_window(app: &AppHandle) {
    let state = app.state::<AppShellState>();
    if state.initial_reveal_pending.load(Ordering::Relaxed)
        || app
            .get_webview_window("main")
            .is_none_or(|window| is_background_window(&window))
    {
        reveal_main_window(app);
    } else if let Err(error) = hide_main_window(app) {
        crate::operational_log::log_warn(
            "window",
            "tray-hide",
            "failed",
            &[crate::operational_log::field("error", error)],
        );
    }
}

pub(crate) fn reveal_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let state = app.state::<AppShellState>();
    if state.initial_reveal_pending.load(Ordering::Relaxed) {
        if state.start_hidden.swap(false, Ordering::Relaxed) {
            restore_foreground_memory(app);
            let _ = window.emit("app://startup-revealed", ());
            schedule_initial_reveal_fallback(app);
        }
        return;
    }
    show_main_window(&window);
}

fn show_main_window(window: &tauri::WebviewWindow) {
    let app = window.app_handle();
    *lock_or_recover(&app.state::<AppShellState>().quit_forwarded_at) = None;
    restore_foreground_memory(app);
    // Avoid unminimizing a non-minimized window: on Windows SW_RESTORE un-maximizes it.
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    let _ = window.show();
    let _ = window.set_focus();
    let _ = sync_tray_state(app);
}

fn set_webview_memory_target(app: &AppHandle, low: bool) {
    if app
        .state::<AppShellState>()
        .webview_memory_low
        .load(Ordering::Relaxed)
        == low
    {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        apply_webview_memory_target(&window, low);
    }
}

fn apply_webview_memory_target(window: &tauri::WebviewWindow, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows::core::Interface;

    let target_window = window.clone();
    let _ = window.with_webview(move |webview| {
        let app = target_window.app_handle();
        // Never throttle a visible, non-minimized window.
        if low && !is_background_window(&target_window) {
            return;
        }
        // SAFETY: with_webview runs on the WebView's owning thread with a live controller.
        // The COM interfaces remain in this callback, and level is a valid WebView2 enum value.
        unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else {
                return;
            };
            let Ok(core) = core.cast::<ICoreWebView2_19>() else {
                return;
            };
            let level = if low {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
            } else {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
            };
            if core.SetMemoryUsageTargetLevel(level).is_ok() {
                app.state::<AppShellState>()
                    .webview_memory_low
                    .store(low, Ordering::Relaxed);
            }
        }
    });
}

pub(crate) fn handle_main_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let app = window.app_handle();
    match event {
        tauri::WindowEvent::Resized(_) if window.is_minimized().unwrap_or(false) => {
            handle_main_window_minimized(app);
            let _ = sync_tray_state(app);
        }
        tauri::WindowEvent::Focused(true) => {
            restore_foreground_memory(app);
            let _ = sync_tray_state(app);
        }
        tauri::WindowEvent::Resized(_) if window.is_visible().unwrap_or(false) => {
            restore_foreground_memory(app);
            let _ = sync_tray_state(app);
        }
        _ => {}
    }
}

fn handle_main_window_minimized(app: &AppHandle) {
    let state = app.state::<AppShellState>();
    if state.minimize_to_tray.load(Ordering::Relaxed) {
        match hide_main_window(app) {
            Ok(()) => return,
            Err(error) => crate::operational_log::log_warn(
                "window",
                "minimize_to_tray",
                "failed",
                &[crate::operational_log::field("error", error)],
            ),
        }
    }
    start_background_maintenance(app);
}

fn is_background_window(window: &tauri::WebviewWindow) -> bool {
    !window.is_visible().unwrap_or(true) || window.is_minimized().unwrap_or(false)
}

fn restore_foreground_memory(app: &AppHandle) {
    let state = app.state::<AppShellState>();
    state.next_background_epoch();
    if let Some(previous) = lock_or_recover(&state.maintenance_task).take() {
        previous.handle.abort();
    }
    set_webview_memory_target(app, false);
}

fn start_background_maintenance(app: &AppHandle) {
    let state = app.state::<AppShellState>();
    let mut slot = lock_or_recover(&state.maintenance_task);
    if slot.is_some() {
        return;
    }
    let id = state.next_background_epoch();
    let task_app = app.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let _guard = BackgroundMaintenanceGuard {
            app: task_app.clone(),
            id,
        };
        run_background_maintenance(task_app, id).await;
    });
    *slot = Some(BackgroundMaintenanceEntry { id, handle });
}

async fn run_background_maintenance(app: AppHandle, background_epoch: u64) {
    // Give close-to-tray time to settle its pause and save before probing mpv.
    tokio::time::sleep(BACKGROUND_SETTLE_DELAY).await;
    while is_background_epoch_current(&app, background_epoch) {
        let Some(window) = app.get_webview_window("main").filter(is_background_window) else {
            break;
        };
        purge_expired_provider_caches(&app);
        let playback_active = super::player_mpv_commands::is_playback_active(app.clone()).await;
        let target_window = window.clone();
        let _ = app.run_on_main_thread(move || {
            // Restore and the delayed memory request are serialized on the window thread.
            let app = target_window.app_handle();
            if is_background_epoch_current(app, background_epoch) {
                if !playback_active {
                    let _ = app.emit("app://memory-trim", ());
                }
                set_webview_memory_target(app, !playback_active);
            }
        });
        tokio::time::sleep(BACKGROUND_SWEEP_INTERVAL).await;
    }
}

/// Queues a validated link for the renderer; the payload stays in Rust until the renderer asks.
pub(crate) fn accept_app_link(app: &AppHandle, args: impl IntoIterator<Item = String>) {
    let Some(link) = find_app_link(args) else {
        return;
    };
    queue_app_link(app, link);
}

fn queue_app_link(app: &AppHandle, link: AppLink) {
    *lock_or_recover(&app.state::<AppShellState>().pending_app_link) = Some(link);
    let _ = app.emit("app://link", ());
}

#[tauri::command]
pub(crate) fn take_pending_app_link(app: AppHandle) -> Option<AppLink> {
    lock_or_recover(&app.state::<AppShellState>().pending_app_link).take()
}

#[tauri::command]
pub(crate) fn is_start_hidden(app: AppHandle) -> bool {
    app.state::<AppShellState>()
        .start_hidden
        .load(Ordering::Relaxed)
}

fn disable_webview_autofill(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings4;
    use windows::core::Interface;

    let _ = window.with_webview(move |webview| {
        // SAFETY: with_webview runs on the WebView's owning thread with a live controller.
        // The COM interfaces stay within this callback.
        unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else {
                return;
            };
            let Ok(settings) = core.Settings() else {
                return;
            };
            let Ok(settings) = settings.cast::<ICoreWebView2Settings4>() else {
                return;
            };
            let _ = settings.SetIsGeneralAutofillEnabled(false);
            let _ = settings.SetIsPasswordAutosaveEnabled(false);
        }
    });
}

pub(crate) fn prepare_startup_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        disable_webview_autofill(&window);
    }
    if app
        .state::<AppShellState>()
        .start_hidden
        .load(Ordering::Relaxed)
    {
        start_background_maintenance(app);
    } else {
        schedule_initial_reveal_fallback(app);
    }
}

fn schedule_initial_reveal_fallback(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(10)).await;
        frontend_first_frame_ready(app);
    });
}

#[tauri::command]
pub(crate) fn frontend_first_frame_ready(app: AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if !handle.state::<AppShellState>().take_initial_reveal() {
            return;
        }
        if let Some(window) = handle.get_webview_window("main") {
            show_main_window(&window);
        }
        super::config_commands::schedule_capability_classification(&handle, |error| {
            crate::operational_log::log_warn(
                "startup",
                "classify_addon_capabilities",
                "skipped",
                &[crate::operational_log::field("error", error)],
            );
        });
    });
}

#[tauri::command]
pub(crate) async fn get_launch_at_login(app: AppHandle) -> Result<bool, String> {
    super::run_blocking_op(
        tokio::time::Instant::now() + super::BLOCKING_OP_TIMEOUT,
        "Launch at login check timed out.",
        move || {
            app.autolaunch()
                .is_enabled()
                .map_err(|error| error.to_string())
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn set_launch_at_login(app: AppHandle, enabled: bool) -> Result<bool, String> {
    super::run_blocking_store_op(move || {
        let autolaunch = app.autolaunch();
        if enabled {
            autolaunch.enable()
        } else {
            autolaunch.disable()
        }
        .map_err(|error| error.to_string())?;
        let enabled = autolaunch.is_enabled().map_err(|error| error.to_string())?;
        if !enabled {
            let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;
            let mut preferences = load_app_ui_preferences(&store);
            let start_minimized = preferences.start_minimized;
            normalize_start_minimized(&mut preferences, enabled);
            if preferences.start_minimized != start_minimized {
                save_app_ui_preferences_to_store(&store, &preferences);
                store.save()?;
            }
        }
        Ok(enabled)
    })
    .await
}

#[tauri::command]
pub(crate) fn hide_main_window_to_tray(app: AppHandle) -> Result<(), String> {
    hide_main_window(&app)
}

#[tauri::command]
pub(crate) fn mark_frontend_quit_ready(app: AppHandle) {
    app.state::<AppShellState>()
        .frontend_quit_ready
        .store(true, Ordering::Relaxed);
}

#[tauri::command]
pub(crate) fn close_main_window_to_tray(app: AppHandle) -> Result<bool, String> {
    if !app
        .state::<AppShellState>()
        .close_to_tray
        .load(Ordering::Relaxed)
    {
        return Ok(false);
    }
    hide_main_window(&app)?;
    Ok(true)
}

fn hide_main_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("The main window is unavailable.")?;
    let tray = app
        .tray_by_id("main")
        .ok_or("The system tray is unavailable.")?;
    // Make the recovery affordance available before hiding the only window.
    tray.set_visible(true).map_err(|error| error.to_string())?;
    let state = app.state::<AppShellState>();
    state.initial_reveal_pending.store(false, Ordering::Relaxed);
    *lock_or_recover(&state.quit_forwarded_at) = None;
    window.hide().map_err(|error| error.to_string())?;
    let _ = sync_tray_state(app);
    start_background_maintenance(app);
    Ok(())
}

fn purge_expired_provider_caches(app: &AppHandle) {
    if let Some(transport) = app.try_state::<AddonTransport>() {
        transport.purge_expired_caches();
    }
    if let Some(client) = app.try_state::<AddonResourceClient>() {
        client.purge_expired_caches();
    }
    if let Some(client) = app.try_state::<EnrichmentClient>() {
        client.purge_expired_caches();
    }
    if let Some(cache) = app.try_state::<super::calendar_commands::CalendarScheduleCache>() {
        cache.purge_expired();
    }
    if let Some(skip_times) = app.try_state::<SkipTimesProvider>() {
        skip_times.purge_expired_caches();
    }
    super::app_update_commands::purge_expired_caches();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_reveal_waits_for_permission_and_only_runs_once() {
        let state = AppShellState::default();
        state.initial_reveal_pending.store(true, Ordering::Relaxed);
        state.start_hidden.store(true, Ordering::Relaxed);
        assert!(!state.take_initial_reveal());
        state.start_hidden.store(false, Ordering::Relaxed);
        assert!(state.take_initial_reveal());
        assert!(!state.take_initial_reveal());
    }

    #[test]
    fn repeat_tray_quit_allows_the_save_barrier_and_a_later_hung_renderer_exit() {
        let state = AppShellState::default();
        let first = Instant::now();
        assert!(!state.forward_quit_to_frontend(first));
        state.frontend_quit_ready.store(true, Ordering::Relaxed);
        assert!(state.forward_quit_to_frontend(first));
        assert!(state.forward_quit_to_frontend(first + Duration::from_secs(1)));
        assert!(!state.forward_quit_to_frontend(first + Duration::from_secs(30)));
    }

    #[test]
    fn background_epoch_advances_and_invalidates_stale_trims() {
        let state = AppShellState::default();
        let first = state.next_background_epoch();
        assert!(state.is_background_epoch_current(first));
        let second = state.next_background_epoch();
        assert_ne!(first, second);
        assert!(!state.is_background_epoch_current(first));
        assert!(state.is_background_epoch_current(second));
    }
}
