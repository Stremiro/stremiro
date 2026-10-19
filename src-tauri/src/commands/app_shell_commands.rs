use super::config_store::{
    load_app_ui_preferences, normalize_start_minimized, save_app_ui_preferences_to_store,
    AppUiPreferences,
};
use crate::providers::{addon_resource::AddonResourceClient, addons::AddonTransport};
use std::sync::atomic::{AtomicBool, Ordering};
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
}

impl AppShellState {
    fn set_preferences(&self, preferences: &AppUiPreferences) {
        self.close_to_tray
            .store(preferences.close_to_tray, Ordering::Relaxed);
        self.minimize_to_tray
            .store(preferences.minimize_to_tray, Ordering::Relaxed);
    }
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
        std::env::args().any(|arg| arg == "--autostart") && preferences.start_minimized;
    state.set_preferences(&preferences);
    state.initial_reveal_pending.store(true, Ordering::Relaxed);

    let show = MenuItem::with_id(app, "show", "Show Stremiro", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Stremiro", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &separator, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Stremiro")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => reveal_main_window(app),
            "quit" => {
                let state = app.state::<AppShellState>();
                if !state.frontend_quit_ready.load(Ordering::Relaxed)
                    || state.quit_pending.swap(true, Ordering::Relaxed)
                {
                    app.exit(0);
                } else if let Some(window) = app.get_webview_window("main") {
                    if window.emit("app://quit-requested", ()).is_err() {
                        state.quit_pending.store(false, Ordering::Relaxed);
                    }
                }
            }
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

pub(crate) fn sync_preferences(
    app: &AppHandle,
    preferences: &AppUiPreferences,
) -> Result<(), String> {
    let state = app.state::<AppShellState>();
    state.set_preferences(preferences);
    state.preferences_hydrated.store(true, Ordering::Relaxed);
    sync_tray_visibility(app)
}

pub(crate) fn hydrate_preferences(app: &AppHandle, preferences: &AppUiPreferences) {
    if !app
        .state::<AppShellState>()
        .preferences_hydrated
        .swap(true, Ordering::Relaxed)
    {
        if let Err(error) = sync_preferences(app, preferences) {
            crate::operational_log::log_warn(
                "window",
                "hydrate-preferences-tray-sync",
                "failed",
                &[crate::operational_log::field("error", error)],
            );
        }
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
    #[cfg(windows)]
    set_webview_memory_target(&window, false);
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    let _ = sync_tray_visibility(app);
}

#[cfg(windows)]
fn set_webview_memory_target(window: &tauri::WebviewWindow, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows_core::Interface;

    let _ = window.with_webview(move |webview| unsafe {
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
    });
}

pub(crate) fn minimize_main_window_to_tray(window: &tauri::Window) {
    let app = window.app_handle();
    if app
        .state::<AppShellState>()
        .minimize_to_tray
        .load(Ordering::Relaxed)
        && window.is_minimized().unwrap_or(false)
    {
        if let Err(error) = hide_main_window(app) {
            crate::operational_log::log_warn(
                "window",
                "minimize_to_tray",
                "failed",
                &[crate::operational_log::field("error", error)],
            );
        }
    }
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
    #[cfg(windows)]
    set_webview_memory_target(&window, true);
    if let Some(transport) = app.try_state::<AddonTransport>() {
        transport.purge_expired_caches();
    }
    if let Some(client) = app.try_state::<AddonResourceClient>() {
        client.purge_expired_caches();
    }
    if let Some(cache) = app.try_state::<super::calendar_commands::CalendarScheduleCache>() {
        cache.purge_expired();
    }
    Ok(())
}
