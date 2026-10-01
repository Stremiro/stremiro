use super::{normalize_non_empty, DurableStore};
use crate::providers::addon_manifest::{snapshot_is_classified, AddonManifest};
use crate::providers::addons::sanitize_addon_log;
use crate::providers::{strip_manifest_suffix, trim_to_max};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};

pub(super) const ADDON_CONFIGS_KEY: &str = "addon_configs";
/// Default registry install URL, reused in user-facing "no catalog/meta
/// addon" errors so the hint never drifts from the seeded default.
pub(crate) const DEFAULT_CINEMETA_INSTALL_URL: &str =
    "stremio://v3-cinemeta.strem.io/manifest.json";
const DEFAULT_CINEMETA_ADDON_NAME: &str = "Cinemeta";
/// OpenSubtitles ships as a second pinned default — broad subtitle-language
/// coverage out of the box. Order matters: index = pinned registry slot.
pub(crate) const DEFAULT_OPENSUBTITLES_INSTALL_URL: &str =
    "stremio://opensubtitles-v3.strem.io/manifest.json";
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
const STREAM_SELECTOR_PREFERENCES_KEY: &str = "stream_selector_preferences";
const APP_UPDATE_VERSION_MAX_CHARS: usize = 64;
const PLAYER_VOLUME_DEFAULT: u32 = 75;
const PLAYER_SPEED_DEFAULT: f64 = 1.0;
const PLAYER_SPEED_MIN: f64 = 0.25;
const PLAYER_SPEED_MAX: f64 = 4.0;
// Subtitle tuning bounds mirror the player's apply-time quantizers
// (`use-subtitle-adjustments.ts`): delay quantized to 0.1s, scale to 0.05.
const SUBTITLE_DELAY_DEFAULT: f64 = 0.0;
const SUBTITLE_DELAY_MAX_ABS: f64 = 5.0;
const SUBTITLE_POS_DEFAULT: f64 = 100.0;
const SUBTITLE_SCALE_DEFAULT: f64 = 1.0;
const SUBTITLE_SCALE_MIN: f64 = 0.25;
const SUBTITLE_SCALE_MAX: f64 = 3.0;
const PROFILE_NAME_MAX_CHARS: usize = 32;
const PROFILE_ACCENT_INTENSITY_DEFAULT: u8 = 100;
// The renderer downsizes uploads to a 256px WebP (~40KB encoded); the cap
// only bounds what a misbehaving writer can park in the preferences blob.
const PROFILE_AVATAR_MAX_CHARS: usize = 512 * 1024;
const PROFILE_AVATAR_PREFIXES: [&str; 3] = [
    "data:image/webp;base64,",
    "data:image/png;base64,",
    "data:image/jpeg;base64,",
];
const STREAM_SELECTOR_ADDON_MAX_CHARS: usize = 160;

/// Bumped on every addon-registry write so memoized parsed snapshots are
/// dropped the moment stored config changes.
static ADDON_CONFIGS_GENERATION: AtomicU64 = AtomicU64::new(0);

pub(crate) fn addon_configs_generation() -> u64 {
    ADDON_CONFIGS_GENERATION.load(Ordering::SeqCst)
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct AddonConfig {
    pub id: String,
    pub url: String,
    pub name: String,
    pub enabled: bool,
    // A corrupt stored snapshot degrades to `None` (re-classified on the
    // next fetch) instead of dropping the whole addon config — the strict
    // `AddonManifest` decode would otherwise poison every config read.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_option"
    )]
    pub capabilities: Option<AddonManifest>,
}

/// Per-field tolerance on stored blobs: one malformed value drops to `None`
/// instead of failing the whole struct decode — a strict `Option<T>` field
/// would reset every sibling preference to defaults on a single bad write.
fn lenient_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    Ok(Option::<Value>::deserialize(deserializer)?
        .and_then(|value| serde_json::from_value::<T>(value).ok()))
}

/// IPC view of an [`AddonConfig`]: `display_url` is the credential-masked URL
/// for UI surfaces, computed by the same `sanitize_addon_log` pipeline that
/// guards logs and errors — one redaction implementation, so a renderer-side
/// masker cannot drift and leak a user key. Output-only: renderer-supplied
/// values are ignored on save and the masked string is never persisted.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonConfigView {
    #[serde(flatten)]
    pub config: AddonConfig,
    pub display_url: String,
}

impl AddonConfigView {
    pub(crate) fn from_config(config: AddonConfig) -> Self {
        let display_url = sanitize_addon_log(&config.url);
        Self {
            config,
            display_url,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppUiPreferences {
    pub player_volume: u32,
    pub player_speed: f64,
    pub spoiler_protection: bool,
    /// Subtitle sync/position/scale tuning — persisted so it survives the
    /// per-episode player remount where a release group's offset is constant.
    pub subtitle_delay: f64,
    pub subtitle_pos: f64,
    pub subtitle_scale: f64,
    /// Opt-in EOF auto-advance: the Up Next card runs a countdown instead of
    /// waiting for a click. Off by default — auto-advance is a surprise the
    /// user must choose.
    pub auto_play_next: bool,
    /// Opt-OUT muted trailer embed on hover-expanded cards. On by default —
    /// disabling must never change behavior for existing users.
    pub trailer_previews: bool,
    /// Opt-in auto-skip: SkipDB intro/recap segments seek to the segment end
    /// on entry. Off by default — jumping content uninvited is a surprise the
    /// user must choose. Outros/previews and the next-episode tail stay manual.
    pub auto_skip_intro: bool,
}

impl Default for AppUiPreferences {
    fn default() -> Self {
        Self {
            player_volume: PLAYER_VOLUME_DEFAULT,
            player_speed: PLAYER_SPEED_DEFAULT,
            spoiler_protection: false,
            subtitle_delay: SUBTITLE_DELAY_DEFAULT,
            subtitle_pos: SUBTITLE_POS_DEFAULT,
            subtitle_scale: SUBTITLE_SCALE_DEFAULT,
            auto_play_next: false,
            trailer_previews: true,
            auto_skip_intro: false,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppUiPreferencesPatch {
    pub player_volume: Option<u32>,
    pub player_speed: Option<f64>,
    pub spoiler_protection: Option<bool>,
    pub subtitle_delay: Option<f64>,
    pub subtitle_pos: Option<f64>,
    pub subtitle_scale: Option<f64>,
    pub auto_play_next: Option<bool>,
    pub trailer_previews: Option<bool>,
    pub auto_skip_intro: Option<bool>,
}

/// Which UI surfaces follow the profile accent — opt-out flags default to on
/// so stores written before the flags existed keep their current look.
#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccentTargets {
    pub navigation: bool,
    pub actions: bool,
    pub progress: bool,
    pub artwork: bool,
}

impl Default for AccentTargets {
    fn default() -> Self {
        Self {
            navigation: true,
            actions: true,
            progress: true,
            artwork: true,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalProfile {
    pub username: String,
    pub accent_color: String,
    pub accent_intensity: u8,
    // Older renderers omit the field entirely — fall back to all targets on.
    #[serde(default)]
    pub accent_targets: AccentTargets,
    /// Base64 image data URL; absent means the initial-letter fallback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
}

impl Default for LocalProfile {
    fn default() -> Self {
        Self {
            username: "Guest User".to_string(),
            accent_color: "#ffffff".to_string(),
            accent_intensity: PROFILE_ACCENT_INTENSITY_DEFAULT,
            accent_targets: AccentTargets::default(),
            avatar: None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ProfileViewMode {
    #[default]
    Grid,
    List,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePreferences {
    pub profile: LocalProfile,
    pub view_mode: ProfileViewMode,
}

impl Default for ProfilePreferences {
    fn default() -> Self {
        Self {
            profile: LocalProfile::default(),
            view_mode: ProfileViewMode::Grid,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
pub enum StreamSelectorQuality {
    #[default]
    #[serde(rename = "all")]
    All,
    #[serde(rename = "4k")]
    P2160,
    #[serde(rename = "1080p")]
    P1080,
    #[serde(rename = "720p")]
    P720,
    #[serde(rename = "sd")]
    Sd,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum StreamSelectorSource {
    #[default]
    All,
    Cached,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum StreamSelectorSort {
    #[default]
    Smart,
    Quality,
    Seeds,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum StreamSelectorBatch {
    #[default]
    All,
    Episodes,
    Packs,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamSelectorPreferences {
    pub quality: StreamSelectorQuality,
    pub source: StreamSelectorSource,
    pub addon: String,
    pub sort: StreamSelectorSort,
    pub batch: StreamSelectorBatch,
}

impl Default for StreamSelectorPreferences {
    fn default() -> Self {
        Self {
            quality: StreamSelectorQuality::All,
            source: StreamSelectorSource::All,
            addon: "all".to_string(),
            sort: StreamSelectorSort::Smart,
            batch: StreamSelectorBatch::All,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAccentTargets {
    #[serde(default, deserialize_with = "lenient_option")]
    navigation: Option<bool>,
    #[serde(default, deserialize_with = "lenient_option")]
    actions: Option<bool>,
    #[serde(default, deserialize_with = "lenient_option")]
    progress: Option<bool>,
    #[serde(default, deserialize_with = "lenient_option")]
    artwork: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredLocalProfile {
    #[serde(default, deserialize_with = "lenient_option")]
    username: Option<String>,
    #[serde(default, deserialize_with = "lenient_option")]
    accent_color: Option<String>,
    #[serde(default, deserialize_with = "lenient_option")]
    accent_intensity: Option<u8>,
    #[serde(default, deserialize_with = "lenient_option")]
    accent_targets: Option<StoredAccentTargets>,
    #[serde(default, deserialize_with = "lenient_option")]
    avatar: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredProfilePreferences {
    #[serde(default, deserialize_with = "lenient_option")]
    profile: Option<StoredLocalProfile>,
    #[serde(default, deserialize_with = "lenient_option")]
    view_mode: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAppUiPreferences {
    #[serde(default, deserialize_with = "lenient_option")]
    player_volume: Option<u32>,
    #[serde(default, deserialize_with = "lenient_option")]
    player_speed: Option<f64>,
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
    trailer_previews: Option<bool>,
    #[serde(default, deserialize_with = "lenient_option")]
    auto_skip_intro: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredStreamSelectorPreferences {
    #[serde(default, deserialize_with = "lenient_option")]
    quality: Option<String>,
    #[serde(default, deserialize_with = "lenient_option")]
    source: Option<String>,
    #[serde(default, deserialize_with = "lenient_option")]
    addon: Option<String>,
    #[serde(default, deserialize_with = "lenient_option")]
    sort: Option<String>,
    #[serde(default, deserialize_with = "lenient_option")]
    batch: Option<String>,
}

fn normalize_player_volume(value: Option<u32>) -> u32 {
    value
        .map(|volume| volume.min(100))
        .unwrap_or(PLAYER_VOLUME_DEFAULT)
}

fn normalize_player_speed(value: Option<f64>) -> f64 {
    value
        .filter(|speed| speed.is_finite() && *speed > 0.0)
        .map(|speed| speed.clamp(PLAYER_SPEED_MIN, PLAYER_SPEED_MAX))
        .unwrap_or(PLAYER_SPEED_DEFAULT)
}

fn normalize_subtitle_delay(value: Option<f64>) -> f64 {
    value
        .filter(|delay| delay.is_finite())
        .map(|delay| {
            (delay.clamp(-SUBTITLE_DELAY_MAX_ABS, SUBTITLE_DELAY_MAX_ABS) * 10.0).round() / 10.0
        })
        .unwrap_or(SUBTITLE_DELAY_DEFAULT)
}

fn normalize_subtitle_pos(value: Option<f64>) -> f64 {
    value
        .filter(|pos| pos.is_finite())
        .map(|pos| pos.clamp(0.0, 100.0))
        .unwrap_or(SUBTITLE_POS_DEFAULT)
}

fn normalize_subtitle_scale(value: Option<f64>) -> f64 {
    value
        .filter(|scale| scale.is_finite() && *scale > 0.0)
        .map(|scale| (scale.clamp(SUBTITLE_SCALE_MIN, SUBTITLE_SCALE_MAX) * 20.0).round() / 20.0)
        .unwrap_or(SUBTITLE_SCALE_DEFAULT)
}

fn normalize_last_notified_app_update_version(value: Option<String>) -> Option<String> {
    value
        .as_deref()
        .and_then(|version| trim_to_max(version, APP_UPDATE_VERSION_MAX_CHARS))
}

fn normalize_profile_username(value: Option<String>) -> String {
    let candidate = value
        .as_deref()
        .and_then(|value| trim_to_max(value, PROFILE_NAME_MAX_CHARS));

    candidate.unwrap_or_else(|| LocalProfile::default().username)
}

fn normalize_profile_accent_intensity(value: Option<u8>) -> u8 {
    value.unwrap_or(PROFILE_ACCENT_INTENSITY_DEFAULT).min(100)
}

fn normalize_profile_accent_color(value: Option<String>) -> String {
    let candidate = value
        .as_deref()
        .map(str::trim)
        .filter(|value| {
            value.len() == 7
                && value.starts_with('#')
                && value.chars().skip(1).all(|c| c.is_ascii_hexdigit())
        })
        .map(str::to_ascii_lowercase);

    candidate.unwrap_or_else(|| LocalProfile::default().accent_color)
}

fn normalize_profile_view_mode(value: Option<&str>) -> ProfileViewMode {
    match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("list") => ProfileViewMode::List,
        _ => ProfileViewMode::Grid,
    }
}

// Missing flags default on: a store written before a given target existed
// should keep the behavior it was used with, not flip surfaces neutral.
fn normalize_accent_targets(value: Option<StoredAccentTargets>) -> AccentTargets {
    let Some(targets) = value else {
        return AccentTargets::default();
    };
    AccentTargets {
        navigation: targets.navigation.unwrap_or(true),
        actions: targets.actions.unwrap_or(true),
        progress: targets.progress.unwrap_or(true),
        artwork: targets.artwork.unwrap_or(true),
    }
}

fn normalize_profile_avatar(value: Option<String>) -> Option<String> {
    value.filter(|avatar| {
        avatar.len() <= PROFILE_AVATAR_MAX_CHARS
            && PROFILE_AVATAR_PREFIXES.iter().any(|prefix| {
                avatar.strip_prefix(prefix).is_some_and(|payload| {
                    !payload.is_empty()
                        && payload
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
                })
            })
    })
}

pub(crate) fn sanitize_local_profile(profile: LocalProfile) -> LocalProfile {
    LocalProfile {
        username: normalize_profile_username(Some(profile.username)),
        accent_color: normalize_profile_accent_color(Some(profile.accent_color)),
        accent_intensity: normalize_profile_accent_intensity(Some(profile.accent_intensity)),
        // Typed bools can't arrive malformed over IPC — nothing to normalize.
        accent_targets: profile.accent_targets,
        avatar: normalize_profile_avatar(profile.avatar),
    }
}

fn normalize_stored_local_profile(profile: Option<StoredLocalProfile>) -> LocalProfile {
    let profile = profile.unwrap_or_default();

    LocalProfile {
        username: normalize_profile_username(profile.username),
        accent_color: normalize_profile_accent_color(profile.accent_color),
        accent_intensity: normalize_profile_accent_intensity(profile.accent_intensity),
        accent_targets: normalize_accent_targets(profile.accent_targets),
        avatar: normalize_profile_avatar(profile.avatar),
    }
}

pub(crate) fn sanitize_profile_preferences(preferences: ProfilePreferences) -> ProfilePreferences {
    ProfilePreferences {
        profile: sanitize_local_profile(preferences.profile),
        view_mode: preferences.view_mode,
    }
}

pub(crate) fn sanitize_app_ui_preferences(preferences: AppUiPreferences) -> AppUiPreferences {
    AppUiPreferences {
        player_volume: normalize_player_volume(Some(preferences.player_volume)),
        player_speed: normalize_player_speed(Some(preferences.player_speed)),
        spoiler_protection: preferences.spoiler_protection,
        subtitle_delay: normalize_subtitle_delay(Some(preferences.subtitle_delay)),
        subtitle_pos: normalize_subtitle_pos(Some(preferences.subtitle_pos)),
        subtitle_scale: normalize_subtitle_scale(Some(preferences.subtitle_scale)),
        auto_play_next: preferences.auto_play_next,
        trailer_previews: preferences.trailer_previews,
        auto_skip_intro: preferences.auto_skip_intro,
    }
}

pub(crate) fn apply_app_ui_preferences_patch(
    current: AppUiPreferences,
    patch: AppUiPreferencesPatch,
) -> AppUiPreferences {
    sanitize_app_ui_preferences(AppUiPreferences {
        player_volume: patch.player_volume.unwrap_or(current.player_volume),
        player_speed: patch.player_speed.unwrap_or(current.player_speed),
        spoiler_protection: patch
            .spoiler_protection
            .unwrap_or(current.spoiler_protection),
        subtitle_delay: patch.subtitle_delay.unwrap_or(current.subtitle_delay),
        subtitle_pos: patch.subtitle_pos.unwrap_or(current.subtitle_pos),
        subtitle_scale: patch.subtitle_scale.unwrap_or(current.subtitle_scale),
        auto_play_next: patch.auto_play_next.unwrap_or(current.auto_play_next),
        trailer_previews: patch.trailer_previews.unwrap_or(current.trailer_previews),
        auto_skip_intro: patch.auto_skip_intro.unwrap_or(current.auto_skip_intro),
    })
}

fn normalize_stored_profile_preferences(
    preferences: StoredProfilePreferences,
) -> ProfilePreferences {
    ProfilePreferences {
        profile: normalize_stored_local_profile(preferences.profile),
        view_mode: normalize_profile_view_mode(preferences.view_mode.as_deref()),
    }
}

fn normalize_stored_app_ui_preferences(preferences: StoredAppUiPreferences) -> AppUiPreferences {
    AppUiPreferences {
        player_volume: normalize_player_volume(preferences.player_volume),
        player_speed: normalize_player_speed(preferences.player_speed),
        spoiler_protection: preferences.spoiler_protection.unwrap_or(false),
        subtitle_delay: normalize_subtitle_delay(preferences.subtitle_delay),
        subtitle_pos: normalize_subtitle_pos(preferences.subtitle_pos),
        subtitle_scale: normalize_subtitle_scale(preferences.subtitle_scale),
        auto_play_next: preferences.auto_play_next.unwrap_or(false),
        // Missing key = a store written before the toggle shipped — keep
        // previews on, matching the behavior that store was used with.
        trailer_previews: preferences.trailer_previews.unwrap_or(true),
        // Opt-in: missing keys on old stores keep auto-skip off.
        auto_skip_intro: preferences.auto_skip_intro.unwrap_or(false),
    }
}

/// Lenient decode shared by the store loaders and backup restore: stored
/// blobs and backup files are both untrusted JSON.
pub(crate) fn parse_profile_preferences(value: Value) -> Option<ProfilePreferences> {
    serde_json::from_value::<StoredProfilePreferences>(value)
        .ok()
        .map(normalize_stored_profile_preferences)
}

pub(crate) fn parse_app_ui_preferences(value: Value) -> Option<AppUiPreferences> {
    serde_json::from_value::<StoredAppUiPreferences>(value)
        .ok()
        .map(normalize_stored_app_ui_preferences)
}

pub(crate) fn parse_stream_selector_preferences(value: Value) -> Option<StreamSelectorPreferences> {
    serde_json::from_value::<StoredStreamSelectorPreferences>(value)
        .ok()
        .map(normalize_stored_stream_selector_preferences)
}

pub(crate) fn load_profile_preferences(store: &DurableStore) -> ProfilePreferences {
    store
        .get(PROFILE_PREFERENCES_KEY)
        .and_then(parse_profile_preferences)
        .unwrap_or_default()
}

pub(crate) fn load_app_ui_preferences(store: &DurableStore) -> AppUiPreferences {
    store
        .get(APP_UI_PREFERENCES_KEY)
        .and_then(parse_app_ui_preferences)
        .unwrap_or_default()
}

pub(crate) fn load_last_notified_app_update_version(store: &DurableStore) -> Option<String> {
    store
        .get(LAST_NOTIFIED_APP_UPDATE_VERSION_KEY)
        .and_then(|value| value.as_str().map(str::to_string))
        .and_then(|value| normalize_last_notified_app_update_version(Some(value)))
}

pub(crate) fn save_profile_preferences_to_store(
    store: &DurableStore,
    preferences: &ProfilePreferences,
) {
    store.set(PROFILE_PREFERENCES_KEY, serde_json::json!(preferences));
}

pub(crate) fn save_app_ui_preferences_to_store(
    store: &DurableStore,
    preferences: &AppUiPreferences,
) {
    store.set(APP_UI_PREFERENCES_KEY, serde_json::json!(preferences));
}

/// Returns whether the store actually changed so callers can skip the
/// disk write on a no-op clear (the common "still up to date" path).
pub(crate) fn save_last_notified_app_update_version_to_store(
    store: &DurableStore,
    version: Option<String>,
) -> bool {
    if let Some(version) = normalize_last_notified_app_update_version(version) {
        store.set(
            LAST_NOTIFIED_APP_UPDATE_VERSION_KEY,
            serde_json::json!(version),
        );
        true
    } else {
        store.delete(LAST_NOTIFIED_APP_UPDATE_VERSION_KEY)
    }
}

fn normalize_stream_selector_quality(value: Option<&str>) -> StreamSelectorQuality {
    match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("4k") => StreamSelectorQuality::P2160,
        Some("1080p") => StreamSelectorQuality::P1080,
        Some("720p") => StreamSelectorQuality::P720,
        Some("sd") => StreamSelectorQuality::Sd,
        _ => StreamSelectorQuality::All,
    }
}

fn normalize_stream_selector_source(value: Option<&str>) -> StreamSelectorSource {
    match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("cached") => StreamSelectorSource::Cached,
        _ => StreamSelectorSource::All,
    }
}

fn normalize_stream_selector_sort(value: Option<&str>) -> StreamSelectorSort {
    match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("quality") => StreamSelectorSort::Quality,
        Some("seeds") => StreamSelectorSort::Seeds,
        _ => StreamSelectorSort::Smart,
    }
}

fn normalize_stream_selector_batch(value: Option<&str>) -> StreamSelectorBatch {
    match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("episodes") => StreamSelectorBatch::Episodes,
        Some("packs") => StreamSelectorBatch::Packs,
        _ => StreamSelectorBatch::All,
    }
}

fn normalize_stream_selector_addon(value: Option<String>) -> String {
    let normalized = value
        .as_deref()
        .and_then(|value| trim_to_max(value, STREAM_SELECTOR_ADDON_MAX_CHARS))
        .unwrap_or_else(|| "all".to_string());

    if normalized.eq_ignore_ascii_case("all") {
        "all".to_string()
    } else {
        normalized
    }
}

pub(crate) fn sanitize_stream_selector_preferences(
    preferences: StreamSelectorPreferences,
) -> StreamSelectorPreferences {
    StreamSelectorPreferences {
        quality: preferences.quality,
        source: preferences.source,
        addon: normalize_stream_selector_addon(Some(preferences.addon)),
        sort: preferences.sort,
        batch: preferences.batch,
    }
}

fn normalize_stored_stream_selector_preferences(
    preferences: StoredStreamSelectorPreferences,
) -> StreamSelectorPreferences {
    StreamSelectorPreferences {
        quality: normalize_stream_selector_quality(preferences.quality.as_deref()),
        source: normalize_stream_selector_source(preferences.source.as_deref()),
        addon: normalize_stream_selector_addon(preferences.addon),
        sort: normalize_stream_selector_sort(preferences.sort.as_deref()),
        batch: normalize_stream_selector_batch(preferences.batch.as_deref()),
    }
}

/// One store read for the `(preferences, initialized)` pair the getter
/// command returns — the two halves share the same key.
pub(crate) fn load_stream_selector_preferences_state(
    store: &DurableStore,
) -> (StreamSelectorPreferences, bool) {
    let stored = store.get(STREAM_SELECTOR_PREFERENCES_KEY);
    let initialized = stored.is_some();
    let preferences = stored
        .and_then(parse_stream_selector_preferences)
        .unwrap_or_default();
    (preferences, initialized)
}

pub(crate) fn save_stream_selector_preferences_to_store(
    store: &DurableStore,
    preferences: &StreamSelectorPreferences,
) {
    store.set(
        STREAM_SELECTOR_PREFERENCES_KEY,
        serde_json::json!(preferences),
    );
}

pub(crate) fn get_trimmed_store_string(store: &DurableStore, key: &str) -> Option<String> {
    store
        .get(key)
        .and_then(|value| value.as_str().map(|item| item.trim().to_string()))
        .filter(|value| !value.is_empty())
}

fn strip_ascii_prefix_ignore_case<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    let prefix_len = prefix.len();
    if value.len() >= prefix_len
        && value.is_char_boundary(prefix_len)
        && value[..prefix_len].eq_ignore_ascii_case(prefix)
    {
        Some(&value[prefix_len..])
    } else {
        None
    }
}

fn rewrite_stremio_install_reference(trimmed: &str) -> Result<String, String> {
    let Some(rest) = strip_ascii_prefix_ignore_case(trimmed, "stremio://") else {
        if trimmed.contains("://") {
            return Ok(trimmed.to_string());
        }
        return Ok(format!("https://{trimmed}"));
    };

    if strip_ascii_prefix_ignore_case(rest, "https://").is_some()
        || strip_ascii_prefix_ignore_case(rest, "http://").is_some()
    {
        return Ok(rest.to_string());
    }

    if rest.contains("://") {
        return Err("Addon URL must start with http://, https://, or stremio://".to_string());
    }

    Ok(format!("https://{rest}"))
}

pub(crate) fn normalize_addon_url(config: &str) -> Result<Option<String>, String> {
    let trimmed = config.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let candidate = rewrite_stremio_install_reference(trimmed)?;

    let mut parsed = reqwest::Url::parse(&candidate).map_err(|_| {
        "Invalid addon URL. Please provide a valid http(s) or stremio:// URL.".to_string()
    })?;

    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("Addon URL must start with http://, https://, or stremio://".to_string());
    }

    if parsed.host_str().is_none() {
        return Err("Addon URL must include a valid host.".to_string());
    }

    // Addon URLs persist in the registry and travel in diagnostics: strip
    // embedded credentials instead of storing them. Query/path config data
    // is preserved; only the userinfo authority section is purged.
    if !parsed.username().is_empty() || parsed.password().is_some() {
        parsed.set_username("").ok();
        parsed.set_password(None).ok();
    }

    parsed.set_fragment(None);

    let normalized_path = strip_manifest_suffix(parsed.path()).to_string();

    if normalized_path.is_empty() {
        parsed.set_path("/");
    } else {
        parsed.set_path(&normalized_path);
    }

    let mut normalized = parsed.to_string();
    if normalized.ends_with('/') {
        normalized.pop();
    }

    // A serialized `Url` is never empty.
    Ok(Some(normalized))
}

fn normalize_loaded_addon_config(mut config: AddonConfig) -> Option<AddonConfig> {
    let url = normalize_addon_url(&config.url).ok().flatten()?;
    let fallback_name = reqwest::Url::parse(&url)
        .ok()
        .and_then(|value| value.host_str().map(|host| host.to_string()));

    config.id = normalize_non_empty(&config.id).unwrap_or_else(|| url.clone());
    config.name = normalize_non_empty(&config.name)
        .or(fallback_name)
        .unwrap_or_else(|| "Addon".to_string());
    config.url = url;
    if config
        .capabilities
        .as_ref()
        .is_some_and(|snapshot| !snapshot_is_classified(snapshot))
    {
        config.capabilities = None;
    }

    Some(config)
}

pub(crate) fn parse_stored_addon_configs(value: Value) -> Vec<AddonConfig> {
    match value {
        Value::Array(items) => items
            .into_iter()
            .filter_map(|item| serde_json::from_value::<AddonConfig>(item).ok())
            .collect(),
        _ => Vec::new(),
    }
}

fn normalize_loaded_addon_configs(configs: Vec<AddonConfig>) -> Vec<AddonConfig> {
    let mut normalized_configs = Vec::with_capacity(configs.len());
    let mut seen_urls = std::collections::HashSet::with_capacity(configs.len());
    let mut seen_ids = std::collections::HashSet::with_capacity(configs.len());

    for mut config in configs
        .into_iter()
        .filter_map(normalize_loaded_addon_config)
    {
        if !seen_urls.insert(config.url.clone()) {
            continue;
        }

        if !seen_ids.insert(config.id.clone()) {
            config.id = config.url.clone();
            if !seen_ids.insert(config.id.clone()) {
                continue;
            }
        }

        normalized_configs.push(config);
    }

    normalized_configs
}

fn default_addon_config(install_url: &str, name: &str) -> Option<AddonConfig> {
    let url = normalize_addon_url(install_url).ok().flatten()?;

    Some(AddonConfig {
        id: url.clone(),
        url,
        name: name.to_string(),
        enabled: true,
        capabilities: None,
    })
}

/// Default addons are pinned: each entry in `DEFAULT_ADDON_INSTALLS` always
/// occupies its index in the registry and cannot be removed. An explicit user
/// disable (`enabled: false`) is preserved; only the toggle is user-controlled.
fn pin_default_addons(mut configs: Vec<AddonConfig>) -> Vec<AddonConfig> {
    for (index, (install_url, name)) in DEFAULT_ADDON_INSTALLS.iter().enumerate() {
        let Some(default) = default_addon_config(install_url, name) else {
            continue;
        };
        // A stored copy keeps the user's toggle/name/snapshot; a missing one
        // is seeded enabled.
        let pinned = match configs.iter().position(|config| config.url == default.url) {
            Some(position) => configs.remove(position),
            None => default,
        };
        configs.insert(index.min(configs.len()), pinned);
    }
    configs
}

pub(crate) fn resolve_addon_configs(stored_configs: Option<Vec<AddonConfig>>) -> Vec<AddonConfig> {
    // A missing registry is first-run: normalizing an empty list is a no-op
    // and the pin pass seeds both defaults.
    pin_default_addons(normalize_loaded_addon_configs(
        stored_configs.unwrap_or_default(),
    ))
}

pub(crate) fn load_addon_configs(store: &DurableStore) -> Vec<AddonConfig> {
    if let Some(value) = store.get(ADDON_CONFIGS_KEY) {
        let stored_configs = parse_stored_addon_configs(value);
        return resolve_addon_configs(Some(stored_configs));
    }

    resolve_addon_configs(None)
}

pub(crate) fn save_addon_configs_to_store(store: &DurableStore, configs: &[AddonConfig]) {
    store.set(ADDON_CONFIGS_KEY, serde_json::json!(configs));
    // Bump after `set` so a reader that observes the new generation always
    // re-reads data that already includes this write.
    ADDON_CONFIGS_GENERATION.fetch_add(1, Ordering::SeqCst);
}

#[cfg(test)]
mod tests;
