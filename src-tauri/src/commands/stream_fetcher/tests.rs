use super::{
    source_health_priority_for_addon, summarize_cooldown_skipped_addon, StreamSelectorData,
    StreamSelectorSnapshot, StreamSelectorStats, StreamSourceStatus, StreamSourceSummary,
    ACTIVE_SOURCE_COOLDOWN_PRIORITY,
};
use crate::providers::addons::{StreamDeliveryKind, StreamResolution};
use crate::test_helpers::{test_addon, test_stream};
use std::collections::HashMap;

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

    for fatal_error_message in [None, Some("boom".to_string())] {
        let owned = StreamSelectorData {
            streams: vec![p2p.clone(), cached.clone(), http.clone()],
            source_summaries: vec![summary.clone()],
            fatal_error_message,
        };
        let snapshot = StreamSelectorSnapshot {
            streams: &owned.streams,
            stats: StreamSelectorStats::from_streams(&owned.streams),
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
            })
        );
    }
}
