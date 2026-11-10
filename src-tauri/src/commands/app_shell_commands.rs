use super::app_links::{find_app_link, AppLink};
use super::config_store::{
    load_app_ui_preferences, normalize_start_minimized, save_app_ui_preferences_to_store,
    AppUiPreferences,
};
use crate::providers::{
    addon_resource::AddonResourceClient, addons::AddonTransport, enrichment::EnrichmentClient,
    lock_or_recover,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;

#[derive(Default)]
pub(crate) struct AppShellState {
    close_to_tray: AtomicBool,
    minimize_to_tray: AtomicBool,
    preferences_hydrated: AtomicBool,
    start_hidden: AtomicBool,
    initial_reveal_pending: AtomicBool,
    quit_pending: AtomicBool,
    frontend_quit_ready: AtomicBool,
    exit_pending: AtomicBool,
    exit_ready: AtomicBool,
    webview_memory_low: AtomicBool,
    pending_app_link: Mutex<Option<AppLink>>,
}

impl AppShellState {
    fn set_preferences(&self, preferences: &AppUiPreferences) {
        self.close_to_tray
            .store(preferences.close_to_tray, Ordering::Relaxed);
        self.minimize_to_tray
            .store(preferences.minimize_to_tray, Ordering::Relaxed);
    }

    fn begin_frontend_quit(&self) -> bool {
        self.frontend_quit_ready.load(Ordering::Relaxed)
            && !self.quit_pending.swap(true, Ordering::Relaxed)
    }

    fn reset_frontend(&self) {
        self.frontend_quit_ready.store(false, Ordering::Relaxed);
        self.quit_pending.store(false, Ordering::Relaxed);
    }
}

pub(crate) fn frontend_loading(app: &AppHandle) {
    app.state::<AppShellState>().reset_frontend();
}

fn request_quit(app: &AppHandle) {
    if app.state::<AppShellState>().begin_frontend_quit()
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
    let show = MenuItem::with_id(app, "show", format!("Show {app_name}"), true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", format!("Quit {app_name}"), true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &settings, &separator, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip(app_name)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => reveal_main_window(app),
            "settings" => {
                reveal_main_window(app);
                let _ = app.emit("app://settings-requested", ());
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
    // Only start hidden once the tray exists to bring the window back.
    state.start_hidden.store(start_hidden, Ordering::Relaxed);
    Ok(())
}

pub(crate) fn sync_preferences(app: &AppHandle, preferences: &AppUiPreferences, action: &str) {
    let state = app.state::<AppShellState>();
    state.set_preferences(preferences);
    state.preferences_hydrated.store(true, Ordering::Relaxed);
    if let Err(error) = sync_tray_visibility(app) {
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

fn sync_tray_visibility(app: &AppHandle) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main") {
        let state = app.state::<AppShellState>();
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

pub(crate) fn reveal_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Some(state) = app.try_state::<AppShellState>() {
        state.start_hidden.store(false, Ordering::Relaxed);
        state.initial_reveal_pending.store(false, Ordering::Relaxed);
        state.quit_pending.store(false, Ordering::Relaxed);
    }
    set_webview_memory_target(app, false);
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    let _ = sync_tray_visibility(app);
}

fn set_webview_memory_target(app: &AppHandle, low: bool) {
    if app
        .state::<AppShellState>()
        .webview_memory_low
        .swap(low, Ordering::Relaxed)
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
    use windows_core::Interface;

    let _ = window.with_webview(move |webview| {
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
            let _ = core.SetMemoryUsageTargetLevel(level);
        }
    });
}

pub(crate) fn handle_main_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    match event {
        tauri::WindowEvent::Resized(_) if window.is_minimized().unwrap_or(false) => {
            handle_main_window_minimized(window.app_handle());
        }
        tauri::WindowEvent::Focused(true) => set_webview_memory_target(window.app_handle(), false),
        _ => {}
    }
}

fn handle_main_window_minimized(app: &AppHandle) {
    let state = app.state::<AppShellState>();
    if state.minimize_to_tray.load(Ordering::Relaxed) {
        if let Err(error) = hide_main_window(app) {
            crate::operational_log::log_warn(
                "window",
                "minimize_to_tray",
                "failed",
                &[crate::operational_log::field("error", error)],
            );
        }
        return;
    }
    release_background_memory_when_idle(app);
}

fn should_release_background_memory(
    playback_active: bool,
    window_visible: bool,
    window_minimized: bool,
) -> bool {
    !playback_active && (!window_visible || window_minimized)
}

fn release_background_memory_when_idle(app: &AppHandle) {
    if app
        .state::<AppShellState>()
        .webview_memory_low
        .load(Ordering::Relaxed)
    {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Playback keeps the normal target: the player still drives its clock and media session.
        let playback_active = super::player_mpv_commands::is_playback_active(app.clone()).await;
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        // Recheck after the native probe: the user may already have restored the window.
        if should_release_background_memory(
            playback_active,
            window.is_visible().unwrap_or(true),
            window.is_minimized().unwrap_or(false),
        ) {
            release_background_memory(&app);
        }
    });
}

/// Queues a validated link for the renderer; the payload stays in Rust until the renderer asks.
pub(crate) fn accept_app_link(app: &AppHandle, args: impl IntoIterator<Item = String>) {
    let Some(link) = find_app_link(args) else {
        return;
    };
    *lock_or_recover(&app.state::<AppShellState>().pending_app_link) = Some(link);
    let _ = app.emit("app://link", ());
}

#[tauri::command]
pub(crate) fn take_pending_app_link(app: AppHandle) -> Option<AppLink> {
    lock_or_recover(&app.state::<AppShellState>().pending_app_link).take()
}

pub(crate) fn reveal_on_startup(app: &AppHandle) {
    let Some(state) = app.try_state::<AppShellState>() else {
        return;
    };
    if state.initial_reveal_pending.load(Ordering::Relaxed)
        && !state.start_hidden.load(Ordering::Relaxed)
    {
        reveal_main_window(app);
    }
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
    state.quit_pending.store(false, Ordering::Relaxed);
    window.hide().map_err(|error| error.to_string())?;
    release_background_memory_when_idle(app);
    Ok(())
}

/// Hidden or minimized while idle: lower the WebView2 target and drop expired provider
/// payloads, which otherwise stay resident until the next insert into each cache.
fn release_background_memory(app: &AppHandle) {
    set_webview_memory_target(app, true);
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_quit_only_waits_for_a_ready_renderer_once() {
        let state = AppShellState::default();
        assert!(!state.begin_frontend_quit());
        state.frontend_quit_ready.store(true, Ordering::Relaxed);
        assert!(state.begin_frontend_quit());
        assert!(!state.begin_frontend_quit());

        state.reset_frontend();
        assert!(!state.begin_frontend_quit());
        state.frontend_quit_ready.store(true, Ordering::Relaxed);
        assert!(state.begin_frontend_quit());
    }

    #[test]
    fn active_playback_keeps_the_normal_memory_target_even_when_hidden() {
        for visible in [false, true] {
            for minimized in [false, true] {
                assert!(
                    !should_release_background_memory(true, visible, minimized),
                    "active playback: visible={visible}, minimized={minimized}"
                );
            }
        }
    }

    #[test]
    fn idle_memory_is_released_only_while_hidden_or_minimized() {
        assert!(should_release_background_memory(false, false, false));
        assert!(should_release_background_memory(false, false, true));
        assert!(should_release_background_memory(false, true, true));
        assert!(!should_release_background_memory(false, true, false));
    }
}
