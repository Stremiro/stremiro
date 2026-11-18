use super::{
    addon_declares_stream, fetch_addon_stream_outcome, fetch_prepared_streams_for_addon,
    fetch_stream_for_link_from_addons, recovery_addons_needing_fallback, resolve_fetch_deadline,
    resolve_ranking_deadline, retain_rankable_streams, selector_metadata_deadline,
    source_health_priority_for_addon, summarize_addon_outcome, summarize_cooldown_skipped_addon,
    AddonStreamFetchOutcome, EpisodeEligibility, ResolveFetch, StreamQueryRequest,
    StreamRankingScope, StreamSelectorData, StreamSelectorSnapshot, StreamSelectorStats,
    StreamSourceStatus, StreamSourceSummary, ACTIVE_SOURCE_COOLDOWN_PRIORITY,
};
use crate::commands::config_store::AddonConfig;
use crate::commands::probe_pool::{is_probeable_stream, StreamExclusions};
use crate::commands::stream_coordinator::{
    sort_streams_by_recommendation, StreamMatchContext, StreamRecommendationInputs,
    StreamSignalCache,
};
use crate::commands::streaming_helpers::{build_stream_query_ids, prepare_addon_streams};
use crate::providers::addon_manifest::{AddonManifest, AddonResourceCapability};
use crate::providers::addons::{
    stream_conflicts_with_episode_targets, AddonStream, AddonTransport, BehaviorHints,
    StreamDeliveryKind, StreamEpisodeMatchKind, StreamRecommendationReason, StreamResolution,
};
use crate::test_helpers::{test_addon, test_stream};
use std::collections::{BTreeMap, HashMap};

/// The transport caches prepared rows, exactly as a real fetch stores them.
fn seed_prepared(
    provider: &AddonTransport,
    media_type: &str,
    id: &str,
    addon: &AddonConfig,
    streams: Vec<AddonStream>,
) {
    let prepared = prepare_addon_streams(streams, &addon.name, &addon.id);
    provider.seed_stream_cache(
        media_type,
        id,
        &addon.url,
        (&addon.name, &addon.id),
        prepared,
    );
}

/// Eligibility gate with the canonical defaults — tests override only the
/// fields under scrutiny via struct update (`..episode_eligibility(&[])`).
fn episode_eligibility<'a>(targets: &'a [(u32, u32)]) -> EpisodeEligibility<'a> {
    EpisodeEligibility {
        targets,
        accepted_years: &[],
        reference_title: None,
        resolve: true,
        final_season: None,
        exclusions: None,
    }
}

fn series_query(season: u32, episode: u32, absolute: Option<u32>) -> StreamQueryRequest<'static> {
    StreamQueryRequest {
        media_type: "series",
        id: "tt123",
        season: Some(season),
        episode: Some(episode),
        absolute_episode: absolute,
    }
}

fn ranking_scope(title: Option<&str>, season: u32, episode: u32) -> StreamRankingScope {
    StreamRankingScope {
        media_type: "series".into(),
        media_id: "tt123".into(),
        title: title.map(str::to_string),
        season: Some(season),
        episode: Some(episode),
    }
}

fn match_context<'a>(media_type: &'a str) -> StreamMatchContext<'a> {
    StreamMatchContext {
        accepted_years: &[],
        media_type,
        title: None,
        episode_targets: &[],
        canonical_season: None,
        is_final_season: false,
    }
}

/// Ranking inputs with no match evidence and the given priority maps —
/// tests override the fields under scrutiny via struct update.
fn recommendation_inputs<'a>(
    addon_priorities: &'a HashMap<String, u32>,
    health: &'a HashMap<String, u8>,
    families: &'a HashMap<String, u8>,
) -> StreamRecommendationInputs<'a> {
    StreamRecommendationInputs {
        addon_source_priorities: addon_priorities,
        source_health_priorities: health,
        stream_family_priorities: families,
        preferred_title_source_id: None,
        match_context: match_context("movie"),
        preferred_audio_language: None,
        preferred_subtitle_language: None,
    }
}

#[tokio::test(start_paused = true)]
async fn family_priority_reads_keep_addon_fetches_running() {
    use futures_util::StreamExt;
    let mut pending = futures_util::stream::iter(0..5)
        .map(|index| async move {
            tokio::time::sleep(std::time::Duration::from_millis(index as u64)).await;
            (
                index,
                AddonStreamFetchOutcome {
                    id: index.to_string(),
                    name: index.to_string(),
                    streams: Vec::new(),
                    latency_ms: 0,
                    error_message: None,
                },
            )
        })
        .buffer_unordered(super::ADDON_STREAM_FETCH_CONCURRENCY_LIMIT);
    assert_eq!(pending.next().await.unwrap().0, 0);
    let mut ready = std::collections::VecDeque::new();
    let lookup = async {
        tokio::time::sleep(super::PROGRESSIVE_FAMILY_LOOKUP_TIMEOUT).await;
        Err("advisory read failed".to_string())
    };
    assert_eq!(
        super::await_family_priorities(lookup, &mut pending, &mut ready).await,
        Err("advisory read failed".to_string()),
    );
    assert_eq!(
        ready
            .into_iter()
            .map(|(index, _)| index)
            .collect::<Vec<_>>(),
        [1, 2, 3, 4]
    );
    assert!(pending.next().await.is_none());
}

#[tokio::test(start_paused = true)]
async fn family_priority_deadline_bounds_a_queued_selector_store_read() {
    let _guard = super::super::STORE_OP_LOCK.lock().await;
    let now = tokio::time::Instant::now();
    let deadline = super::family_priority_deadline(now, None);
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let result = super::super::run_store_op_at::<_, String, _>(deadline, move || {
        let _ = sender.send(());
        Ok(())
    })
    .await;
    assert!(result.is_err());
    assert!(receiver.await.is_err());
    assert_eq!(
        tokio::time::Instant::now() - now,
        super::PROGRESSIVE_FAMILY_LOOKUP_TIMEOUT
    );
    for remaining in [
        std::time::Duration::ZERO,
        std::time::Duration::from_millis(100),
        std::time::Duration::from_secs(12),
    ] {
        assert_eq!(
            super::family_priority_deadline(now, Some(now + remaining)),
            super::resolve_ranking_deadline(now, Some(now + remaining)),
        );
    }
}

#[test]
fn resolve_prefilter_preserves_selector_rows_and_all_p2p_vs_empty() {
    for urls in [
        vec![],
        vec![None, Some("magnet:?xt=urn:btih:ABC123")],
        vec![None, Some("http://127.0.0.1/file.mkv")],
        vec![None, Some("https://cdn.example/file.mkv")],
    ] {
        let streams: Vec<_> = urls
            .iter()
            .enumerate()
            .map(|(index, url)| AddonStream {
                stream_key: format!("s:{index}"),
                url: url.map(str::to_string),
                content_hash: Some("abc123".to_string()),
                ..test_stream()
            })
            .collect();
        let original_keys: Vec<_> = streams
            .iter()
            .map(|stream| stream.stream_key.clone())
            .collect();
        let mut selector = streams.clone();
        retain_rankable_streams(&mut selector, false);
        assert_eq!(selector.len(), urls.len());
        assert_eq!(
            selector
                .iter()
                .map(|stream| stream.stream_key.clone())
                .collect::<Vec<_>>(),
            original_keys,
        );
        let has_direct = streams.iter().any(is_probeable_stream);
        let mut resolve = streams;
        retain_rankable_streams(&mut resolve, true);
        if has_direct {
            assert_eq!(resolve.len(), 1);
            assert!(resolve.iter().all(is_probeable_stream));
        } else {
            assert_eq!(resolve.len(), urls.len());
            assert_eq!(
                resolve
                    .iter()
                    .map(|stream| stream.stream_key.clone())
                    .collect::<Vec<_>>(),
                original_keys,
            );
        }
    }
}

#[test]
fn mixed_pool_http_ranking_matches_full_pool_then_filtering() {
    let streams: Vec<_> = (0..36)
        .map(|index| {
            let source = if index % 2 == 0 { "alpha" } else { "beta" };
            AddonStream {
                stream_key: format!("s:{index}"),
                name: Some(if index % 4 == 0 {
                    "Show S01E03 1080p English".to_string()
                } else {
                    "Show S01 720p".to_string()
                }),
                url: (index % 3 == 0).then(|| format!("https://{source}.example/{index}.mkv")),
                content_hash: (index % 3 != 0).then(|| format!("{index:040x}")),
                source_id: Some(source.to_string()),
                stream_family: Some(format!("{source}|release:group")),
                cached: index % 6 == 0,
                size_bytes: Some(if index % 4 == 0 {
                    2_000_000_000
                } else {
                    1_000_000_000
                }),
                ..test_stream()
            }
        })
        .collect();
    let addon_priorities = HashMap::from([("alpha".to_string(), 1), ("beta".to_string(), 2)]);
    let health = HashMap::from([("alpha".to_string(), 2), ("beta".to_string(), 3)]);
    let families = HashMap::from([
        ("alpha|release:group".to_string(), 4),
        ("beta|release:group".to_string(), 0),
    ]);
    let targets = [(1, 3)];
    for preferred_audio_language in [None, Some("en")] {
        let inputs = StreamRecommendationInputs {
            preferred_title_source_id: Some("beta"),
            match_context: StreamMatchContext {
                title: Some("Show"),
                episode_targets: &targets,
                canonical_season: Some(1),
                ..match_context("series")
            },
            preferred_audio_language,
            ..recommendation_inputs(&addon_priorities, &health, &families)
        };
        let mut expected = streams.clone();
        sort_streams_by_recommendation(&mut expected, inputs, &mut StreamSignalCache::default());
        expected.retain(is_probeable_stream);
        let mut actual = streams.clone();
        retain_rankable_streams(&mut actual, true);
        assert_eq!(actual.len(), 12);
        sort_streams_by_recommendation(&mut actual, inputs, &mut StreamSignalCache::default());
        assert_eq!(
            actual
                .iter()
                .map(|stream| &stream.stream_key)
                .collect::<Vec<_>>(),
            expected
                .iter()
                .map(|stream| &stream.stream_key)
                .collect::<Vec<_>>(),
        );
        for (actual, expected) in actual.iter().zip(&expected) {
            assert_eq!(actual.selection_priority, expected.selection_priority);
            assert_eq!(
                actual.recommendation_reasons,
                expected.recommendation_reasons
            );
        }
    }
}

#[tokio::test]
async fn stream_link_lookup_keeps_searching_after_errors_and_distinguishes_missing_rows() {
    for (failures, matching, expected_error) in [
        ([true, true], false, true),
        ([true, false], true, false),
        ([false, true], true, false),
        ([true, false], false, true),
        ([false, true], false, true),
        ([false, false], false, false),
    ] {
        for hint in [
            None,
            Some("first"),
            Some("second"),
            Some("disabled-or-unknown"),
        ] {
            let provider = AddonTransport::new();
            let mut addons = [test_addon("first", "First"), test_addon("second", "Second")];
            let query_ids = vec!["tt123".to_string()];
            let mut expected_key = "s:missing".to_string();
            for (index, addon) in addons.iter_mut().enumerate() {
                addon.url = format!("https://{}.example/manifest.json", addon.id);
                if failures[index] {
                    addon.url = format!("invalid-addon-{index}");
                    continue;
                }
                let streams = if matching {
                    vec![episode_stream("Matched stream")]
                } else {
                    vec![episode_stream("Different stream")]
                };
                if matching {
                    expected_key = crate::commands::streaming_helpers::prepare_addon_streams(
                        streams.clone(),
                        &addon.name,
                        &addon.id,
                    )[0]
                    .stream_key
                    .clone();
                }
                seed_prepared(&provider, "movie", &query_ids[0], addon, streams);
            }
            let result = fetch_stream_for_link_from_addons(
                &provider,
                "movie",
                &query_ids,
                addons.iter().collect(),
                &expected_key,
                hint,
            )
            .await;
            assert_eq!(
                result.is_err(),
                expected_error,
                "{failures:?}, {matching}, {hint:?}"
            );
            if !expected_error {
                assert_eq!(
                    result.unwrap().map(|stream| stream.stream_key),
                    matching.then_some(expected_key),
                    "{failures:?}, {matching}, {hint:?}"
                );
            }
        }
    }
}

#[test]
fn resolve_fetch_cutoff_preserves_initial_budget_and_reserves_late_probe_time() {
    use std::time::Duration;
    let now = tokio::time::Instant::now();
    for (remaining_ms, fetch_ms) in [
        (30_000, 14_000),
        (24_000, 14_000),
        (20_000, 10_000),
        (12_000, 6_000),
        (2_000, 1_000),
        (0, 0),
    ] {
        assert_eq!(
            resolve_fetch_deadline(now, Some(now + Duration::from_millis(remaining_ms))),
            now + Duration::from_millis(fetch_ms)
        );
    }
    assert_eq!(
        resolve_fetch_deadline(now, Some(now - Duration::from_secs(1))),
        now
    );
    assert_eq!(
        resolve_fetch_deadline(now, None),
        now + Duration::from_secs(14)
    );
}

#[test]
fn cold_start_metadata_is_capped_and_leaves_stream_resolution_budget() {
    use std::time::Duration;
    let now = tokio::time::Instant::now();
    assert_eq!(
        selector_metadata_deadline(now, None, None),
        now + Duration::from_millis(2_500)
    );
    for remaining in [0, 40, 400, 4_000, 20_000] {
        let deadline = now + Duration::from_millis(remaining);
        let expected = now + Duration::from_millis((remaining / 4).min(2_500));
        assert_eq!(
            selector_metadata_deadline(now, Some(deadline), None),
            expected
        );
        assert_eq!(
            selector_metadata_deadline(now, None, Some(deadline)),
            expected
        );
    }
    assert_eq!(
        selector_metadata_deadline(
            now,
            Some(now + Duration::from_secs(20)),
            Some(now + Duration::from_secs(1))
        ),
        now + Duration::from_millis(250)
    );
    assert_eq!(
        selector_metadata_deadline(now, Some(now - Duration::from_secs(1)), None),
        now
    );
}

#[tokio::test]
async fn stream_audit_family_reads_outlive_fetch_cutoff_and_reserve_probe_time() {
    use std::time::Duration;
    let start = tokio::time::Instant::now() - Duration::from_secs(14);
    let request_deadline = start + Duration::from_secs(30);
    let fetch_deadline = resolve_fetch_deadline(start, Some(request_deadline));
    assert!(
        tokio::time::timeout_at(fetch_deadline, std::future::pending::<()>())
            .await
            .is_err()
    );
    let after_fetch = tokio::time::Instant::now();
    let ranking_deadline = resolve_ranking_deadline(after_fetch, Some(request_deadline));
    let families = tokio::time::timeout_at(ranking_deadline, async {
        tokio::task::yield_now().await;
        HashMap::from([("failed".to_string(), 0), ("healthy".to_string(), 4)])
    })
    .await
    .expect("family reads still have a live budget after the fetch cutoff");
    let addon_priorities = HashMap::new();
    let empty = HashMap::new();
    let mut inputs = recommendation_inputs(&addon_priorities, &empty, &empty);
    let mut streams: Vec<_> = ["failed", "healthy"]
        .into_iter()
        .map(|family| AddonStream {
            stream_key: format!("s:{family}"),
            stream_family: Some(family.to_string()),
            ..test_stream()
        })
        .collect();
    let mut cache = StreamSignalCache::default();
    sort_streams_by_recommendation(&mut streams, inputs, &mut cache);
    assert_eq!(streams[0].stream_key, "s:failed");
    inputs.stream_family_priorities = &families;
    sort_streams_by_recommendation(&mut streams, inputs, &mut cache);
    assert_eq!(streams[0].stream_key, "s:healthy");
    for remaining_ms in [30_000, 24_000, 20_000, 12_000, 2_000, 0] {
        let now = tokio::time::Instant::now();
        let deadline = now + Duration::from_millis(remaining_ms);
        let cutoff = resolve_fetch_deadline(now, Some(deadline));
        let ranking_cutoff = resolve_ranking_deadline(cutoff, Some(deadline));
        let probe_reserve =
            Duration::from_secs(10).min(deadline.saturating_duration_since(cutoff) / 2);
        assert_eq!(deadline - ranking_cutoff, probe_reserve);
        assert!(ranking_cutoff >= cutoff);
        assert_eq!(ranking_cutoff > cutoff, remaining_ms > 0);
    }
}

#[tokio::test]
async fn borrowed_addon_outcomes_preserve_identity_on_empty_and_failed_fetches() {
    let provider = AddonTransport::new();
    let mut addon = test_addon("addon-1", "Example Addon");
    addon.url = "not-a-url".to_string();
    for query_ids in [Vec::new(), vec!["tt123".to_string()]] {
        assert_eq!(
            addon_declares_stream(&addon, "movie", &query_ids),
            !query_ids.is_empty()
        );
        let outcome =
            fetch_addon_stream_outcome(&provider, "movie", &query_ids, &addon, None, None).await;
        assert_eq!(outcome.id, addon.id);
        assert_eq!(outcome.name, addon.name);
        assert!(outcome.streams.is_empty());
        assert_eq!(outcome.error_message.is_some(), !query_ids.is_empty());
    }
}

fn episode_stream(name: &str) -> AddonStream {
    AddonStream {
        name: Some(name.to_string()),
        url: Some(format!("https://stream.example/{name}.mkv")),
        ..test_stream()
    }
}

#[tokio::test]
async fn one_piece_alternate_video_ids_keep_absolute_anime_releases_eligible() {
    use crate::commands::episode_navigation::{
        additional_episode_video_id, build_source_episode_coordinates,
    };
    use crate::test_helpers::test_episode;
    for (season, episode, video_season, absolute) in [(10, 1, 7, 196), (22, 4, 22, 1089)] {
        let ep = crate::providers::Episode {
            alternate_video_id: Some(format!("tt0388629:{video_season}:{absolute}")),
            ..test_episode(&format!("tt0388629:{season}:{episode}"), season, episode)
        };
        let source = build_source_episode_coordinates(&ep, "tt0388629");
        let video_id = additional_episode_video_id(&ep, &source).unwrap();
        let query = StreamQueryRequest {
            id: "tt0388629",
            ..series_query(season, episode, None)
        };
        let ranking = StreamRankingScope {
            media_id: "tt0388629".into(),
            ..ranking_scope(Some("One Piece"), season, episode)
        };
        let ids = query.query_ids(Some(&video_id));
        assert_eq!(
            &ids[..3],
            [
                format!("tt0388629:{season}:{episode}"),
                video_id.clone(),
                format!("tt0388629:1:{absolute}"),
            ]
        );
        let targets = query.episode_targets_with_video_id(&ranking, Some(&video_id));
        assert!(targets.contains(&(video_season, absolute)));
        assert!(!targets.contains(&(1, absolute)));
        let stream = episode_stream(&format!("[SubsPlease] One Piece - {absolute} (1080p).mkv"));
        assert!(!stream_conflicts_with_episode_targets(
            stream.match_texts(),
            &targets,
            None
        ));
        let mut wrong = ep;
        wrong.alternate_video_id = Some("tt9999999:7:196".into());
        assert!(additional_episode_video_id(&wrong, &source).is_none());
    }
}

#[tokio::test]
async fn video_id_queries_preserve_primary_fallbacks_and_source_episode_eligibility() {
    let query = series_query(1, 2, Some(13));
    let ranking = ranking_scope(None, 1, 2);
    let ids = query.query_ids(Some("tt999:4:12"));
    assert_eq!(ids, ["tt123:1:2", "tt999:4:12", "tt999:1:12", "tt123:1:13"]);
    for duplicate in ["tt123:1:2", "tt123:1:13"] {
        assert_eq!(query.query_ids(Some(duplicate)), query.query_ids(None));
    }
    for invalid in [
        " \u{feff} ".to_string(),
        "x".repeat(crate::commands::MEDIA_ID_MAX_CHARS + 1),
    ] {
        assert_eq!(query.query_ids(Some(&invalid)), query.query_ids(None));
    }
    assert_eq!(query.query_ids(Some("kitsu:42:12"))[1], "kitsu:42:12");
    assert_eq!(
        query.episode_targets_with_video_id(&ranking, Some("kitsu:42:12")),
        query.episode_targets(&ranking)
    );
    let targets = query.episode_targets_with_video_id(&ranking, Some("tt999:4:12"));
    assert!(targets.contains(&(4, 12)));
    assert!(targets.contains(&(1, 2)));
    let addon = test_addon("https://addon.example", "Example Addon");
    for (winner, name) in [(0, "Show.S01E02"), (1, "Show.S04E12"), (2, "Show.S01E13")] {
        let provider = AddonTransport::new();
        for (index, id) in ids.iter().enumerate() {
            let streams = if index == winner {
                vec![episode_stream(name)]
            } else {
                Vec::new()
            };
            seed_prepared(&provider, "series", id, &addon, streams);
        }
        let outcome = fetch_addon_stream_outcome(
            &provider,
            "series",
            &ids,
            &addon,
            Some(episode_eligibility(&targets)),
            None,
        )
        .await;
        assert!(outcome.error_message.is_none());
        assert_eq!(outcome.streams[0].name.as_deref(), Some(name));
    }
}

#[tokio::test]
async fn stream_capabilities_route_query_ids_and_gate_each_attempt() {
    let names = ["Primary stream", "First fallback", "Second fallback"];
    for (media_type, id, prefix, primary_empty, expected_index) in [
        ("series", "tt123", "tt123", false, Some(0)),
        ("series", "tt123", "tt123:", false, Some(0)),
        ("series", "tt123", "tt123:1:", false, Some(2)),
        ("series", "tt123", "tt123:2:3", true, None),
        ("series", "tt123", "tt999:", false, None),
        ("anime", "kitsu:123", "kitsu:123:3", false, Some(1)),
        ("anime", "kitsu:123", "kitsu:123:27", false, Some(2)),
        ("anime", "kitsu:123", "kitsu:123:2:", true, None),
    ] {
        let provider = AddonTransport::new();
        let mut addon = test_addon("https://addon.example", "Example Addon");
        addon.capabilities = Some(AddonManifest {
            name: addon.name.clone(),
            resources: vec![AddonResourceCapability {
                name: "stream".to_string(),
                types: vec!["series".to_string()],
                id_prefixes: vec![prefix.to_string()],
            }],
            ..Default::default()
        });
        let query_ids = build_stream_query_ids(media_type, id, Some(2), Some(3), Some(27));
        assert_eq!(
            addon_declares_stream(&addon, "series", &query_ids),
            prefix != "tt999:",
            "{media_type}, prefix={prefix}"
        );
        assert!(!addon_declares_stream(&addon, "movie", &query_ids));
        for (index, query_id) in query_ids.iter().enumerate() {
            let streams = if primary_empty && index == 0 {
                Vec::new()
            } else {
                vec![episode_stream(names[index])]
            };
            seed_prepared(&provider, "series", query_id, &addon, streams);
        }

        for eligibility in [None, Some(episode_eligibility(&[(2, 3), (2, 27), (1, 27)]))] {
            let outcome = fetch_addon_stream_outcome(
                &provider,
                "series",
                &query_ids,
                &addon,
                eligibility,
                None,
            )
            .await;
            assert!(outcome.error_message.is_none());
            assert_eq!(outcome.streams.len(), usize::from(expected_index.is_some()));
            assert_eq!(
                outcome
                    .streams
                    .first()
                    .and_then(|stream| stream.name.as_deref()),
                expected_index.map(|index| names[index]),
                "{media_type}, prefix={prefix}, resolve={}",
                eligibility.is_some()
            );
        }
        let link = fetch_prepared_streams_for_addon(
            &provider, "series", &query_ids, &addon, None, None, None,
        )
        .await
        .unwrap();
        assert_eq!(link.len(), usize::from(expected_index.is_some()));
        assert_eq!(
            link.first().and_then(|stream| stream.name.as_deref()),
            expected_index.map(|index| names[index]),
            "{media_type}, prefix={prefix}, link"
        );
    }
}

#[tokio::test]
async fn first_supported_stream_query_gets_the_primary_timeout() {
    use std::io::{BufRead, BufReader, Write};
    use std::time::{Duration, Instant};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let (requested, request_received) = tokio::sync::oneshot::channel();
    let (respond, response_ready) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let started = Instant::now();
        let mut socket = loop {
            match listener.accept() {
                Ok((socket, _)) => break socket,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(started.elapsed() < Duration::from_secs(10));
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(error) => panic!("{error}"),
            }
        };
        socket.set_nonblocking(false).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut reader = BufReader::new(&mut socket);
        let mut request = String::new();
        reader.read_line(&mut request).unwrap();
        loop {
            let mut header = String::new();
            reader.read_line(&mut header).unwrap();
            if header == "\r\n" || header.is_empty() {
                break;
            }
        }
        requested.send(()).unwrap();
        response_ready.recv_timeout(Duration::from_secs(2)).unwrap();
        let body = r#"{"streams":[{"url":"https://cdn.example/video.mkv"}]}"#;
        let _ = write!(
            socket,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        request
    });
    let mut addon = test_addon(&url, "Supported fallback");
    addon.capabilities = Some(AddonManifest {
        name: addon.name.clone(),
        resources: vec![AddonResourceCapability {
            name: "stream".to_string(),
            types: vec!["series".to_string()],
            id_prefixes: vec!["kitsu:123:3".to_string()],
        }],
        ..Default::default()
    });
    let ids = build_stream_query_ids("anime", "kitsu:123", Some(2), Some(3), Some(27));
    let provider = AddonTransport::new();
    let outcome = fetch_addon_stream_outcome(&provider, "series", &ids, &addon, None, None);
    tokio::pin!(outcome);
    tokio::select! {
        ready = request_received => ready.unwrap(),
        _ = &mut outcome => panic!("query completed before the delayed response"),
    }
    // Pause only after the real request arrives; resume before response I/O so
    // an idle runtime cannot auto-advance through reqwest's socket deadlines.
    tokio::time::pause();
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_secs(6)) => {}
        _ = &mut outcome => {
            panic!("the first supported query must outlive the five-second fallback timeout");
        }
    }
    tokio::time::resume();
    respond.send(()).unwrap();
    let outcome = outcome.await;
    let request = server.join().unwrap();
    assert!(request.contains(&crate::providers::encode_uri_component(&ids[1]).into_owned()));
    assert!(
        outcome.error_message.is_none(),
        "{:?}",
        outcome.error_message
    );
    assert_eq!(outcome.streams.len(), 1);
}

#[tokio::test]
async fn resolve_uses_episode_fallback_only_when_no_primary_candidate_survives() {
    let addon = test_addon("https://addon.example", "Example Addon");
    let query = series_query(2, 3, Some(27));
    let ranking = ranking_scope(None, 2, 3);
    let targets = query.episode_targets(&ranking);
    let query_ids = ["tt123:2:3".to_string(), "tt123:1:27".to_string()];
    for (label, primary, targets, expected) in [
        (
            "conflicting primary → absolute fallback",
            &["Show.S02E28"][..],
            targets.as_slice(),
            "Show.S01E27",
        ),
        (
            "mixed primary → surviving primary, not fallback",
            &["Show.S02E28", "Show.S02E03"][..],
            &[(2, 3), (2, 27), (1, 27)],
            "Show.S02E03",
        ),
    ] {
        let provider = AddonTransport::new();
        for (id, names) in query_ids.iter().zip([primary, &["Show.S01E27"][..]]) {
            seed_prepared(
                &provider,
                "series",
                id,
                &addon,
                names.iter().map(|name| episode_stream(name)).collect(),
            );
        }
        let outcome = fetch_addon_stream_outcome(
            &provider,
            "series",
            &query_ids,
            &addon,
            Some(episode_eligibility(targets)),
            None,
        )
        .await;
        assert!(outcome.error_message.is_none(), "{label}");
        assert_eq!(outcome.streams.len(), 1, "{label}");
        assert_eq!(
            outcome.streams[0].name.as_deref(),
            Some(expected),
            "{label}"
        );
    }
}

#[tokio::test]
async fn stream_audit_recovery_uses_supported_fallback_after_excluded_primary() {
    let provider = AddonTransport::new();
    let mut addon = test_addon("https://addon.example", "Example Addon");
    addon.capabilities = Some(AddonManifest {
        name: addon.name.clone(),
        resources: vec![AddonResourceCapability {
            name: "stream".to_string(),
            types: vec!["series".to_string()],
            id_prefixes: vec!["tt123:2:3".to_string(), "tt123:1:27".to_string()],
        }],
        ..Default::default()
    });
    let query_ids = [
        "tt123:2:3".to_string(),
        "tt123:2:27".to_string(),
        "tt123:1:27".to_string(),
    ];
    let primary = episode_stream("Show.S02E03");
    let fallback = AddonStream {
        url: Some("https://cdn.example/fallback.mkv".to_string()),
        ..episode_stream("Show.S01E27")
    };
    let excluded_keys = prepare_addon_streams(vec![primary.clone()], &addon.name, &addon.id)
        .into_iter()
        .map(|stream| stream.stream_key)
        .collect::<Vec<_>>();
    seed_prepared(&provider, "series", &query_ids[0], &addon, vec![primary]);
    seed_prepared(&provider, "series", &query_ids[2], &addon, vec![fallback]);
    let exclusions = StreamExclusions::new(&excluded_keys, None, None);
    let streams = fetch_prepared_streams_for_addon(
        &provider,
        "series",
        &query_ids,
        &addon,
        Some(EpisodeEligibility {
            exclusions: Some(&exclusions),
            ..episode_eligibility(&[(2, 3), (1, 27)])
        }),
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(streams.len(), 1);
    assert_eq!(streams[0].name.as_deref(), Some("Show.S01E27"));
}

#[tokio::test]
async fn stream_link_lookup_finds_a_row_owned_by_a_fallback_query_id() {
    let provider = AddonTransport::new();
    let addon = test_addon("https://addon.example", "Example Addon");
    let query_ids = ["tt123:2:3".to_string(), "tt123:1:27".to_string()];
    let fallback = AddonStream {
        url: Some("https://cdn.example/fallback.mkv".to_string()),
        ..episode_stream("Show.S01E27")
    };
    let fallback_key = prepare_addon_streams(vec![fallback.clone()], &addon.name, &addon.id)[0]
        .stream_key
        .clone();
    seed_prepared(
        &provider,
        "series",
        &query_ids[0],
        &addon,
        vec![episode_stream("Show.S02E03")],
    );
    seed_prepared(&provider, "series", &query_ids[1], &addon, vec![fallback]);

    let found = fetch_stream_for_link_from_addons(
        &provider,
        "series",
        &query_ids,
        vec![&addon],
        &fallback_key,
        None,
    )
    .await
    .unwrap();
    assert_eq!(found.map(|stream| stream.stream_key), Some(fallback_key));
}

#[tokio::test]
async fn stream_audit_late_request_alias_reopens_only_its_addon_fallback() {
    let provider = AddonTransport::new();
    let failed_addon = test_addon("https://failed.example", "Failed");
    let alias_addon = test_addon("https://alias.example", "Alias");
    let ids = ["tt123:2:3".to_string(), "tt123:1:27".to_string()];
    let failed = episode_stream("Show.S02E03");
    let failed_key =
        prepare_addon_streams(vec![failed.clone()], &failed_addon.name, &failed_addon.id)
            .remove(0)
            .stream_key;
    let alias = AddonStream {
        url: Some(format!("{}#alias", failed.url.as_deref().unwrap())),
        ..failed.clone()
    };
    let fallback = AddonStream {
        url: Some("https://cdn.example/fallback.mkv".to_string()),
        ..episode_stream("Show.S01E27")
    };
    for (addon, primary, secondary) in [
        (&failed_addon, failed, Vec::new()),
        (&alias_addon, alias, vec![fallback]),
    ] {
        seed_prepared(&provider, "series", &ids[0], addon, vec![primary]);
        seed_prepared(&provider, "series", &ids[1], addon, secondary);
    }
    let exclusions = StreamExclusions::new(&[], Some(&failed_key), None);
    let eligibility = Some(EpisodeEligibility {
        exclusions: Some(&exclusions),
        ..episode_eligibility(&[(2, 3), (1, 27)])
    });
    let early =
        fetch_addon_stream_outcome(&provider, "series", &ids, &alias_addon, eligibility, None)
            .await;
    assert_eq!(early.streams.len(), 1);
    let late =
        fetch_addon_stream_outcome(&provider, "series", &ids, &failed_addon, eligibility, None)
            .await;
    assert!(late.streams.is_empty());
    let mut outcomes = BTreeMap::from([(0, late), (1, early)]);
    let addons = [(0, &failed_addon), (1, &alias_addon)];
    let retries = recovery_addons_needing_fallback(&mut outcomes, &addons, &exclusions);
    assert_eq!(
        retries.iter().map(|(index, _)| *index).collect::<Vec<_>>(),
        [1]
    );
    for (index, addon) in retries {
        let outcome =
            fetch_addon_stream_outcome(&provider, "series", &ids, addon, eligibility, None).await;
        outcomes.insert(index, outcome);
    }
    assert_eq!(outcomes[&1].streams[0].name.as_deref(), Some("Show.S01E27"));
    assert!(recovery_addons_needing_fallback(&mut outcomes, &addons, &exclusions).is_empty());
}

#[tokio::test]
async fn selector_and_link_fetches_keep_primary_pack_rows_without_eligibility() {
    let provider = AddonTransport::new();
    let addon = test_addon("https://addon.example", "Example Addon");
    let query_ids = ["tt123:2:3".to_string(), "tt123:1:27".to_string()];
    seed_prepared(
        &provider,
        "series",
        &query_ids[0],
        &addon,
        vec![episode_stream("Show.Season.1.Complete")],
    );
    seed_prepared(
        &provider,
        "series",
        &query_ids[1],
        &addon,
        vec![episode_stream("Show.S02E03")],
    );

    let selector =
        fetch_addon_stream_outcome(&provider, "series", &query_ids, &addon, None, None).await;
    assert!(selector.error_message.is_none());
    let link =
        fetch_prepared_streams_for_addon(&provider, "series", &query_ids, &addon, None, None, None)
            .await
            .unwrap();

    for streams in [&selector.streams, &link] {
        assert_eq!(streams.len(), 1);
        assert_eq!(streams[0].name.as_deref(), Some("Show.Season.1.Complete"));
        assert!(streams[0].presentation.is_batch);
        assert!(stream_conflicts_with_episode_targets(
            streams[0].match_texts(),
            &[(2, 3)],
            None
        ));
    }
}

#[tokio::test]
async fn movie_fetches_bypass_episode_eligibility_with_no_targets() {
    let provider = AddonTransport::new();
    let addon = test_addon("https://addon.example", "Example Addon");
    let query_ids = ["tt123".to_string()];
    seed_prepared(
        &provider,
        "movie",
        &query_ids[0],
        &addon,
        vec![episode_stream("Show.Season.1.Complete")],
    );

    let outcome = fetch_addon_stream_outcome(
        &provider,
        "movie",
        &query_ids,
        &addon,
        Some(EpisodeEligibility {
            final_season: Some(2),
            ..episode_eligibility(&[])
        }),
        None,
    )
    .await;

    assert!(outcome.error_message.is_none());
    assert_eq!(outcome.streams.len(), 1);
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
fn ranking_uses_the_same_absolute_targets_as_the_conflict_gate() {
    let query = series_query(2, 3, Some(27));
    let ranking = ranking_scope(Some("Show"), 2, 3);
    let targets = query.episode_targets(&ranking);
    assert_eq!(targets, [(2, 3), (2, 27), (1, 27)]);
    let addon_priorities = HashMap::new();
    let priorities = HashMap::new();
    let inputs = StreamRecommendationInputs {
        match_context: StreamMatchContext {
            media_type: &ranking.media_type,
            title: ranking.title.as_deref(),
            episode_targets: &targets,
            canonical_season: ranking.season,
            ..match_context("series")
        },
        ..recommendation_inputs(&addon_priorities, &priorities, &priorities)
    };
    for (name, filename, admitted) in [
        ("Show S02E03", None, true),
        ("Show S02E27", None, true),
        ("Show S01E27", None, true),
        ("Show S02E28", None, false),
        ("Show S02E27", Some("Show S02E28.mkv"), false),
    ] {
        let mut stream = test_stream();
        stream.stream_key = format!("s:{name}:{filename:?}");
        stream.name = Some(name.to_string());
        stream.behavior_hints = filename.map(|filename| BehaviorHints {
            filename: Some(filename.to_string()),
            ..BehaviorHints::default()
        });
        assert_eq!(
            !stream_conflicts_with_episode_targets(stream.match_texts(), &targets, None),
            admitted,
            "{name}, filename={filename:?}"
        );
        let mut streams = vec![stream];
        sort_streams_by_recommendation(&mut streams, inputs, &mut StreamSignalCache::default());
        let expected = if admitted {
            StreamEpisodeMatchKind::Exact
        } else {
            StreamEpisodeMatchKind::None
        };
        assert_eq!(
            streams[0].selection_priority.unwrap().episode_match,
            expected,
            "{name}, filename={filename:?}"
        );
    }
}

#[test]
fn recovery_failure_overlay_replaces_positive_reputation_before_signal_caching() {
    let resolve = ResolveFetch {
        failed_source_id: Some(" FailedSource "),
        failed_stream_family: Some(" FAILED|Release:Group "),
        ..ResolveFetch::default()
    };
    let mut source_health = HashMap::from([
        ("FailedSource".to_string(), 3),
        ("HealthySource".to_string(), 2),
    ]);
    let mut preferred = Some("FailedSource".to_string());
    resolve.apply_source_failure(&mut source_health, &mut preferred);
    assert_eq!(source_health["FailedSource"], 1);
    assert_eq!(source_health["HealthySource"], 2);
    assert!(preferred.is_none());
    let families = resolve.initial_family_priorities();
    assert_eq!(families["failed|release:group"], 0);
    let addon_priorities = HashMap::new();
    let inputs = StreamRecommendationInputs {
        preferred_title_source_id: preferred.as_deref(),
        ..recommendation_inputs(&addon_priorities, &source_health, &families)
    };
    let mut failed = test_stream();
    failed.stream_key = "s:failed".to_string();
    failed.source_id = Some("FailedSource".to_string());
    failed.stream_family = Some("failed|release:group".to_string());
    let mut healthy = test_stream();
    healthy.stream_key = "s:healthy".to_string();
    healthy.source_id = Some("HealthySource".to_string());
    let mut streams = vec![failed, healthy];
    let mut cache = StreamSignalCache::default();
    for _ in 0..2 {
        sort_streams_by_recommendation(&mut streams, inputs, &mut cache);
        assert_eq!(streams[0].stream_key, "s:healthy");
        assert_eq!(
            streams[1].recommendation_reasons,
            [
                StreamRecommendationReason::SourceIssues,
                StreamRecommendationReason::ReleaseGroupCooling,
            ]
        );
    }

    // Missing failure metadata changes nothing, and a known cooldown stays active.
    source_health.insert("FailedSource".to_string(), 0);
    preferred = Some("HealthySource".to_string());
    resolve.apply_source_failure(&mut source_health, &mut preferred);
    assert_eq!(source_health["FailedSource"], 0);
    assert_eq!(preferred.as_deref(), Some("HealthySource"));
    let before = source_health.clone();
    ResolveFetch::default().apply_source_failure(&mut source_health, &mut preferred);
    assert_eq!(source_health, before);
    assert!(ResolveFetch::default()
        .initial_family_priorities()
        .is_empty());
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
            has_enabled_addons: true,
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
            has_enabled_addons: owned.has_enabled_addons,
            streams: owned.streams.iter().collect::<Vec<_>>(),
            stats: StreamSelectorStats::from_snapshot(&owned.streams, &owned.source_summaries),
            source_summaries: owned.source_summaries.iter().collect::<Vec<_>>(),
            fatal_error_message: owned.fatal_error_message.as_deref(),
        };
        let payload = serde_json::to_value(&owned).unwrap();
        assert_eq!(payload["hasEnabledAddons"], true);
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

#[tokio::test]
async fn avatar_mixed_pool_filters_work_years_before_settlement_and_merge_on_rotated_urls() {
    let provider = AddonTransport::new();
    let mut addon = test_addon("torrentio", "Torrentio");
    addon.url = "https://torrentio.example/manifest.json".into();
    let releases = [
        (
            "2024",
            "Avatar.The.Last.Airbender.2024.S01E05.2160p.NF.WEB-DL.DV.HDR",
        ),
        ("2005", "Avatar.The.Last.Airbender.2005.S01E05.1080p.BluRay"),
        (
            "2026",
            "Avatar.The.Last.Airbender.2026.S01E05.2160p.NF.WEB-DL.DV.HDR",
        ),
    ];
    let make = |signature| {
        releases
            .iter()
            .map(|(year, title)| AddonStream {
                name: Some("Torrentio\n1080p".into()),
                title: Some((*title).into()),
                url: Some(format!(
                    "https://cdn.example/{year}.mkv?signature={signature}"
                )),
                ..test_stream()
            })
            .collect()
    };
    let previous = prepare_addon_streams(make("old"), &addon.name, &addon.id);
    let preferred_stream_key = previous[0].stream_key.clone();
    let ids = vec!["tt0417299:1:5".to_string()];
    seed_prepared(&provider, "series", &ids[0], &addon, make("rotated"));
    let empty = HashMap::new();
    for resolve in [true, false] {
        let outcome = fetch_addon_stream_outcome(
            &provider,
            "series",
            &ids,
            &addon,
            Some(EpisodeEligibility {
                targets: &[(1, 5)],
                accepted_years: &[2005, 2006],
                reference_title: Some("Avatar The Last Airbender"),
                resolve,
                ..episode_eligibility(&[])
            }),
            None,
        )
        .await;
        assert!(outcome.error_message.is_none());
        assert_eq!(outcome.streams.len(), 1);
        assert!(!outcome
            .streams
            .iter()
            .any(|stream| stream.stream_key == preferred_stream_key));
        assert!(!previous
            .iter()
            .any(|previous| previous.stream_key == outcome.streams[0].stream_key));
        let mut merged = Vec::new();
        crate::commands::streaming_helpers::merge_unique_streams(
            &mut merged,
            &mut Default::default(),
            outcome.streams,
        );
        sort_streams_by_recommendation(
            &mut merged,
            StreamRecommendationInputs {
                preferred_title_source_id: Some(&addon.id),
                match_context: StreamMatchContext {
                    title: Some("Avatar The Last Airbender"),
                    accepted_years: &[2005, 2006],
                    episode_targets: &[(1, 5)],
                    canonical_season: Some(1),
                    ..match_context("series")
                },
                ..recommendation_inputs(&empty, &HashMap::new(), &HashMap::new())
            },
            &mut StreamSignalCache::default(),
        );
        assert_eq!(
            merged[0].url.as_deref(),
            Some("https://cdn.example/2005.mkv?signature=rotated")
        );
    }
    // Eligibility applies only to this fetch's owned rows, not the prepared transport cache.
    let cached =
        fetch_prepared_streams_for_addon(&provider, "series", &ids, &addon, None, None, None)
            .await
            .unwrap();
    assert_eq!(cached.len(), 3);
}
