use super::{
    normalize_addon_url, parse_stored_addon_configs, sanitize_app_ui_preferences,
    sanitize_local_profile, sanitize_profile_preferences, sanitize_stream_selector_preferences,
    AccentTargets, AddonConfig, AddonConfigView, AppUiPreferences, LocalProfile,
    ProfilePreferences, ProfileViewMode, StreamSelectorBatch, StreamSelectorPreferences,
    StreamSelectorQuality, StreamSelectorSort, StreamSelectorSource,
};

#[test]
fn addon_config_view_masks_credentials_and_keeps_manifest_rust_side() {
    let view = AddonConfigView::from_config(AddonConfig {
        id: "a1".to_string(),
        url: "https://user:pass@addon.example/AbCdEfGhIjKlMnOpQrStUvWxYz012345/config?token=sekrit"
            .to_string(),
        name: "My Addon".to_string(),
        enabled: true,
        capabilities: Some(crate::providers::addon_manifest::AddonManifest {
            name: "My Addon".to_string(),
            resources: Vec::new(),
            catalogs: Vec::new(),
        }),
    });

    let value = serde_json::to_value(&view).expect("serializable");
    assert_eq!(value["id"], "a1");
    assert_eq!(value["enabled"], true);
    assert_eq!(value["pinned"], false);
    assert!(value.get("capabilities").is_none());
    let display = value["displayUrl"].as_str().expect("displayUrl present");
    assert!(!display.contains("sekrit") && !display.contains("user:pass"));
    assert!(display.contains("[redacted]"));

    let cinemeta_url = normalize_addon_url(super::DEFAULT_CINEMETA_INSTALL_URL)
        .expect("valid default")
        .expect("non-empty default");
    let pinned = AddonConfigView::from_config(AddonConfig {
        id: cinemeta_url.clone(),
        url: cinemeta_url,
        name: "Cinemeta".to_string(),
        enabled: false,
        capabilities: None,
    });
    assert!(pinned.pinned);
}

#[test]
fn parse_stored_addon_configs_keeps_valid_siblings() {
    let stored = parse_stored_addon_configs(serde_json::json!([
        {
            "id": "https://v3-cinemeta.strem.io",
            "url": "https://v3-cinemeta.strem.io",
            "name": "Cinemeta",
            "enabled": true
        },
        {
            "id": "broken",
            "url": "https://broken.example",
            "enabled": true
        }
    ]));

    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].url, "https://v3-cinemeta.strem.io");
}

#[test]
fn normalize_addon_url_strips_embedded_userinfo_but_keeps_config() {
    let normalized =
        normalize_addon_url("https://user:pass@example.com/stremio/v1?token=abc/manifest.json")
            .expect("valid url")
            .expect("non-empty url");

    assert_eq!(
        normalized,
        "https://example.com/stremio/v1?token=abc/manifest.json"
    );
}

#[test]
fn sanitize_local_profile_trims_defaults_and_clamps_intensity() {
    let profile = sanitize_local_profile(LocalProfile {
        username: "   ".to_string(),
        accent_color: "not-a-color".to_string(),
        accent_intensity: 250,
        accent_targets: AccentTargets::default(),
        avatar: Some("https://example.com/avatar.png".to_string()),
    });

    assert_eq!(profile.username, "Guest User");
    assert_eq!(profile.accent_color, "#ffffff");
    assert_eq!(profile.accent_intensity, 100);
    assert_eq!(profile.accent_targets, AccentTargets::default());
    assert_eq!(profile.avatar, None);
}

#[test]
fn profile_avatar_accepts_only_bounded_base64_image_data_urls() {
    let avatar = |value: &str| super::normalize_profile_avatar(Some(value.to_string()));

    assert!(avatar("data:image/webp;base64,UklGRg==").is_some());
    assert!(avatar("data:image/jpeg;base64,/9j/4AAQ+w==").is_some());
    assert!(avatar("data:image/webp;base64,").is_none());
    assert!(avatar("data:image/svg+xml;base64,PHN2Zz4=").is_none());
    assert!(avatar("data:image/png;base64,iVBOR\"onerror=").is_none());
    let oversized = format!(
        "data:image/png;base64,{}",
        "A".repeat(super::PROFILE_AVATAR_MAX_CHARS)
    );
    assert!(avatar(&oversized).is_none());
}

#[test]
fn sanitize_profile_preferences_preserves_view_mode() {
    let preferences = sanitize_profile_preferences(ProfilePreferences {
        profile: LocalProfile {
            username: "  Streamer  ".to_string(),
            accent_color: "#ABCDEF".to_string(),
            accent_intensity: 40,
            accent_targets: AccentTargets {
                navigation: false,
                ..AccentTargets::default()
            },
            avatar: None,
        },
        view_mode: ProfileViewMode::List,
    });

    assert_eq!(preferences.profile.username, "Streamer");
    assert_eq!(preferences.profile.accent_color, "#abcdef");
    assert_eq!(preferences.profile.accent_intensity, 40);
    // Sanitize passes the typed flags through untouched.
    assert!(!preferences.profile.accent_targets.navigation);
    assert!(preferences.profile.accent_targets.actions);
    assert_eq!(preferences.view_mode, ProfileViewMode::List);
}

#[test]
fn stored_profile_ignores_legacy_bio_and_defaults_intensity() {
    let stored = serde_json::json!({
        "profile": {
            "username": "Streamer",
            "accentColor": "#ABCDEF",
            "bio": "legacy write-only field",
        },
        "viewMode": "grid",
    });

    let parsed = serde_json::from_value::<super::StoredProfilePreferences>(stored)
        .map(super::normalize_stored_profile_preferences)
        .expect("legacy bio payload parses");

    assert_eq!(parsed.profile.username, "Streamer");
    assert_eq!(parsed.profile.accent_color, "#abcdef");
    assert_eq!(
        parsed.profile.accent_intensity,
        super::PROFILE_ACCENT_INTENSITY_DEFAULT
    );
    // Stores written before tint targets existed keep every surface on.
    assert_eq!(parsed.profile.accent_targets, AccentTargets::default());
}

#[test]
fn stored_profile_accent_targets_default_per_flag() {
    let stored = serde_json::json!({
        "profile": {
            "username": "Streamer",
            "accentColor": "#abcdef",
            "accentIntensity": 60,
            "accentTargets": { "navigation": false, "artwork": "bogus" },
        },
        "viewMode": "grid",
    });

    let parsed = serde_json::from_value::<super::StoredProfilePreferences>(stored)
        .map(super::normalize_stored_profile_preferences)
        .expect("partial targets payload parses");

    // Explicit false survives; missing or malformed flags fall back to on.
    assert!(!parsed.profile.accent_targets.navigation);
    assert!(parsed.profile.accent_targets.actions);
    assert!(parsed.profile.accent_targets.progress);
    assert!(parsed.profile.accent_targets.artwork);
}

#[test]
fn stored_app_ui_preferences_drops_only_malformed_fields() {
    // One corrupt field must not reset every sibling preference — the
    // lenient per-field decode drops just the malformed value.
    let parsed = serde_json::from_value::<super::StoredAppUiPreferences>(serde_json::json!({
        "playerVolume": 73.4,
        "playerSpeed": 1.5,
        "spoilerProtection": true,
    }))
    .map(super::normalize_stored_app_ui_preferences)
    .expect("blob parses with a malformed field");

    assert_eq!(parsed.player_volume, super::PLAYER_VOLUME_DEFAULT);
    assert_eq!(parsed.player_speed, 1.5);
    assert!(parsed.spoiler_protection);
}

#[test]
fn sanitize_stream_selector_preferences_canonicalizes_addon_token() {
    let preferences = sanitize_stream_selector_preferences(StreamSelectorPreferences {
        quality: StreamSelectorQuality::P1080,
        source: StreamSelectorSource::Cached,
        addon: "  ALL  ".to_string(),
        sort: StreamSelectorSort::Seeds,
        batch: StreamSelectorBatch::Episodes,
    });

    assert_eq!(preferences.quality, StreamSelectorQuality::P1080);
    assert_eq!(preferences.source, StreamSelectorSource::Cached);
    assert_eq!(preferences.addon, "all");
    assert_eq!(preferences.sort, StreamSelectorSort::Seeds);
    assert_eq!(preferences.batch, StreamSelectorBatch::Episodes);
}

#[test]
fn sanitize_app_ui_preferences_clamps_runtime_values() {
    let preferences = sanitize_app_ui_preferences(AppUiPreferences {
        auto_play_next: false,
        auto_skip_intro: true,
        player_volume: 140,
        player_speed: 9.0,
        spoiler_protection: true,
        subtitle_delay: -9.04,
        subtitle_pos: 140.0,
        subtitle_scale: 12.0,
        trailer_previews: false,
    });

    assert_eq!(preferences.player_volume, 100);
    assert_eq!(preferences.player_speed, 4.0);
    assert!(preferences.spoiler_protection);
    assert_eq!(preferences.subtitle_delay, -5.0);
    assert_eq!(preferences.subtitle_pos, 100.0);
    assert_eq!(preferences.subtitle_scale, 3.0);
    assert!(preferences.auto_skip_intro);
}

#[test]
fn stored_app_ui_preferences_defaults_missing_subtitle_tuning() {
    // Stores written before subtitle tuning shipped carry none of the keys.
    let parsed = serde_json::from_value::<super::StoredAppUiPreferences>(serde_json::json!({
        "playerVolume": 80
    }))
    .map(super::normalize_stored_app_ui_preferences)
    .expect("legacy payload parses");

    assert_eq!(parsed.player_volume, 80);
    assert_eq!(parsed.subtitle_delay, 0.0);
    assert_eq!(parsed.subtitle_pos, 100.0);
    assert_eq!(parsed.subtitle_scale, 1.0);
    // Stores written before the toggle shipped keep previews on.
    assert!(parsed.trailer_previews);
    // Opt-in: stores written before auto-skip shipped keep it off.
    assert!(!parsed.auto_skip_intro);
}

#[test]
fn app_ui_preferences_patch_quantizes_subtitle_tuning() {
    let patched = super::apply_app_ui_preferences_patch(
        AppUiPreferences::default(),
        super::AppUiPreferencesPatch {
            subtitle_delay: Some(0.26),
            subtitle_scale: Some(1.33),
            ..Default::default()
        },
    );

    // Same quanta as the renderer's apply-time clamp: 0.1s delay, 0.05 scale.
    assert_eq!(patched.subtitle_delay, 0.3);
    assert_eq!(patched.subtitle_scale, 1.35);
}
