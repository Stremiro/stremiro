use super::{
    lenient_option, DurableStore, PROFILE_ACCENT_INTENSITY_DEFAULT, PROFILE_AVATAR_KEY,
    PROFILE_AVATAR_MAX_CHARS, PROFILE_AVATAR_PREFIXES, PROFILE_NAME_MAX_CHARS,
    PROFILE_PREFERENCES_KEY,
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
    pub skip: bool,
}

impl Default for AccentTargets {
    fn default() -> Self {
        Self {
            navigation: true,
            actions: true,
            progress: true,
            artwork: true,
            skip: true,
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

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePreferences {
    pub profile: LocalProfile,
    pub view_mode: ProfileViewMode,
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
    skip: Option<bool>,
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
    #[serde(default, deserialize_with = "lenient_option")]
    skip: Option<bool>,
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
        skip: targets.skip.unwrap_or(true),
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
        avatar: normalize_profile_avatar(profile.avatar),
        ..profile
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
        ..preferences
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
            skip: targets.skip.unwrap_or(profile.accent_targets.skip),
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

/// The avatar has its own store so frequent settings writes stay small. A legacy
/// settings copy moves once; settings drop it only after the avatar store committed.
pub(crate) fn load_profile_preferences(
    settings: &DurableStore,
    avatars: &DurableStore,
) -> ProfilePreferences {
    let mut preferences = settings
        .get_typed::<StoredProfilePreferences>(PROFILE_PREFERENCES_KEY)
        .map(normalize_stored_profile_preferences)
        .unwrap_or_default();
    let Some(legacy) = preferences.profile.avatar.take() else {
        preferences.profile.avatar =
            normalize_profile_avatar(avatars.get_typed(PROFILE_AVATAR_KEY));
        return preferences;
    };
    let stored = normalize_profile_avatar(avatars.get_typed(PROFILE_AVATAR_KEY));
    let mut migrated = stored.is_some();
    if !migrated {
        avatars.set(PROFILE_AVATAR_KEY, Value::String(legacy.clone()));
        migrated = avatars.save().is_ok();
        if !migrated {
            // Keep the unsaved copy out of memory so a later load still sees settings as the source.
            avatars.delete(PROFILE_AVATAR_KEY);
        }
    }
    preferences.profile.avatar = Some(stored.unwrap_or(legacy));
    if migrated {
        // A failed save leaves settings dirty for the exit flush; the avatar is already durable.
        if let Err(error) = save_profile_preferences_to_store(settings, avatars, &preferences)
            .and_then(|()| settings.save())
        {
            crate::operational_log::log_warn(
                "store",
                "profile-avatar-migration",
                "cleanup-failed",
                &[crate::operational_log::field("error", error)],
            );
        }
    } else {
        crate::operational_log::log_warn("store", "profile-avatar-migration", "deferred", &[]);
    }
    preferences
}

/// Commit the avatar before staging settings so failed saves cannot leave legacy removal dirty.
pub(crate) fn save_profile_preferences_to_store(
    settings: &DurableStore,
    avatars: &DurableStore,
    preferences: &ProfilePreferences,
) -> Result<(), String> {
    let mut value = serde_json::json!(preferences);
    let avatar = value
        .get_mut("profile")
        .and_then(Value::as_object_mut)
        .and_then(|profile| profile.remove("avatar"));
    // Rollback snapshot only when the avatar changes; it can be hundreds of KiB.
    let rollback = avatars.with_value(PROFILE_AVATAR_KEY, |stored| {
        (stored != avatar.as_ref()).then(|| stored.cloned())
    });
    match avatar {
        Some(avatar) => avatars.set(PROFILE_AVATAR_KEY, avatar),
        None => {
            avatars.delete(PROFILE_AVATAR_KEY);
        }
    }
    if let Err(error) = avatars.save() {
        match rollback {
            Some(Some(previous)) => avatars.set(PROFILE_AVATAR_KEY, previous),
            Some(None) => {
                avatars.delete(PROFILE_AVATAR_KEY);
            }
            None => {}
        }
        return Err(error);
    }
    settings.set(PROFILE_PREFERENCES_KEY, value);
    Ok(())
}
