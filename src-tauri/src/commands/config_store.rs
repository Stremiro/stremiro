use super::DurableStore;
use crate::providers::{bound_optional, lenient_option};
use serde::Deserialize;

mod addons;
mod app_ui;
mod keybindings;
mod profile;
mod stream_selector;

pub use addons::{AddonConfig, AddonConfigView};
pub use app_ui::{
    AppUiPreferences, AppUiPreferencesPatch, AppUiPreferencesView, SubtitleColor, SubtitleEdge,
    SubtitleFont,
};
pub use profile::{ProfilePreferences, ProfilePreferencesPatch};
pub use stream_selector::StreamSelectorPreferences;

pub(crate) use addons::{
    addon_configs_generation, load_addon_configs, normalize_addon_url, opaque_addon_id,
    resolve_addon_configs, save_addon_configs_to_store,
};
pub(super) use addons::{
    addon_display_url, is_pinned_default_addon_url, strip_ascii_prefix_ignore_case,
};
#[cfg(test)]
pub(super) use addons::{parse_stored_addon_configs, LEGACY_INSTALL_SCHEME};
pub(crate) use app_ui::{
    apply_app_ui_preferences_patch, default_player_keybindings, load_app_ui_preferences,
    normalize_audio_delay, normalize_start_minimized, normalize_subtitle_delay,
    normalize_subtitle_pos, normalize_subtitle_scale, parse_app_ui_preferences, push_recent_search,
    save_app_ui_preferences_to_store, startup_route,
};
pub(crate) use keybindings::bind_player_key;
pub(crate) use profile::{
    apply_profile_preferences_patch, load_profile_preferences, normalize_profile_avatar,
    parse_profile_preferences, save_profile_preferences_to_store,
};
pub(crate) use stream_selector::{
    apply_stream_selector_preferences_patch, default_stream_selector_preferences,
    load_stream_selector_preferences_state, parse_stream_selector_preferences,
    save_stream_selector_preferences_to_store, StreamSelectorBatch, StreamSelectorPreferencesPatch,
    StreamSelectorQuality, StreamSelectorSort, StreamSelectorSource,
};

#[cfg(test)]
pub(crate) use app_ui::sanitize_app_ui_preferences;
#[cfg(test)]
pub use app_ui::StartupPage;
#[cfg(test)]
use app_ui::{
    normalize_last_location, normalize_stored_app_ui_preferences, StoredAppUiPreferences,
};
#[cfg(test)]
use keybindings::{normalize_player_binding_key, resolve_player_keybindings};
#[cfg(test)]
use profile::{normalize_stored_profile_preferences, StoredProfilePreferences};
#[cfg(test)]
pub(crate) use profile::{sanitize_local_profile, sanitize_profile_preferences};
#[cfg(test)]
pub use profile::{AccentTargets, LocalProfile, ProfileViewMode};
#[cfg(test)]
pub(crate) use stream_selector::sanitize_stream_selector_preferences;

pub(super) const ADDON_CONFIGS_KEY: &str = "addon_configs";
/// First pinned default. Order matters: index = pinned registry slot.
const DEFAULT_CINEMETA_INSTALL_URL: &str = "stremiro://v3-cinemeta.strem.io/manifest.json";
const DEFAULT_CINEMETA_ADDON_NAME: &str = "Cinemeta";
/// Second pinned default.
const DEFAULT_OPENSUBTITLES_INSTALL_URL: &str =
    "stremiro://opensubtitles-v3.strem.io/manifest.json";
const DEFAULT_OPENSUBTITLES_ADDON_NAME: &str = "OpenSubtitles";

const DEFAULT_ADDON_INSTALLS: [(&str, &str); 2] = [
    (DEFAULT_CINEMETA_INSTALL_URL, DEFAULT_CINEMETA_ADDON_NAME),
    (
        DEFAULT_OPENSUBTITLES_INSTALL_URL,
        DEFAULT_OPENSUBTITLES_ADDON_NAME,
    ),
];
pub(crate) const APP_UI_PREFERENCES_KEY: &str = "app_ui_preferences";
const LAST_NOTIFIED_APP_UPDATE_VERSION_KEY: &str = "last_notified_app_update_version";
pub(crate) const PROFILE_PREFERENCES_KEY: &str = "profile_preferences";
const PROFILE_AVATAR_KEY: &str = "avatar";
const STREAM_SELECTOR_PREFERENCES_KEY: &str = "stream_selector_preferences";
const APP_UPDATE_VERSION_MAX_CHARS: usize = 64;
const PLAYER_VOLUME_DEFAULT: u32 = 75;
pub(crate) const PLAYER_VOLUME_MAX: u32 = 100;
const PLAYER_SPEED_DEFAULT: f64 = 1.0;
pub(crate) const PLAYER_SPEED_MIN: f64 = 0.25;
pub(crate) const PLAYER_SPEED_MAX: f64 = 4.0;
const NEXT_EPISODE_COUNTDOWN_SECS_DEFAULT: u32 = 8;
const CONTROLS_HIDE_DELAY_MS_DEFAULT: u32 = 3000;
// Subtitle tuning bounds mirror the player's apply-time quantizers (`use-subtitle-adjustments.ts`).
const SUBTITLE_DELAY_DEFAULT: f64 = 0.0;
const SUBTITLE_DELAY_MAX_ABS: f64 = 5.0;
const SUBTITLE_POS_DEFAULT: f64 = 100.0;
const SUBTITLE_SCALE_DEFAULT: f64 = 1.0;
const SUBTITLE_SCALE_MIN: f64 = 0.25;
const SUBTITLE_SCALE_MAX: f64 = 3.0;
const PROFILE_NAME_MAX_CHARS: usize = 32;
const PROFILE_ACCENT_INTENSITY_DEFAULT: u8 = 100;
// Native uploads are resized before persistence; also bound backups and legacy writers.
const PROFILE_AVATAR_MAX_CHARS: usize = 512 * 1024;
const PROFILE_AVATAR_PREFIXES: [&str; 3] = [
    "data:image/webp;base64,",
    "data:image/png;base64,",
    "data:image/jpeg;base64,",
];
const STREAM_SELECTOR_ADDON_MAX_CHARS: usize = 4_096;

fn deserialize_nullable_patch<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

fn normalize_last_notified_app_update_version(value: Option<String>) -> Option<String> {
    bound_optional(value, APP_UPDATE_VERSION_MAX_CHARS)
}

pub(crate) fn load_last_notified_app_update_version(store: &DurableStore) -> Option<String> {
    normalize_last_notified_app_update_version(
        store.get_typed(LAST_NOTIFIED_APP_UPDATE_VERSION_KEY),
    )
}

pub(crate) fn save_last_notified_app_update_version_to_store(
    store: &DurableStore,
    version: Option<String>,
) {
    if let Some(version) = normalize_last_notified_app_update_version(version) {
        store.set(
            LAST_NOTIFIED_APP_UPDATE_VERSION_KEY,
            serde_json::json!(version),
        );
    } else {
        store.delete(LAST_NOTIFIED_APP_UPDATE_VERSION_KEY);
    }
}

pub(crate) fn get_trimmed_store_string(store: &DurableStore, key: &str) -> Option<String> {
    bound_optional(store.get_typed(key), usize::MAX)
}

#[cfg(test)]
mod tests;
