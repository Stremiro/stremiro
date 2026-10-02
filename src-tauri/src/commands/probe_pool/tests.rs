use super::{
    find_preferred_position, resolve_candidate_results, resolve_ranked_best_stream_candidate,
    CandidateProbeResult, PreferredStreamHint, ProbeError, ResolveStreamErrorKind, ResolvedStream,
    StreamPoolQuery, StreamResolveCandidateInput,
};
use crate::commands::stream_fetcher::StreamRankingOverrides;
use crate::providers::addons::{AddonStream, StreamEpisodeMatchKind};
use crate::test_helpers::test_stream;
use futures_util::stream::FuturesOrdered;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Probeable row with an explicit prepared key and an optional info hash
/// (the hash feeds `stream_dedup_key` for the legacy-key tier).
fn probeable_stream(stream_key: &str, info_hash: Option<&str>) -> AddonStream {
    AddonStream {
        url: Some("https://cdn.example/file.mkv".to_string()),
        info_hash: info_hash.map(str::to_string),
        stream_key: stream_key.to_string(),
        ..test_stream()
    }
}

fn hint(stream_key: &'static str) -> PreferredStreamHint<'static> {
    PreferredStreamHint {
        stream_key: Some(stream_key),
        ..PreferredStreamHint::default()
    }
}

/// The canonical two-candidate pool rows most `find_preferred_position`
/// tests probe.
fn pair() -> Vec<AddonStream> {
    vec![
        probeable_stream("s:aaaa", None),
        probeable_stream("s:bbbb", None),
    ]
}

#[test]
fn preferred_position_matches_prepared_stream_key() {
    let streams = pair();

    assert_eq!(
        find_preferred_position(&streams, hint("s:bbbb"), None),
        Some(1)
    );
}

#[test]
fn preferred_position_matches_legacy_dedup_key() {
    // Rows persisted before prepared keys carry the `h:` content key while
    // the pool row's `stream_key` is the prepared `s:` form — the tier must
    // bind them via the row's dedup identity, not string equality.
    let streams = vec![
        probeable_stream("s:prepared-1", None),
        probeable_stream("s:prepared-2", Some("ABC123")),
    ];

    assert_eq!(
        find_preferred_position(&streams, hint("h:abc123:0"), None),
        Some(1)
    );
}

#[test]
fn preferred_position_skips_excluded_key() {
    let streams = pair();

    // The excluded failed stream must not re-bind through the key tier.
    assert_eq!(
        find_preferred_position(&streams, hint("s:aaaa"), Some("s:aaaa")),
        None
    );
}

#[test]
fn preferred_position_ignores_key_hits_without_direct_url() {
    // A saved `h:` torrent key on a pool row with no direct URL: the key
    // tier must pass it by so softer tiers (or no match) decide.
    let torrent = AddonStream {
        url: None,
        info_hash: Some("abc123".to_string()),
        stream_key: "s:prepared".to_string(),
        ..test_stream()
    };

    assert_eq!(
        find_preferred_position(&[torrent], hint("h:abc123:0"), None),
        None
    );
}

#[test]
fn preferred_position_falls_through_key_miss_to_family() {
    let mut streams = pair();
    streams[1].stream_family = Some("alpha|release:test".to_string());

    let mut preferred = hint("s:rotted");
    preferred.stream_family = Some("alpha|release:test");

    assert_eq!(find_preferred_position(&streams, preferred, None), Some(1));
}

#[test]
fn preferred_position_excluded_stream_does_not_rebind_by_family() {
    let mut excluded = probeable_stream("s:aaaa", None);
    excluded.stream_family = Some("alpha|release:x".to_string());
    let streams = vec![excluded, probeable_stream("s:bbbb", None)];

    let mut preferred = hint("s:rotted");
    preferred.stream_family = Some("alpha|release:x");

    assert_eq!(
        find_preferred_position(&streams, preferred, Some("s:aaaa")),
        None
    );
}

#[test]
fn preferred_position_excluded_stream_does_not_rebind_by_source() {
    let mut excluded = probeable_stream("s:aaaa", None);
    excluded.source_name = Some("alpha".to_string());
    let streams = vec![excluded, probeable_stream("s:bbbb", None)];

    let mut preferred = hint("s:rotted");
    preferred.source_name = Some("alpha");

    assert_eq!(
        find_preferred_position(&streams, preferred, Some("s:aaaa")),
        None
    );
}

#[test]
fn preferred_position_excluded_stream_does_not_rebind_by_legacy_hash() {
    let mut excluded = probeable_stream("s:prepared", Some("ABC123"));
    excluded.stream_family = Some("alpha|release:x".to_string());
    let streams = vec![excluded, probeable_stream("s:bbbb", None)];

    let mut preferred = hint("s:rotted");
    preferred.stream_family = Some("alpha|release:x");

    assert_eq!(
        find_preferred_position(&streams, preferred, Some("h:abc123:0")),
        None
    );
}

#[test]
fn preferred_position_falls_back_to_source_name() {
    let mut streams = pair();
    streams[1].source_name = Some("alpha".to_string());

    let mut preferred = hint("s:rotted");
    preferred.source_name = Some("alpha");

    assert_eq!(find_preferred_position(&streams, preferred, None), Some(1));
}

#[test]
fn preferred_position_source_id_miss_does_not_fall_through_to_name() {
    let mut stream = probeable_stream("s:aaaa", None);
    stream.source_id = Some("addon-a".to_string());
    stream.source_name = Some("shared".to_string());

    let preferred = PreferredStreamHint {
        source_id: Some("addon-b"),
        source_name: Some("shared"),
        ..PreferredStreamHint::default()
    };

    assert_eq!(find_preferred_position(&[stream], preferred, None), None);
}

#[test]
fn preferred_position_family_tier_requires_same_source_id() {
    let mut wrong_instance = probeable_stream("s:aaaa", None);
    wrong_instance.stream_family = Some("alpha|release:x".to_string());
    wrong_instance.source_id = Some("addon-a".to_string());
    let mut right_instance = probeable_stream("s:bbbb", None);
    right_instance.stream_family = Some("alpha|release:x".to_string());
    right_instance.source_id = Some("addon-b".to_string());
    let streams = vec![wrong_instance, right_instance];

    let preferred = PreferredStreamHint {
        stream_family: Some("alpha|release:x"),
        source_id: Some("addon-b"),
        ..PreferredStreamHint::default()
    };

    assert_eq!(find_preferred_position(&streams, preferred, None), Some(1));
}

#[test]
fn preferred_position_family_hint_cannot_drop_below_best_episode_match() {
    let mut streams = pair();
    streams[0].selection_priority = Some((StreamEpisodeMatchKind::Exact, true, 4, 1, 0));
    streams[1].stream_family = Some("alpha|release:x".to_string());
    streams[1].selection_priority = Some((StreamEpisodeMatchKind::None, false, 4, 1, 0));

    let mut preferred = hint("s:rotted");
    preferred.stream_family = Some("alpha|release:x");

    assert_eq!(find_preferred_position(&streams, preferred, None), None);
}

#[test]
fn preferred_position_source_hint_cannot_drop_below_best_language_match() {
    let mut streams = pair();
    streams[0].selection_priority = Some((StreamEpisodeMatchKind::Exact, true, 4, 1, 6));
    streams[1].source_id = Some("addon-a".to_string());
    streams[1].selection_priority = Some((StreamEpisodeMatchKind::Exact, true, 4, 1, 0));

    let mut preferred = hint("s:rotted");
    preferred.source_id = Some("addon-a");

    assert_eq!(find_preferred_position(&streams, preferred, None), None);
}

#[test]
fn preferred_position_family_hint_allowed_at_equal_priority() {
    let mut streams = pair();
    let priority = (StreamEpisodeMatchKind::Exact, true, 4, 1, 6);
    streams[0].selection_priority = Some(priority);
    streams[1].stream_family = Some("alpha|release:x".to_string());
    streams[1].selection_priority = Some(priority);

    let mut preferred = hint("s:rotted");
    preferred.stream_family = Some("alpha|release:x");

    assert_eq!(find_preferred_position(&streams, preferred, None), Some(1));
}

#[test]
fn preferred_position_exact_key_honored_below_best_priority() {
    let mut streams = pair();
    streams[0].selection_priority = Some((StreamEpisodeMatchKind::Exact, true, 4, 1, 6));
    streams[1].selection_priority = Some((StreamEpisodeMatchKind::None, false, 0, 1, 0));

    assert_eq!(
        find_preferred_position(&streams, hint("s:bbbb"), None),
        Some(1)
    );
}

fn pool_query(media_type: &str, season: Option<u32>, episode: Option<u32>) -> StreamPoolQuery {
    StreamPoolQuery::new(
        media_type,
        "tt123",
        season,
        episode,
        None,
        StreamRankingOverrides {
            media_type: None,
            media_id: None,
            title: None,
            season: None,
            episode: None,
        },
        "stream lookup",
    )
    .expect("valid query")
}

#[test]
fn retain_episode_candidates_drops_conflicting_claims_keeps_order() {
    let query = pool_query("series", Some(1), Some(5));
    let mut correct = probeable_stream("s:good", None);
    correct.name = Some("Show.S01E05.1080p".to_string());
    let mut unknown = probeable_stream("s:unknown", None);
    unknown.name = Some("Show.1080p.Release".to_string());
    let mut wrong = probeable_stream("s:bad", None);
    wrong.name = Some("Show.S02E05.1080p".to_string());

    let mut streams = vec![correct, unknown, wrong];
    query.retain_episode_candidates(&mut streams, false);

    assert_eq!(
        streams
            .iter()
            .map(|stream| stream.stream_key.as_str())
            .collect::<Vec<_>>(),
        vec!["s:good", "s:unknown"]
    );
}

#[test]
fn retain_episode_candidates_wrong_only_pool_leaves_no_preferred_match() {
    let query = pool_query("series", Some(1), Some(5));
    let mut wrong = probeable_stream("s:bad", None);
    wrong.name = Some("Show.S02E05.1080p".to_string());
    let mut streams = vec![wrong];

    query.retain_episode_candidates(&mut streams, false);

    assert!(streams.is_empty());
    assert_eq!(find_preferred_position(&streams, hint("s:bad"), None), None);
}

#[test]
fn retain_episode_candidates_bypasses_movies() {
    let query = pool_query("movie", None, None);
    let mut stream = probeable_stream("s:bad", None);
    stream.name = Some("Show.S02E05.1080p".to_string());
    let mut streams = vec![stream];

    query.retain_episode_candidates(&mut streams, false);

    assert_eq!(streams.len(), 1);
}

#[tokio::test]
async fn excluded_legacy_key_filters_matching_pool_candidate() {
    let mut stream = probeable_stream("s:prepared", Some("ABC123"));
    stream.source_name = Some("alpha".to_string());

    let error = resolve_ranked_best_stream_candidate(
        vec![stream],
        Some("h:abc123:0"),
        None,
        PreferredStreamHint::default(),
    )
    .await
    .expect_err("the excluded stream must be filtered before probing");

    assert_eq!(error.kind, ResolveStreamErrorKind::Failed);
    assert_eq!(
        error.message,
        "Unable to resolve a playable stream from the best candidates."
    );
}

fn candidate_input(source_name: &str, stream_key: &str) -> StreamResolveCandidateInput {
    StreamResolveCandidateInput {
        source_id: None,
        source_name: Some(source_name.to_string()),
        stream_family: None,
        stream_key: stream_key.to_string(),
        direct_url: format!("https://cdn.example/{stream_key}.mkv"),
        request_headers: Vec::new(),
    }
}

fn resolved(url: &str) -> ResolvedStream {
    ResolvedStream {
        url: url.to_string(),
        format: "mkv".to_string(),
        mpv_http_header_fields: String::new(),
    }
}

type FakeProbeInner = Pin<Box<dyn Future<Output = Result<ResolvedStream, ProbeError>>>>;

async fn fake_probe(
    candidate: StreamResolveCandidateInput,
    timeout: Duration,
    inner: FakeProbeInner,
) -> CandidateProbeResult {
    let result = tokio::time::timeout(timeout, inner).await;
    (candidate, result)
}

#[tokio::test]
async fn candidate_results_consume_in_rank_order() {
    let mut candidates = FuturesOrdered::new();
    candidates.push_back(fake_probe(
        candidate_input("slow-a", "s:a"),
        Duration::from_secs(1),
        Box::pin(async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            Ok(resolved("https://cdn.example/a.mkv"))
        }),
    ));
    candidates.push_back(fake_probe(
        candidate_input("fast-b", "s:b"),
        Duration::from_secs(1),
        Box::pin(async { Ok(resolved("https://cdn.example/b.mkv")) }),
    ));

    let winner = resolve_candidate_results(candidates, None)
        .await
        .expect("first-ranked probe wins");

    assert_eq!(winner.url, "https://cdn.example/a.mkv");
    assert_eq!(winner.stream_key.as_deref(), Some("s:a"));
}

#[tokio::test]
async fn candidate_results_failed_first_rank_passes_to_next() {
    let mut candidates = FuturesOrdered::new();
    candidates.push_back(fake_probe(
        candidate_input("a", "s:a"),
        Duration::from_secs(1),
        Box::pin(async { Err("boom".to_string().into()) }),
    ));
    candidates.push_back(fake_probe(
        candidate_input("b", "s:b"),
        Duration::from_secs(1),
        Box::pin(async { Ok(resolved("https://cdn.example/b.mkv")) }),
    ));

    let winner = resolve_candidate_results(candidates, None)
        .await
        .expect("next-ranked probe wins");

    assert_eq!(winner.stream_key.as_deref(), Some("s:b"));
}

#[tokio::test]
async fn candidate_results_timed_out_first_rank_passes_to_next() {
    let mut candidates = FuturesOrdered::new();
    candidates.push_back(fake_probe(
        candidate_input("slow-a", "s:a"),
        Duration::from_millis(1),
        Box::pin(async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            Ok(resolved("https://cdn.example/a.mkv"))
        }),
    ));
    candidates.push_back(fake_probe(
        candidate_input("b", "s:b"),
        Duration::from_secs(1),
        Box::pin(async { Ok(resolved("https://cdn.example/b.mkv")) }),
    ));

    let winner = resolve_candidate_results(candidates, None)
        .await
        .expect("next-ranked probe wins");

    assert_eq!(winner.stream_key.as_deref(), Some("s:b"));
}

#[tokio::test]
async fn candidate_results_excluded_resolved_url_passes_to_next() {
    let mut candidates = FuturesOrdered::new();
    candidates.push_back(fake_probe(
        candidate_input("a", "s:a"),
        Duration::from_secs(1),
        Box::pin(async { Ok(resolved("https://cdn.example/excluded.mkv")) }),
    ));
    candidates.push_back(fake_probe(
        candidate_input("b", "s:b"),
        Duration::from_secs(1),
        Box::pin(async { Ok(resolved("https://cdn.example/b.mkv")) }),
    ));

    let winner = resolve_candidate_results(candidates, Some("https://cdn.example/excluded.mkv"))
        .await
        .expect("next-ranked probe wins");

    assert_eq!(winner.stream_key.as_deref(), Some("s:b"));
}

#[tokio::test]
async fn candidate_results_all_failures_error() {
    let mut candidates = FuturesOrdered::new();
    candidates.push_back(fake_probe(
        candidate_input("a", "s:a"),
        Duration::from_secs(1),
        Box::pin(async { Err("boom".to_string().into()) }),
    ));
    candidates.push_back(fake_probe(
        candidate_input("b", "s:b"),
        Duration::from_secs(1),
        Box::pin(async { Err("gone".to_string().into()) }),
    ));

    let error = resolve_candidate_results(candidates, None)
        .await
        .expect_err("all probes failed");

    assert_eq!(error.kind, ResolveStreamErrorKind::Failed);
    assert!(error.message.contains("a: boom"));
    assert!(error.message.contains("b: gone"));
}

#[tokio::test]
async fn candidate_results_rate_limited_probe_marks_error_kind() {
    let mut candidates = FuturesOrdered::new();
    candidates.push_back(fake_probe(
        candidate_input("a", "s:a"),
        Duration::from_secs(1),
        Box::pin(async {
            Err(ProbeError {
                message: "range probe returned HTTP 429".to_string(),
                rate_limited: true,
            })
        }),
    ));

    let error = resolve_candidate_results(candidates, None)
        .await
        .expect_err("the only probe failed");

    assert_eq!(error.kind, ResolveStreamErrorKind::RateLimited);
}

#[tokio::test]
async fn candidate_results_drops_queued_probe_futures_after_winner() {
    struct DropFlag(Arc<AtomicBool>);
    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    let dropped = Arc::new(AtomicBool::new(false));
    let flag = DropFlag(dropped.clone());

    let mut candidates = FuturesOrdered::new();
    candidates.push_back(fake_probe(
        candidate_input("a", "s:a"),
        Duration::from_secs(1),
        Box::pin(async { Ok(resolved("https://cdn.example/a.mkv")) }),
    ));
    candidates.push_back(fake_probe(
        candidate_input("b", "s:b"),
        Duration::from_secs(60),
        Box::pin(async move {
            let _flag = flag;
            std::future::pending::<Result<ResolvedStream, ProbeError>>().await
        }),
    ));

    let winner = resolve_candidate_results(candidates, None)
        .await
        .expect("first-ranked probe wins");

    assert_eq!(winner.stream_key.as_deref(), Some("s:a"));
    assert!(dropped.load(Ordering::SeqCst));
}
