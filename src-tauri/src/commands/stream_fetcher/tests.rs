use super::{
    addon_declares_stream, fetch_addon_stream_outcome, fetch_prepared_streams_for_addon,
    fetch_stream_for_link_from_addons, recovery_addons_needing_fallback, resolve_fetch_deadline,
    resolve_ranking_deadline, retain_rankable_streams, source_health_priority_for_addon,
    stream_match_context, summarize_addon_outcome, summarize_cooldown_skipped_addon,
    AddonStreamFetchOutcome, EpisodeEligibility, ResolveFetch, StreamQueryRequest,
    StreamRankingScope, StreamSelectorData, StreamSelectorSnapshot, StreamSelectorStats,
    StreamSourceStatus, StreamSourceSummary, ACTIVE_SOURCE_COOLDOWN_PRIORITY,
};
use crate::commands::probe_pool::{is_probeable_stream, StreamExclusions};
use crate::commands::stream_coordinator::{
    sort_streams_by_recommendation, StreamRecommendationInputs, StreamSignalCache,
};
use crate::commands::streaming_helpers::{build_stream_query_ids, prepare_addon_streams};
use crate::providers::addon_manifest::{AddonManifest, AddonResourceCapability};
use crate::providers::addons::{
    stream_conflicts_with_episode_targets, AddonStream, AddonTransport, BehaviorHints,
    StreamDeliveryKind, StreamEpisodeMatchKind, StreamRecommendationReason, StreamResolution,
};
use crate::test_helpers::{test_addon, test_stream};
use std::collections::{BTreeMap, HashMap};

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
                info_hash: Some("abc123".to_string()),
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
                info_hash: (index % 3 != 0).then(|| format!("{index:040x}")),
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
    let ranking = StreamRankingScope {
        media_type: "series".to_string(),
        media_id: "tt123".to_string(),
        title: Some("Show".to_string()),
        season: Some(1),
        episode: Some(3),
    };
    let addon_priorities = HashMap::from([("alpha".to_string(), 1), ("beta".to_string(), 2)]);
    let health = HashMap::from([("alpha".to_string(), 2), ("beta".to_string(), 3)]);
    let families = HashMap::from([
        ("alpha|release:group".to_string(), 4),
        ("beta|release:group".to_string(), 0),
    ]);
    let targets = [(1, 3)];
    for preferred_audio_language in [None, Some("en")] {
        let inputs = StreamRecommendationInputs {
            addon_source_priorities: &addon_priorities,
            source_health_priorities: &health,
            stream_family_priorities: &families,
            preferred_title_source_id: Some("beta"),
            match_context: stream_match_context(&targets, &ranking, false),
            preferred_audio_language,
            preferred_subtitle_language: None,
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
                provider.seed_stream_cache("movie", &query_ids[0], &addon.url, streams);
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
    let ranking = StreamRankingScope {
        media_type: "movie".to_string(),
        media_id: "tt123".to_string(),
        title: None,
        season: None,
        episode: None,
    };
    let addon_priorities = HashMap::new();
    let empty = HashMap::new();
    let mut inputs = StreamRecommendationInputs {
        addon_source_priorities: &addon_priorities,
        source_health_priorities: &empty,
        stream_family_priorities: &empty,
        preferred_title_source_id: None,
        match_context: stream_match_context(&[], &ranking, false),
        preferred_audio_language: None,
        preferred_subtitle_language: None,
    };
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
async fn video_id_queries_preserve_primary_fallbacks_and_source_episode_eligibility() {
    let query = StreamQueryRequest {
        media_type: "series",
        id: "tt123",
        season: Some(1),
        episode: Some(2),
        absolute_episode: Some(13),
    };
    let ranking = StreamRankingScope {
        media_type: "series".into(),
        media_id: "tt123".into(),
        title: None,
        season: Some(1),
        episode: Some(2),
    };
    let ids = query.query_ids(Some("tt999:4:12"));
    assert_eq!(ids, ["tt123:1:2", "tt999:4:12", "tt123:1:13"]);
    for duplicate in ["tt123:1:2", "tt123:1:13"] {
        assert_eq!(query.query_ids(Some(duplicate)), query.query_ids(None));
    }
    for invalid in [" \u{feff} ".to_string(), "x".repeat(257)] {
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
            provider.seed_stream_cache("series", id, &addon.url, streams);
        }
        let outcome = fetch_addon_stream_outcome(
            &provider,
            "series",
            &ids,
            &addon,
            Some(EpisodeEligibility {
                targets: &targets,
                final_season: None,
                exclusions: None,
            }),
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
            catalogs: Vec::new(),
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
            provider.seed_stream_cache("series", query_id, &addon.url, streams);
        }

        for eligibility in [
            None,
            Some(EpisodeEligibility {
                targets: &[(2, 3), (2, 27), (1, 27)],
                final_season: None,
                exclusions: None,
            }),
        ] {
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
        let link =
            fetch_prepared_streams_for_addon(&provider, "series", &query_ids, &addon, None, None)
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
        std::thread::sleep(Duration::from_secs(6));
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
        catalogs: Vec::new(),
    });
    let ids = build_stream_query_ids("anime", "kitsu:123", Some(2), Some(3), Some(27));
    let outcome =
        fetch_addon_stream_outcome(&AddonTransport::new(), "series", &ids, &addon, None, None)
            .await;
    let request = server.join().unwrap();
    assert!(request.contains(&urlencoding::encode(&ids[1]).into_owned()));
    assert!(
        outcome.error_message.is_none(),
        "{:?}",
        outcome.error_message
    );
    assert_eq!(outcome.streams.len(), 1);
}

#[tokio::test]
async fn resolve_uses_fallback_when_primary_only_has_conflicting_episodes() {
    let provider = AddonTransport::new();
    let addon = test_addon("https://addon.example", "Example Addon");
    let query = StreamQueryRequest {
        media_type: "series",
        id: "tt123",
        season: Some(2),
        episode: Some(3),
        absolute_episode: Some(27),
    };
    let ranking = StreamRankingScope {
        media_type: "series".to_string(),
        media_id: "tt123".to_string(),
        title: None,
        season: Some(2),
        episode: Some(3),
    };
    let targets = query.episode_targets(&ranking);
    let query_ids = ["tt123:2:3".to_string(), "tt123:1:27".to_string()];
    provider.seed_stream_cache(
        "series",
        &query_ids[0],
        &addon.url,
        vec![episode_stream("Show.S02E28")],
    );
    provider.seed_stream_cache(
        "series",
        &query_ids[1],
        &addon.url,
        vec![episode_stream("Show.S01E27")],
    );

    let outcome = fetch_addon_stream_outcome(
        &provider,
        "series",
        &query_ids,
        &addon,
        Some(EpisodeEligibility {
            targets: &targets,
            final_season: None,
            exclusions: None,
        }),
        None,
    )
    .await;

    assert!(outcome.error_message.is_none());
    assert_eq!(outcome.streams.len(), 1);
    assert_eq!(outcome.streams[0].name.as_deref(), Some("Show.S01E27"));
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
        catalogs: Vec::new(),
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
    provider.seed_stream_cache("series", &query_ids[0], &addon.url, vec![primary]);
    provider.seed_stream_cache("series", &query_ids[2], &addon.url, vec![fallback]);
    let exclusions = StreamExclusions::new(&excluded_keys, None, None);
    let streams = fetch_prepared_streams_for_addon(
        &provider,
        "series",
        &query_ids,
        &addon,
        Some(EpisodeEligibility {
            targets: &[(2, 3), (1, 27)],
            final_season: None,
            exclusions: Some(&exclusions),
        }),
        None,
    )
    .await
    .unwrap();
    assert_eq!(streams.len(), 1);
    assert_eq!(streams[0].name.as_deref(), Some("Show.S01E27"));
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
        provider.seed_stream_cache("series", &ids[0], &addon.url, vec![primary]);
        provider.seed_stream_cache("series", &ids[1], &addon.url, secondary);
    }
    let exclusions = StreamExclusions::new(&[], Some(&failed_key), None);
    let eligibility = Some(EpisodeEligibility {
        targets: &[(2, 3), (1, 27)],
        final_season: None,
        exclusions: Some(&exclusions),
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
async fn resolve_stops_at_primary_when_any_episode_candidate_survives() {
    let provider = AddonTransport::new();
    let addon = test_addon("https://addon.example", "Example Addon");
    let query_ids = ["tt123:2:3".to_string(), "tt123:1:27".to_string()];
    provider.seed_stream_cache(
        "series",
        &query_ids[0],
        &addon.url,
        vec![episode_stream("Show.S02E28"), episode_stream("Show.S02E03")],
    );
    provider.seed_stream_cache(
        "series",
        &query_ids[1],
        &addon.url,
        vec![episode_stream("Show.S01E27")],
    );

    let outcome = fetch_addon_stream_outcome(
        &provider,
        "series",
        &query_ids,
        &addon,
        Some(EpisodeEligibility {
            targets: &[(2, 3), (2, 27), (1, 27)],
            final_season: None,
            exclusions: None,
        }),
        None,
    )
    .await;

    assert!(outcome.error_message.is_none());
    assert_eq!(outcome.streams.len(), 1);
    assert_eq!(outcome.streams[0].name.as_deref(), Some("Show.S02E03"));
}

#[tokio::test]
async fn selector_and_link_fetches_keep_primary_pack_rows_without_eligibility() {
    let provider = AddonTransport::new();
    let addon = test_addon("https://addon.example", "Example Addon");
    let query_ids = ["tt123:2:3".to_string(), "tt123:1:27".to_string()];
    provider.seed_stream_cache(
        "series",
        &query_ids[0],
        &addon.url,
        vec![episode_stream("Show.Season.1.Complete")],
    );
    provider.seed_stream_cache(
        "series",
        &query_ids[1],
        &addon.url,
        vec![episode_stream("Show.S02E03")],
    );

    let selector =
        fetch_addon_stream_outcome(&provider, "series", &query_ids, &addon, None, None).await;
    assert!(selector.error_message.is_none());
    let link =
        fetch_prepared_streams_for_addon(&provider, "series", &query_ids, &addon, None, None)
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
    provider.seed_stream_cache(
        "movie",
        &query_ids[0],
        &addon.url,
        vec![episode_stream("Show.Season.1.Complete")],
    );

    let outcome = fetch_addon_stream_outcome(
        &provider,
        "movie",
        &query_ids,
        &addon,
        Some(EpisodeEligibility {
            targets: &[],
            final_season: Some(2),
            exclusions: None,
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
    let query = StreamQueryRequest {
        media_type: "series",
        id: "tt123",
        season: Some(2),
        episode: Some(3),
        absolute_episode: Some(27),
    };
    let ranking = StreamRankingScope {
        media_type: "series".to_string(),
        media_id: "tt123".to_string(),
        title: Some("Show".to_string()),
        season: Some(2),
        episode: Some(3),
    };
    let targets = query.episode_targets(&ranking);
    assert_eq!(targets, [(2, 3), (2, 27), (1, 27)]);
    let context = stream_match_context(&targets, &ranking, false);
    let addon_priorities = HashMap::new();
    let priorities = HashMap::new();
    let inputs = StreamRecommendationInputs {
        addon_source_priorities: &addon_priorities,
        source_health_priorities: &priorities,
        stream_family_priorities: &priorities,
        preferred_title_source_id: None,
        match_context: context,
        preferred_audio_language: None,
        preferred_subtitle_language: None,
    };
    for (name, filename, admitted) in [
        ("Show S02E03", None, true),
        ("Show S02E27", None, true),
        ("Show S01E27", None, true),
        ("Show S02E28", None, false),
        ("Show S02E27", Some("Show S02E28.mkv"), false),
    ] {
        let mut stream = test_stream();
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
    let ranking = StreamRankingScope {
        media_type: "movie".to_string(),
        media_id: "tt123".to_string(),
        title: None,
        season: None,
        episode: None,
    };
    let addon_priorities = HashMap::new();
    let inputs = StreamRecommendationInputs {
        addon_source_priorities: &addon_priorities,
        source_health_priorities: &source_health,
        stream_family_priorities: &families,
        preferred_title_source_id: preferred.as_deref(),
        match_context: stream_match_context(&[], &ranking, false),
        preferred_audio_language: None,
        preferred_subtitle_language: None,
    };
    let mut failed = test_stream();
    failed.stream_key = "s:failed".to_string();
    failed.source_id = Some("FailedSource".to_string());
    failed.stream_family = Some("FAILED|Release:Group".to_string());
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
            streams: owned.streams.iter().collect::<Vec<_>>(),
            stats: StreamSelectorStats::from_snapshot(&owned.streams, &owned.source_summaries),
            source_summaries: owned.source_summaries.iter().collect::<Vec<_>>(),
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
