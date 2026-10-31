use super::{
    build_candidate_input, build_probe_candidates, find_preferred_position, probe_candidate,
    resolve_candidate_results, resolve_probe_candidates, CandidateProbeResult, PreferredStreamHint,
    ProbeError, ProbeRequestIdentity, ResolveStreamErrorKind, ResolvedStream, StreamExclusions,
    StreamPoolQuery, StreamResolveCandidateInput, BEST_STREAM_MAX_CANDIDATES,
    BEST_STREAM_PROBE_CONCURRENCY, SAME_HOST_PROBE_SPACING,
};
use crate::commands::stream_fetcher::StreamRankingOverrides;
use crate::providers::addons::{
    stream_conflicts_with_episode_targets, AddonStream, SelectionPriority, StreamEpisodeMatchKind,
};
use crate::test_helpers::test_stream;
use futures_util::stream::FuturesOrdered;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Probeable row with an explicit prepared key and an optional content hash
/// (the hash feeds `stream_dedup_key` for the legacy-key tier).
fn probeable_stream(stream_key: &str, content_hash: Option<&str>) -> AddonStream {
    AddonStream {
        url: Some("https://cdn.example/file.mkv".to_string()),
        content_hash: content_hash.map(str::to_string),
        stream_key: stream_key.to_string(),
        ..test_stream()
    }
}

#[test]
fn candidate_input_moves_identity_and_preserves_probe_fields() {
    let mut stream = probeable_stream("s:prepared", None);
    stream.url = Some("HTTPS://CDN.EXAMPLE/file.mkv".to_string());
    stream.source_id = Some("addon-instance".to_string());
    stream.source_name = Some("Addon Name".to_string());
    stream.stream_family = Some("release:group".to_string());
    stream.behavior_hints = Some(
        serde_json::from_value(serde_json::json!({
            "proxyHeaders": {"request": {"Referer": "https://site.example/"}}
        }))
        .unwrap(),
    );
    let identity = [
        stream.source_id.as_ref().unwrap().as_ptr(),
        stream.source_name.as_ref().unwrap().as_ptr(),
        stream.stream_family.as_ref().unwrap().as_ptr(),
        stream.stream_key.as_ptr(),
    ];

    let candidate = build_candidate_input(stream).unwrap();
    assert_eq!(
        [
            candidate.source_id.as_ref().unwrap().as_ptr(),
            candidate.source_name.as_ref().unwrap().as_ptr(),
            candidate.stream_family.as_ref().unwrap().as_ptr(),
            candidate.stream_key.as_ptr(),
        ],
        identity
    );
    assert_eq!(
        candidate.direct_url.as_str(),
        "https://cdn.example/file.mkv"
    );
    assert_eq!(
        candidate.request_headers,
        vec![("Referer".to_string(), "https://site.example/".to_string())]
    );

    for url in [
        "http://127.0.0.1/video",
        "https://user:secret@cdn.example/video",
        "magnet:?xt=urn:btih:ABC123",
    ] {
        let mut stream = probeable_stream("s:rejected", None);
        stream.url = Some(url.to_string());
        assert!(build_candidate_input(stream).is_none(), "{url}");
    }
}

#[test]
fn probe_plan_caps_preferred_pool_and_staggers_each_host() {
    let streams = (0..BEST_STREAM_MAX_CANDIDATES + 4)
        .map(|index| {
            let mut stream = probeable_stream(&format!("s:{index}"), None);
            let host = if index == 1 {
                "other.example"
            } else {
                "cdn.example"
            };
            stream.url = Some(format!("https://{host}/{index}.mkv"));
            stream
        })
        .collect();
    let plan = build_probe_candidates(streams, hint("s:10"));
    assert_eq!(plan.len(), BEST_STREAM_MAX_CANDIDATES);
    assert_eq!(
        plan.iter()
            .map(|(candidate, ..)| candidate.stream_key.as_str())
            .collect::<Vec<_>>(),
        std::iter::once(10)
            .chain((0..BEST_STREAM_MAX_CANDIDATES + 4).filter(|index| *index != 10))
            .take(BEST_STREAM_MAX_CANDIDATES)
            .map(|index| format!("s:{index}"))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        plan.iter().map(|(_, delay, ..)| *delay).collect::<Vec<_>>(),
        [0, 1, 0]
            .into_iter()
            .chain(2..BEST_STREAM_MAX_CANDIDATES as u32 - 1)
            .map(|slot| SAME_HOST_PROBE_SPACING * slot)
            .collect::<Vec<_>>()
    );
}

#[test]
fn probe_plan_deduplicates_requests_without_collapsing_auth_or_spending_slots_on_exclusions() {
    let mut preferred = probeable_stream("s:preferred", None);
    preferred.url = Some("HTTPS://CDN.EXAMPLE/file.mkv".to_string());
    let mut authenticated = probeable_stream("s:auth", None);
    authenticated.behavior_hints = Some(
        serde_json::from_value(serde_json::json!({
            "proxyHeaders": {"request": {"Authorization": "Bearer fixture"}}
        }))
        .unwrap(),
    );
    let mut excluded_url = probeable_stream("s:excluded-url", None);
    excluded_url.url = Some("https://cdn.example/excluded.mkv".to_string());
    let mut streams = vec![
        probeable_stream("s:duplicate", None),
        probeable_stream("s:excluded-key", Some("ABC123")),
        excluded_url,
        authenticated,
        preferred,
    ];
    StreamExclusions::new(
        &[],
        Some("h:abc123:0"),
        Some("https://cdn.example/excluded.mkv"),
    )
    .retain(&mut streams);
    let plan = build_probe_candidates(streams, hint("s:preferred"));
    assert_eq!(plan.len(), 2);
    assert_eq!(plan[0].0.stream_key, "s:preferred");
    assert_eq!(plan[1].0.stream_key, "s:auth");
    assert!(plan[0].0.request_headers.is_empty());
    assert_eq!(plan[1].0.request_headers.len(), 1);
}

#[test]
fn probe_plan_ignores_fragment_aliases_without_losing_player_hints_or_request_variants() {
    let mut streams: Vec<_> = (0..BEST_STREAM_MAX_CANDIDATES)
        .map(|index| {
            let mut stream = probeable_stream(&format!("s:{index}"), None);
            stream.url = Some(format!("https://cdn.example/dead.mkv#hint{index}.mkv"));
            stream
        })
        .collect();
    let mut healthy = probeable_stream("s:healthy", None);
    healthy.url = Some("https://cdn.example/healthy.mkv#container.mkv".to_string());
    streams.push(healthy);
    let mut authenticated = streams[0].clone();
    authenticated.stream_key = "s:auth".to_string();
    authenticated.behavior_hints = Some(
        serde_json::from_value(serde_json::json!({
            "proxyHeaders": {"request": {"Authorization": "Bearer fixture"}}
        }))
        .unwrap(),
    );
    streams.push(authenticated);
    let mut query_variant = streams[0].clone();
    query_variant.stream_key = "s:query".to_string();
    query_variant.url = Some("https://cdn.example/dead.mkv?token=other#hint.mkv".to_string());
    streams.push(query_variant);

    let plan = build_probe_candidates(streams.clone(), PreferredStreamHint::default());
    assert_eq!(
        plan.iter()
            .map(|(candidate, ..)| candidate.stream_key.as_str())
            .collect::<Vec<_>>(),
        ["s:0", "s:healthy", "s:auth", "s:query"]
    );
    assert_eq!(plan[0].0.direct_url.fragment(), Some("hint0.mkv"));
    assert_eq!(plan[1].0.direct_url.fragment(), Some("container.mkv"));

    StreamExclusions::new(&[], Some("s:0"), None).retain(&mut streams);
    let recovery = build_probe_candidates(streams, PreferredStreamHint::default());
    assert_eq!(
        recovery
            .iter()
            .map(|(candidate, ..)| candidate.stream_key.as_str())
            .collect::<Vec<_>>(),
        ["s:healthy", "s:auth", "s:query"]
    );
}

#[test]
fn probe_plan_deduplicates_header_names_without_changing_values_or_duplicates() {
    let streams = [
        (
            "s:first",
            serde_json::json!({
                "Authorization": "Bearer fixture", "X-Tag": "first", "x-tag": "second"
            }),
        ),
        (
            "s:case-duplicate",
            serde_json::json!({
                "authorization": "Bearer fixture", "X-TAG": "second", "x-tag": "first"
            }),
        ),
        (
            "s:different-value",
            serde_json::json!({
                "Authorization": "Bearer Fixture", "X-Tag": "first", "x-tag": "second"
            }),
        ),
        (
            "s:missing-duplicate",
            serde_json::json!({"authorization": "Bearer fixture", "X-Tag": "first"}),
        ),
        (
            "s:different-duplicate",
            serde_json::json!({
                "authorization": "Bearer fixture", "X-Tag": "first", "x-tag": "first"
            }),
        ),
    ]
    .into_iter()
    .map(|(key, headers)| {
        let mut stream = probeable_stream(key, None);
        stream.behavior_hints = Some(
            serde_json::from_value(serde_json::json!({"proxyHeaders": {"request": headers}}))
                .unwrap(),
        );
        stream
    })
    .collect::<Vec<_>>();
    let original_headers = streams[0].request_headers();

    let plan = build_probe_candidates(streams, PreferredStreamHint::default());

    assert_eq!(
        plan.iter()
            .map(|(candidate, ..)| candidate.stream_key.as_str())
            .collect::<Vec<_>>(),
        [
            "s:first",
            "s:different-value",
            "s:missing-duplicate",
            "s:different-duplicate"
        ]
    );
    assert_eq!(plan[0].0.request_headers, original_headers);
    assert_eq!(
        plan.iter().map(|(_, delay, ..)| *delay).collect::<Vec<_>>(),
        [0, 1, 2, 3].map(|slot| SAME_HOST_PROBE_SPACING * slot)
    );
}

#[test]
fn recovery_probe_plan_excludes_failed_requests_without_collapsing_auth_variants() {
    let streams: Vec<_> = [
        (
            "s:failed",
            serde_json::json!({
                "Authorization": "Bearer first", "Referer": "https://site.example/first"
            }),
        ),
        (
            "s:alias",
            serde_json::json!({
                "authorization": "Bearer first", "referer": "https://site.example/first"
            }),
        ),
        (
            "s:different-auth",
            serde_json::json!({
                "Authorization": "Bearer second", "Referer": "https://site.example/first"
            }),
        ),
        (
            "s:different-referer",
            serde_json::json!({
                "Authorization": "Bearer first", "Referer": "https://site.example/second"
            }),
        ),
    ]
    .into_iter()
    .map(|(key, headers)| {
        let mut stream = probeable_stream(key, None);
        stream.behavior_hints = Some(
            serde_json::from_value(serde_json::json!({"proxyHeaders": {"request": headers}}))
                .unwrap(),
        );
        stream
    })
    .collect();

    for (failed_key, expected) in [
        (
            Some("s:failed"),
            vec!["s:different-auth", "s:different-referer"],
        ),
        (
            Some(" s:failed "),
            vec!["s:different-auth", "s:different-referer"],
        ),
        (
            Some("s:expired"),
            vec!["s:failed", "s:different-auth", "s:different-referer"],
        ),
        (None, vec![]),
        (Some("h:legacy:0"), vec![]),
    ] {
        let mut admitted = streams.clone();
        StreamExclusions::new(&[], failed_key, Some("https://cdn.example/file.mkv"))
            .retain(&mut admitted);
        let plan = build_probe_candidates(admitted, PreferredStreamHint::default());
        assert_eq!(
            plan.iter()
                .map(|(candidate, ..)| candidate.stream_key.as_str())
                .collect::<Vec<_>>(),
            expected,
            "{failed_key:?}"
        );
        for (candidate, ..) in plan {
            let original = streams
                .iter()
                .find(|stream| stream.stream_key == candidate.stream_key)
                .unwrap();
            assert_eq!(candidate.request_headers, original.request_headers());
        }
    }
}

#[test]
fn recovery_exclusions_cover_the_chain_and_request_aliases_but_keep_distinct_auth() {
    let stream = |key: &str, path: &str, headers: serde_json::Value| AddonStream {
        url: Some(format!("https://cdn.example/{path}")),
        behavior_hints: Some(
            serde_json::from_value(serde_json::json!({"proxyHeaders": {"request": headers}}))
                .unwrap(),
        ),
        ..probeable_stream(key, None)
    };
    let first = stream(
        "s:older",
        "old.mkv#first",
        serde_json::json!({
            "Authorization": "Bearer first", "X-Custom": "one"
        }),
    );
    let latest = stream("s:latest", "latest.mkv", serde_json::json!({}));
    let keys = vec![" s:older ".to_string(), "s:missing".to_string()];
    let exclusions = StreamExclusions::new(
        &keys,
        Some("s:latest"),
        Some("https://cdn.example/latest.mkv"),
    );
    let mut known = vec![first, latest];
    exclusions.retain(&mut known);
    assert!(known.is_empty());
    let mut aliases = vec![
        stream(
            "s:older-alias",
            "old.mkv#second",
            serde_json::json!({
                "x-custom": "one", "authorization": "Bearer first"
            }),
        ),
        stream("s:latest-alias", "latest.mkv#second", serde_json::json!({})),
        stream(
            "s:auth",
            "old.mkv#third",
            serde_json::json!({
                "Authorization": "Bearer second", "X-Custom": "one"
            }),
        ),
        stream(
            "s:duplicate-header",
            "old.mkv",
            serde_json::json!({
                "Authorization": "Bearer first", "authorization": "Bearer first", "X-Custom": "one"
            }),
        ),
        stream(
            "s:value-case",
            "old.mkv",
            serde_json::json!({
                "Authorization": "bearer first", "X-Custom": "one"
            }),
        ),
    ];
    exclusions.retain(&mut aliases);
    assert_eq!(
        aliases
            .iter()
            .map(|stream| stream.stream_key.as_str())
            .collect::<Vec<_>>(),
        ["s:auth", "s:duplicate-header", "s:value-case"]
    );
    let mut legacy = vec![probeable_stream("s:legacy", Some("ABC123"))];
    StreamExclusions::new(&[], Some("h:abc123:0"), None).retain(&mut legacy);
    assert!(legacy.is_empty());
    let mut url_only = vec![stream("s:url", "old.mkv#player", serde_json::json!({}))];
    StreamExclusions::new(&[], None, Some("https://cdn.example/old.mkv#failed"))
        .retain(&mut url_only);
    assert!(url_only.is_empty());
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

fn priority(
    episode_match: StreamEpisodeMatchKind,
    season_claim_verified: bool,
    title_match: i8,
    language: u8,
) -> Option<SelectionPriority> {
    Some(SelectionPriority {
        episode_match,
        season_claim_verified,
        title_match,
        viability: 1,
        language,
    })
}

macro_rules! preferred_position_tests {
    ($($name:ident: ($streams:expr, $preferred:expr, $excluded:expr) => $expected:expr;)*) => {
        $(
            #[test]
            fn $name() {
                let mut streams = $streams;
                StreamExclusions::new(&[], $excluded, None).retain(&mut streams);
                assert_eq!(find_preferred_position(&streams, $preferred), $expected);
            }
        )*
    };
}

preferred_position_tests! {
    preferred_position_matches_prepared_stream_key:
        (pair(), hint("s:bbbb"), None) => Some(1);
    // Legacy `h:` keys bind through dedup identity, not prepared-key equality.
    preferred_position_matches_legacy_dedup_key:
        (vec![
            probeable_stream("s:prepared-1", None),
            probeable_stream("s:prepared-2", Some("ABC123")),
        ], hint("h:abc123:0"), None) => Some(1);
    preferred_position_skips_excluded_key:
        (pair(), hint("s:aaaa"), Some("s:aaaa")) => None;
    preferred_position_ignores_key_hits_without_direct_url:
        (vec![AddonStream {
            url: None,
            content_hash: Some("abc123".to_string()),
            stream_key: "s:prepared".to_string(),
            ..test_stream()
        }], hint("h:abc123:0"), None) => None;
    preferred_position_falls_through_key_miss_to_family:
        ({
            let mut streams = pair();
            streams[1].stream_family = Some("alpha|release:test".to_string());
            streams
        }, PreferredStreamHint {
            stream_family: Some("alpha|release:test"),
            ..hint("s:rotted")
        }, None) => Some(1);
    preferred_position_excluded_stream_does_not_rebind_by_family:
        ({
            let mut streams = pair();
            streams[0].stream_family = Some("alpha|release:x".to_string());
            streams
        }, PreferredStreamHint {
            stream_family: Some("alpha|release:x"),
            ..hint("s:rotted")
        }, Some("s:aaaa")) => None;
    preferred_position_excluded_stream_does_not_rebind_by_source:
        ({
            let mut streams = pair();
            streams[0].source_name = Some("alpha".to_string());
            streams
        }, PreferredStreamHint {
            source_name: Some("alpha"),
            ..hint("s:rotted")
        }, Some("s:aaaa")) => None;
    preferred_position_excluded_stream_does_not_rebind_by_legacy_hash:
        ({
            let mut excluded = probeable_stream("s:prepared", Some("ABC123"));
            excluded.stream_family = Some("alpha|release:x".to_string());
            vec![excluded, probeable_stream("s:bbbb", None)]
        }, PreferredStreamHint {
            stream_family: Some("alpha|release:x"),
            ..hint("s:rotted")
        }, Some("h:abc123:0")) => None;
    preferred_position_falls_back_to_source_name:
        ({
            let mut streams = pair();
            streams[1].source_name = Some("alpha".to_string());
            streams
        }, PreferredStreamHint {
            source_name: Some("alpha"),
            ..hint("s:rotted")
        }, None) => Some(1);
    preferred_position_source_id_miss_does_not_fall_through_to_name:
        (vec![AddonStream {
            source_id: Some("addon-a".to_string()),
            source_name: Some("shared".to_string()),
            ..probeable_stream("s:aaaa", None)
        }], PreferredStreamHint {
            source_id: Some("addon-b"),
            source_name: Some("shared"),
            ..PreferredStreamHint::default()
        }, None) => None;
}

#[test]
fn preferred_position_legacy_resume_family_falls_back_to_source_id() {
    use crate::commands::resume_store::ResumeStore;
    use crate::commands::streaming_helpers::prepare_addon_streams;
    use crate::test_helpers::{test_progress, test_store};

    let fixture = test_store();
    let mut resume_store = ResumeStore::open(&fixture.path).unwrap();
    let progress = crate::commands::WatchProgress {
        last_stream_key: Some("s:expired".to_string()),
        source_id: Some("addon-b".to_string()),
        source_name: Some("Shared".to_string()),
        stream_family: Some("shared|release:show".to_string()),
        ..test_progress()
    };
    resume_store
        .upsert_progress("movie:tt123", &progress)
        .unwrap();
    let row = resume_store.get_entry("movie:tt123").unwrap().unwrap();
    let mut streams = Vec::new();
    for source_id in ["addon-a", "addon-b"] {
        streams.extend(prepare_addon_streams(
            vec![probeable_stream("s:unprepared", None)],
            "Shared",
            source_id,
        ));
    }
    assert!(streams
        .iter()
        .all(|stream| stream.stream_family != row.stream_family));
    let preferred = PreferredStreamHint {
        stream_key: row.last_stream_key.as_deref(),
        source_id: row.source_id.as_deref(),
        source_name: row.source_name.as_deref(),
        stream_family: row.stream_family.as_deref(),
    };
    assert_eq!(find_preferred_position(&streams, preferred), Some(1));
    assert_eq!(
        resume_store
            .get_entry("movie:tt123")
            .unwrap()
            .unwrap()
            .stream_family
            .as_deref(),
        Some("shared|release:show")
    );
}

preferred_position_tests! {
    preferred_position_family_tier_requires_same_source_id:
        ({
            let mut streams = pair();
            for (stream, source_id) in streams.iter_mut().zip(["addon-a", "addon-b"]) {
                stream.stream_family = Some("alpha|release:x".to_string());
                stream.source_id = Some(source_id.to_string());
            }
            streams
        }, PreferredStreamHint {
            stream_family: Some("alpha|release:x"),
            source_id: Some("addon-b"),
            ..PreferredStreamHint::default()
        }, None) => Some(1);
    preferred_position_family_hint_cannot_drop_below_best_episode_match:
        ({
            let mut streams = pair();
            streams[0].selection_priority = priority(StreamEpisodeMatchKind::Exact, true, 4, 0);
            streams[1].stream_family = Some("alpha|release:x".to_string());
            streams[1].selection_priority = priority(StreamEpisodeMatchKind::None, false, 4, 0);
            streams
        }, PreferredStreamHint {
            stream_family: Some("alpha|release:x"),
            ..hint("s:rotted")
        }, None) => None;
    preferred_position_source_hint_cannot_drop_below_best_language_match:
        ({
            let mut streams = pair();
            streams[0].selection_priority = priority(StreamEpisodeMatchKind::Exact, true, 4, 6);
            streams[1].source_id = Some("addon-a".to_string());
            streams[1].selection_priority = priority(StreamEpisodeMatchKind::Exact, true, 4, 0);
            streams
        }, PreferredStreamHint {
            source_id: Some("addon-a"),
            ..hint("s:rotted")
        }, None) => None;
    preferred_position_family_hint_allowed_at_equal_priority:
        ({
            let mut streams = pair();
            streams[0].selection_priority = priority(StreamEpisodeMatchKind::Exact, true, 4, 6);
            streams[1].stream_family = Some("alpha|release:x".to_string());
            streams[1].selection_priority = streams[0].selection_priority;
            streams
        }, PreferredStreamHint {
            stream_family: Some("alpha|release:x"),
            ..hint("s:rotted")
        }, None) => Some(1);
    preferred_position_exact_key_honored_below_best_priority:
        ({
            let mut streams = pair();
            streams[0].selection_priority = priority(StreamEpisodeMatchKind::Exact, true, 4, 6);
            streams[1].selection_priority = priority(StreamEpisodeMatchKind::None, false, 0, 0);
            streams
        }, hint("s:bbbb"), None) => Some(1);
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
fn stream_pool_query_preserves_composed_ipc_trimming() {
    let query = |media_type: &str, id: &str| {
        StreamPoolQuery::new(
            media_type,
            id,
            None,
            None,
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
        .map(|query| (query.media_type, query.id))
    };
    for (prefix, suffix, valid) in [
        (" \t\u{feff}\u{a0}", "\u{2028}\u{feff}\r\n ", true),
        ("\u{feff}\u{85}", "\u{85}\u{feff}", true),
        ("\u{85}\u{feff}", "\u{feff}\u{85}", false),
    ] {
        let media_type = format!("{prefix}MoViE{suffix}");
        let id = format!("{prefix}tt123{suffix}");
        let actual = query(&media_type, &id);
        assert_eq!(
            actual,
            query(
                crate::commands::js_trim(&media_type),
                crate::commands::js_trim(&id)
            )
        );
        assert_eq!(actual.is_ok(), valid);
        if valid {
            assert_eq!(actual.unwrap(), ("movie".to_string(), "tt123".to_string()));
        }
    }
}

/// Keys that survive the fetch-time episode gate for `query.request(fetch_id)`.
fn eligible_keys(query: &StreamPoolQuery, streams: &[AddonStream], fetch_id: &str) -> Vec<String> {
    let targets = query.request(fetch_id).episode_targets(&query.ranking);
    streams
        .iter()
        .filter(|stream| {
            !stream_conflicts_with_episode_targets(stream.match_texts(), &targets, None)
        })
        .map(|stream| stream.stream_key.clone())
        .collect()
}

fn named_stream(key: &str, name: &str) -> AddonStream {
    let mut stream = probeable_stream(key, None);
    stream.name = Some(name.to_string());
    stream
}

#[test]
fn episode_targets_drop_conflicting_claims_and_keep_order() {
    let query = pool_query("series", Some(1), Some(5));
    let streams = [
        named_stream("s:good", "Show.S01E05.1080p"),
        named_stream("s:unknown", "Show.1080p.Release"),
        named_stream("s:bad", "Show.S02E05.1080p"),
    ];

    assert_eq!(
        eligible_keys(&query, &streams, &query.id),
        ["s:good", "s:unknown"]
    );
}

#[test]
fn episode_targets_keep_queried_absolute_episode_fallbacks() {
    for media_type in ["series", "anime"] {
        let mut query = pool_query(media_type, Some(2), Some(3));
        query.absolute_episode = Some(27);
        let streams = [(2, 3), (2, 27), (1, 27), (1, 28)].map(|(season, episode)| {
            named_stream(
                &format!("s:{season}:{episode}"),
                &format!("Show.S{season:02}E{episode:02}.1080p"),
            )
        });

        assert_eq!(
            eligible_keys(&query, &streams, &query.id),
            ["s:2:3", "s:2:27", "s:1:27"],
            "{media_type}"
        );
    }
}

#[test]
fn episode_targets_limit_absolute_fallbacks_to_the_fetch_id() {
    for (media_type, id, fetch_id, absolute_episode, retained) in [
        ("series", "tt123", "tt123", Some(27), 1),
        ("series", "tt123", "tt123", None, 0),
        ("series", "tt123", "tt123", Some(3), 0),
        ("series", "tt123", "kitsu:123", Some(27), 0),
        ("anime", "kitsu:123", "tt123", Some(27), 1),
        ("anime", "kitsu:123", "kitsu:123", Some(27), 0),
    ] {
        let mut query = pool_query(media_type, Some(2), Some(3));
        query.id = id.to_string();
        query.absolute_episode = absolute_episode;
        let streams = [named_stream("s:absolute", "Show.S01E27.1080p")];

        assert_eq!(
            eligible_keys(&query, &streams, fetch_id).len(),
            retained,
            "{media_type} {id} {fetch_id} {absolute_episode:?}"
        );
    }
}

#[test]
fn excluded_legacy_key_filters_matching_pool_candidate() {
    let mut stream = probeable_stream("s:prepared", Some("ABC123"));
    stream.source_name = Some("alpha".to_string());

    let mut streams = vec![stream];
    StreamExclusions::new(&[], Some("h:abc123:0"), None).retain(&mut streams);
    assert!(build_probe_candidates(streams, PreferredStreamHint::default()).is_empty());
}

fn candidate_input(source_name: &str, stream_key: &str) -> StreamResolveCandidateInput {
    StreamResolveCandidateInput {
        pool_fetched_at: None,
        source_id: None,
        source_name: Some(source_name.to_string()),
        stream_family: None,
        stream_key: stream_key.to_string(),
        direct_url: reqwest::Url::parse(&format!("https://cdn.example/{stream_key}.mkv")).unwrap(),
        request_headers: Vec::new(),
    }
}

fn resolved(url: &str) -> ResolvedStream {
    ResolvedStream {
        url: url.to_string(),
        mpv_http_header_fields: String::new(),
    }
}

type FakeProbeInner = Pin<Box<dyn Future<Output = Result<ResolvedStream, ProbeError>>>>;

#[derive(Default)]
struct ProbeActivity {
    started: AtomicUsize,
    active: AtomicUsize,
    peak: AtomicUsize,
}

impl ProbeActivity {
    fn enter(self: &Arc<Self>) -> ActiveProbe {
        self.started.fetch_add(1, Ordering::SeqCst);
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak.fetch_max(active, Ordering::SeqCst);
        ActiveProbe(self.clone())
    }
}

struct ActiveProbe(Arc<ProbeActivity>);

impl Drop for ActiveProbe {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}

fn refill_probe_plan(
    count: usize,
) -> Vec<(StreamResolveCandidateInput, Duration, ProbeRequestIdentity)> {
    let mut streams: Vec<_> = (0..count)
        .map(|index| {
            let mut stream = probeable_stream(&format!("s:{index}"), None);
            stream.url = Some(format!("https://cdn{index}.example/{index}.mkv"));
            stream
        })
        .collect();
    let mut alias = streams[0].clone();
    alias.stream_key = "s:alias".to_string();
    alias.url.as_mut().unwrap().push_str("#filename.mkv");
    streams.insert(1, alias);
    build_probe_candidates(streams, PreferredStreamHint::default())
}

#[tokio::test]
async fn probe_pool_refills_eight_failed_slots_and_resolves_ninth_request() {
    let activity = Arc::new(ProbeActivity::default());
    let probes = activity.clone();
    let barrier = Arc::new(tokio::sync::Barrier::new(BEST_STREAM_PROBE_CONCURRENCY));
    let plan = refill_probe_plan(9);
    assert_eq!(plan.len(), 9);
    let winner = resolve_probe_candidates(
        plan,
        None,
        None,
        tokio::time::Instant::now() + Duration::from_secs(1),
        None,
        move |candidate, _, deadline| {
            let activity = probes.clone();
            let barrier = barrier.clone();
            async move {
                let _active = activity.enter();
                let result = tokio::time::timeout_at(deadline, async {
                    if candidate.stream_key == "s:8" {
                        Ok(resolved("https://cdn.example/healthy.mkv"))
                    } else {
                        barrier.wait().await;
                        Err("fast failure".to_string().into())
                    }
                })
                .await;
                (candidate, result)
            }
        },
    )
    .await
    .expect("the ninth distinct request remains eligible");
    assert_eq!(winner.stream_key.as_deref(), Some("s:8"));
    assert_eq!(activity.started.load(Ordering::SeqCst), 9);
    assert_eq!(
        activity.peak.load(Ordering::SeqCst),
        BEST_STREAM_PROBE_CONCURRENCY
    );
    assert_eq!(activity.active.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn probe_pool_refills_behind_pending_higher_rank_without_changing_the_winner() {
    for first_succeeds in [false, true] {
        let ninth_started = Arc::new(tokio::sync::Notify::new());
        let winner = resolve_probe_candidates(
            refill_probe_plan(9),
            None,
            Some("https://cdn.example/excluded.mkv#old"),
            tokio::time::Instant::now() + Duration::from_secs(1),
            None,
            move |candidate, _, deadline| {
                let ninth_started = ninth_started.clone();
                async move {
                    let result = tokio::time::timeout_at(deadline, async {
                        match candidate.stream_key.as_str() {
                            "s:0" => {
                                ninth_started.notified().await;
                                if first_succeeds {
                                    Ok(resolved("https://cdn.example/first.mkv"))
                                } else {
                                    Err("first failed".to_string().into())
                                }
                            }
                            "s:1" => Ok(resolved("https://cdn.example/excluded.mkv#new")),
                            "s:8" => {
                                ninth_started.notify_one();
                                Ok(resolved("https://cdn.example/ninth.mkv"))
                            }
                            _ => Err("failed".to_string().into()),
                        }
                    })
                    .await;
                    (candidate, result)
                }
            },
        )
        .await
        .expect("a lower-ranked completion does not settle ahead of pending higher ranks");
        assert_eq!(
            winner.stream_key.as_deref(),
            Some(if first_succeeds { "s:0" } else { "s:8" })
        );
    }
}

#[tokio::test]
async fn probe_pool_refill_keeps_the_original_deadline_and_drops_timed_out_probes() {
    let activity = Arc::new(ProbeActivity::default());
    let probes = activity.clone();
    let started = tokio::time::Instant::now();
    let original_deadline = started + Duration::from_millis(100);
    let mut started_requests = Vec::new();
    let error = resolve_probe_candidates(
        refill_probe_plan(BEST_STREAM_MAX_CANDIDATES),
        None,
        None,
        original_deadline,
        Some(&mut started_requests),
        move |candidate, _, deadline| {
            assert_eq!(deadline, original_deadline);
            let activity = probes.clone();
            async move {
                let _active = activity.enter();
                let result = tokio::time::timeout_at(deadline, async {
                    if candidate.stream_key == "s:0" {
                        Err("failed".to_string().into())
                    } else {
                        std::future::pending::<Result<ResolvedStream, ProbeError>>().await
                    }
                })
                .await;
                (candidate, result)
            }
        },
    )
    .await
    .expect_err("refilled probes cannot extend the original deadline");
    assert_eq!(error.kind, ResolveStreamErrorKind::Failed);
    assert!(error.message.contains("timed out"));
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(activity.started.load(Ordering::SeqCst), 9);
    assert_eq!(
        started_requests
            .iter()
            .map(|request| request.url.path())
            .collect::<Vec<_>>(),
        (0..9)
            .map(|index| format!("/{index}.mkv"))
            .collect::<Vec<_>>()
    );
    assert_eq!(activity.active.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn probe_pool_cancellation_drops_all_in_flight_probes_without_starting_the_tail() {
    let activity = Arc::new(ProbeActivity::default());
    let probes = activity.clone();
    let all_started = Arc::new(tokio::sync::Notify::new());
    let signal = all_started.clone();
    tokio::select! {
        result = resolve_probe_candidates(
            refill_probe_plan(BEST_STREAM_MAX_CANDIDATES),
            None,
            None,
            tokio::time::Instant::now() + Duration::from_secs(60),
            None,
            move |candidate, _, deadline| {
                let activity = probes.clone();
                let signal = signal.clone();
                async move {
                    let _active = activity.enter();
                    if activity.active.load(Ordering::SeqCst) == BEST_STREAM_PROBE_CONCURRENCY {
                        signal.notify_one();
                    }
                    let result = tokio::time::timeout_at(
                        deadline,
                        std::future::pending::<Result<ResolvedStream, ProbeError>>(),
                    ).await;
                    (candidate, result)
                }
            },
        ) => panic!("pending probes unexpectedly settled: {result:?}"),
        _ = all_started.notified() => {},
    }
    assert_eq!(
        activity.started.load(Ordering::SeqCst),
        BEST_STREAM_PROBE_CONCURRENCY
    );
    assert_eq!(activity.active.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn probe_stagger_wait_obeys_the_shared_deadline() {
    let candidate = candidate_input("delayed", "s:delayed");
    let original_url = candidate.direct_url.clone();
    let (candidate, result) = probe_candidate(
        candidate,
        Duration::from_secs(1),
        tokio::time::Instant::now() + Duration::from_millis(1),
    )
    .await;
    assert!(result.is_err());
    assert_eq!(
        candidate.direct_url, original_url,
        "the probe never started"
    );
}

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
        candidate_input("slow-a", "s:rank-order-a"),
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
    assert_eq!(winner.stream_key.as_deref(), Some("s:rank-order-a"));
}

#[tokio::test]
async fn candidate_results_failed_first_rank_passes_to_next() {
    let cases: [(&str, Duration, FakeProbeInner, Option<&str>); 3] = [
        (
            "a",
            Duration::from_secs(1),
            Box::pin(async { Err("boom".to_string().into()) }),
            None,
        ),
        (
            "slow-a",
            Duration::from_millis(1),
            Box::pin(async {
                tokio::time::sleep(Duration::from_millis(20)).await;
                Ok(resolved("https://cdn.example/a.mkv"))
            }),
            None,
        ),
        (
            "a",
            Duration::from_secs(1),
            Box::pin(async { Ok(resolved("https://cdn.example/excluded.mkv#new")) }),
            Some("https://cdn.example/excluded.mkv#old"),
        ),
    ];
    for (source, timeout, inner, excluded_url) in cases {
        let mut candidates = FuturesOrdered::new();
        candidates.push_back(fake_probe(candidate_input(source, "s:a"), timeout, inner));
        candidates.push_back(fake_probe(
            candidate_input("b", "s:b"),
            Duration::from_secs(1),
            Box::pin(async { Ok(resolved("https://cdn.example/b.mkv")) }),
        ));

        let winner = resolve_candidate_results(candidates, excluded_url)
            .await
            .expect("next-ranked probe wins");

        assert_eq!(winner.stream_key.as_deref(), Some("s:b"));
    }
}

#[tokio::test]
async fn recovery_candidate_results_accept_same_url_for_a_different_prepared_request() {
    for (failed_key, expected) in [
        (Some("s:failed"), "s:alternate"),
        (Some(" s:failed "), "s:alternate"),
        (None, "s:fallback"),
        (Some("h:legacy:0"), "s:fallback"),
    ] {
        let winner = resolve_probe_candidates(
            ["alternate", "fallback"]
                .into_iter()
                .map(|source| {
                    let candidate = candidate_input(source, &format!("s:{source}"));
                    let identity = ProbeRequestIdentity::from_candidate(&candidate);
                    (candidate, Duration::ZERO, identity)
                })
                .collect(),
            failed_key,
            Some("https://cdn.example/failed.mkv"),
            tokio::time::Instant::now() + Duration::from_secs(1),
            None,
            |candidate, _, _| async move {
                let resolved = if candidate.stream_key == "s:alternate" {
                    ResolvedStream {
                        url: "https://cdn.example/failed.mkv".to_string(),
                        mpv_http_header_fields: "Authorization: Bearer second".to_string(),
                    }
                } else {
                    resolved("https://cdn.example/fallback.mkv")
                };
                (candidate, Ok(Ok(resolved)))
            },
        )
        .await
        .expect("a distinct request resolves");
        assert_eq!(winner.stream_key.as_deref(), Some(expected));
        if expected == "s:alternate" {
            assert_eq!(winner.url, "https://cdn.example/failed.mkv");
            assert_eq!(
                winner.mpv_http_header_fields,
                "Authorization: Bearer second"
            );
        }
    }
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
