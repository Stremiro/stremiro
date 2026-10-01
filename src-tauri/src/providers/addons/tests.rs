use super::stream_match::*;
use super::transport::*;
use super::*;
use crate::test_helpers::test_stream;
use std::sync::atomic::Ordering;

fn episode_matches_text(text: &str, season: u32, episode: u32) -> bool {
    episode_matches_text_final(text, season, episode, false)
}

/// `final_season` mirrors the backend's mapping-index fact for the request:
/// the battery needs it to resolve a numberless "final season" naming
/// claim (see `text_matches_requested_season`).
fn episode_matches_text_final(text: &str, season: u32, episode: u32, final_season: bool) -> bool {
    let t = normalize_separators(text).to_lowercase();
    episode_matches_lowered(
        &t,
        season,
        episode,
        text_matches_requested_season(&t, season, final_season),
    )
}

fn stream_contains_batch(s: &AddonStream) -> bool {
    stream_contains_batch_texts(s.match_texts())
}

fn stream_matches_episode(s: &AddonStream, season: u32, episode: u32) -> bool {
    s.match_texts()
        .fields_with_season_context(season, false)
        .into_iter()
        .flatten()
        .any(|(text, season_context, _)| {
            episode_matches_lowered(text, season, episode, season_context)
        })
}

fn stream_episode_match(
    s: &AddonStream,
    season: u32,
    episode: u32,
    final_season: bool,
) -> StreamEpisodeMatch {
    stream_episode_match_texts(s.match_texts(), season, episode, final_season)
}

fn stream_episode_match_kind(s: &AddonStream, season: u32, episode: u32) -> StreamEpisodeMatchKind {
    stream_episode_match(s, season, episode, false).kind
}

/// Magnet-only pack stream with a display `name` — the shape batch and
/// season-pack tests build repeatedly.
fn named_pack(name: &str) -> AddonStream {
    let mut stream = mk_stream(None, Some("magnet:?xt=urn:btih:pack"), false);
    stream.name = Some(name.to_string());
    stream
}

// ── episode_matches_text ──────────────────────────────────────────────

#[test]
fn matches_standard_s_xxe_yy_format() {
    assert!(episode_matches_text("Show.S01E05.1080p", 1, 5));
}

#[test]
fn matches_zero_padded_s_format() {
    assert!(episode_matches_text("Show.S15E52.BluRay", 15, 52));
}

#[test]
fn matches_unpadded_s_format() {
    assert!(episode_matches_text("show s1e5 hdtv", 1, 5));
}

#[test]
fn matches_x_nn_format() {
    assert!(episode_matches_text("Show.1x05.HDTV", 1, 5));
}

#[test]
fn matches_episode_keyword() {
    assert!(episode_matches_text("Show Episode 12 1080p", 1, 12));
}

#[test]
fn loose_episode_keyword_rejects_conflicting_season_context() {
    assert!(!episode_matches_text("Show Season 2 Episode 1 1080p", 1, 1));
}

#[test]
fn no_match_wrong_episode() {
    assert!(!episode_matches_text("Show.S01E10.1080p", 1, 5));
}

#[test]
fn no_match_wrong_season() {
    assert!(!episode_matches_text("Show.S02E05.1080p", 1, 5));
}

#[test]
fn no_match_empty_title() {
    assert!(!episode_matches_text("", 1, 1));
}

#[test]
fn no_match_episode_number_prefix() {
    // A requested episode that is a digit-prefix of the real one must
    // not match: `s1e1` is a substring of `s1e10`, `ep1` of `ep12`.
    assert!(!episode_matches_text("Show.S01E10.1080p", 1, 1));
    assert!(!episode_matches_text("Show.S1E12.1080p", 1, 1));
    assert!(!episode_matches_text("Show.S1E1000.1080p", 1, 100));
    assert!(!episode_matches_text("Show.Episode 10.1080p", 1, 1));
    assert!(!episode_matches_text("Show.Ep.12.1080p", 1, 1));
    assert!(!episode_matches_text("Show #12 [1080p]", 1, 1));
    assert!(!episode_matches_text("Show - 100 [1080p]", 1, 10));
}

#[test]
fn no_match_x_format_larger_season() {
    // `1x01` inside `11x01` is season 11, not season 1.
    assert!(!episode_matches_text("Show.11x01.HDTV", 1, 1));
    assert!(!episode_matches_text("Show.1x1000.HDTV", 1, 100));
    assert!(episode_matches_text("Show.1x01.HDTV", 1, 1));
}

#[test]
fn matches_mixed_padding_and_loose_separators() {
    // Release groups pad season and episode independently and use
    // dots/underscores as separators in keyword forms.
    assert!(episode_matches_text("Show.S1E05.1080p", 1, 5));
    assert!(episode_matches_text("Show.S01E5.1080p", 1, 5));
    assert!(episode_matches_text("Show.1x5.HDTV", 1, 5));
    assert!(episode_matches_text("Show.S01.Episode.05.1080p", 1, 5));
    assert!(episode_matches_text("Show_ep_05_1080p", 1, 5));
    // Detached `E05` segment next to a matching season marker.
    assert!(episode_matches_text("Show.S01.E05.1080p", 1, 5));
    // …but not when the declared season is a different one.
    assert!(!episode_matches_text("Show.S02.E05.1080p", 1, 5));
    // …and a bare `e5`-shaped token without any season marker is not an
    // episode claim ("Xeon E5", codec fragments).
    assert!(!episode_matches_text("Show.E5.1080p", 1, 5));
    // Mixed padding must keep digit boundaries: E05 is not E50.
    assert!(!episode_matches_text("Show.S1E05.1080p", 1, 50));
    assert!(!episode_matches_text("Show.S1E50.1080p", 1, 5));
}

#[test]
fn bare_season_token_rejects_conflicting_loose_episode() {
    // `S02` without an `E` segment still declares a season: a loose
    // "Episode 5" next to it must not match an S1 target.
    assert!(!episode_matches_text("Show.S02.Episode.5.1080p", 1, 5));
    assert!(episode_matches_text("Show.S01.Episode.5.1080p", 1, 5));
}

#[test]
fn stream_episode_match_kind_detects_bare_season_and_complete_series_packs() {
    let season_pack = named_pack("Show.S01.COMPLETE.1080p");
    assert_eq!(
        stream_episode_match_kind(&season_pack, 1, 7),
        StreamEpisodeMatchKind::SeasonPack
    );
    assert!(stream_contains_batch(&season_pack));

    let series_pack = named_pack("Show.Complete.Series.1080p");
    assert_eq!(
        stream_episode_match_kind(&series_pack, 3, 7),
        StreamEpisodeMatchKind::SeasonPack
    );

    // A pack that names a different season is not a match candidate.
    let other_season = named_pack("Show.S02.COMPLETE.1080p");
    assert_eq!(
        stream_episode_match_kind(&other_season, 1, 7),
        StreamEpisodeMatchKind::None
    );

    // A bare keyword with no season marker is not a pack (movie titles
    // like "Complete Unknown" must not trip the batch filter).
    let movie = named_pack("Complete.Unknown.2016.1080p");
    assert!(!stream_contains_batch(&movie));
}

#[test]
fn final_season_release_does_not_cross_match_other_seasons() {
    // Attack on Titan shape: S1 releases and Final Season releases both use
    // the per-season dash form with no numeric claim, so the titled form is
    // the only distinguishing evidence. Without the named claim the
    // final-season file Exact-matched an S01E04 request and a cached 4K
    // encode of the wrong season could outrank the right file.
    let season_one = "Shingeki no Kyojin - 04 [1080p]";
    let final_season = "[SubsPlease] Shingeki no Kyojin - The Final Season - 04 (1080p)";

    // S1 request: the S1 dash file matches; the titled final-season file is
    // an explicit claim of a different season and must not match.
    assert!(episode_matches_text_final(season_one, 1, 4, false));
    assert!(!episode_matches_text_final(final_season, 1, 4, false));

    // Final-season request (the fact arrives from the mapping index): the
    // titled file matches its own season again.
    assert!(episode_matches_text_final(final_season, 4, 4, true));
    // A request the mapping fact could not confirm degrades to no-match on
    // the titled release — never a cross-season false positive.
    assert!(!episode_matches_text_final(final_season, 4, 4, false));

    // Part-suffixed titles still carry the claim.
    let part_two = "[SubsPlease] Shingeki no Kyojin - The Final Season Part 2 - 09 (1080p)";
    assert!(episode_matches_text_final(part_two, 4, 9, true));
    assert!(!episode_matches_text_final(part_two, 1, 9, false));
}

#[test]
fn final_season_pack_is_season_pack_only_for_its_own_season() {
    let pack = named_pack("Shingeki no Kyojin - The Final Season Complete Batch 1080p");

    // Final-season request: the pack claims the requested season, so it
    // contains the episode with the claim verified.
    let matched = stream_episode_match(&pack, 4, 7, true);
    assert_eq!(matched.kind, StreamEpisodeMatchKind::SeasonPack);
    assert!(matched.season_claim_verified);
    // S1 request: the same pack is another season's content and must
    // neither SeasonPack-match nor loose-match the episode.
    assert_eq!(
        stream_episode_match(&pack, 1, 7, false).kind,
        StreamEpisodeMatchKind::None
    );
}

#[test]
fn ordinal_season_claims_match_their_own_season_only() {
    assert!(episode_matches_text_final(
        "Re Zero 2nd Season - 05 [1080p]",
        2,
        5,
        false
    ));
    assert!(episode_matches_text_final(
        "Re Zero Second Season - 05 [1080p]",
        2,
        5,
        false
    ));
    assert!(!episode_matches_text_final(
        "Re Zero 2nd Season - 05 [1080p]",
        1,
        5,
        false
    ));
    assert!(episode_matches_text_final(
        "Overlord First Season - 04 [1080p]",
        1,
        4,
        false
    ));
    // A season that outranks the ordinal claim is a mismatch too.
    assert!(!episode_matches_text_final(
        "Re Zero 2nd Season - 05 [1080p]",
        3,
        5,
        false
    ));
}

#[test]
fn season_claim_verified_separates_titled_from_bare_dash_matches() {
    // A final-season request in a mixed pool: both files Exact-match the
    // dash form; the titled one carries the verified claim while the bare
    // S1-style file stays an assumed match.
    let mut bare = mk_stream(None, Some("magnet:?xt=urn:btih:bare"), false);
    bare.name = Some("Shingeki no Kyojin - 04 [2160p]".to_string());
    let mut titled = mk_stream(None, Some("magnet:?xt=urn:btih:titled"), false);
    titled.name = Some("Shingeki no Kyojin - The Final Season - 04 [1080p]".to_string());

    let bare_match = stream_episode_match(&bare, 4, 4, true);
    assert_eq!(bare_match.kind, StreamEpisodeMatchKind::Exact);
    assert!(!bare_match.season_claim_verified);
    let titled_match = stream_episode_match(&titled, 4, 4, true);
    assert_eq!(titled_match.kind, StreamEpisodeMatchKind::Exact);
    assert!(titled_match.season_claim_verified);
}

// ── BATCH_REGEX ───────────────────────────────────────────────────────

/// Table-driven `BATCH_REGEX` cases: `input => expected is_match`. Each row
/// keeps its own named `#[test]` and echoes the input on failure.
macro_rules! batch_regex_tests {
    ($($name:ident: $input:expr => $matches:expr;)*) => {
        $(
            #[test]
            fn $name() {
                assert_eq!(BATCH_REGEX.is_match($input), $matches, "{}", $input);
            }
        )*
    };
}

batch_regex_tests! {
    batch_regex_detects_season_pack: "Show Complete Season Pack 2024" => true;
    batch_regex_detects_season_range: "Naruto S01-S23 Complete 1080p" => true;
    batch_regex_detects_episode_range: "One.Piece.E001-E1100.HDTV" => true;
    // A single episode title should not trigger the batch regex.
    batch_regex_does_not_false_positive_single_episode: "Show.S01E05.1080p.BluRay" => false;
    batch_regex_does_not_false_positive_plain_title: "The Dark Knight 2008 1080p BluRay" => false;
}

#[test]
fn stream_contains_batch_works_for_name_or_title() {
    let stream = AddonStream {
        name: Some("Butter".to_string()),
        title: Some("Complete Season Pack".to_string()),
        ..test_stream()
    };
    assert!(stream_contains_batch(&stream));
}

#[test]
fn stream_matches_episode_works_for_name_or_title() {
    let stream = AddonStream {
        name: Some("Show.S03E07".to_string()),
        title: Some("Other text".to_string()),
        ..test_stream()
    };
    assert!(stream_matches_episode(&stream, 3, 7));
}

#[test]
fn stream_episode_match_kind_detects_episode_ranges() {
    let stream = AddonStream {
        name: Some("One.Piece.E1000-E1010.1080p".to_string()),
        ..test_stream()
    };

    assert_eq!(
        stream_episode_match_kind(&stream, 21, 1004),
        StreamEpisodeMatchKind::EpisodeRange
    );
}

#[test]
fn stream_episode_match_kind_detects_targeted_season_packs() {
    let stream = AddonStream {
        name: Some("Show Complete Season 3 Pack 1080p".to_string()),
        ..test_stream()
    };

    assert_eq!(
        stream_episode_match_kind(&stream, 3, 7),
        StreamEpisodeMatchKind::SeasonPack
    );
}

fn stream_conflicts(s: &AddonStream, targets: &[(u32, u32)]) -> bool {
    stream_conflicts_with_episode_targets(s.match_texts(), targets, None)
}

fn named_stream(name: &str) -> AddonStream {
    AddonStream {
        name: Some(name.to_string()),
        ..test_stream()
    }
}

#[test]
fn episode_claim_gate_rejects_conflicting_numeric_claims() {
    let requested = [(1u32, 5u32)];
    for (name, conflict) in [
        ("Show.S01E05.1080p", false),
        ("Show.S02E05.1080p", true),
        ("Show.S01E06.1080p", true),
        ("Show.S01.E05.1080p", false),
        ("Show_S01_E06.1080p", true),
        ("Show.1x05.1080p", false),
        ("Show.2x05.1080p", true),
        ("Show.Episode.6.1080p", true),
        ("Show.1080p.Release", false),
        ("Show.S01.COMPLETE.1080p", false),
        ("Show.S02.COMPLETE.1080p", true),
    ] {
        assert_eq!(
            stream_conflicts(&named_stream(name), &requested),
            conflict,
            "{name}"
        );
    }
}

#[test]
fn episode_claim_gate_evaluates_episode_ranges() {
    let range = named_stream("Show.S01E03-E07.1080p");
    assert!(!stream_conflicts(&range, &[(1, 5)]));
    assert!(stream_conflicts(&range, &[(1, 8)]));

    let bare = named_stream("Show.E03-E07.1080p");
    assert!(!stream_conflicts(&bare, &[(1, 5)]));
    assert!(stream_conflicts(&bare, &[(1, 8)]));
}

#[test]
fn episode_claim_gate_prioritizes_filename_over_name_and_title() {
    let mut wrong_filename = named_stream("Show.S01E05.1080p");
    wrong_filename.title = Some("Show.S01E05".to_string());
    wrong_filename.behavior_hints = Some(BehaviorHints {
        filename: Some("Show.S02E05.1080p.mkv".to_string()),
        ..Default::default()
    });
    assert!(stream_conflicts(&wrong_filename, &[(1, 5)]));

    let mut right_filename = named_stream("Show.S02E05.1080p");
    right_filename.title = Some("Show.S02E05".to_string());
    right_filename.behavior_hints = Some(BehaviorHints {
        filename: Some("Show.S01E05.1080p.mkv".to_string()),
        ..Default::default()
    });
    assert!(!stream_conflicts(&right_filename, &[(1, 5)]));
}

#[test]
fn episode_claim_gate_accepts_any_complete_target_pair() {
    let targets = [(1u32, 17u32), (2u32, 5u32)];
    assert!(!stream_conflicts(
        &named_stream("Show.S01E17.1080p"),
        &targets
    ));
    assert!(!stream_conflicts(
        &named_stream("Show.S02E05.1080p"),
        &targets
    ));
    assert!(stream_conflicts(
        &named_stream("Show.S03E05.1080p"),
        &targets
    ));
}

#[test]
fn episode_claim_gate_without_targets_rejects_nothing() {
    assert!(!stream_conflicts(&named_stream("Show.S02E05.1080p"), &[]));
}

#[test]
fn episode_claim_gate_honors_final_season_named_claim() {
    // "Final Season" is a numberless named claim for the show's last season:
    // with the fact supplied the resolve pool keeps the row (matching the
    // ranker); without it the claim counts as a different-season conflict.
    let stream = named_stream("Show Final Season Episode 04");
    let requested = [(5u32, 4u32)];
    assert!(stream_conflicts(&stream, &requested));
    assert!(!stream_conflicts_with_episode_targets(
        stream.match_texts(),
        &requested,
        Some(5)
    ));
    // A season the fact was not computed for keeps the conservative read.
    assert!(stream_conflicts_with_episode_targets(
        stream.match_texts(),
        &requested,
        Some(3)
    ));
}

fn mk_stream(info_hash: Option<&str>, url: Option<&str>, cached: bool) -> AddonStream {
    AddonStream {
        name: Some("src".to_string()),
        title: Some("title".to_string()),
        info_hash: info_hash.map(|s| s.to_string()),
        url: url.map(|s| s.to_string()),
        cached,
        ..test_stream()
    }
}

fn stream_fixture(name: Option<&str>, url: Option<&str>) -> AddonStream {
    AddonStream {
        name: name.map(|value| value.to_string()),
        url: url.map(|value| value.to_string()),
        ..test_stream()
    }
}

#[test]
fn direct_http_url_is_not_labeled_cached() {
    let mut stream = stream_fixture(None, Some("https://example.com/file.mp4"));
    AddonTransport::hydrate_stream(&mut stream);
    assert!(!stream.cached);
}

#[test]
fn lightning_hint_marks_cached_and_download_arrow_opts_out() {
    let mut cached = stream_fixture(Some("Release \u{26A1}"), None);
    AddonTransport::hydrate_stream(&mut cached);
    assert!(cached.cached);

    let mut plain = stream_fixture(
        Some("Release \u{2B07}"),
        Some("https://example.com/file.mp4"),
    );
    AddonTransport::hydrate_stream(&mut plain);
    assert!(!plain.cached);
}

#[test]
fn decode_stream_items_skips_malformed_siblings() {
    let bytes = br#"{"streams": [
            {"name": "Valid", "infoHash": "abc123"},
            {"name": 42, "infoHash": "bad"},
            {"url": "https://example.com/file.mp4"}
        ]}"#;
    let streams = decode_stream_items(bytes).expect("decodes");
    assert_eq!(streams.len(), 2);
    assert_eq!(streams[0].info_hash.as_deref(), Some("abc123"));
    assert_eq!(
        streams[1].url.as_deref(),
        Some("https://example.com/file.mp4")
    );
}

#[test]
fn decode_stream_items_decodes_typed_protocol_fields() {
    let bytes = br#"{"streams": [{
            "name": "Release",
            "externalUrl": "https://example.com/open",
            "behaviorHints": {
                "bingeGroup": "group-1",
                "filename": "release.mkv",
                "notWebReady": true,
                "proxyHeaders": {"request": {"Authorization": "Bearer x"}},
                "futureHint": "keep-me"
            },
            "futureField": "keep-me"
        }]}"#;
    let streams = decode_stream_items(bytes).expect("decodes");
    let stream = &streams[0];
    let hints = stream.behavior_hints.as_ref().expect("hints");
    assert_eq!(hints.binge_group.as_deref(), Some("group-1"));
    assert!(hints.proxy_headers.is_some());
}

#[test]
fn decode_stream_items_discards_spoofed_derived_ranking_inputs() {
    // The unified `AddonStream` DTO must round-trip prepared rows for the
    // filter command, so derived fields deserialize. Network ingress must
    // still discard them: otherwise a malicious addon floats to the top
    // of Smart/size/seeds ordering plus auto-pick by asserting huge
    // values, since hydration only fills these when absent.
    let bytes = br#"{"streams": [{
            "name": "Release 1080p",
            "url": "https://example.com/file.mp4",
            "seeders": 999999,
            "sizeBytes": 99999999999,
            "source_name": "Spoofed Source"
        }]}"#;
    let streams = decode_stream_items(bytes).expect("decodes");
    let stream = &streams[0];
    assert_eq!(stream.seeders, None);
    assert_eq!(stream.size_bytes, None);
    assert_eq!(stream.url.as_deref(), Some("https://example.com/file.mp4"));
}

#[test]
fn selection_priority_is_never_forged_or_serialized() {
    let bytes = br#"{"streams": [{
            "name": "Release",
            "url": "https://example.com/video.mp4",
            "selectionPriority": ["exact", true, 4, 4, 6]
        }]}"#;
    let streams = decode_stream_items(bytes).expect("decodes");
    assert_eq!(streams[0].selection_priority, None);

    let mut prepared = sample_stream();
    prepared.selection_priority = Some((StreamEpisodeMatchKind::Exact, true, 4, 4, 6));
    let json = serde_json::to_value(&prepared).expect("serializes");
    assert!(json.get("selectionPriority").is_none());
    assert!(json.get("selection_priority").is_none());
}

#[test]
fn build_stream_endpoint_preserves_config_and_encodes_id() {
    let url = AddonTransport::build_stream_endpoint(
        "https://example.com/stremio/v1?token=abc",
        "movie",
        "tt1234567:1:2",
    )
    .expect("endpoint");
    assert_eq!(
        url,
        "https://example.com/stremio/v1/stream/movie/tt1234567%3A1%3A2.json?token=abc"
    );
}

#[test]
fn stream_cache_put_enforces_hard_entry_bound_and_keeps_newest() {
    let transport = AddonTransport::new();
    let stream = sample_stream();
    let generation = transport.generation.load(Ordering::SeqCst);

    for index in 0..(STREAM_CACHE_MAX_ENTRIES + 5) {
        transport.cache_put(&format!("key-{index}"), vec![stream.clone()], generation);
    }

    assert_eq!(transport.cache.len(), STREAM_CACHE_MAX_ENTRIES);
    assert!(transport
        .cache
        .get(&format!("key-{}", STREAM_CACHE_MAX_ENTRIES + 4))
        .is_some());
}

#[test]
fn fetch_failure_cooldown_blocks_and_clear_cache_releases() {
    let transport = AddonTransport::new();
    let addon_key = config_cache_segment("https://dead.example.com");

    assert!(!transport.fetch_failure_cooling_down(&addon_key));
    let generation = transport.generation.load(Ordering::SeqCst);
    transport.note_fetch_failure_for_generation(&addon_key, generation);
    assert!(transport.fetch_failure_cooling_down(&addon_key));

    // A config change (clear_cache) must give the host a fresh try.
    transport.clear_cache();
    assert!(!transport.fetch_failure_cooling_down(&addon_key));
}

#[test]
fn stream_cache_put_from_stale_generation_is_dropped() {
    let transport = AddonTransport::new();
    let stale = transport.generation.load(Ordering::SeqCst);
    transport.clear_cache();

    let batch = [sample_stream()];
    transport.cache_put("stale-key", batch.to_vec(), stale);
    assert!(transport.cache.get("stale-key").is_none());
    assert_eq!(transport.cache.len(), 0);

    let current = transport.generation.load(Ordering::SeqCst);
    transport.cache_put("fresh-key", batch.to_vec(), current);
    assert!(transport.cache.get("fresh-key").is_some());
}

#[test]
fn fetch_failure_record_from_stale_generation_is_suppressed() {
    let transport = AddonTransport::new();
    let addon_key = config_cache_segment("https://dead.example.com");
    let stale = transport.generation.load(Ordering::SeqCst);

    // A fetch that exhausted retries after `clear_cache` ran must not
    // reinstall the cooldown the clear just wiped.
    transport.clear_cache();
    transport.note_fetch_failure_for_generation(&addon_key, stale);
    assert!(!transport.fetch_failure_cooling_down(&addon_key));

    // Same recording at the current generation still cools the addon down.
    let fresh = transport.generation.load(Ordering::SeqCst);
    transport.note_fetch_failure_for_generation(&addon_key, fresh);
    assert!(transport.fetch_failure_cooling_down(&addon_key));
}

#[test]
fn fetch_failure_for_url_respects_caller_generation() {
    let transport = AddonTransport::new();
    let addon_url = "https://dead.example.com";
    let addon_key = config_cache_segment(addon_url);
    let stale = transport.generation.load(Ordering::SeqCst);

    // A fetcher timeout recorded after `clear_cache` ran must not
    // reinstall the cooldown the clear just wiped.
    transport.clear_cache();
    transport.note_fetch_failure_for_url(addon_url, stale);
    assert!(!transport.fetch_failure_cooling_down(&addon_key));

    // A timeout at the current generation still records.
    let fresh = transport.generation.load(Ordering::SeqCst);
    transport.note_fetch_failure_for_url(addon_url, fresh);
    assert!(transport.fetch_failure_cooling_down(&addon_key));
}

#[test]
fn stale_fetch_success_cannot_clear_fresh_cooldown() {
    let transport = AddonTransport::new();
    let addon_key = config_cache_segment("https://flaky.example.com");
    let stale = transport.generation.load(Ordering::SeqCst);

    transport.clear_cache();
    let fresh = transport.generation.load(Ordering::SeqCst);
    transport.note_fetch_failure_for_generation(&addon_key, fresh);

    // A fetch that started before the clear must not wipe the new
    // generation's cooldown on success.
    transport.clear_fetch_failure_for_generation(&addon_key, stale);
    assert!(transport.fetch_failure_cooling_down(&addon_key));

    // A success at the current generation still clears it.
    transport.clear_fetch_failure_for_generation(&addon_key, fresh);
    assert!(!transport.fetch_failure_cooling_down(&addon_key));
}

#[test]
fn sanitize_redacts_signed_query_keys_and_path_config_blobs() {
    let redacted = sanitize_addon_log(
        "error sending request for url (https://cdn.example/v.m3u8?sig=abcdef0123456789): timeout",
    );
    assert!(!redacted.contains("abcdef0123456789"), "{redacted}");
    assert!(redacted.contains("sig=[redacted]"), "{redacted}");

    let blob = "eyJmaWx0ZXJzIjpbXSwiZGVicmlkLWtleSI6InNlY3JldCJ9";
    let redacted = sanitize_addon_log(&format!(
            "error sending request for url (https://addon.example.com/{blob}/stream/series/tt1234567.json): timeout"
        ));
    assert!(!redacted.contains(blob), "{redacted}");
    assert!(redacted.contains("/[redacted-path]/"), "{redacted}");
}

#[test]
fn sanitize_preserves_short_protocol_path_segments() {
    let plain = "https://v3-cinemeta.strem.io/catalog/series/top/skip=50.json";
    assert_eq!(sanitize_addon_log(plain), plain);

    let meta = "https://v3-cinemeta.strem.io/meta/series/tt1234567.json";
    assert_eq!(sanitize_addon_log(meta), meta);
}

#[test]
fn decode_strips_blocked_url_but_keeps_stream_and_magnets() {
    let bytes = br#"{"streams": [
            {"name": "Good", "url": "https://example.com/video.mp4"},
            {"name": "File", "url": "file:///etc/passwd"},
            {"name": "Loopback", "url": "http://127.0.0.1:9999/video.mp4"},
            {"name": "Creds", "url": "https://user:pass@example.com/video.mp4"},
            {"name": "Magnet", "url": "magnet:?xt=urn:btih:abc123"}
        ]}"#;
    let streams = decode_stream_items(bytes).expect("decodes");
    assert_eq!(streams.len(), 5);
    assert_eq!(
        streams[0].url.as_deref(),
        Some("https://example.com/video.mp4")
    );
    for (index, blocked) in streams.iter().enumerate().skip(1).take(3) {
        assert!(
            blocked.url.is_none(),
            "stream {index} url must be stripped: {blocked:?}"
        );
    }
    assert_eq!(
        streams[4].url.as_deref(),
        Some("magnet:?xt=urn:btih:abc123")
    );
}

#[test]
fn sanitize_redacts_mixed_case_signed_query_keys() {
    for raw in [
        "https://cdn.example/v.m3u8?Token=signed-secret",
        "https://cdn.example/v.m3u8?APIKEY=signed-secret",
        "https://cdn.example/v.m3u8?Sig=signed-secret",
    ] {
        let redacted = sanitize_addon_log(&format!("probe failed for url ({raw}): timeout"));
        assert!(!redacted.contains("signed-secret"), "{redacted}");
        assert!(redacted.contains("[redacted]"), "{redacted}");
    }
}

#[test]
fn sanitize_redacts_full_signed_hint_family() {
    // Every signed-link query hint shape must be scrubbed: the redactor
    // exists so credential-bearing URLs never reach logs or errors.
    for raw in [
        "https://cdn.example/v.m3u8?expires=1700000000&sig=signed-secret",
        "https://cdn.example/v.m3u8?exp=1700000000",
        "https://cdn.example/v.m3u8?policy=signed-secret",
        "https://cdn.example/v.m3u8?hdnts=signed-secret",
        "https://cdn.example/v.m3u8?md5=signed-secret",
        "https://cdn.example/v.m3u8?x-amz-signature=signed-secret",
        "https://cdn.example/v.m3u8?x-goog-expires=1700000000",
    ] {
        let redacted = sanitize_addon_log(&format!("probe failed for url ({raw}): timeout"));
        assert!(!redacted.contains("signed-secret"), "{redacted}");
        assert!(!redacted.contains("1700000000"), "{redacted}");
        assert!(redacted.contains("[redacted]"), "{redacted}");
    }
}

fn sample_stream() -> AddonStream {
    AddonStream {
        url: Some("https://example.com/video.mp4".to_string()),
        ..test_stream()
    }
}

fn hints_with_proxy_headers(headers: Value) -> BehaviorHints {
    BehaviorHints {
        proxy_headers: Some(headers),
        ..Default::default()
    }
}

#[test]
fn proxy_request_headers_extracts_bounded_request_entries() {
    let hints = hints_with_proxy_headers(serde_json::json!({
        "request": {
            "Authorization": "Bearer secret",
            "User-Agent": "Stremio/1.0",
            "X-Retry": 3,
            "X-Inject": "a\nb",
            "Bad Name": "dropped",
            "": "dropped",
            "X-Null": null,
            "X-List": ["dropped"]
        },
        "response": {"X-Response": "ignored"}
    }));
    let headers = hints.proxy_request_headers();
    assert_eq!(
        headers,
        vec![
            ("Authorization".to_string(), "Bearer secret".to_string()),
            ("User-Agent".to_string(), "Stremio/1.0".to_string()),
            ("X-Retry".to_string(), "3".to_string()),
        ]
    );
}

#[test]
fn proxy_request_headers_drops_transport_owned_names() {
    let hints = hints_with_proxy_headers(serde_json::json!({
        "request": {
            "Authorization": "Bearer secret",
            "Range": "bytes=100-200",
            "HOST": "evil.example",
            "Content-Length": "12",
            "Connection": "keep-alive",
            "Proxy-Authorization": "Basic c2VjcmV0",
            "Referer": "https://example.com/"
        }
    }));
    let headers = hints.proxy_request_headers();
    assert_eq!(
        headers,
        vec![
            ("Authorization".to_string(), "Bearer secret".to_string()),
            ("Referer".to_string(), "https://example.com/".to_string()),
        ]
    );
}

#[test]
fn proxy_request_headers_ignores_missing_or_response_only_hints() {
    assert!(BehaviorHints::default().proxy_request_headers().is_empty());
    let hints = hints_with_proxy_headers(serde_json::json!({
        "response": {"X-Response": "ignored"}
    }));
    assert!(hints.proxy_request_headers().is_empty());
    let hints = hints_with_proxy_headers(serde_json::json!(["not", "an", "object"]));
    assert!(hints.proxy_request_headers().is_empty());
}

#[test]
fn proxy_request_headers_enforces_entry_cap() {
    let mut request = serde_json::Map::new();
    for index in 0..12 {
        request.insert(
            format!("X-Header-{index}"),
            Value::String("value".to_string()),
        );
    }
    let hints = hints_with_proxy_headers(Value::Object({
        let mut root = serde_json::Map::new();
        root.insert("request".to_string(), Value::Object(request));
        root
    }));
    assert_eq!(hints.proxy_request_headers().len(), 8);
}

#[test]
fn truncate_stream_item_drops_oversized_proxy_headers() {
    let mut stream = sample_stream();
    stream.behavior_hints = Some(hints_with_proxy_headers(serde_json::json!({
        "request": {"Authorization": "Bearer kept"}
    })));
    truncate_stream_item(&mut stream);
    assert!(stream
        .behavior_hints
        .as_ref()
        .and_then(|hints| hints.proxy_headers.as_ref())
        .is_some());

    let mut bloated = sample_stream();
    bloated.behavior_hints = Some(hints_with_proxy_headers(serde_json::json!({
        "request": {"Authorization": "x".repeat(9_000)}
    })));
    truncate_stream_item(&mut bloated);
    assert!(bloated
        .behavior_hints
        .as_ref()
        .and_then(|hints| hints.proxy_headers.as_ref())
        .is_none());
}

fn flags_for(text: &str) -> StreamFlags {
    detect_stream_flags(&normalize_separators(text).to_lowercase())
}

#[test]
fn release_flags_reject_lookalike_tokens() {
    // "HDRip" is a capture-format tag, not HDR video — a raw `hdr`
    // substring probe awarded it the HDR badge and +50 quality. "4Kids"
    // is a dub tag, not P2160. "5.1 GB"/"7.1 GB" are sizes, not layouts.
    let flags = flags_for("Show.S01E01.HDRip.x264-GROUP");
    assert!(!flags.hdr);

    let flags = flags_for("Show.4Kids.Dub.1080p");
    assert_eq!(flags.resolution, StreamResolutionTier::P1080);

    let flags = flags_for("Show.S01E01.1080p.5.1 GB.WEB-DL");
    assert!(!flags.surround);
    let flags = flags_for("Show.S01E01.1080p.7.1 GB.WEB-DL");
    assert!(!flags.surround);
}

#[test]
fn release_flags_keep_real_markers() {
    let flags = flags_for("Show.S01E01.2160p.HDR10.5.1.WEB-DL.x265");
    assert!(flags.hdr);
    assert!(flags.surround);
    assert_eq!(flags.resolution, StreamResolutionTier::P2160);

    let flags = flags_for("Show.4K.HDR.WEB-DL");
    assert!(flags.hdr);
    assert_eq!(flags.resolution, StreamResolutionTier::P2160);
}

// ── wire contract ─────────────────────────────────────────────────────────
// The selector keys badges, dot-field tiers, and aria strings on these exact
// serialized values (`matchSummary.episode`/`title`); a casing drift here
// silently drops two of three match badges and mis-sorts tier groups.
#[test]
fn match_summary_serializes_snake_case_tier_values() {
    for (kind, expected) in [
        (StreamEpisodeMatchKind::SeasonPack, "season_pack"),
        (StreamEpisodeMatchKind::EpisodeRange, "episode_range"),
        (StreamEpisodeMatchKind::Exact, "exact"),
        (StreamEpisodeMatchKind::None, "none"),
    ] {
        assert_eq!(
            serde_json::to_value(kind).unwrap(),
            serde_json::json!(expected)
        );
    }

    for (title_match, expected) in [
        (StreamTitleMatch::Close, "close"),
        (StreamTitleMatch::Partial, "partial"),
    ] {
        assert_eq!(
            serde_json::to_value(title_match).unwrap(),
            serde_json::json!(expected)
        );
    }

    let summary = StreamMatchSummary {
        episode: Some(StreamEpisodeMatchKind::EpisodeRange),
        title: Some(StreamTitleMatch::Close),
    };
    assert_eq!(
        serde_json::to_value(summary).unwrap(),
        serde_json::json!({ "episode": "episode_range", "title": "close" })
    );
}
