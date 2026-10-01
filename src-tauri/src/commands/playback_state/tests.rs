use super::episode_mapping::{build_episode_mapping_snapshot, episode_mappings_digest};
use super::language_preferences::{
    merge_playback_language_preferences, PlaybackLanguagePreferencesSnapshot,
};
use super::playback_title_scope_key;
use super::stream_health::{
    accepts_outcome, recent_successful_source, score_source_health_priority,
    score_stream_family_priority, update_verified_family_source_id, PlaybackSourceHealthSnapshot,
    PlaybackStreamFamilySnapshot,
};
use super::{PlaybackStateService, PlaybackStreamOutcomeKind};
use crate::commands::stream_coordinator::{
    DEFAULT_SOURCE_HEALTH_PRIORITY, DEFAULT_STREAM_FAMILY_PRIORITY,
};
use crate::commands::{PlaybackLanguagePreferences, WatchProgress};
use crate::providers::Episode;
use crate::test_helpers::test_progress;

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
fn stream_family_priority_rewards_recent_nearby_success() {
    let now_ms = 100_000;
    let snapshot = PlaybackStreamFamilySnapshot {
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
fn explicit_language_preferences_override_observed_tracks() {
    let effective = merged(Some("en"), Some("off"), Some("ja"), None);

    assert_eq!(effective.preferred_audio_language.as_deref(), Some("en"));
    assert_eq!(
        effective.preferred_subtitle_language.as_deref(),
        Some("off")
    );
}

#[test]
fn explicit_language_preferences_win_over_scoped_snapshot_per_field() {
    let effective = merged(Some("en"), Some("en"), Some("de"), Some("ja"));

    assert_eq!(effective.preferred_audio_language.as_deref(), Some("en"));
    assert_eq!(effective.preferred_subtitle_language.as_deref(), Some("en"));
}

#[test]
fn observed_language_preferences_fill_unset_global_defaults() {
    let effective = merged(None, None, Some("ja"), Some("off"));

    assert_eq!(effective.preferred_audio_language.as_deref(), Some("ja"));
    assert_eq!(
        effective.preferred_subtitle_language.as_deref(),
        Some("off")
    );
}

#[test]
fn invalid_global_language_preferences_fall_back_to_sanitized_scoped_aliases() {
    let effective = merged(
        Some("commentary"),
        Some("commentary"),
        Some("jpn"),
        Some("eng"),
    );

    assert_eq!(effective.preferred_audio_language.as_deref(), Some("ja"));
    assert_eq!(effective.preferred_subtitle_language.as_deref(), Some("en"));
}

#[test]
fn explicit_subtitle_off_overrides_observed_track_language() {
    let effective = merged(None, Some("off"), None, Some("en"));

    assert_eq!(effective.preferred_audio_language, None);
    assert_eq!(
        effective.preferred_subtitle_language.as_deref(),
        Some("off")
    );
}

#[test]
fn episode_mapping_snapshot_prefers_backend_normalized_episode_coordinates() {
    let snapshot = build_episode_mapping_snapshot(
        "anime",
        "kitsu:42",
        Some("tt-fallback"),
        &Episode {
            id: "episode-1".to_string(),
            title: Some("Episode 1".to_string()),
            season: 1,
            episode: 1,
            released: None,
            release_date: None,
            overview: None,
            thumbnail: None,
            stream_lookup_id: Some("tt-stream".to_string()),
            stream_season: Some(4),
            stream_episode: Some(12),
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
        id: format!("episode-{season}-{ep}"),
        title: Some(format!("Episode {ep}")),
        season,
        episode: ep,
        released: None,
        release_date: None,
        overview: None,
        thumbnail: None,
        stream_lookup_id: None,
        stream_season: None,
        stream_episode: None,
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
    service.mark_history_persisted(key.clone(), progress.clone(), generation);
    assert!(service.should_skip_history_write(&key, &progress, None));

    let mut runtime = crate::providers::lock_or_recover(&service.runtime);
    let pending_service = service.clone();
    let pending_key = key.clone();
    let pending_progress = progress.clone();
    let pending = std::thread::spawn(move || {
        pending_service.mark_history_persisted(pending_key, pending_progress, generation);
    });
    service.bump_history_generation();
    runtime.persisted_history.clear();
    drop(runtime);
    pending.join().expect("pending save completion");

    assert!(!service.should_skip_history_write(&key, &progress, None));
    service.mark_history_persisted(key.clone(), progress.clone(), service.history_generation());
    assert!(service.should_skip_history_write(&key, &progress, None));
}
