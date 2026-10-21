use super::keybindings::{
    normalize_player_keybindings, resolve_player_keybindings, PLAYER_KEYBINDING_ACTIONS,
};
use super::{
    deserialize_nullable_patch, lenient_option, DurableStore, APP_UI_PREFERENCES_KEY,
    CONTROLS_HIDE_DELAY_MS_DEFAULT, NEXT_EPISODE_COUNTDOWN_SECS_DEFAULT, PLAYER_SPEED_DEFAULT,
    PLAYER_SPEED_MAX, PLAYER_SPEED_MIN, PLAYER_VOLUME_DEFAULT, PLAYER_VOLUME_MAX,
    SUBTITLE_DELAY_DEFAULT, SUBTITLE_DELAY_MAX_ABS, SUBTITLE_POS_DEFAULT, SUBTITLE_SCALE_DEFAULT,
    SUBTITLE_SCALE_MAX, SUBTITLE_SCALE_MIN,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Serialize, Deserialize, Clone, Copy, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StartupPage {
    Library,
    Calendar,
    LastVisited,
    #[default]
    #[serde(other)]
    Home,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppUiPreferences {
    pub player_volume: u32,
    pub player_speed: f64,
    #[serde(default)]
    pub audio_delay: f64,
    #[serde(default)]
    pub night_mode: bool,
    pub spoiler_protection: bool,
    /// Subtitle tuning persisted across the per-episode player remount (a release group's offset is constant).
    pub subtitle_delay: f64,
    pub subtitle_pos: f64,
    pub subtitle_scale: f64,
    /// Opt-in EOF auto-advance (Up Next countdown). Off by default — auto-advance is a surprise the user must choose.
    pub auto_play_next: bool,
    pub next_episode_countdown_secs: u32,
    pub controls_hide_delay_ms: u32,
    /// Opt-OUT muted trailer embed on hover cards. On by default — disabling must never change existing users' behavior.
    pub trailer_previews: bool,
    /// Opt-in auto-skip of SkipDB intro/recap segments. Off by default — jumping content uninvited is a surprise.
    pub auto_skip_intro: bool,
    #[serde(default = "automatic_update_checks_default")]
    pub automatic_update_checks: bool,
    pub close_to_tray: bool,
    pub minimize_to_tray: bool,
    pub start_minimized: bool,
    pub startup_page: StartupPage,
    pub last_location: Option<String>,
    /// Per-action overrides only (`[]` = unbound); absent actions use defaults.
    pub player_keybindings: BTreeMap<String, Vec<String>>,
}

impl Default for AppUiPreferences {
    fn default() -> Self {
        Self {
            player_volume: PLAYER_VOLUME_DEFAULT,
            player_speed: PLAYER_SPEED_DEFAULT,
            audio_delay: 0.0,
            night_mode: false,
            spoiler_protection: false,
            subtitle_delay: SUBTITLE_DELAY_DEFAULT,
            subtitle_pos: SUBTITLE_POS_DEFAULT,
            subtitle_scale: SUBTITLE_SCALE_DEFAULT,
            auto_play_next: false,
            next_episode_countdown_secs: NEXT_EPISODE_COUNTDOWN_SECS_DEFAULT,
            controls_hide_delay_ms: CONTROLS_HIDE_DELAY_MS_DEFAULT,
            trailer_previews: true,
            auto_skip_intro: false,
            automatic_update_checks: true,
            close_to_tray: false,
            minimize_to_tray: false,
            start_minimized: false,
            startup_page: StartupPage::Home,
            last_location: None,
            player_keybindings: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUiPreferencesView {
    #[serde(flatten)]
    pub preferences: AppUiPreferences,
    pub effective_player_keybindings: BTreeMap<String, Vec<String>>,
    pub default_player_keybindings: BTreeMap<String, Vec<String>>,
}

pub(crate) fn default_player_keybindings() -> BTreeMap<String, Vec<String>> {
    PLAYER_KEYBINDING_ACTIONS
        .into_iter()
        .map(|(action, keys)| {
            (
                action.to_string(),
                keys.iter().map(|key| key.to_string()).collect(),
            )
        })
        .collect()
}

impl AppUiPreferencesView {
    pub(crate) fn from_preferences(preferences: AppUiPreferences) -> Self {
        Self {
            effective_player_keybindings: resolve_player_keybindings(
                &preferences.player_keybindings,
            ),
            default_player_keybindings: default_player_keybindings(),
            preferences,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppUiPreferencesPatch {
    pub player_volume: Option<u32>,
    pub player_speed: Option<f64>,
    pub audio_delay: Option<f64>,
    pub night_mode: Option<bool>,
    pub spoiler_protection: Option<bool>,
    pub subtitle_delay: Option<f64>,
    pub subtitle_pos: Option<f64>,
    pub subtitle_scale: Option<f64>,
    pub auto_play_next: Option<bool>,
    pub next_episode_countdown_secs: Option<u32>,
    pub controls_hide_delay_ms: Option<u32>,
    pub trailer_previews: Option<bool>,
    pub auto_skip_intro: Option<bool>,
    pub automatic_update_checks: Option<bool>,
    pub close_to_tray: Option<bool>,
    pub minimize_to_tray: Option<bool>,
    pub start_minimized: Option<bool>,
    pub startup_page: Option<StartupPage>,
    #[serde(default, deserialize_with = "deserialize_nullable_patch")]
    pub last_location: Option<Option<String>>,
    /// Replaces the whole override map; `{}` restores every default.
    pub player_keybindings: Option<BTreeMap<String, Vec<String>>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StoredAppUiPreferences {
    #[serde(default, deserialize_with = "lenient_option")]
    player_volume: Option<u32>,
    #[serde(default, deserialize_with = "lenient_option")]
    player_speed: Option<f64>,
    #[serde(default, deserialize_with = "lenient_option")]
    audio_delay: Option<f64>,
    #[serde(default, deserialize_with = "lenient_option")]
    night_mode: Option<bool>,
    #[serde(default, deserialize_with = "lenient_option")]
    spoiler_protection: Option<bool>,
    #[serde(default, deserialize_with = "lenient_option")]
    subtitle_delay: Option<f64>,
    #[serde(default, deserialize_with = "lenient_option")]
    subtitle_pos: Option<f64>,
    #[serde(default, deserialize_with = "lenient_option")]
    subtitle_scale: Option<f64>,
    #[serde(default, deserialize_with = "lenient_option")]
    auto_play_next: Option<bool>,
    #[serde(default, deserialize_with = "lenient_option")]
    next_episode_countdown_secs: Option<u32>,
    #[serde(default, deserialize_with = "lenient_option")]
    controls_hide_delay_ms: Option<u32>,
    #[serde(default, deserialize_with = "lenient_option")]
    trailer_previews: Option<bool>,
    #[serde(default, deserialize_with = "lenient_option")]
    auto_skip_intro: Option<bool>,
    #[serde(default, deserialize_with = "lenient_option")]
    automatic_update_checks: Option<bool>,
    #[serde(default, deserialize_with = "lenient_option")]
    close_to_tray: Option<bool>,
    #[serde(default, deserialize_with = "lenient_option")]
    minimize_to_tray: Option<bool>,
    #[serde(default, deserialize_with = "lenient_option")]
    start_minimized: Option<bool>,
    #[serde(default, deserialize_with = "lenient_option")]
    startup_page: Option<StartupPage>,
    #[serde(default, deserialize_with = "lenient_option")]
    last_location: Option<String>,
    #[serde(default, deserialize_with = "lenient_option")]
    player_keybindings: Option<BTreeMap<String, Vec<String>>>,
}

fn automatic_update_checks_default() -> bool {
    true
}

fn normalize_player_volume(value: Option<u32>) -> u32 {
    value
        .map(|volume| volume.min(PLAYER_VOLUME_MAX))
        .unwrap_or(PLAYER_VOLUME_DEFAULT)
}

fn normalize_player_speed(value: Option<f64>) -> f64 {
    value
        .filter(|speed| speed.is_finite() && *speed > 0.0)
        .map(|speed| speed.clamp(PLAYER_SPEED_MIN, PLAYER_SPEED_MAX))
        .unwrap_or(PLAYER_SPEED_DEFAULT)
}

fn normalize_next_episode_countdown_secs(value: Option<u32>) -> u32 {
    value
        .filter(|secs| matches!(*secs, 5 | 8 | 10 | 15 | 30))
        .unwrap_or(NEXT_EPISODE_COUNTDOWN_SECS_DEFAULT)
}

fn normalize_controls_hide_delay_ms(value: Option<u32>) -> u32 {
    value
        .filter(|delay| matches!(*delay, 2000 | 3000 | 5000 | 8000))
        .unwrap_or(CONTROLS_HIDE_DELAY_MS_DEFAULT)
}

pub(crate) fn normalize_audio_delay(value: Option<f64>) -> f64 {
    value
        .filter(|delay| delay.is_finite())
        .map(|delay| (delay.clamp(-5.0, 5.0) * 10.0).round() / 10.0)
        .unwrap_or(0.0)
}

pub(crate) fn normalize_subtitle_delay(value: Option<f64>) -> f64 {
    value
        .filter(|delay| delay.is_finite())
        .map(|delay| {
            (delay.clamp(-SUBTITLE_DELAY_MAX_ABS, SUBTITLE_DELAY_MAX_ABS) * 10.0).round() / 10.0
        })
        .unwrap_or(SUBTITLE_DELAY_DEFAULT)
}

pub(crate) fn normalize_subtitle_pos(value: Option<f64>) -> f64 {
    value
        .filter(|pos| pos.is_finite())
        .map(|pos| pos.clamp(0.0, 100.0))
        .unwrap_or(SUBTITLE_POS_DEFAULT)
}

pub(crate) fn normalize_subtitle_scale(value: Option<f64>) -> f64 {
    value
        .filter(|scale| scale.is_finite() && *scale > 0.0)
        .map(|scale| (scale.clamp(SUBTITLE_SCALE_MIN, SUBTITLE_SCALE_MAX) * 20.0).round() / 20.0)
        .unwrap_or(SUBTITLE_SCALE_DEFAULT)
}

pub(super) fn normalize_last_location(location: Option<String>) -> Option<String> {
    location.filter(|value| {
        if !value.starts_with('/')
            || value.chars().count() > 512
            || value.chars().any(char::is_control)
            || value.contains("//")
            || value.contains("..")
            || value.contains('\\')
        {
            return false;
        }
        let path = value.split(['?', '#']).next().unwrap_or_default();
        let segment = path.strip_prefix('/').unwrap_or_default().split('/').next();
        matches!(
            segment,
            Some("" | "search" | "details" | "profile" | "library" | "calendar" | "settings")
        )
    })
}

pub(crate) fn startup_route(
    preferences: impl std::borrow::Borrow<AppUiPreferences>,
) -> Option<String> {
    let preferences = preferences.borrow();
    match preferences.startup_page {
        StartupPage::Home => None,
        StartupPage::Library => Some("/library".to_string()),
        StartupPage::Calendar => Some("/calendar".to_string()),
        StartupPage::LastVisited => {
            normalize_last_location(preferences.last_location.clone()).filter(|location| {
                // History replacement resolves encoded parent segments before routing.
                !location
                    .split(['?', '#'])
                    .next()
                    .unwrap_or_default()
                    .split('/')
                    .any(|segment| {
                        segment.eq_ignore_ascii_case("%2e%2e")
                            || segment.eq_ignore_ascii_case(".%2e")
                            || segment.eq_ignore_ascii_case("%2e.")
                    })
            })
        }
    }
}

pub(crate) fn normalize_start_minimized(preferences: &mut AppUiPreferences, launch_at_login: bool) {
    preferences.start_minimized &=
        launch_at_login || preferences.close_to_tray || preferences.minimize_to_tray;
}

pub(crate) fn sanitize_app_ui_preferences(preferences: AppUiPreferences) -> AppUiPreferences {
    AppUiPreferences {
        player_volume: normalize_player_volume(Some(preferences.player_volume)),
        player_speed: normalize_player_speed(Some(preferences.player_speed)),
        audio_delay: normalize_audio_delay(Some(preferences.audio_delay)),
        subtitle_delay: normalize_subtitle_delay(Some(preferences.subtitle_delay)),
        subtitle_pos: normalize_subtitle_pos(Some(preferences.subtitle_pos)),
        subtitle_scale: normalize_subtitle_scale(Some(preferences.subtitle_scale)),
        next_episode_countdown_secs: normalize_next_episode_countdown_secs(Some(
            preferences.next_episode_countdown_secs,
        )),
        controls_hide_delay_ms: normalize_controls_hide_delay_ms(Some(
            preferences.controls_hide_delay_ms,
        )),
        last_location: normalize_last_location(preferences.last_location),
        player_keybindings: normalize_player_keybindings(preferences.player_keybindings),
        ..preferences
    }
}

pub(crate) fn apply_app_ui_preferences_patch(
    current: AppUiPreferences,
    patch: AppUiPreferencesPatch,
) -> AppUiPreferences {
    sanitize_app_ui_preferences(AppUiPreferences {
        player_volume: patch.player_volume.unwrap_or(current.player_volume),
        player_speed: patch.player_speed.unwrap_or(current.player_speed),
        audio_delay: patch.audio_delay.unwrap_or(current.audio_delay),
        night_mode: patch.night_mode.unwrap_or(current.night_mode),
        spoiler_protection: patch
            .spoiler_protection
            .unwrap_or(current.spoiler_protection),
        subtitle_delay: patch.subtitle_delay.unwrap_or(current.subtitle_delay),
        subtitle_pos: patch.subtitle_pos.unwrap_or(current.subtitle_pos),
        subtitle_scale: patch.subtitle_scale.unwrap_or(current.subtitle_scale),
        auto_play_next: patch.auto_play_next.unwrap_or(current.auto_play_next),
        next_episode_countdown_secs: patch
            .next_episode_countdown_secs
            .unwrap_or(current.next_episode_countdown_secs),
        controls_hide_delay_ms: patch
            .controls_hide_delay_ms
            .unwrap_or(current.controls_hide_delay_ms),
        trailer_previews: patch.trailer_previews.unwrap_or(current.trailer_previews),
        auto_skip_intro: patch.auto_skip_intro.unwrap_or(current.auto_skip_intro),
        automatic_update_checks: patch
            .automatic_update_checks
            .unwrap_or(current.automatic_update_checks),
        close_to_tray: patch.close_to_tray.unwrap_or(current.close_to_tray),
        minimize_to_tray: patch.minimize_to_tray.unwrap_or(current.minimize_to_tray),
        start_minimized: patch.start_minimized.unwrap_or(current.start_minimized),
        startup_page: patch.startup_page.unwrap_or(current.startup_page),
        last_location: patch.last_location.unwrap_or(current.last_location),
        player_keybindings: patch
            .player_keybindings
            .unwrap_or(current.player_keybindings),
    })
}

pub(super) fn normalize_stored_app_ui_preferences(
    preferences: StoredAppUiPreferences,
) -> AppUiPreferences {
    AppUiPreferences {
        player_volume: normalize_player_volume(preferences.player_volume),
        player_speed: normalize_player_speed(preferences.player_speed),
        audio_delay: normalize_audio_delay(preferences.audio_delay),
        night_mode: preferences.night_mode.unwrap_or(false),
        spoiler_protection: preferences.spoiler_protection.unwrap_or(false),
        subtitle_delay: normalize_subtitle_delay(preferences.subtitle_delay),
        subtitle_pos: normalize_subtitle_pos(preferences.subtitle_pos),
        subtitle_scale: normalize_subtitle_scale(preferences.subtitle_scale),
        auto_play_next: preferences.auto_play_next.unwrap_or(false),
        next_episode_countdown_secs: normalize_next_episode_countdown_secs(
            preferences.next_episode_countdown_secs,
        ),
        controls_hide_delay_ms: normalize_controls_hide_delay_ms(
            preferences.controls_hide_delay_ms,
        ),
        // Missing key = pre-toggle store — keep previews on, matching its behavior.
        trailer_previews: preferences.trailer_previews.unwrap_or(true),
        // Opt-in: missing keys on old stores keep auto-skip off.
        auto_skip_intro: preferences.auto_skip_intro.unwrap_or(false),
        automatic_update_checks: preferences.automatic_update_checks.unwrap_or(true),
        close_to_tray: preferences.close_to_tray.unwrap_or(false),
        minimize_to_tray: preferences.minimize_to_tray.unwrap_or(false),
        start_minimized: preferences.start_minimized.unwrap_or(false),
        startup_page: preferences.startup_page.unwrap_or_default(),
        last_location: normalize_last_location(preferences.last_location),
        player_keybindings: normalize_player_keybindings(
            preferences.player_keybindings.unwrap_or_default(),
        ),
    }
}

pub(crate) fn parse_app_ui_preferences(value: Value) -> Option<AppUiPreferences> {
    serde_json::from_value::<StoredAppUiPreferences>(value)
        .ok()
        .map(normalize_stored_app_ui_preferences)
}

pub(crate) fn load_app_ui_preferences(store: &DurableStore) -> AppUiPreferences {
    store
        .get_typed::<StoredAppUiPreferences>(APP_UI_PREFERENCES_KEY)
        .map(normalize_stored_app_ui_preferences)
        .unwrap_or_default()
}

pub(crate) fn save_app_ui_preferences_to_store(
    store: &DurableStore,
    preferences: &AppUiPreferences,
) {
    store.set(APP_UI_PREFERENCES_KEY, serde_json::json!(preferences));
}
