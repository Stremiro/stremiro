use super::{
    get_stream_pack_rows, normalize_recovery_url, preferred_probe_error, retain_unprobed_streams,
    stream_link, validated_content_hash, PackEpisodeCoordinates, ProbeRequestIdentity,
    ResolveStreamError, ResolveStreamErrorKind, StreamLinkKind, StreamPackCoverage, StreamPackRow,
    StreamRequestRegistry, PACK_COVERAGE_CLAIMS_MAX, PACK_EPISODES_MAX, STREAM_EARLY_CANCELS_MAX,
    STREAM_REQUESTS_MAX,
};
use crate::providers::addons::BehaviorHints;
use crate::test_helpers::test_stream;
use serde_json::json;

#[test]
fn ipc_stream_keys_require_prepared_digests_and_preserve_bounded_legacy_hints() {
    use crate::commands::streaming_helpers::{normalize_stream_key, prepare_addon_streams};
    let mut stream = test_stream();
    stream.url = Some("https://cdn.example/file.mkv".to_string());
    let prepared = prepare_addon_streams(vec![stream], "addon", "Addon");
    let key = &prepared[0].stream_key;
    assert_eq!(key.len(), 66);
    assert_eq!(normalize_stream_key(key).as_ref(), Some(key));
    assert_eq!(
        normalize_stream_key(&format!(" {key} ")).as_ref(),
        Some(key)
    );
    assert!(normalize_stream_key(&format!("s:{}", "A".repeat(64))).is_some());
    for invalid in [
        String::new(),
        "s:".to_string(),
        "s:short".to_string(),
        format!("s:{}", "a".repeat(63)),
        format!("s:{}", "a".repeat(65)),
        format!("s:{}", "g".repeat(64)),
        format!("s:{}", "界".repeat(64)),
        format!(
            "h:{}",
            "a".repeat(crate::commands::history_helpers::STREAM_KEY_MAX_CHARS)
        ),
        "u:https://cdn.example/file".to_string(),
    ] {
        assert!(normalize_stream_key(&invalid).is_none(), "{invalid}");
    }
    for legacy in ["h:abc123:0", "uh:0123456789abcdef:0"] {
        assert_eq!(normalize_stream_key(legacy).as_deref(), Some(legacy));
    }
}

#[test]
fn preferred_fallback_preserves_the_first_failure_unless_only_fallback_is_rate_limited() {
    use ResolveStreamErrorKind::{Failed, RateLimited};
    for (first, fallback, expected_kind, expected_message) in [
        (Failed, Failed, Failed, "first"),
        (Failed, RateLimited, RateLimited, "fallback"),
        (RateLimited, Failed, RateLimited, "first"),
        (RateLimited, RateLimited, RateLimited, "first"),
    ] {
        let error = preferred_probe_error(
            ResolveStreamError::new(first, "first"),
            ResolveStreamError::new(fallback, "fallback"),
        );
        assert_eq!(error.kind, expected_kind);
        assert_eq!(error.message, expected_message);
    }
}

#[test]
fn preferred_fallback_excludes_only_started_requests_and_their_aliases() {
    let streams: Vec<_> = (0..28)
        .map(|index| {
            let mut stream = test_stream();
            stream.stream_key = format!("s:{index}");
            stream.url = Some(format!("https://cdn.example/{index}.mkv"));
            stream
        })
        .collect();
    let requests: Vec<_> = std::iter::once(&streams[10])
        .chain(&streams[..8])
        .filter_map(ProbeRequestIdentity::from_stream)
        .collect();

    let mut fallback = streams;
    let mut alias = fallback[10].clone();
    alias.stream_key = "s:another-addon".to_string();
    alias.source_id = Some("another-addon".to_string());
    alias.url = Some("HTTPS://CDN.EXAMPLE/10.mkv#filename.mkv".to_string());
    fallback.push(alias);
    let mut authenticated = fallback[10].clone();
    authenticated.stream_key = "s:authenticated".to_string();
    authenticated.behavior_hints = Some(
        serde_json::from_value(json!({
            "proxyHeaders": {"request": {"Authorization": "Bearer fixture"}}
        }))
        .unwrap(),
    );
    fallback.push(authenticated);
    retain_unprobed_streams(&mut fallback, &requests);
    assert_eq!(
        fallback
            .iter()
            .map(|stream| stream.stream_key.as_str())
            .collect::<Vec<_>>(),
        (8..28)
            .filter(|index| *index != 10)
            .map(|index| format!("s:{index}"))
            .chain(std::iter::once("s:authenticated".to_string()))
            .collect::<Vec<_>>()
    );
}

#[test]
fn preferred_fallback_request_identity_preserves_header_values_and_duplicates() {
    let streams: Vec<_> = [
        (
            "s:preferred",
            json!({"Authorization": "Bearer fixture", "X-Tag": "first", "x-tag": "second"}),
        ),
        (
            "s:case-alias",
            json!({"authorization": "Bearer fixture", "X-TAG": "second", "x-tag": "first"}),
        ),
        (
            "s:different-value",
            json!({"Authorization": "Bearer Fixture", "X-Tag": "first", "x-tag": "second"}),
        ),
        (
            "s:missing-duplicate",
            json!({"authorization": "Bearer fixture", "X-Tag": "first"}),
        ),
    ]
    .into_iter()
    .map(|(key, headers)| {
        let mut stream = test_stream();
        stream.stream_key = key.to_string();
        stream.url = Some("https://cdn.example/video.mkv".to_string());
        stream.behavior_hints =
            Some(serde_json::from_value(json!({"proxyHeaders": {"request": headers}})).unwrap());
        stream
    })
    .collect();
    let requests = vec![ProbeRequestIdentity::from_stream(&streams[0]).unwrap()];
    let mut fallback = streams;
    retain_unprobed_streams(&mut fallback, &requests);
    assert_eq!(
        fallback
            .iter()
            .map(|stream| stream.stream_key.as_str())
            .collect::<Vec<_>>(),
        ["s:different-value", "s:missing-duplicate"]
    );
}

#[tokio::test]
async fn stream_request_registry_honors_early_and_live_cancellation() {
    let registry = StreamRequestRegistry::default();
    registry.cancel("early".to_string()).expect("early cancel");
    let (_early_guard, mut early) = registry.register("early".to_string()).expect("register");
    assert!(*early
        .wait_for(|cancelled| *cancelled)
        .await
        .expect("cancelled"));
    let (_live_guard, mut live) = registry.register("live".to_string()).expect("register");
    assert!(!*live.borrow());
    registry.cancel("live".to_string()).expect("live cancel");
    assert!(*live
        .wait_for(|cancelled| *cancelled)
        .await
        .expect("cancelled"));
    assert_eq!(
        serde_json::to_value(super::ResolveStreamErrorKind::Cancelled).expect("error kind"),
        json!("cancelled")
    );
}

#[test]
fn stream_request_registry_cleans_guards_and_bounds_requests() {
    let registry = StreamRequestRegistry::default();
    for invalid in ["", "has space", "ümlaut", &"x".repeat(65)] {
        assert!(registry.register(invalid.to_string()).is_err());
        assert!(registry.cancel(invalid.to_string()).is_err());
    }
    let mut guards = Vec::new();
    for index in 0..STREAM_REQUESTS_MAX {
        guards.push(
            registry
                .register(format!("live-{index}"))
                .expect("register"),
        );
    }
    assert!(registry.register("overflow".to_string()).is_err());
    assert!(registry.register("live-0".to_string()).is_err());
    guards.pop();
    let replacement = registry
        .register("replacement".to_string())
        .expect("cleanup");
    drop(replacement);
    drop(guards);
    for index in 0..=STREAM_EARLY_CANCELS_MAX {
        registry.cancel(format!("early-{index}")).expect("cancel");
    }
    let requests = registry.requests.lock().expect("registry");
    assert!(requests.live.is_empty());
    assert_eq!(requests.early_cancels.len(), STREAM_EARLY_CANCELS_MAX);
    assert_eq!(
        requests.early_cancels.front().map(String::as_str),
        Some("early-1")
    );
}

fn episode_indices(rows: Vec<StreamPackRow>) -> Vec<u32> {
    rows.into_iter()
        .filter_map(|row| match row {
            StreamPackRow::Episode { index } => Some(index),
            StreamPackRow::Header { .. } => None,
        })
        .collect()
}

#[test]
fn pack_rows_add_season_headers_only_for_multi_season_results() {
    let episodes: Vec<PackEpisodeCoordinates> = serde_json::from_value(json!([
        {"season": 1, "episode": 1},
        {"season": 1, "episode": 2},
        {"season": 2, "episode": 1}
    ]))
    .expect("coordinates");
    let rows = get_stream_pack_rows(None, episodes.clone()).expect("rows");
    assert_eq!(
        serde_json::to_value(&rows).expect("serialized rows"),
        json!([
            {"type": "header", "season": 1},
            {"type": "episode", "index": 0},
            {"type": "episode", "index": 1},
            {"type": "header", "season": 2},
            {"type": "episode", "index": 2}
        ])
    );
    let season_two = serde_json::from_value(json!({"seasons": [2]})).expect("coverage");
    assert_eq!(
        get_stream_pack_rows(Some(season_two), episodes).expect("rows"),
        vec![StreamPackRow::Episode { index: 2 }]
    );
}

#[test]
fn pack_coverage_absent_or_unrestricted_keeps_all_episodes() {
    let episodes: Vec<PackEpisodeCoordinates> = serde_json::from_value(
        json!([{}, {"season": 0, "episode": 0}, {"season": 4, "episode": 9}]),
    )
    .expect("coordinates");
    assert_eq!(
        episode_indices(get_stream_pack_rows(None, episodes.clone()).expect("absent coverage")),
        vec![0, 1, 2]
    );
    let coverage = serde_json::from_value(json!({"seasons": []})).expect("coverage");
    assert_eq!(
        episode_indices(
            get_stream_pack_rows(Some(coverage), episodes).expect("unrestricted coverage")
        ),
        vec![0, 1, 2]
    );
}

#[test]
fn pack_coverage_bounds_are_inclusive_and_season_scoped() {
    let coverage: StreamPackCoverage = serde_json::from_value(json!({
        "seasons": [2],
        "episodeRanges": [{"season": 2, "start": 3, "end": 5}]
    }))
    .expect("coverage");
    assert!(coverage.covers(Some(2), Some(3)));
    assert!(coverage.covers(Some(2), Some(5)));
    assert!(!coverage.covers(Some(2), Some(2)));
    assert!(!coverage.covers(Some(2), Some(6)));
    assert!(!coverage.covers(Some(1), Some(4)));
    assert!(!coverage.covers(None, Some(4)));
    assert!(!coverage.covers(Some(2), None));
}

#[test]
fn pack_coverage_matches_source_or_canonical_coordinates_but_not_uncovered_episodes() {
    let coverage = serde_json::from_value(json!({
        "seasons": [2],
        "episodeRanges": [{"season": 2, "start": 3, "end": 5}]
    }))
    .expect("coverage");
    let episodes = serde_json::from_value(json!([
        {"season": 2, "episode": 4, "streamSeason": 1, "streamEpisode": 99},
        {"season": 1, "episode": 99, "streamSeason": 2, "streamEpisode": 4},
        {"season": 1, "episode": 99, "streamSeason": 3, "streamEpisode": 4},
        {"season": 2, "episode": 8, "streamSeason": 2, "streamEpisode": 9}
    ]))
    .expect("coordinates");
    assert_eq!(
        episode_indices(get_stream_pack_rows(Some(coverage), episodes).expect("covered indices")),
        vec![0, 1]
    );
}

#[test]
fn pack_coverage_source_coordinates_fall_back_independently_and_preserve_zero() {
    let coverage = serde_json::from_value(json!({
        "seasons": [0],
        "episodeRanges": [{"start": 0, "end": 0}]
    }))
    .expect("coverage");
    let episodes = serde_json::from_value(json!([
        {"season": 0, "episode": 9, "streamEpisode": 0},
        {"season": 8, "episode": 0, "streamSeason": 0},
        {"season": 8, "episode": 9, "streamSeason": 0, "streamEpisode": 0},
        {"season": 0, "episode": 9, "streamSeason": null, "streamEpisode": 0},
        {"season": 8, "episode": 9}
    ]))
    .expect("coordinates");
    assert_eq!(
        episode_indices(get_stream_pack_rows(Some(coverage), episodes).expect("fallback indices")),
        vec![0, 1, 2, 3]
    );
}

#[test]
fn pack_coverage_distinguishes_missing_ranges_from_empty_ranges() {
    let unrestricted: StreamPackCoverage =
        serde_json::from_value(json!({"seasons": [1]})).expect("coverage");
    assert!(unrestricted.covers(Some(1), None));
    assert!(!unrestricted.covers(None, Some(1)));
    assert_eq!(
        serde_json::to_value(&unrestricted).expect("serialized coverage"),
        json!({"seasons": [1]})
    );
    let empty: StreamPackCoverage =
        serde_json::from_value(json!({"seasons": [], "episodeRanges": []})).expect("coverage");
    assert!(!empty.covers(Some(1), Some(1)));
    assert_eq!(
        serde_json::to_value(empty).expect("serialized coverage"),
        json!({"seasons": [], "episodeRanges": []})
    );
}

#[test]
fn pack_coverage_unscoped_ranges_allow_missing_season_but_require_episode() {
    let coverage: StreamPackCoverage = serde_json::from_value(json!({
        "seasons": [],
        "episodeRanges": [{"start": 3, "end": 5}]
    }))
    .expect("coverage");
    assert!(coverage.covers(None, Some(4)));
    assert!(coverage.covers(Some(9), Some(4)));
    assert!(!coverage.covers(None, None));
    let reversed: StreamPackCoverage = serde_json::from_value(json!({
        "seasons": [],
        "episodeRanges": [{"start": 5, "end": 3}]
    }))
    .expect("coverage");
    assert!(!reversed.covers(Some(1), Some(4)));
}

#[test]
fn pack_coverage_rejects_oversized_episode_and_claim_payloads() {
    let episode: PackEpisodeCoordinates =
        serde_json::from_value(json!({"season": 1, "episode": 1})).expect("coordinates");
    assert_eq!(
        get_stream_pack_rows(None, vec![episode.clone(); PACK_EPISODES_MAX])
            .expect("bounded episodes")
            .len(),
        PACK_EPISODES_MAX
    );
    assert!(get_stream_pack_rows(None, vec![episode; PACK_EPISODES_MAX + 1]).is_err());
    let seasons = StreamPackCoverage {
        seasons: vec![1; PACK_COVERAGE_CLAIMS_MAX + 1],
        episode_ranges: None,
    };
    assert!(get_stream_pack_rows(Some(seasons), Vec::new()).is_err());
    let ranges = serde_json::from_value(json!({
        "seasons": [],
        "episodeRanges": vec![json!({"start": 1, "end": 2}); PACK_COVERAGE_CLAIMS_MAX + 1]
    }))
    .expect("coverage");
    assert!(get_stream_pack_rows(Some(ranges), Vec::new()).is_err());
}

#[test]
fn stream_link_validates_hash_formats() {
    let hex = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
    assert_eq!(validated_content_hash(hex), Some(hex.to_ascii_lowercase()));
    let base32 = "abcdefghijklmnopqrstuvwxyz234567";
    assert_eq!(
        validated_content_hash(base32),
        Some(base32.to_ascii_uppercase())
    );
    for invalid in [
        "",
        "abc123",
        "ABCDEF0123456789ABCDEF0123456789ABCDEF0Z",
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ234568",
        " ABCDEF0123456789ABCDEF0123456789ABCDEF01",
    ] {
        assert!(validated_content_hash(invalid).is_none());
    }
}

#[test]
fn stream_link_builds_encoded_magnet_with_filename_and_trackers() {
    let mut stream = test_stream();
    stream.content_hash = Some("ABCDEF0123456789ABCDEF0123456789ABCDEF01".to_string());
    stream.title = Some("Release & name\n1080p".to_string());
    stream.sources = vec![
        "tracker:udp://tracker.example:80/announce".to_string(),
        "tracker:https://tracker.example/announce?x=1&y=2".to_string(),
    ];
    let link = stream_link(&stream).expect("magnet");
    assert!(matches!(link.kind, StreamLinkKind::Magnet));
    assert_eq!(
        link.url,
        "magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01&dn=Release%20%26%20name&tr=udp%3A%2F%2Ftracker.example%3A80%2Fannounce&tr=https%3A%2F%2Ftracker.example%2Fannounce%3Fx%3D1%26y%3D2"
    );
    stream.behavior_hints = Some(BehaviorHints {
        filename: Some("chosen file.mkv".to_string()),
        ..BehaviorHints::default()
    });
    assert!(stream_link(&stream)
        .expect("filename")
        .url
        .contains("&dn=chosen%20file.mkv&tr="));
    stream.content_hash = Some("bad-hash".to_string());
    assert!(stream_link(&stream).is_err());
}

#[test]
fn stream_link_preserves_admitted_urls_without_resolution() {
    let mut stream = test_stream();
    for url in [
        "https://cdn.example/video.mkv?sig=a%2FB&token=x",
        "magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01&dn=Raw%20Name",
    ] {
        stream.url = Some(url.to_string());
        assert_eq!(stream_link(&stream).expect("original link").url, url);
    }
    stream.url = Some("file:///private".to_string());
    assert!(stream_link(&stream).is_err());
}

#[test]
fn recovery_url_uses_the_shared_fetchable_gate() {
    assert!(normalize_recovery_url(Some("https://cdn.example/video.m3u8".to_string())).is_some());
    // Non-HTTP schemes, embedded credentials, and non-routable targets
    // (dotted or numeric) never reach the player, matching the probe gate.
    for blocked in [
        "file:///etc/passwd",
        "https://user:pass@cdn.example/video.m3u8",
        "http://127.0.0.1:11470/video.mp4",
        "http://169.254.169.254/latest/meta-data",
        "http://2130706433/video.mp4",
        "http://0x7f.0.0.1/video.mp4",
    ] {
        assert!(
            normalize_recovery_url(Some(blocked.to_string())).is_none(),
            "{blocked} must be rejected"
        );
    }
}
