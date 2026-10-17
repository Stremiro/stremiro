use super::{
    lenient_option, DurableStore, PROFILE_ACCENT_INTENSITY_DEFAULT, PROFILE_AVATAR_MAX_CHARS,
    PROFILE_AVATAR_PREFIXES, PROFILE_NAME_MAX_CHARS, PROFILE_PREFERENCES_KEY,
};
use crate::providers::bound_optional;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Which surfaces follow the profile accent — flags default on so pre-flag stores keep their look.
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

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePreferencesPatch {
    username: Option<String>,
    accent_color: Option<String>,
    accent_intensity: Option<u8>,
    accent_targets: Option<AccentTargetsPatch>,
    view_mode: Option<ProfileViewMode>,
}

#[derive(Debug, Deserialize)]
struct AccentTargetsPatch {
    navigation: Option<bool>,
    actions: Option<bool>,
    progress: Option<bool>,
    artwork: Option<bool>,
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
pub(super) struct StoredProfilePreferences {
    #[serde(default, deserialize_with = "lenient_option")]
    profile: Option<StoredLocalProfile>,
    #[serde(default, deserialize_with = "lenient_option")]
    view_mode: Option<String>,
}

fn normalize_profile_username(value: Option<String>) -> String {
    bound_optional(value, PROFILE_NAME_MAX_CHARS)
        .unwrap_or_else(|| LocalProfile::default().username)
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
    match value.map(str::trim) {
        Some(value) if value.eq_ignore_ascii_case("list") => ProfileViewMode::List,
        _ => ProfileViewMode::Grid,
    }
}

// Missing flags default on — a pre-flag store keeps the behavior it was used with.
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

pub(crate) fn normalize_profile_avatar(value: Option<String>) -> Option<String> {
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

pub(crate) fn apply_profile_preferences_patch(
    mut current: ProfilePreferences,
    patch: ProfilePreferencesPatch,
) -> ProfilePreferences {
    let profile = &mut current.profile;
    if let Some(value) = patch.username {
        profile.username = value;
    }
    if let Some(value) = patch.accent_color {
        profile.accent_color = value;
    }
    if let Some(value) = patch.accent_intensity {
        profile.accent_intensity = value;
    }
    if let Some(targets) = patch.accent_targets {
        profile.accent_targets = AccentTargets {
            navigation: targets
                .navigation
                .unwrap_or(profile.accent_targets.navigation),
            actions: targets.actions.unwrap_or(profile.accent_targets.actions),
            progress: targets.progress.unwrap_or(profile.accent_targets.progress),
            artwork: targets.artwork.unwrap_or(profile.accent_targets.artwork),
        };
    }
    if let Some(value) = patch.view_mode {
        current.view_mode = value;
    }
    sanitize_profile_preferences(current)
}

pub(super) fn normalize_stored_profile_preferences(
    preferences: StoredProfilePreferences,
) -> ProfilePreferences {
    ProfilePreferences {
        profile: normalize_stored_local_profile(preferences.profile),
        view_mode: normalize_profile_view_mode(preferences.view_mode.as_deref()),
    }
}

/// Lenient decode shared by store loaders and backup restore — both are untrusted JSON.
pub(crate) fn parse_profile_preferences(value: Value) -> Option<ProfilePreferences> {
    serde_json::from_value::<StoredProfilePreferences>(value)
        .ok()
        .map(normalize_stored_profile_preferences)
}

pub(crate) fn load_profile_preferences(store: &DurableStore) -> ProfilePreferences {
    store
        .get(PROFILE_PREFERENCES_KEY)
        .and_then(parse_profile_preferences)
        .unwrap_or_default()
}

pub(crate) fn save_profile_preferences_to_store(
    store: &DurableStore,
    preferences: &ProfilePreferences,
) {
    store.set(PROFILE_PREFERENCES_KEY, serde_json::json!(preferences));
}
