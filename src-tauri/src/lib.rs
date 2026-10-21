mod commands;
mod operational_log;
mod providers;
#[cfg(test)]
mod test_helpers;

use commands::app_update_commands::PendingAppUpdate;
use commands::playback_state::PlaybackStateService;
use providers::addon_resource::AddonResourceClient;
use providers::addons::AddonTransport;
use providers::skip_times::SkipTimesProvider;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            commands::app_shell_commands::reveal_main_window(app);
        }))
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let window = webview.window();
                if let Some(icon) = webview.app_handle().default_window_icon().cloned() {
                    let _ = window.set_icon(icon);
                }
                commands::app_shell_commands::reveal_on_startup(webview.app_handle());
            }
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                commands::app_shell_commands::handle_main_window_event(window, event);
            }
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_libmpv::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        // App-owned durable stores: registry exists before any command runs.
        .manage(commands::DurableStoreRegistry::default())
        .manage(commands::player_window_commands::PlayerPipState::default())
        .manage(commands::app_shell_commands::AppShellState::default())
        .manage(commands::calendar_commands::CalendarScheduleCache::default())
        .manage(commands::stream_commands::StreamRequestRegistry::default())
        .setup(|app| {
            if let Some(icon) = app.default_window_icon().cloned() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_icon(icon);
                }
            }

            let handle = app.handle().clone();
            app.manage(PlaybackStateService::new());
            app.manage(PendingAppUpdate::default());

            commands::validate_startup_stores(&handle);
            if let Err(error) = commands::app_shell_commands::setup(&handle) {
                operational_log::log_warn(
                    "startup",
                    "system_tray",
                    "unavailable",
                    &[operational_log::field("error", error)],
                );
            }

            // Fail-safe: reveal the window even if the page load never finishes.
            let reveal_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                commands::app_shell_commands::reveal_on_startup(&reveal_handle);
            });

            commands::config_commands::schedule_capability_classification(&handle, |err| {
                operational_log::log_warn(
                    "startup",
                    "classify_addon_capabilities",
                    "skipped",
                    &[operational_log::field("error", &err)],
                );
            });

            Ok(())
        })
        .manage(AddonResourceClient::new())
        .manage(AddonTransport::new())
        .manage(SkipTimesProvider::new())
        .invoke_handler(tauri::generate_handler![
            commands::app_shell_commands::get_launch_at_login,
            commands::app_shell_commands::set_launch_at_login,
            commands::app_shell_commands::hide_main_window_to_tray,
            commands::app_shell_commands::close_main_window_to_tray,
            commands::app_shell_commands::mark_frontend_quit_ready,
            commands::app_update_commands::get_current_app_version,
            commands::app_update_commands::get_app_release_notes,
            commands::app_update_commands::check_for_app_update,
            commands::app_update_commands::download_app_update,
            commands::app_update_commands::install_app_update,
            commands::stream_commands::resolve_best_stream,
            commands::stream_commands::recover_playback_stream,
            commands::stream_commands::cancel_stream_request,
            commands::stream_commands::get_stream_selector_data,
            commands::stream_commands::get_stream_selector_indices,
            commands::stream_commands::get_stream_link,
            commands::stream_commands::get_stream_pack_rows,
            commands::search_commands::query_search_catalog,
            commands::similar_titles_commands::query_similar_titles,
            commands::similar_titles_commands::get_recent_watch_seed,
            commands::browse_genre_commands::get_browse_genres,

            commands::media_commands::get_media_details,
            commands::episode_navigation::get_episode_navigation,
            commands::episode_navigation::get_unaired_episode_indices,
            commands::media_commands::search_episodes,
            commands::media_commands::get_details_prefetch_bundle,
            commands::up_next_commands::get_resume_rail,
            commands::calendar_commands::get_calendar_events,
            commands::media_commands::get_addon_subtitles,
            commands::history_playback_commands::build_history_playback_plan,
            commands::playback_state_commands::report_playback_stream_outcome,
            commands::watch_history_commands::save_watch_progress,
            commands::watch_history_commands::save_watch_progress_batch,
            commands::watch_history_commands::set_episodes_watched,
            commands::watch_history_commands::get_watch_history,
            commands::watch_history_commands::get_watch_progress,
            commands::watch_history_commands::get_title_watch_progress,
            commands::watch_history_commands::get_total_watch_time_secs,
            commands::watch_history_commands::remove_all_from_watch_history,
            commands::watch_history_commands::bulk_remove_from_watch_history,
            commands::config_commands::get_addon_configs,
            commands::config_commands::get_addon_url,
            commands::config_commands::inspect_addon_url,
            commands::config_commands::update_addon_configs,
            commands::playback_preferences_commands::save_playback_language_preference,
            commands::playback_preferences_commands::get_playback_language_preferences,
            commands::playback_preferences_commands::get_effective_playback_language_preferences,
            commands::playback_preferences_commands::resolve_preferred_track_selection,
            commands::playback_preferences_commands::save_selected_playback_language_preference,
            commands::playback_preferences_commands::save_playback_language_preference_outcome_from_tracks,
            commands::playback_preferences_commands::get_supported_languages,
            commands::player_track_commands::read_player_track_list,
            commands::player_mpv_commands::player_mpv_command,
            commands::player_mpv_commands::player_mpv_destroy,
            commands::player_mpv_commands::player_mpv_set_video_margin_ratio,
            commands::player_mpv_commands::player_mpv_set_property,
            commands::player_mpv_commands::player_mpv_set_properties,
            commands::player_mpv_commands::player_mpv_set_audio_settings,
            commands::player_mpv_commands::player_mpv_get_property,
            commands::player_mpv_commands::player_mpv_get_playback_position,
            commands::player_mpv_commands::player_mpv_init,
            commands::player_window_commands::set_player_pip,
            commands::player_window_commands::get_player_pip,
            commands::player_window_commands::snap_player_pip,
            commands::config_commands::get_app_ui_preferences,
            commands::config_commands::get_default_player_keybindings,
            commands::config_commands::bind_player_keybinding,
            commands::config_commands::get_bootstrap_snapshot,
            commands::config_commands::save_app_ui_preferences,
            commands::config_commands::save_last_notified_app_update_version,
            commands::config_commands::get_profile_preferences,
            commands::config_commands::save_profile_preferences,
            commands::avatar_commands::set_profile_avatar_from_bytes,
            commands::avatar_commands::clear_profile_avatar,
            commands::config_commands::get_stream_selector_preferences,
            commands::config_commands::patch_stream_selector_preferences,
            commands::library_commands::add_to_library,
            commands::library_commands::remove_from_library,
            commands::library_commands::bulk_remove_from_library,
            commands::library_commands::get_library,
            commands::library_commands::get_library_genres,
            commands::library_commands::get_profile_library,
            commands::library_commands::search_titles,
            commands::list_commands::create_list,
            commands::list_commands::delete_list,
            commands::list_commands::rename_list,
            commands::list_commands::add_to_list,
            commands::list_commands::bulk_add_to_list,
            commands::list_commands::remove_from_list,
            commands::list_commands::bulk_remove_from_list,
            commands::list_commands::restore_list_items,
            commands::list_commands::get_lists,
            commands::list_commands::get_list_summaries,
            commands::list_commands::reorder_list_items,
            commands::list_commands::reorder_lists,
            commands::watch_status_commands::set_watch_status,
            commands::watch_status_commands::bulk_set_watch_status,
            commands::watch_status_commands::get_all_watch_statuses,
            commands::get_skip_times,
            commands::get_data_stats,
            commands::clear_watch_history,
            commands::clear_library,
            commands::clear_all_lists,
            commands::clear_all_watch_statuses,
            commands::backup_commands::export_app_data_to_file,
            commands::backup_commands::import_app_data_from_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                // Persist whatever the trailing debounce window mutated —
                // before the single-instance lock is released.
                if let Some(registry) = app.try_state::<commands::DurableStoreRegistry>() {
                    if let Err(error) = registry.flush_dirty() {
                        operational_log::log_warn(
                            "shutdown",
                            "durable-store-flush",
                            "failed",
                            &[operational_log::field("error", error)],
                        );
                    }
                }
            }
        });
}
