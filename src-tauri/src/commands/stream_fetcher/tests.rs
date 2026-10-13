use super::{
    fetch_addon_stream_outcome, source_health_priority_for_addon, summarize_addon_outcome,
    summarize_cooldown_skipped_addon, AddonStreamFetchOutcome, StreamSelectorData,
    StreamSelectorSnapshot, StreamSelectorStats, StreamSourceStatus, StreamSourceSummary,
    ACTIVE_SOURCE_COOLDOWN_PRIORITY,
};
use crate::providers::addons::{AddonTransport, StreamDeliveryKind, StreamResolution};
use crate::test_helpers::{test_addon, test_stream};
use std::collections::HashMap;

#[tokio::test]
async fn borrowed_addon_outcomes_preserve_identity_on_empty_and_failed_fetches() {
    let provider = AddonTransport::new();
    let mut addon = test_addon("addon-1", "Example Addon");
    addon.url = "not-a-url".to_string();
    for query_ids in [Vec::new(), vec!["tt123".to_string()]] {
        let outcome = fetch_addon_stream_outcome(&provider, "movie", &query_ids, &addon).await;
        assert_eq!(outcome.id, addon.id);
        assert_eq!(outcome.name, addon.name);
        assert!(outcome.streams.is_empty());
        assert_eq!(outcome.error_message.is_some(), !query_ids.is_empty());
    }
}

#[test]
fn source_health_priority_for_addon_uses_instance_ids() {
    // Two instances sharing one display name keep independent scores:
    // the cooling instance is skipped while its twin still fetches.
    let source_health = HashMap::from([
        (
            "https://a.example".to_string(),
            ACTIVE_SOURCE_COOLDOWN_PRIORITY,
        ),
        ("https://b.example".to_string(), 3),
    ]);

    assert_eq!(
        source_health_priority_for_addon(
            &test_addon("https://a.example", " Shared "),
            &source_health
        ),
        ACTIVE_SOURCE_COOLDOWN_PRIORITY
    );
    assert_eq!(
        source_health_priority_for_addon(
            &test_addon("https://b.example", " Shared "),
            &source_health
        ),
        3
    );
}

#[test]
fn summarize_cooldown_skipped_addon_marks_source_offline() {
    let summary = summarize_cooldown_skipped_addon(&test_addon("addon-1", "Example Addon"));

    assert_eq!(summary.status, StreamSourceStatus::Offline);
    assert_eq!(summary.stream_count, 0);
    assert!(summary.latency_ms.is_none());
    assert!(summary.error_message.is_some());
}

#[test]
fn successful_empty_sources_are_no_results_without_hiding_fetch_failures() {
    for (has_streams, latency_ms, error_message, status) in [
        (false, 10, None, StreamSourceStatus::NoResults),
        (false, 5_000, None, StreamSourceStatus::NoResults),
        (true, 10, None, StreamSourceStatus::Healthy),
        (true, 5_000, None, StreamSourceStatus::Degraded),
        (false, 10, Some("fetch failed"), StreamSourceStatus::Offline),
    ] {
        let outcome = AddonStreamFetchOutcome {
            id: "addon-1".to_string(),
            name: "Example".to_string(),
            streams: if has_streams {
                vec![test_stream()]
            } else {
                Vec::new()
            },
            latency_ms,
            error_message: error_message.map(str::to_string),
        };
        let summary = summarize_addon_outcome(&outcome);
        assert_eq!(summary.status, status);
        assert_eq!(summary.stream_count, usize::from(has_streams));
        assert_eq!(
            summary.latency_ms,
            error_message.is_none().then_some(latency_ms)
        );
        if status == StreamSourceStatus::NoResults {
            assert_eq!(
                serde_json::to_value(summary).unwrap()["status"],
                "no_results"
            );
        }
    }
}

#[test]
fn selector_snapshot_serializes_like_selector_data() {
    // The progressive channel serializes `StreamSelectorSnapshot`, a borrowed
    // mirror of `StreamSelectorData`: if the owned struct gains a field this
    // fails until the mirror picks it up, keeping the wire shape one contract.
    let mut p2p = test_stream();
    p2p.presentation.resolution = StreamResolution::P2160;
    p2p.presentation.is_batch = true;
    let mut cached = test_stream();
    cached.presentation.is_instantly_playable = true;
    cached.presentation.delivery_kind = StreamDeliveryKind::Cached;
    cached.presentation.resolution = StreamResolution::P720;
    cached.presentation.is_batch = true;
    let mut http = test_stream();
    http.presentation.is_instantly_playable = true;
    http.presentation.delivery_kind = StreamDeliveryKind::Http;
    http.presentation.resolution = StreamResolution::P1080;
    let summary = StreamSourceSummary {
        id: "addon-1".to_string(),
        name: "Example".to_string(),
        status: StreamSourceStatus::Degraded,
        stream_count: 3,
        latency_ms: Some(12),
        error_message: None,
    };
    for (sources, expected) in [
        (
            vec![],
            serde_json::json!({"degraded": 0, "offline": 0, "pending": 0}),
        ),
        (
            vec![StreamSourceSummary {
                status: StreamSourceStatus::Pending,
                ..summary.clone()
            }],
            serde_json::json!({"degraded": 0, "offline": 0, "pending": 1}),
        ),
    ] {
        let stats = StreamSelectorStats::from_snapshot(&[], &sources);
        assert_eq!(
            serde_json::to_value(stats).unwrap()["sourceHealth"],
            expected
        );
    }

    for fatal_error_message in [None, Some("boom".to_string())] {
        let owned = StreamSelectorData {
            streams: vec![p2p.clone(), cached.clone(), http.clone()],
            source_summaries: [
                StreamSourceStatus::Degraded,
                StreamSourceStatus::Offline,
                StreamSourceStatus::Offline,
                StreamSourceStatus::Pending,
                StreamSourceStatus::Pending,
                StreamSourceStatus::Pending,
                StreamSourceStatus::Healthy,
                StreamSourceStatus::NoResults,
            ]
            .into_iter()
            .map(|status| StreamSourceSummary {
                status,
                ..summary.clone()
            })
            .collect(),
            fatal_error_message,
        };
        let snapshot = StreamSelectorSnapshot {
            streams: &owned.streams,
            stats: StreamSelectorStats::from_snapshot(&owned.streams, &owned.source_summaries),
            source_summaries: owned.source_summaries.iter().collect(),
            fatal_error_message: owned.fatal_error_message.as_deref(),
        };
        let payload = serde_json::to_value(&owned).unwrap();
        assert_eq!(serde_json::to_value(&snapshot).unwrap(), payload);
        assert_eq!(
            payload["stats"],
            serde_json::json!({
                "resCounts": {"4k": 0, "1080p": 1, "720p": 1, "sd": 0},
                "playableCount": 2, "p2pCount": 1, "cachedCount": 1,
                "batchCount": 1, "episodeLikeCount": 1,
                "sourceHealth": {"degraded": 1, "offline": 2, "pending": 3},
            })
        );
    }
}
