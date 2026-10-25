use super::episode_mapping::{build_episode_mapping_snapshot, episode_mappings_digest};
use super::language_preferences::{
    merge_playback_language_preferences, PlaybackLanguagePreferencesSnapshot,
};
use super::playback_title_scope_key;
use super::stream_health::{
    accepts_outcome, load_source_health_snapshot, recent_successful_source,
    score_source_health_priority, score_stream_family_priority, update_verified_family_source_id,
    upsert_source_health_snapshot, PlaybackSourceHealthSnapshot, PlaybackStreamFamilySnapshot,
};
use super::{PlaybackStateService, PlaybackStreamOutcomeKind};
use crate::commands::stream_coordinator::{
    DEFAULT_SOURCE_HEALTH_PRIORITY, DEFAULT_STREAM_FAMILY_PRIORITY,
};
use crate::commands::{PlaybackLanguagePreferences, WatchProgress};
use crate::providers::Episode;
use crate::test_helpers::{test_episode, test_progress};

fn health(
    success: Option<u64>,
    failure: Option<u64>,
    failures: u32,
    cooldown: Option<u64>,
) -> PlaybackSourceHealthSnapshot {
    PlaybackSourceHealthSnapshot {
        last_success_at: success,
        last_failure_at: failure,
        consecutive_failures: failures,
        cooldown_until: cooldown,
    }
}

#[test]
fn least_active_eviction_preserves_original_order_for_recency_ties() {
    for (overflow, expected) in [
        (0, vec!["b", "a", "c", "d"]),
        (1, vec!["b", "a", "d"]),
        (2, vec!["a", "d"]),
        (4, vec![]),
    ] {
        let fixture = crate::test_helpers::test_store();
        let mut index: Vec<String> = ["b", "a", "c", "d"]
            .into_iter()
            .map(str::to_string)
            .collect();
        for key in &index {
            fixture.store.set(key.clone(), serde_json::json!(true));
        }
        let scored = index
            .iter()
            .enumerate()
            .map(|(ordinal, key)| (key.clone(), if key == "c" { 5 } else { 10 }, ordinal))
            .collect();
        super::evict_least_active(&fixture.store, &mut index, scored, overflow, str::to_string);
        assert_eq!(index, expected);
        for key in ["b", "a", "c", "d"] {
            assert_eq!(fixture.store.get(key).is_some(), expected.contains(&key));
        }
    }
}

#[test]
fn source_health_priority_penalizes_active_cooldown() {
    let now_ms = 10_000;
    let snapshot = health(Some(5_000), Some(9_000), 3, Some(20_000));

    assert_eq!(score_source_health_priority(Some(&snapshot), now_ms), 0);
}

#[test]
fn source_health_priority_penalizes_recent_repeat_failures() {
    let now_ms = 60_000;
    let snapshot = health(None, Some(55_000), 2, None);

    assert_eq!(score_source_health_priority(Some(&snapshot), now_ms), 1);
}

#[test]
fn source_health_priority_rewards_recent_success() {
    let now_ms = 60_000;
    let snapshot = health(Some(58_000), None, 0, None);

    assert_eq!(score_source_health_priority(Some(&snapshot), now_ms), 3);
}

#[test]
fn source_failure_streak_expires_before_the_next_failure() {
    let fixture = crate::test_helpers::test_store();
    let window_ms = 1000 * 60 * 30;
    for (key, gap_ms, expected_streak) in [
        ("at-window", window_ms, 2),
        ("after-window", window_ms + 1, 1),
    ] {
        upsert_source_health_snapshot(
            &fixture.store,
            key,
            PlaybackStreamOutcomeKind::LoadFailed,
            1_000,
            false,
        );
        let timestamp_ms = 1_000 + gap_ms;
        upsert_source_health_snapshot(
            &fixture.store,
            key,
            PlaybackStreamOutcomeKind::LoadFailed,
            timestamp_ms,
            false,
        );
        let snapshot = load_source_health_snapshot(&fixture.store, key).expect("source snapshot");
        assert_eq!(snapshot.last_failure_at, Some(timestamp_ms));
        assert_eq!(snapshot.consecutive_failures, expected_streak, "{key}");
        assert_eq!(
            snapshot.cooldown_until.is_some(),
            expected_streak >= 2,
            "{key}"
        );
        assert_eq!(
            score_source_health_priority(Some(&snapshot), timestamp_ms),
            if expected_streak >= 2 { 0 } else { 1 },
            "{key}"
        );
    }
}

#[test]
fn source_health_recovers_from_future_dated_reputation() {
    use super::stream_health::playback_source_health_item_key;

    let fixture = crate::test_helpers::test_store();
    let now_ms = crate::commands::now_unix_millis();
    let future_ms = now_ms + 24 * 60 * 60 * 1000;
    let key = "clock-corrected-source";
    let item_key = playback_source_health_item_key(key);
    for outcome in [
        PlaybackStreamOutcomeKind::Verified,
        PlaybackStreamOutcomeKind::LoadFailed,
    ] {
        let snapshot = health(
            Some(future_ms - 1),
            Some(future_ms),
            3,
            Some(future_ms + 900_000),
        );
        fixture.store.set(&item_key, serde_json::json!(snapshot));
        assert_eq!(
            score_source_health_priority(Some(&snapshot), now_ms),
            DEFAULT_SOURCE_HEALTH_PRIORITY
        );
        assert!(accepts_outcome(
            snapshot.last_success_at,
            snapshot.last_failure_at,
            now_ms
        ));

        upsert_source_health_snapshot(&fixture.store, key, outcome, now_ms, false);
        let updated = load_source_health_snapshot(&fixture.store, key).unwrap();
        assert_eq!(updated.cooldown_until, None);
        match outcome {
            PlaybackStreamOutcomeKind::Verified => {
                assert_eq!(updated.last_success_at, Some(now_ms));
                assert_eq!(updated.last_failure_at, None);
                assert_eq!(updated.consecutive_failures, 0);
                assert_eq!(score_source_health_priority(Some(&updated), now_ms), 3);
            }
            _ => {
                assert_eq!(updated.last_success_at, None);
                assert_eq!(updated.last_failure_at, Some(now_ms));
                assert_eq!(updated.consecutive_failures, 1);
                assert_eq!(score_source_health_priority(Some(&updated), now_ms), 1);
            }
        }
        let saved = fixture.store.get(&item_key);
        upsert_source_health_snapshot(
            &fixture.store,
            key,
            PlaybackStreamOutcomeKind::Verified,
            now_ms - 10 * 60 * 1000,
            false,
        );
        assert_eq!(fixture.store.get(&item_key), saved);
    }
}

#[test]
fn reputation_scoring_bounds_cooldowns_and_future_failures() {
    let now_ms = 100_000;
    let mut source = health(None, Some(now_ms - 1), 2, Some(now_ms + 20 * 60 * 1000));
    assert_eq!(score_source_health_priority(Some(&source), now_ms), 0);
    source.cooldown_until = source.cooldown_until.map(|until| until + 1);
    assert_eq!(score_source_health_priority(Some(&source), now_ms), 1);
    source.cooldown_until = None;
    source.last_failure_at = Some(now_ms + 5 * 60 * 1000);
    assert_eq!(score_source_health_priority(Some(&source), now_ms), 1);
    source.last_failure_at = source.last_failure_at.map(|at| at + 1);
    assert_eq!(
        score_source_health_priority(Some(&source), now_ms),
        DEFAULT_SOURCE_HEALTH_PRIORITY
    );

    let mut family = stream_family_snapshot(None, None, Some(now_ms - 1));
    family.consecutive_failures = 2;
    family.cooldown_until = Some(now_ms + 17 * 60 * 1000);
    assert_eq!(
        score_stream_family_priority(Some(&family), None, None, now_ms),
        0
    );
    family.cooldown_until = family.cooldown_until.map(|until| until + 1);
    assert_eq!(
        score_stream_family_priority(Some(&family), None, None, now_ms),
        1
    );
    family.cooldown_until = None;
    family.last_failure_at = Some(now_ms + 5 * 60 * 1000);
    assert_eq!(
        score_stream_family_priority(Some(&family), None, None, now_ms),
        1
    );
    family.last_failure_at = family.last_failure_at.map(|at| at + 1);
    assert_eq!(
        score_stream_family_priority(Some(&family), None, None, now_ms),
        DEFAULT_STREAM_FAMILY_PRIORITY
    );
}

#[test]
fn stream_family_priority_rewards_recent_nearby_success() {
    let now_ms = 100_000;
    let snapshot = PlaybackStreamFamilySnapshot {
        scope_key: None,
        source_id: None,
        last_success_at: Some(99_000),
        last_success_season: Some(1),
        last_success_episode: Some(4),
        last_failure_at: None,
        last_failure_season: None,
        last_failure_episode: None,
        consecutive_failures: 0,
        cooldown_until: None,
    };

    assert_eq!(
        score_stream_family_priority(Some(&snapshot), Some(1), Some(5), now_ms),
        4
    );
}

#[test]
fn stream_family_priority_penalizes_recent_nearby_failure() {
    let now_ms = 100_000;
    let snapshot = PlaybackStreamFamilySnapshot {
        scope_key: None,
        source_id: None,
        last_success_at: None,
        last_success_season: None,
        last_success_episode: None,
        last_failure_at: Some(99_500),
        last_failure_season: Some(1),
        last_failure_episode: Some(5),
        consecutive_failures: 1,
        cooldown_until: Some(110_000),
    };

    assert_eq!(
        score_stream_family_priority(Some(&snapshot), Some(1), Some(6), now_ms),
        0
    );
}

fn stream_family_snapshot(
    source_id: Option<&str>,
    last_success_at: Option<u64>,
    last_failure_at: Option<u64>,
) -> PlaybackStreamFamilySnapshot {
    PlaybackStreamFamilySnapshot {
        scope_key: None,
        source_id: source_id.map(str::to_string),
        last_success_at,
        last_success_season: None,
        last_success_episode: None,
        last_failure_at,
        last_failure_season: None,
        last_failure_episode: None,
        consecutive_failures: 0,
        cooldown_until: None,
    }
}

#[test]
fn stream_family_recovers_from_future_dated_reputation() {
    use super::stream_health::{
        load_playback_stream_family_snapshot, playback_stream_family_item_key,
        playback_stream_family_snapshot_key, upsert_stream_family_snapshot, StreamOutcomeReport,
    };

    let fixture = crate::test_helpers::test_store();
    let now_ms = crate::commands::now_unix_millis();
    let future_ms = now_ms + 24 * 60 * 60 * 1000;
    let scope = "movie:tt1";
    let family = "clock-corrected-family";
    let key = playback_stream_family_snapshot_key(scope, family);
    let item_key = playback_stream_family_item_key(&key);
    for outcome in [
        PlaybackStreamOutcomeKind::Verified,
        PlaybackStreamOutcomeKind::LoadFailed,
    ] {
        let mut snapshot =
            stream_family_snapshot(Some("old-source"), Some(future_ms - 1), Some(future_ms));
        snapshot.consecutive_failures = 3;
        snapshot.cooldown_until = Some(future_ms + 720_000);
        fixture.store.set(&item_key, serde_json::json!(snapshot));
        assert_eq!(
            score_stream_family_priority(Some(&snapshot), None, None, now_ms),
            DEFAULT_STREAM_FAMILY_PRIORITY
        );
        let report = StreamOutcomeReport {
            media_id: "tt1".to_string(),
            media_type: "movie",
            season: None,
            episode: None,
            source_id: Some("current-source".to_string()),
            stream_family: Some(family.to_string()),
            outcome,
            timestamp_ms: now_ms,
        };
        upsert_stream_family_snapshot(
            &fixture.store,
            scope,
            family,
            report.source_id.clone(),
            &report,
            false,
        );
        let updated = load_playback_stream_family_snapshot(&fixture.store, &key).unwrap();
        assert_eq!(updated.scope_key.as_deref(), Some(scope));
        match outcome {
            PlaybackStreamOutcomeKind::Verified => {
                assert_eq!(updated.last_success_at, Some(now_ms));
                assert_eq!(updated.last_failure_at, None);
                assert_eq!(updated.consecutive_failures, 0);
                assert_eq!(updated.cooldown_until, None);
                assert_eq!(updated.source_id.as_deref(), Some("current-source"));
                assert_eq!(
                    score_stream_family_priority(Some(&updated), None, None, now_ms),
                    4
                );
            }
            _ => {
                assert_eq!(updated.last_success_at, None);
                assert_eq!(updated.last_failure_at, Some(now_ms));
                assert_eq!(updated.consecutive_failures, 1);
                assert_eq!(updated.cooldown_until, Some(now_ms + 720_000));
                assert_eq!(updated.source_id, None);
            }
        }
    }
}

#[test]
fn stream_family_migration_drops_legacy_reputation_and_preserves_other_state_once() {
    use super::stream_health::{
        playback_source_health_item_key, playback_stream_family_item_key,
        playback_stream_family_snapshot_key, PLAYBACK_SOURCE_HEALTH_INDEX_KEY,
        PLAYBACK_STREAM_FAMILY_INDEX_KEY,
    };
    use crate::commands::streaming_helpers::{derive_stream_family, source_health_key};
    use serde_json::json;

    let fixture = crate::test_helpers::test_store();
    let store = &fixture.store;
    let source_id = "https://user:secret@addon.example/manifest.json";
    let family = derive_stream_family(&crate::test_helpers::test_stream(), source_id).unwrap();
    let current_key = playback_stream_family_snapshot_key("series:tt1|alternate", &family);
    let snapshot = json!(stream_family_snapshot(Some(source_id), Some(50_000), None));
    let legacy_keys = [
        "series:tt1|shared|release:show",
        "series:tt1|shared|binge:show",
        "movie:tt1|shared|delivery:http",
        "series:tt1|v2:not-a-digest|release:show",
        "series:tt1|orphan|release:show",
    ];
    for key in legacy_keys {
        store.set(playback_stream_family_item_key(key), snapshot.clone());
    }
    store.set(
        playback_stream_family_item_key(&current_key),
        snapshot.clone(),
    );
    let missing_legacy_key = "movie:tt2|missing|delivery:http";
    let mut index: Vec<_> = legacy_keys[..4].iter().map(|key| key.to_string()).collect();
    index.extend([missing_legacy_key.to_string(), current_key.clone()]);
    store.set(PLAYBACK_STREAM_FAMILY_INDEX_KEY, json!(index));

    let health_key = source_health_key(source_id);
    upsert_source_health_snapshot(
        store,
        &health_key,
        PlaybackStreamOutcomeKind::Verified,
        50_000,
        false,
    );
    let preserved = [
        (
            playback_source_health_item_key(&health_key),
            store
                .get(playback_source_health_item_key(&health_key))
                .unwrap(),
        ),
        (
            PLAYBACK_SOURCE_HEALTH_INDEX_KEY.to_string(),
            store.get(PLAYBACK_SOURCE_HEALTH_INDEX_KEY).unwrap(),
        ),
        (
            super::language_preferences::PLAYBACK_LANGUAGE_PREFERENCES_INDEX_KEY.to_string(),
            json!(["series:tt1"]),
        ),
        (
            super::language_preferences::playback_language_preferences_item_key("series:tt1"),
            json!({"preferredAudioLanguage": "ja", "preferredSubtitleLanguage": "en", "updatedAt": 42}),
        ),
        (
            super::episode_mapping::PLAYBACK_EPISODE_MAPPING_INDEX_KEY.to_string(),
            json!(["series:tt1:1:1"]),
        ),
        (
            super::episode_mapping::playback_episode_mapping_item_key("series:tt1:1:1"),
            json!({"sourceLookupId": "tt1", "sourceSeason": 1, "sourceEpisode": 1}),
        ),
        ("unrelated".to_string(), json!({"durable": true})),
    ];
    for (key, value) in &preserved {
        store.set(key, value.clone());
    }
    store.save().unwrap();
    let saves_before = store.save_count();

    let service = PlaybackStateService::new();
    service.migrate_legacy_stream_families(store).unwrap();
    assert_eq!(store.save_count(), saves_before + 1);
    assert_eq!(
        store.get(PLAYBACK_STREAM_FAMILY_INDEX_KEY),
        Some(json!([current_key]))
    );
    assert_eq!(
        store.get(playback_stream_family_item_key(&current_key)),
        Some(snapshot)
    );
    for key in legacy_keys {
        assert!(store.get(playback_stream_family_item_key(key)).is_none());
    }
    let migrated_bytes = std::fs::read(&fixture.path).unwrap();
    let persisted: serde_json::Value = serde_json::from_slice(&migrated_bytes).unwrap();
    for (key, value) in preserved {
        assert_eq!(store.get(&key), Some(value.clone()), "{key}");
        assert_eq!(persisted.get(&key), Some(&value), "{key}");
    }
    assert_eq!(
        score_source_health_priority(
            load_source_health_snapshot(store, &health_key).as_ref(),
            50_000
        ),
        3
    );
    for _ in 0..2 {
        service.migrate_legacy_stream_families(store).unwrap();
    }
    PlaybackStateService::new()
        .migrate_legacy_stream_families(store)
        .unwrap();
    assert_eq!(store.save_count(), saves_before + 1);
    assert_eq!(std::fs::read(&fixture.path).unwrap(), migrated_bytes);
}

#[test]
fn movie_stream_family_priority_rewards_success_and_penalizes_failure_within_title_scope() {
    let now = 100_000;
    let success = stream_family_snapshot(None, Some(99_000), None);
    assert_eq!(
        score_stream_family_priority(Some(&success), None, None, now),
        4
    );
    assert_eq!(
        score_stream_family_priority(Some(&success), Some(1), Some(1), now),
        DEFAULT_STREAM_FAMILY_PRIORITY
    );
    let mut failure = stream_family_snapshot(None, None, Some(99_500));
    failure.consecutive_failures = 1;
    failure.cooldown_until = Some(110_000);
    assert_eq!(
        score_stream_family_priority(Some(&failure), None, None, now),
        0
    );
    failure.cooldown_until = None;
    assert_eq!(
        score_stream_family_priority(Some(&failure), None, None, now),
        1
    );
    assert_eq!(
        score_stream_family_priority(Some(&failure), None, Some(1), now),
        DEFAULT_STREAM_FAMILY_PRIORITY
    );
    assert_eq!(
        score_stream_family_priority(
            Some(&success),
            None,
            None,
            99_000 + 1000 * 60 * 60 * 24 * 7 + 1
        ),
        DEFAULT_STREAM_FAMILY_PRIORITY
    );
    let mut series = success;
    series.last_success_season = Some(1);
    series.last_success_episode = Some(5);
    for (season, episode, expected) in [
        (Some(1), Some(7), 4),
        (Some(1), Some(8), DEFAULT_STREAM_FAMILY_PRIORITY),
        (Some(2), Some(5), DEFAULT_STREAM_FAMILY_PRIORITY),
        (None, None, DEFAULT_STREAM_FAMILY_PRIORITY),
    ] {
        assert_eq!(
            score_stream_family_priority(Some(&series), season, episode, now),
            expected
        );
    }
    assert_ne!(
        super::stream_health::playback_stream_family_snapshot_key("movie:tt1", "release"),
        super::stream_health::playback_stream_family_snapshot_key("movie:tt2", "release")
    );
}

#[test]
fn stream_family_source_id_only_moves_on_verified_outcomes() {
    let mut snapshot =
        stream_family_snapshot(Some("https://addon-a/manifest.json"), Some(50_000), None);

    update_verified_family_source_id(
        &mut snapshot,
        Some("https://addon-b/manifest.json".to_string()),
        PlaybackStreamOutcomeKind::LoadFailed,
    );
    assert_eq!(
        snapshot.source_id.as_deref(),
        Some("https://addon-a/manifest.json")
    );

    update_verified_family_source_id(
        &mut snapshot,
        Some("https://addon-b/manifest.json".to_string()),
        PlaybackStreamOutcomeKind::Verified,
    );
    assert_eq!(
        snapshot.source_id.as_deref(),
        Some("https://addon-b/manifest.json")
    );
}

#[test]
fn verified_outcome_without_resolvable_source_clears_family_attribution() {
    let mut snapshot =
        stream_family_snapshot(Some("https://addon-a/manifest.json"), Some(50_000), None);

    update_verified_family_source_id(&mut snapshot, None, PlaybackStreamOutcomeKind::Verified);
    assert_eq!(snapshot.source_id, None);

    snapshot.source_id = Some("https://addon-a/manifest.json".to_string());
    update_verified_family_source_id(
        &mut snapshot,
        Some("   ".to_string()),
        PlaybackStreamOutcomeKind::Verified,
    );
    assert_eq!(snapshot.source_id, None);
}

#[test]
fn recent_successful_source_rejects_family_whose_latest_activity_failed() {
    let polluted = stream_family_snapshot(
        Some("https://addon-b/manifest.json"),
        Some(50_000),
        Some(60_000),
    );
    assert_eq!(recent_successful_source(polluted, 100_000), None);
}

#[test]
fn recent_successful_source_recovers_after_new_verified_success() {
    let recovered = stream_family_snapshot(
        Some("https://addon-b/manifest.json"),
        Some(90_000),
        Some(60_000),
    );
    assert_eq!(
        recent_successful_source(recovered, 100_000),
        Some(("https://addon-b/manifest.json".to_string(), 90_000))
    );
}

#[test]
fn recent_successful_source_ignores_future_and_expired_successes() {
    let future = stream_family_snapshot(Some("https://addon-a/manifest.json"), Some(200_000), None);
    assert_eq!(recent_successful_source(future, 100_000), None);

    let expired = stream_family_snapshot(Some("https://addon-a/manifest.json"), Some(1_000), None);
    assert_eq!(
        recent_successful_source(expired, 1_000 + 1000 * 60 * 60 * 24 * 7 + 1),
        None
    );
}

#[test]
fn accepts_outcome_rejects_reports_older_than_latest_activity() {
    assert!(!accepts_outcome(Some(50_000), None, 49_999));
    assert!(!accepts_outcome(None, Some(60_000), 59_999));
    assert!(!accepts_outcome(Some(50_000), Some(60_000), 55_000));
    assert!(accepts_outcome(Some(50_000), Some(60_000), 60_000));
    assert!(accepts_outcome(Some(50_000), Some(60_000), 60_001));
    assert!(accepts_outcome(None, None, 1));
}

#[test]
fn missing_or_expired_snapshots_score_neutral_default() {
    assert_eq!(
        score_source_health_priority(None, 10_000),
        DEFAULT_SOURCE_HEALTH_PRIORITY
    );
    assert_eq!(
        score_stream_family_priority(None, Some(1), Some(1), 10_000),
        DEFAULT_STREAM_FAMILY_PRIORITY
    );

    let stale_source = health(Some(1_000), None, 0, None);
    assert_eq!(
        score_source_health_priority(Some(&stale_source), 1_000 + 1000 * 60 * 60 * 6 + 1),
        DEFAULT_SOURCE_HEALTH_PRIORITY
    );

    let mut stale_family = stream_family_snapshot(None, Some(1_000), None);
    stale_family.last_success_season = Some(1);
    stale_family.last_success_episode = Some(1);
    assert_eq!(
        score_stream_family_priority(
            Some(&stale_family),
            Some(1),
            Some(1),
            1_000 + 1000 * 60 * 60 * 24 * 7 + 1
        ),
        DEFAULT_STREAM_FAMILY_PRIORITY
    );
}

#[test]
fn language_preferences_scope_collapses_anime_into_series_scope() {
    assert_eq!(
        playback_title_scope_key(Some("anime"), Some("kitsu:42")).as_deref(),
        Some("series:kitsu:42")
    );
}

/// `(default_audio, default_subtitle, scoped_audio, scoped_subtitle)`:
/// builds the global defaults and a `updated_at = 42` scoped snapshot,
/// then merges them.
fn merged(
    default_audio: Option<&str>,
    default_subtitle: Option<&str>,
    scoped_audio: Option<&str>,
    scoped_subtitle: Option<&str>,
) -> PlaybackLanguagePreferences {
    let defaults = PlaybackLanguagePreferences {
        preferred_audio_language: default_audio.map(str::to_string),
        preferred_subtitle_language: default_subtitle.map(str::to_string),
    };
    let scoped = PlaybackLanguagePreferencesSnapshot {
        preferred_audio_language: scoped_audio.map(str::to_string),
        preferred_subtitle_language: scoped_subtitle.map(str::to_string),
        updated_at: 42,
    };
    merge_playback_language_preferences(defaults, Some(&scoped))
}

#[test]
fn language_preferences_merge_explicit_defaults_and_sanitized_observations_per_field() {
    for (label, (audio, subtitle, observed_audio, observed_subtitle), expected) in [
        (
            "explicit",
            (Some("en"), Some("off"), Some("ja"), None),
            (Some("en"), Some("off")),
        ),
        (
            "per field",
            (Some("en"), Some("en"), Some("de"), Some("ja")),
            (Some("en"), Some("en")),
        ),
        (
            "unset",
            (None, None, Some("ja"), Some("off")),
            (Some("ja"), Some("off")),
        ),
        (
            "invalid defaults",
            (
                Some("commentary"),
                Some("commentary"),
                Some("jpn"),
                Some("eng"),
            ),
            (Some("ja"), Some("en")),
        ),
        (
            "subtitle off",
            (None, Some("off"), None, Some("en")),
            (None, Some("off")),
        ),
    ] {
        let effective = merged(audio, subtitle, observed_audio, observed_subtitle);
        assert_eq!(
            (
                effective.preferred_audio_language.as_deref(),
                effective.preferred_subtitle_language.as_deref()
            ),
            expected,
            "{label}"
        );
    }
}

#[test]
fn episode_mapping_snapshot_prefers_backend_normalized_episode_coordinates() {
    let snapshot = build_episode_mapping_snapshot(
        "anime",
        "kitsu:42",
        Some("tt-fallback"),
        &Episode {
            title: Some("Episode 1".to_string()),
            release_date: None,
            stream_lookup_id: Some("tt-stream".to_string()),
            stream_season: Some(4),
            stream_episode: Some(12),
            ..test_episode("episode-1", 1, 1)
        },
        123,
    );

    assert_eq!(snapshot.source_lookup_id, "tt-stream");
    assert_eq!(snapshot.source_season, 4);
    assert_eq!(snapshot.source_episode, 12);
}

#[test]
fn episode_mappings_digest_tracks_every_snapshot_input() {
    let episode = |season: u32, ep: u32| Episode {
        title: Some(format!("Episode {ep}")),
        release_date: None,
        stream_lookup_id: None,
        ..test_episode(&format!("episode-{season}-{ep}"), season, ep)
    };
    let episodes = vec![episode(1, 1), episode(1, 2)];
    let base = episode_mappings_digest("series", "tt1", Some("tt1"), &episodes);

    assert_eq!(
        base,
        episode_mappings_digest("series", "tt1", Some("tt1"), &episodes)
    );

    // Any input the snapshot build reads must change the memo, or a
    // stale hit would suppress a needed rewrite.
    let mut changed = episodes.clone();
    changed[0].stream_lookup_id = Some("kitsu:99".to_string());
    assert_ne!(
        base,
        episode_mappings_digest("series", "tt1", Some("tt1"), &changed)
    );
    assert_ne!(
        base,
        episode_mappings_digest("series", "tt1", Some("other"), &episodes)
    );
    assert_ne!(
        base,
        episode_mappings_digest("movie", "tt1", Some("tt1"), &episodes)
    );
    let mut extra = episodes.clone();
    extra.push(episode(1, 3));
    assert_ne!(
        base,
        episode_mappings_digest("series", "tt1", Some("tt1"), &extra)
    );
}
#[test]
fn deleted_history_snapshot_cannot_repopulate_coalescing_cache() {
    let service = PlaybackStateService::new();
    let key = "movie:tt123".to_string();
    let progress = WatchProgress {
        position: 120.0,
        duration: 600.0,
        last_watched: 1_000,
        ..test_progress()
    };
    let generation = service.history_generation();
    service.mark_history_persisted([(key.clone(), progress.clone())], false, generation);
    assert!(service.should_skip_history_write(&key, &progress, None));

    let mut persisted = crate::providers::lock_or_recover(&service.persisted_history);
    let pending_service = service.clone();
    let pending_key = key.clone();
    let pending_progress = progress.clone();
    let pending = std::thread::spawn(move || {
        pending_service.mark_history_persisted(
            [(pending_key, pending_progress)],
            false,
            generation,
        );
    });
    service.bump_history_generation();
    persisted.clear();
    drop(persisted);
    pending.join().expect("pending save completion");

    assert!(!service.should_skip_history_write(&key, &progress, None));
    let generation = service.history_generation();
    service.mark_history_persisted([(key.clone(), progress.clone())], false, generation);
    assert!(service.should_skip_history_write(&key, &progress, None));

    // A write whose cap pruning deleted rows drops every cached snapshot.
    let other_key = "movie:tt456".to_string();
    service.mark_history_persisted([(other_key.clone(), progress.clone())], true, generation);
    assert!(!service.should_skip_history_write(&key, &progress, None));
    assert!(!service.should_skip_history_write(&other_key, &progress, None));
}
