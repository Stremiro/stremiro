use super::{
    normalize_addon_url, parse_stored_addon_configs, sanitize_app_ui_preferences,
    sanitize_local_profile, sanitize_profile_preferences, sanitize_stream_selector_preferences,
    AccentTargets, AddonConfig, AddonConfigView, AppUiPreferences, LocalProfile,
    ProfilePreferences, ProfileViewMode, StreamSelectorBatch, StreamSelectorPreferences,
    StreamSelectorQuality, StreamSelectorSort, StreamSelectorSource,
};
use std::collections::BTreeMap;

#[test]
fn profile_patches_preserve_unedited_fields_and_merge_target_flags() {
    let patch = |value| serde_json::from_value::<super::ProfilePreferencesPatch>(value).unwrap();
    let current = ProfilePreferences {
        profile: LocalProfile {
            username: "Saved User".into(),
            avatar: Some("data:image/png;base64,AAAA".into()),
            accent_targets: AccentTargets {
                navigation: false,
                ..AccentTargets::default()
            },
            ..LocalProfile::default()
        },
        view_mode: ProfileViewMode::Grid,
    };
    assert_eq!(
        super::apply_profile_preferences_patch(current.clone(), patch(serde_json::json!({}))),
        current
    );
    let saved = super::apply_profile_preferences_patch(
        current.clone(),
        patch(serde_json::json!({
            "accentColor": " #ABCDEF ", "accentTargets": {"actions":false, "skip":false}, "viewMode":"list"
        })),
    );
    assert_eq!(saved.profile.username, current.profile.username);
    assert_eq!(saved.profile.avatar, current.profile.avatar);
    assert_eq!(saved.profile.accent_color, "#abcdef");
    assert!(!saved.profile.accent_targets.navigation);
    assert!(!saved.profile.accent_targets.actions);
    assert!(!saved.profile.accent_targets.skip);
    assert!(saved.profile.accent_targets.progress);
    assert_eq!(saved.view_mode, ProfileViewMode::List);
    let saved = super::apply_profile_preferences_patch(
        saved,
        patch(serde_json::json!({"username":"Next User"})),
    );
    assert_eq!(saved.profile.accent_color, "#abcdef");
    assert!(!saved.profile.accent_targets.actions);
    assert!(!saved.profile.accent_targets.skip);
    assert_eq!(saved.view_mode, ProfileViewMode::List);
}

#[test]
fn profile_patches_ignore_legacy_avatar_fields() {
    let patch = |value| serde_json::from_value::<super::ProfilePreferencesPatch>(value).unwrap();
    let current = ProfilePreferences {
        profile: LocalProfile {
            avatar: Some("data:image/png;base64,AAAA".into()),
            ..LocalProfile::default()
        },
        ..ProfilePreferences::default()
    };
    for edit in [
        serde_json::json!({"viewMode":"list"}),
        serde_json::json!({"avatar":null}),
        serde_json::json!({"avatar":"data:image/webp;base64,BBBB"}),
        serde_json::json!({"avatar":"https://example.com/avatar.png"}),
        serde_json::json!({"avatar":false}),
    ] {
        let saved = super::apply_profile_preferences_patch(current.clone(), patch(edit));
        assert_eq!(saved.profile.avatar, current.profile.avatar);
    }
    for invalid in [
        serde_json::json!({"accentIntensity":256}),
        serde_json::json!({"accentTargets":{"actions":"false"}}),
    ] {
        assert!(serde_json::from_value::<super::ProfilePreferencesPatch>(invalid).is_err());
    }
}

#[test]
fn legacy_settings_avatar_moves_to_its_own_store_before_settings_drop_it() {
    let read_file = |path: &std::path::Path| -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    };
    let with_avatar = |avatar: &str| ProfilePreferences {
        profile: LocalProfile {
            username: "Saved User".into(),
            avatar: Some(avatar.into()),
            ..LocalProfile::default()
        },
        ..ProfilePreferences::default()
    };
    let legacy = with_avatar("data:image/png;base64,AAAA");
    let settings = crate::test_helpers::test_store();
    let avatars = crate::test_helpers::test_store();
    settings
        .store
        .set(super::PROFILE_PREFERENCES_KEY, serde_json::json!(legacy));
    settings.store.save().unwrap();

    let load = || super::load_profile_preferences(&settings.store, &avatars.store);
    assert_eq!(load(), legacy);
    assert_eq!(
        read_file(&avatars.path),
        serde_json::json!({"avatar": "data:image/png;base64,AAAA"})
    );
    let profile = &read_file(&settings.path)["profile_preferences"]["profile"];
    assert_eq!(profile["username"], "Saved User");
    assert!(profile.get("avatar").is_none());

    // A crash between the two commits leaves a stale settings copy; the avatar store wins.
    settings.store.set(
        super::PROFILE_PREFERENCES_KEY,
        serde_json::json!(with_avatar("data:image/png;base64,BBBB")),
    );
    assert_eq!(load(), legacy);
    assert!(read_file(&settings.path)["profile_preferences"]["profile"]
        .get("avatar")
        .is_none());

    settings.store.set(
        "last_notified_app_update_version",
        serde_json::json!("1.0.0"),
    );
    settings.store.save().unwrap();
    assert!(!std::fs::read_to_string(&settings.path)
        .unwrap()
        .contains("base64"));
    let reopen = |path: &std::path::Path| {
        crate::commands::DurableStoreRegistry::default()
            .open_path(path.to_path_buf())
            .unwrap()
    };
    assert_eq!(
        super::load_profile_preferences(&reopen(&settings.path), &reopen(&avatars.path)),
        legacy
    );
}

#[test]
fn backup_profile_round_trip_restores_the_avatar_into_its_store() {
    let avatar = "data:image/webp;base64,UklGRg==";
    let preferences = ProfilePreferences {
        profile: LocalProfile {
            avatar: Some(avatar.into()),
            ..LocalProfile::default()
        },
        view_mode: ProfileViewMode::List,
    };
    let settings = crate::test_helpers::test_store();
    let avatars = crate::test_helpers::test_store();
    super::save_profile_preferences_to_store(&settings.store, &avatars.store, &preferences)
        .unwrap();
    let exported = serde_json::json!(super::load_profile_preferences(
        &settings.store,
        &avatars.store
    ));
    assert_eq!(exported["profile"]["avatar"], avatar);

    let restored_settings = crate::test_helpers::test_store();
    let restored_avatars = crate::test_helpers::test_store();
    let restore = |value: serde_json::Value| {
        super::save_profile_preferences_to_store(
            &restored_settings.store,
            &restored_avatars.store,
            &super::parse_profile_preferences(value).unwrap(),
        )
        .unwrap();
        super::load_profile_preferences(&restored_settings.store, &restored_avatars.store)
    };
    assert_eq!(restore(exported), preferences);
    assert!(restored_settings
        .store
        .get(super::PROFILE_PREFERENCES_KEY)
        .unwrap()["profile"]
        .get("avatar")
        .is_none());
    assert_eq!(
        restore(serde_json::json!({"profile": {}})).profile.avatar,
        None
    );
    assert!(restored_avatars
        .store
        .get(super::PROFILE_AVATAR_KEY)
        .is_none());
    #[cfg(windows)]
    for replacement in [Some(avatar.to_string()), None] {
        use std::os::windows::fs::OpenOptionsExt;

        let settings = crate::test_helpers::test_store();
        let avatars = crate::test_helpers::test_store();
        let legacy = ProfilePreferences {
            profile: LocalProfile {
                avatar: Some("data:image/png;base64,AAAA".into()),
                ..LocalProfile::default()
            },
            ..ProfilePreferences::default()
        };
        let expected = serde_json::json!(legacy);
        settings
            .store
            .set(super::PROFILE_PREFERENCES_KEY, expected.clone());
        settings.store.save().unwrap();
        avatars.store.set(
            super::PROFILE_AVATAR_KEY,
            serde_json::json!(legacy.profile.avatar),
        );
        avatars.store.save().unwrap();
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&avatars.path)
            .unwrap();
        let updated = ProfilePreferences {
            profile: LocalProfile {
                avatar: replacement,
                ..legacy.profile
            },
            ..legacy
        };
        assert!(super::save_profile_preferences_to_store(
            &settings.store,
            &avatars.store,
            &updated,
        )
        .is_err());
        assert_eq!(
            settings.store.get(super::PROFILE_PREFERENCES_KEY),
            Some(expected.clone())
        );
        settings.store.save().unwrap();
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&settings.path).unwrap()).unwrap();
        assert_eq!(saved[super::PROFILE_PREFERENCES_KEY], expected);
        drop(held);
        super::save_profile_preferences_to_store(&settings.store, &avatars.store, &updated)
            .unwrap();
        settings.store.save().unwrap();
        assert_eq!(
            super::load_profile_preferences(&settings.store, &avatars.store),
            updated
        );
    }
}
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
    assert!(value.get("url").is_none());
    assert!(value.get("capabilities").is_none());
    let display = value["displayUrl"].as_str().expect("displayUrl present");
    assert!(!display.contains("sekrit") && !display.contains("user:pass"));
    assert_eq!(display, "•••@addon.example/•••/config?token=•••");

    for (url, expected) in [
        (
            "https://addon.example/manifest.json?credential=demo-secret&mode=fast",
            "addon.example/manifest.json?credential=•••&mode=•••",
        ),
        (
            "https://addon.example/%7B%22credential%22%3A%22demo-secret%22%7D/manifest.json",
            "addon.example/•••/manifest.json",
        ),
    ] {
        let mut config = crate::test_helpers::cinemeta_addon();
        config.url = url.to_string();
        assert_eq!(AddonConfigView::from_config(config).display_url, expected);
    }
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
    let stored = parse_stored_addon_configs(&serde_json::json!([
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
fn addon_identity_projection_matches_full_load_with_capabilities_and_malformed_siblings() {
    let fixture = crate::test_helpers::test_store();
    let capabilities = serde_json::to_value(crate::test_helpers::cinemeta_manifest()).unwrap();
    let stored = serde_json::json!([
        {
            "id": " duplicate-id ", "url": "stremio://disabled.example/manifest.json",
            "name": " Disabled ", "enabled": false, "capabilities": capabilities
        },
        null,
        {"id": "missing-name", "url": "https://broken.example", "enabled": true},
        {"id": "bad-toggle", "url": "https://broken.example", "name": "Bad", "enabled": "false"},
        {
            "id": "duplicate-url", "url": "https://disabled.example/",
            "name": "Duplicate", "enabled": true, "capabilities": capabilities
        },
        {
            "id": "duplicate-id", "url": "https://other.example/manifest.json",
            "name": " ", "enabled": true, "capabilities": capabilities
        },
        {
            "id": "", "url": "https://malformed-capabilities.example/manifest.json",
            "name": "Malformed snapshot", "enabled": false, "capabilities": {"catalogs": false}
        },
        {
            "id": "stored-cinemeta", "url": super::DEFAULT_CINEMETA_INSTALL_URL,
            "name": " My Cinemeta ", "enabled": false, "capabilities": capabilities
        },
        {"id": "invalid-url", "url": "not a URL", "name": "Bad URL", "enabled": true}
    ]);
    fixture.store.set(super::ADDON_CONFIGS_KEY, stored.clone());
    let expected_configs: Vec<_> = stored
        .as_array()
        .unwrap()
        .iter()
        .cloned()
        .filter_map(|value| serde_json::from_value::<AddonConfig>(value).ok())
        .collect();
    assert_eq!(parse_stored_addon_configs(&stored), expected_configs);
    for record in [
        serde_json::json!([
            "array",
            "https://array.example",
            "Array",
            true,
            capabilities
        ]),
        serde_json::json!(["short", "https://array.example", "Short", false]),
        serde_json::json!(["broken", "https://array.example", "Broken", true, 42]),
        serde_json::json!(["invalid"]),
    ] {
        let expected: Vec<_> = serde_json::from_value::<AddonConfig>(record.clone())
            .into_iter()
            .collect();
        assert_eq!(
            parse_stored_addon_configs(&serde_json::json!([record])),
            expected
        );
    }
    let full = super::load_addon_configs(&fixture.store);
    assert!(full[0].capabilities.is_some());
    let full_views: Vec<_> = full
        .iter()
        .cloned()
        .map(AddonConfigView::from_config)
        .collect();
    let expected: Vec<_> = full
        .into_iter()
        .map(|mut config| {
            config.capabilities = None;
            config
        })
        .collect();
    let projected = AddonConfig::load_identities(&fixture.store);
    assert_eq!(projected, expected);
    assert_eq!(projected[0].id, "stored-cinemeta");
    assert!(!projected[0].enabled);
    assert_eq!(projected[0].name, "My Cinemeta");
    assert_eq!(projected[1].name, "OpenSubtitles");
    assert!(projected[1].enabled);
    assert_eq!(projected[2].id, "duplicate-id");
    assert!(!projected[2].enabled);
    assert_eq!(projected[3].id, "https://other.example");
    assert_eq!(projected[3].name, "other.example");
    assert_eq!(projected.len(), 5);
    let projected_views: Vec<_> = projected
        .into_iter()
        .map(AddonConfigView::from_config)
        .collect();
    assert_eq!(
        serde_json::to_value(projected_views).unwrap(),
        serde_json::to_value(full_views).unwrap()
    );
    assert_eq!(fixture.store.get(super::ADDON_CONFIGS_KEY), Some(stored));
}

#[test]
fn addon_identity_projection_matches_full_load_for_missing_or_invalid_registries() {
    let fixture = crate::test_helpers::test_store();
    for stored in [
        None,
        Some(serde_json::json!(null)),
        Some(serde_json::json!({"not": "an array"})),
        Some(serde_json::json!([])),
    ] {
        match stored {
            Some(value) => fixture.store.set(super::ADDON_CONFIGS_KEY, value),
            None => {
                fixture.store.delete(super::ADDON_CONFIGS_KEY);
            }
        }
        assert_eq!(
            AddonConfig::load_identities(&fixture.store),
            super::load_addon_configs(&fixture.store)
        );
    }
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
    let mut stored = serde_json::json!({
        "profile": {
            "username": "Streamer",
            "accentColor": "#abcdef",
            "accentIntensity": 60,
            "accentTargets": { "navigation": false, "artwork": "bogus" },
        },
        "viewMode": "grid",
    });

    let parsed = serde_json::from_value::<super::StoredProfilePreferences>(stored.clone())
        .map(super::normalize_stored_profile_preferences)
        .expect("partial targets payload parses");

    // Explicit false survives; missing or malformed flags fall back to on.
    assert!(!parsed.profile.accent_targets.navigation);
    assert!(parsed.profile.accent_targets.actions);
    assert!(parsed.profile.accent_targets.progress);
    assert!(parsed.profile.accent_targets.artwork);
    assert!(parsed.profile.accent_targets.skip);

    for (value, expected) in [
        (serde_json::json!(null), true),
        (serde_json::json!("bogus"), true),
        (serde_json::json!(false), false),
        (serde_json::json!(true), true),
    ] {
        stored["profile"]["accentTargets"]["skip"] = value;
        let parsed = super::parse_profile_preferences(stored.clone()).unwrap();
        assert_eq!(parsed.profile.accent_targets.skip, expected);
        assert_eq!(
            serde_json::to_value(parsed).unwrap()["profile"]["accentTargets"]["skip"],
            expected
        );
    }
}

#[test]
fn app_ui_automatic_update_checks_default_and_preserve_partial_patches() {
    for value in [
        serde_json::json!({}),
        serde_json::json!({"automaticUpdateChecks": "false"}),
        serde_json::json!({"automaticUpdateChecks": null}),
    ] {
        assert!(
            super::parse_app_ui_preferences(value)
                .unwrap()
                .automatic_update_checks
        );
    }
    let current = super::parse_app_ui_preferences(serde_json::json!({
        "automaticUpdateChecks": false, "playerVolume": 42
    }))
    .unwrap();
    assert!(!current.automatic_update_checks);
    let saved = super::apply_app_ui_preferences_patch(
        current,
        serde_json::from_value(serde_json::json!({"spoilerProtection": true})).unwrap(),
    );
    assert!(!saved.automatic_update_checks);
    assert_eq!(saved.player_volume, 42);
    let enabled = super::apply_app_ui_preferences_patch(
        saved,
        serde_json::from_value(serde_json::json!({"automaticUpdateChecks": true})).unwrap(),
    );
    assert!(enabled.automatic_update_checks);
    assert!(enabled.spoiler_protection);
    assert_eq!(enabled.player_volume, 42);
    assert!(serde_json::from_value::<super::AppUiPreferencesPatch>(
        serde_json::json!({"automaticUpdateChecks": "false"})
    )
    .is_err());
    let mut legacy = serde_json::to_value(AppUiPreferences::default()).unwrap();
    legacy
        .as_object_mut()
        .unwrap()
        .remove("automaticUpdateChecks");
    assert!(
        serde_json::from_value::<AppUiPreferences>(legacy)
            .unwrap()
            .automatic_update_checks
    );
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
fn selector_patch_initializes_media_defaults_before_applying_fields() {
    for (episode_context, expected_batch) in [
        (false, StreamSelectorBatch::All),
        (true, StreamSelectorBatch::Episodes),
    ] {
        let saved = super::apply_stream_selector_preferences_patch(
            StreamSelectorPreferences::default(),
            false,
            super::StreamSelectorPreferencesPatch {
                episode_context,
                quality: Some(StreamSelectorQuality::P1080),
                ..Default::default()
            },
        );
        assert_eq!(saved.quality, StreamSelectorQuality::P1080);
        assert_eq!(saved.batch, expected_batch);
        assert_eq!(saved.source, StreamSelectorSource::All);
        assert_eq!(saved.addon, "all");
        assert_eq!(saved.sort, StreamSelectorSort::Smart);
    }
    let saved = super::apply_stream_selector_preferences_patch(
        StreamSelectorPreferences::default(),
        false,
        serde_json::from_value(serde_json::json!({
            "episodeContext": true, "batch": "packs"
        }))
        .unwrap(),
    );
    assert_eq!(saved.batch, StreamSelectorBatch::Packs);
}

#[test]
fn selector_patches_merge_into_the_current_snapshot_and_sanitize() {
    let current = StreamSelectorPreferences {
        quality: StreamSelectorQuality::P2160,
        source: StreamSelectorSource::Cached,
        addon: "saved-addon".into(),
        sort: StreamSelectorSort::Seeds,
        batch: StreamSelectorBatch::Episodes,
    };
    let saved = super::apply_stream_selector_preferences_patch(
        current.clone(),
        true,
        serde_json::from_value(serde_json::json!({
            "episodeContext": true, "quality": "720p"
        }))
        .unwrap(),
    );
    assert_eq!(
        saved,
        StreamSelectorPreferences {
            quality: StreamSelectorQuality::P720,
            ..current
        }
    );
    let next = super::apply_stream_selector_preferences_patch(
        saved.clone(),
        true,
        serde_json::from_value(serde_json::json!({
            "episodeContext": false, "source": "all", "addon": " ALL ", "sort": "quality"
        }))
        .unwrap(),
    );
    assert_eq!(
        next,
        StreamSelectorPreferences {
            source: StreamSelectorSource::All,
            addon: "all".into(),
            sort: StreamSelectorSort::Quality,
            ..saved
        }
    );
}

#[test]
fn selector_patch_never_reinitializes_a_stored_batch() {
    for batch in [
        StreamSelectorBatch::All,
        StreamSelectorBatch::Episodes,
        StreamSelectorBatch::Packs,
    ] {
        for episode_context in [false, true] {
            let current = StreamSelectorPreferences {
                batch,
                ..Default::default()
            };
            let saved = super::apply_stream_selector_preferences_patch(
                current.clone(),
                true,
                super::StreamSelectorPreferencesPatch {
                    episode_context,
                    ..Default::default()
                },
            );
            assert_eq!(saved, current);
        }
    }
}

#[test]
fn sanitize_app_ui_preferences_clamps_runtime_values() {
    let preferences = sanitize_app_ui_preferences(AppUiPreferences {
        auto_play_next: false,
        auto_skip_intro: true,
        player_volume: 140,
        player_speed: 9.0,
        audio_delay: -9.04,
        night_mode: true,
        spoiler_protection: true,
        subtitle_delay: -9.04,
        subtitle_pos: 140.0,
        subtitle_scale: 12.0,
        trailer_previews: false,
        ..Default::default()
    });

    assert_eq!(preferences.player_volume, 100);
    assert_eq!(preferences.player_speed, 4.0);
    assert_eq!(preferences.audio_delay, -5.0);
    assert!(preferences.night_mode);
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
    assert_eq!(parsed.audio_delay, 0.0);
    assert!(!parsed.night_mode);
    assert_eq!(parsed.subtitle_delay, 0.0);
    assert_eq!(parsed.subtitle_pos, 100.0);
    assert_eq!(parsed.subtitle_scale, 1.0);
    // Stores written before the toggle shipped keep previews on.
    assert!(parsed.trailer_previews);
    // Opt-in: stores written before auto-skip shipped keep it off.
    assert!(!parsed.auto_skip_intro);
    assert!(!parsed.close_to_tray);
    assert!(!parsed.start_minimized);
    assert_eq!(parsed.startup_page, super::StartupPage::Home);
    assert_eq!(parsed.last_location, None);
}

#[test]
fn app_ui_preferences_patch_quantizes_subtitle_tuning() {
    let patched = super::apply_app_ui_preferences_patch(
        AppUiPreferences::default(),
        super::AppUiPreferencesPatch {
            subtitle_delay: Some(0.26),
            audio_delay: Some(0.26),
            night_mode: Some(true),
            subtitle_scale: Some(1.33),
            ..Default::default()
        },
    );

    // Same quanta as the renderer's apply-time clamp: 0.1s delay, 0.05 scale.
    assert_eq!(patched.subtitle_delay, 0.3);
    assert_eq!(patched.audio_delay, 0.3);
    assert!(patched.night_mode);
    assert_eq!(patched.subtitle_scale, 1.35);
    assert_eq!(
        super::parse_app_ui_preferences(serde_json::to_value(&patched).unwrap()),
        Some(patched)
    );
    for delay in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert_eq!(super::normalize_audio_delay(Some(delay)), 0.0);
    }
}

#[test]
fn player_timing_preferences_normalize_and_round_trip() {
    let legacy = super::parse_app_ui_preferences(serde_json::json!({
        "playerVolume": 42,
        "autoPlayNext": true,
    }))
    .unwrap();
    assert_eq!(legacy.next_episode_countdown_secs, 8);
    assert_eq!(legacy.controls_hide_delay_ms, 3000);
    assert_eq!(AppUiPreferences::default().next_episode_countdown_secs, 8);
    assert_eq!(AppUiPreferences::default().controls_hide_delay_ms, 3000);

    for (seconds, delay_ms) in [(5, 2000), (8, 3000), (10, 5000), (15, 8000), (30, 3000)] {
        let patch = serde_json::from_value(serde_json::json!({
            "nextEpisodeCountdownSecs": seconds,
            "controlsHideDelayMs": delay_ms,
        }))
        .unwrap();
        let patched = super::apply_app_ui_preferences_patch(legacy.clone(), patch);
        assert_eq!(patched.next_episode_countdown_secs, seconds);
        assert_eq!(patched.controls_hide_delay_ms, delay_ms);
        assert_eq!(patched.player_volume, 42);
        assert!(patched.auto_play_next);
        assert_eq!(
            super::parse_app_ui_preferences(serde_json::to_value(&patched).unwrap()).unwrap(),
            patched,
        );
        assert_eq!(
            super::apply_app_ui_preferences_patch(patched.clone(), Default::default()),
            patched,
        );
    }

    let patched = super::apply_app_ui_preferences_patch(
        legacy.clone(),
        super::AppUiPreferencesPatch {
            next_episode_countdown_secs: Some(7),
            controls_hide_delay_ms: Some(4000),
            ..Default::default()
        },
    );
    assert_eq!(patched, legacy);

    for (seconds, delay_ms) in [
        (serde_json::json!(0), serde_json::json!(u32::MAX)),
        (serde_json::json!(7), serde_json::json!(4000)),
        (serde_json::json!(-1), serde_json::json!(3.5)),
        (serde_json::json!("15"), serde_json::json!(null)),
    ] {
        let parsed = super::parse_app_ui_preferences(serde_json::json!({
            "playerVolume": 42,
            "autoPlayNext": true,
            "nextEpisodeCountdownSecs": seconds,
            "controlsHideDelayMs": delay_ms,
        }))
        .unwrap();
        assert_eq!(parsed, legacy);
    }
}

#[test]
fn shell_preferences_parse_and_patch_without_resetting_siblings() {
    let parsed = super::parse_app_ui_preferences(serde_json::json!({
        "playerVolume": 42,
        "closeToTray": true,
        "startMinimized": "yes",
        "startupPage": "unknown",
        "lastLocation": "/search?q=space"
    }))
    .unwrap();
    assert_eq!(parsed.player_volume, 42);
    assert!(parsed.close_to_tray);
    assert!(!parsed.start_minimized);
    assert_eq!(parsed.startup_page, super::StartupPage::Home);
    assert_eq!(parsed.last_location.as_deref(), Some("/search?q=space"));

    let patch = serde_json::from_value(serde_json::json!({
        "startMinimized": true,
        "startupPage": "lastVisited"
    }))
    .unwrap();
    let patched = super::apply_app_ui_preferences_patch(parsed, patch);
    assert!(patched.close_to_tray);
    assert!(patched.start_minimized);
    assert_eq!(patched.startup_page, super::StartupPage::LastVisited);
    assert_eq!(patched.last_location.as_deref(), Some("/search?q=space"));
    let clear = serde_json::from_value(serde_json::json!({ "lastLocation": null })).unwrap();
    assert_eq!(
        super::apply_app_ui_preferences_patch(patched, clear).last_location,
        None
    );
}

#[test]
fn player_keybindings_keep_known_actions_and_first_claim_per_key() {
    for (key, normalized) in [(" ", " "), ("K", "k"), ("ArrowRight", "arrowright")] {
        assert_eq!(
            super::normalize_player_binding_key(key),
            Ok(normalized.to_string())
        );
    }
    assert_eq!(
        super::normalize_player_binding_key("5"),
        Err("Number keys are reserved for seeking to a percentage.".to_string())
    );
    for key in ["", "Escape", "Tab", "   ", "\u{7}", "abcdefghijklmnopq"] {
        assert_eq!(
            super::normalize_player_binding_key(key),
            Err("This key can’t be assigned.".to_string())
        );
    }

    let parsed = super::parse_app_ui_preferences(serde_json::json!({
        "closeToTray": true,
        "playerKeybindings": {
            "togglePlay": [" ", "K", "p"],
            "toggleMute": ["k", "Escape", "5", "M"],
            "seekForward": ["ArrowRight", "   ", "\u{7}"],
            "dock": [],
            "deleteEverything": ["d"]
        }
    }))
    .unwrap();
    assert!(parsed.close_to_tray);
    let bindings = &parsed.player_keybindings;
    // Space survives as-is; extra keys past the per-action cap are dropped.
    assert_eq!(bindings["togglePlay"], vec![" ", "k"]);
    // `k` belongs to togglePlay (earlier action); Escape and digits stay fixed.
    assert_eq!(bindings["toggleMute"], vec!["m"]);
    assert_eq!(bindings["seekForward"], vec!["arrowright"]);
    // An explicit empty list is an intentional unbind, not a missing override.
    assert_eq!(bindings["dock"], Vec::<String>::new());
    assert!(!bindings.contains_key("deleteEverything"));

    let reset = serde_json::from_value(serde_json::json!({ "playerKeybindings": {} })).unwrap();
    let patched = super::apply_app_ui_preferences_patch(parsed, reset);
    assert!(patched.player_keybindings.is_empty());
    assert!(patched.close_to_tray);

    let malformed = super::parse_app_ui_preferences(serde_json::json!({
        "playerKeybindings": { "togglePlay": [1, 2] },
        "closeToTray": true
    }))
    .unwrap();
    assert!(malformed.player_keybindings.is_empty());
    assert!(malformed.close_to_tray);
}

#[test]
fn player_keybindings_resolution_claims_overrides_before_defaults() {
    let preferences = super::parse_app_ui_preferences(serde_json::json!({
        "playerKeybindings": {
            "toggleMute": ["k", "arrowleft"],
            "shortcuts": ["i"]
        }
    }))
    .unwrap();
    let view = super::AppUiPreferencesView::from_preferences(preferences);
    let effective = &view.effective_player_keybindings;
    assert_eq!(effective["toggleMute"], vec!["k", "arrowleft"]);
    assert_eq!(effective["togglePlay"], vec![" "]);
    assert_eq!(effective["seekBackward"], vec!["j"]);
    assert_eq!(effective["shortcuts"], vec!["i"]);
    assert!(effective["dock"].is_empty());
    assert_eq!(
        view.default_player_keybindings["togglePlay"],
        vec![" ", "k"]
    );
    assert_eq!(view.default_player_keybindings["dock"], vec!["i"]);

    let conflicting = BTreeMap::from([
        ("togglePlay".to_string(), vec!["p".to_string()]),
        (
            "toggleMute".to_string(),
            vec!["p".to_string(), "m".to_string()],
        ),
    ]);
    let effective = super::resolve_player_keybindings(&conflicting);
    assert_eq!(effective["togglePlay"], vec!["p"]);
    assert_eq!(effective["toggleMute"], vec!["m"]);
}

#[test]
fn player_keybindings_bind_validates_the_entire_override_map() {
    for overrides in [
        BTreeMap::from([("unknown".to_string(), vec![])]),
        BTreeMap::from([("toggleMute".to_string(), vec!["p".to_string(); 3])]),
        BTreeMap::from([("toggleMute".to_string(), vec!["x".repeat(17)])]),
        BTreeMap::from([("toggleMute".to_string(), vec!["escape".to_string()])]),
        (0..23).map(|index| (index.to_string(), vec![])).collect(),
    ] {
        assert!(super::bind_player_key(overrides, "togglePlay", 0, None).is_err());
    }
    let overrides = super::keybindings::PLAYER_KEYBINDING_ACTIONS
        .iter()
        .map(|(action, _)| (action.to_string(), vec![]))
        .collect();
    assert!(super::bind_player_key(overrides, "togglePlay", 0, None).is_ok());
    let overrides = BTreeMap::from([("toggleMute".to_string(), vec!["P".to_string()])]);
    let moved = super::bind_player_key(overrides, "togglePlay", 0, Some("p")).unwrap();
    assert!(moved["toggleMute"].is_empty());
    assert_eq!(moved["togglePlay"][0], "p");
    assert!(
        super::bind_player_key(BTreeMap::new(), "togglePlay", 0, Some(&"x".repeat(17))).is_err()
    );
}

#[test]
fn player_keybindings_bind_moves_keys_and_keeps_first_duplicate() {
    let overrides = BTreeMap::from([(
        "toggleMute".to_string(),
        vec!["p".to_string(), "m".to_string()],
    )]);
    let moved = super::bind_player_key(overrides, "togglePlay", 1, Some("P")).unwrap();
    assert_eq!(moved["togglePlay"], vec![" ", "p"]);
    assert_eq!(moved["toggleMute"], vec!["m"]);
    let deduped = super::bind_player_key(moved, "togglePlay", 0, Some("p")).unwrap();
    assert_eq!(deduped["togglePlay"], vec!["p"]);
    let effective = super::resolve_player_keybindings(&deduped);
    assert_eq!(effective["togglePlay"], vec!["p"]);
    assert_eq!(effective["toggleMute"], vec!["m"]);
}

#[test]
fn player_keybindings_bind_clears_slots_and_removes_default_overrides() {
    let cleared = super::bind_player_key(BTreeMap::new(), "togglePlay", 0, None).unwrap();
    assert_eq!(cleared["togglePlay"], vec!["k"]);
    let unbound = super::bind_player_key(cleared, "togglePlay", 0, None).unwrap();
    assert!(unbound["togglePlay"].is_empty());
    let first = super::bind_player_key(unbound, "togglePlay", 0, Some(" ")).unwrap();
    let reset = super::bind_player_key(first, "togglePlay", 1, Some("K")).unwrap();
    assert!(reset.is_empty());
    assert_eq!(
        super::bind_player_key(BTreeMap::new(), "unknown", 0, Some("p")).unwrap_err(),
        "Unknown player action."
    );
    assert_eq!(
        super::bind_player_key(BTreeMap::new(), "togglePlay", 0, Some("5")).unwrap_err(),
        "Number keys are reserved for seeking to a percentage."
    );
}

#[test]
fn player_keybindings_resolution_keeps_empty_overrides_until_reset() {
    let preferences = super::parse_app_ui_preferences(serde_json::json!({
        "playerKeybindings": { "togglePlay": [], "toggleMute": ["k"] }
    }))
    .unwrap();
    let view = super::AppUiPreferencesView::from_preferences(preferences);
    assert!(view.effective_player_keybindings["togglePlay"].is_empty());
    assert_eq!(view.effective_player_keybindings["toggleMute"], vec!["k"]);

    let per_action_reset = serde_json::from_value(serde_json::json!({
        "playerKeybindings": { "toggleMute": ["k"] }
    }))
    .unwrap();
    let preferences = super::apply_app_ui_preferences_patch(view.preferences, per_action_reset);
    let view = super::AppUiPreferencesView::from_preferences(preferences);
    assert_eq!(view.effective_player_keybindings["togglePlay"], vec![" "]);
    assert_eq!(view.effective_player_keybindings["toggleMute"], vec!["k"]);

    let reset = serde_json::from_value(serde_json::json!({ "playerKeybindings": {} })).unwrap();
    let preferences = super::apply_app_ui_preferences_patch(view.preferences, reset);
    let view = super::AppUiPreferencesView::from_preferences(preferences);
    assert_eq!(
        view.effective_player_keybindings,
        view.default_player_keybindings
    );
    assert_eq!(view.effective_player_keybindings.len(), 20);
}

#[test]
fn player_keybindings_resolution_fields_are_response_only() {
    let preferences = AppUiPreferences::default();
    let stored = serde_json::to_value(&preferences).unwrap();
    assert!(stored.get("effectivePlayerKeybindings").is_none());
    assert!(stored.get("defaultPlayerKeybindings").is_none());

    let patch = serde_json::from_value(serde_json::json!({
        "effectivePlayerKeybindings": { "togglePlay": ["p"] },
        "defaultPlayerKeybindings": { "togglePlay": ["p"] }
    }))
    .unwrap();
    let preferences = super::apply_app_ui_preferences_patch(preferences, patch);
    let view = super::AppUiPreferencesView::from_preferences(preferences);
    assert_eq!(
        view.effective_player_keybindings,
        view.default_player_keybindings
    );
    let response = serde_json::to_value(view).unwrap();
    assert_eq!(response["playerVolume"], 75);
    assert_eq!(
        response["effectivePlayerKeybindings"]["togglePlay"],
        serde_json::json!([" ", "k"])
    );
    assert_eq!(
        response["defaultPlayerKeybindings"]["toggleMute"],
        serde_json::json!(["m"])
    );
    assert!(response.get("preferences").is_none());
}

#[test]
fn last_location_allows_only_bounded_app_routes() {
    for valid in [
        "/",
        "/search?q=space",
        "/details/series/tt123",
        "/profile?tab=library",
        "/library",
        "/calendar",
        "/settings?section=general",
    ] {
        assert_eq!(
            super::normalize_last_location(Some(valid.to_string())).as_deref(),
            Some(valid)
        );
    }
    for invalid in [
        "",
        "https://example.com",
        "//example.com",
        "/player/movie/tt123",
        "/library/../player",
        "/search?q=..",
        "/settings//general",
        "/library\n",
        "/\\example.com",
        "/unknown",
        &format!("/search?q={}", "a".repeat(503)),
    ] {
        let value = serde_json::json!({ "lastLocation": invalid, "closeToTray": true });
        let parsed = super::parse_app_ui_preferences(value).unwrap();
        assert_eq!(parsed.last_location, None, "{invalid:?}");
        assert!(parsed.close_to_tray);
        let patched = super::apply_app_ui_preferences_patch(
            AppUiPreferences::default(),
            super::AppUiPreferencesPatch {
                last_location: Some(Some(invalid.to_string())),
                ..Default::default()
            },
        );
        assert_eq!(patched.last_location, None);
    }
}

#[test]
fn startup_route_uses_only_valid_browse_locations() {
    for (page, route) in [
        (super::StartupPage::Home, None),
        (super::StartupPage::Library, Some("/library")),
        (super::StartupPage::Calendar, Some("/calendar")),
        (
            super::StartupPage::LastVisited,
            Some("/settings?section=general"),
        ),
    ] {
        let preferences = AppUiPreferences {
            startup_page: page,
            last_location: Some("/settings?section=general".to_string()),
            ..Default::default()
        };
        assert_eq!(super::startup_route(preferences).as_deref(), route);
    }
    for location in [
        None,
        Some("/player/movie/tt123"),
        Some("//example.com"),
        Some("/library/%2e%2E/player/movie/tt123"),
        Some("/library/.%2e/player/movie/tt123"),
        Some("/library/%2e./player/movie/tt123"),
    ] {
        assert_eq!(
            super::startup_route(AppUiPreferences {
                startup_page: super::StartupPage::LastVisited,
                last_location: location.map(str::to_string),
                ..Default::default()
            }),
            None
        );
    }
}

#[test]
fn start_minimized_requires_login_or_a_tray_preference() {
    for launch_at_login in [false, true] {
        for close_to_tray in [false, true] {
            for minimize_to_tray in [false, true] {
                for start_minimized in [false, true] {
                    let mut preferences = AppUiPreferences {
                        start_minimized,
                        close_to_tray,
                        minimize_to_tray,
                        ..Default::default()
                    };
                    super::normalize_start_minimized(&mut preferences, launch_at_login);
                    assert_eq!(
                        preferences.start_minimized,
                        start_minimized && (launch_at_login || close_to_tray || minimize_to_tray)
                    );
                }
            }
        }
    }
}

#[test]
fn resolve_addon_configs_drops_unclassified_stored_snapshots() {
    use crate::test_helpers::{cinemeta_addon, cinemeta_manifest};
    let mut nameless = cinemeta_manifest();
    nameless.name = " \t".into();
    let display_only = crate::providers::addon_manifest::AddonManifest {
        name: "Cinemeta".into(),
        resources: Vec::new(),
        catalogs: Vec::new(),
    };
    for snapshot in [nameless, display_only] {
        let resolved = super::resolve_addon_configs(Some(vec![AddonConfig {
            capabilities: Some(snapshot),
            ..cinemeta_addon()
        }]));
        assert_eq!(resolved.len(), 2);
        assert!(resolved[0].capabilities.is_none());
    }
}

#[test]
fn selector_addon_ids_are_preserved_without_truncation_or_aliasing() {
    let long_url_id = format!("https://addon.example/{}/manifest.json", "a".repeat(200));
    let max_id = "界".repeat(super::STREAM_SELECTOR_ADDON_MAX_CHARS);
    for (addon, expected) in [
        (long_url_id.clone(), long_url_id.clone()),
        (format!("  {long_url_id}  "), long_url_id),
        (max_id.clone(), max_id.clone()),
        (format!("{max_id}a"), "all".to_string()),
        (format!("{max_id}b"), "all".to_string()),
    ] {
        let sanitized = sanitize_stream_selector_preferences(StreamSelectorPreferences {
            addon: addon.clone(),
            ..Default::default()
        });
        assert_eq!(sanitized.addon, expected);
        let stored = super::parse_stream_selector_preferences(serde_json::json!({
            "addon": addon,
            "quality": "1080p",
        }))
        .unwrap();
        assert_eq!(stored.addon, expected);
        assert_eq!(stored.quality, StreamSelectorQuality::P1080);
    }
}
