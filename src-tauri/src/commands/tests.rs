use super::backup_commands::{
    normalize_backup_path, prepare_import_lists, validate_backup_size, validate_import_capacity,
    MAX_BACKUP_PATH_LEN, MAX_IMPORT_BYTES,
};
use super::config_commands::apply_manifest_snapshot;
use super::config_store::{normalize_addon_url, resolve_addon_configs, AddonConfig};
use super::history_helpers::{
    choose_entry, is_continue_watching_candidate, sanitize_watch_progress, HistoryEntryQuery,
};
use super::list_helpers::{UserListWithItems, MAX_LISTS, MAX_LIST_ITEMS};
use super::streaming_helpers::{
    build_addon_source_priority_map, build_stream_query_ids, has_playable_stream_source,
    is_placeholder_no_stream, merge_unique_streams, normalize_source_id, prepare_addon_streams,
    stream_quality_score, stream_resolution_priority, stream_source_priority,
};
use super::watch_history_commands::build_title_watch_history_rows;
use super::*;
use crate::providers::addons::{
    detect_stream_flags, AddonStream, BehaviorHints, StreamDeliveryKind, StreamResolution,
};
use crate::test_helpers::{
    cinemeta_addon, cinemeta_manifest, classified_cinemeta_addon, test_media_item, test_progress,
    test_stream,
};
use std::collections::HashMap;

fn mk_watch_progress(id: &str, type_: &str, last_watched: u64) -> WatchProgress {
    WatchProgress {
        id: id.to_string(),
        type_: type_.to_string(),
        last_watched,
        title: "Example".to_string(),
        ..test_progress()
    }
}

/// Series-history row for `tt7654321` with both display and absolute
/// episode coordinates pinned to the same season/episode pair.
fn series_episode_progress(
    watched: u64,
    season: u32,
    episode: u32,
    position: f64,
    duration: f64,
) -> WatchProgress {
    let mut progress = mk_watch_progress("tt7654321", "series", watched);
    progress.season = Some(season);
    progress.episode = Some(episode);
    progress.absolute_season = Some(season);
    progress.absolute_episode = Some(episode);
    progress.position = position;
    progress.duration = duration;
    progress
}

fn mk_stream(
    name: Option<&str>,
    title: Option<&str>,
    url: Option<&str>,
    info_hash: Option<&str>,
    filename: Option<&str>,
) -> AddonStream {
    AddonStream {
        name: name.map(|v| v.to_string()),
        title: title.map(|v| v.to_string()),
        info_hash: info_hash.map(|v| v.to_string()),
        url: url.map(|v| v.to_string()),
        behavior_hints: Some(BehaviorHints {
            filename: filename.map(|v| v.to_string()),
            ..Default::default()
        }),
        ..test_stream()
    }
}

#[test]
fn normalize_stream_media_type_promotes_kitsu_series_ids_to_anime() {
    assert_eq!(
        normalize_stream_media_type("series", Some("kitsu:42")),
        Some("anime")
    );
    assert_eq!(
        normalize_stream_media_type("series", Some("KITSU:42")),
        Some("anime")
    );
    assert_eq!(
        normalize_stream_media_type("series", Some("tt0944947")),
        Some("series")
    );
}

#[test]
fn placeholder_block_payload_is_filtered() {
    let blocked = mk_stream(
        Some("[BLOCKED] No Streams Available"),
        Some("No streams found for this content"),
        Some("data:text/plain;charset=utf-8,No%20streams%20available"),
        None,
        Some("no_streams_available.txt"),
    );

    assert!(is_placeholder_no_stream(&blocked));
    assert!(!has_playable_stream_source(&blocked));
}

#[test]
fn stream_with_filename_marker_is_treated_as_placeholder() {
    let blocked = mk_stream(
        Some("No Streams"),
        Some("Try again later"),
        Some("https://example.com/not-a-video"),
        None,
        Some("no_streams_available.txt"),
    );
    assert!(is_placeholder_no_stream(&blocked));
}

#[test]
fn viable_sources_accept_http_magnet_or_hash() {
    let http = mk_stream(
        None,
        None,
        Some("https://video.example/file.mkv"),
        None,
        None,
    );
    let magnet = mk_stream(None, None, Some("magnet:?xt=urn:btih:abc"), None, None);
    let hash_only = mk_stream(None, None, None, Some("deadbeef"), None);

    assert!(has_playable_stream_source(&http));
    assert!(has_playable_stream_source(&magnet));
    assert!(has_playable_stream_source(&hash_only));
}

#[test]
fn stream_dedup_key_prefers_hash_over_url() {
    let mut stream = mk_stream(
        Some("Example"),
        Some("1080p"),
        Some("https://example.com/video.mkv"),
        Some("abcdef123456"),
        None,
    );
    stream.file_idx = Some(7);

    assert_eq!(
        streaming_helpers::stream_dedup_key(&stream).as_deref(),
        Some("h:abcdef123456:7")
    );
}

#[test]
fn stream_dedup_key_recovers_magnet_xt_hash() {
    // Magnet-only streams (URL but no `info_hash` field) must still dedupe:
    // the `xt` hash is the same torrent identity and keys identically to a
    // field-carrying duplicate, including across case and extra trackers.
    let magnet = mk_stream(
        Some("Magnet-only"),
        Some("1080p"),
        Some("magnet:?xt=urn:btih:ABC123&tr=udp://tracker"),
        None,
        None,
    );
    let hashed = mk_stream(
        Some("Hashed"),
        Some("1080p"),
        Some("magnet:?xt=urn:btih:abc123&tr=udp://other"),
        Some("abc123"),
        None,
    );
    let xtless = mk_stream(
        Some("Xt-less"),
        Some("1080p"),
        Some("magnet:?dn=name-only"),
        None,
        None,
    );

    assert_eq!(
        streaming_helpers::stream_dedup_key(&magnet).as_deref(),
        Some("h:abc123:0")
    );
    // Same `h:` key family: an infoHash-field stream and a magnet-only
    // stream for one torrent collapse to a single selector row.
    assert_eq!(
        streaming_helpers::stream_dedup_key(&hashed).as_deref(),
        streaming_helpers::stream_dedup_key(&magnet).as_deref()
    );
    // A magnet with no `xt` hash has no recoverable identity — drop the row
    // rather than keying on raw attacker-controlled bytes.
    assert_eq!(streaming_helpers::stream_dedup_key(&xtless), None);
}

#[test]
fn stream_dedup_key_normalizes_url_variants_and_file_index() {
    let indexed = mk_stream(
        Some("Multi-file"),
        Some("1080p"),
        Some("https://EXAMPLE.com/video.mkv?utm_source=x&v=2"),
        None,
        None,
    );
    let mut plain = mk_stream(
        Some("Multi-file"),
        Some("1080p"),
        Some("https://example.com/video.mkv?v=2"),
        None,
        None,
    );
    plain.file_idx = Some(1);

    let indexed_key = streaming_helpers::stream_dedup_key(&indexed);
    let plain_key = streaming_helpers::stream_dedup_key(&plain);
    // URL keys carry a digest, never the URL text: the key serializes to the
    // webview and persists as `last_stream_key`, and normalized URLs can
    // still hold signed query credentials.
    let indexed_key = indexed_key.as_deref().unwrap_or_default();
    let plain_key = plain_key.as_deref().unwrap_or_default();
    assert!(indexed_key.starts_with("uh:"));
    assert!(indexed_key.ends_with(":0"));
    assert!(plain_key.starts_with("uh:"));
    assert!(plain_key.ends_with(":1"));
    assert!(!indexed_key.contains("example.com"));
    assert!(!plain_key.contains("example.com"));
    // Only the file index differs: tracking-query/case variants of one file
    // still dedupe to a single row.
    assert_eq!(indexed_key.len(), plain_key.len());
    assert_eq!(
        &indexed_key[..indexed_key.len() - 1],
        &plain_key[..plain_key.len() - 1]
    );
    assert_ne!(indexed_key, plain_key);
}

#[test]
fn stream_dedup_key_url_variants_share_one_digest() {
    let signed = mk_stream(
        Some("Multi-file"),
        Some("1080p"),
        Some("https://EXAMPLE.com/video.mkv?utm_source=x&sig=abc"),
        None,
        None,
    );
    let resigned = mk_stream(
        Some("Multi-file"),
        Some("1080p"),
        Some("https://example.com/video.mkv?sig=def"),
        None,
        None,
    );

    // Distinct signatures are distinct keys — the digest preserves exact
    // dedup semantics instead of collapsing credential-bearing variants.
    let signed_key = streaming_helpers::stream_dedup_key(&signed).unwrap_or_default();
    let resigned_key = streaming_helpers::stream_dedup_key(&resigned).unwrap_or_default();
    assert_ne!(signed_key, resigned_key);
    assert!(!signed_key.contains("sig=abc"));
    assert!(!resigned_key.contains("sig=def"));
}

#[test]
fn prepare_addon_streams_uses_generic_cached_label() {
    let mut stream = mk_stream(
        Some("Cached Release"),
        Some("1080p"),
        Some("https://example.com/video.mkv"),
        None,
        None,
    );
    stream.cached = true;

    let prepared = prepare_addon_streams(vec![stream], "CaseTest", "addon-casetest");
    assert_eq!(prepared.len(), 1);
    assert_eq!(prepared[0].presentation.delivery_label.as_str(), "Cached");
}

#[test]
fn stream_pipeline_dedupes_hash_case_insensitively() {
    let mut upper = mk_stream(
        Some("Upper hash"),
        Some("1080p"),
        Some("magnet:?xt=urn:btih:ABCDEF1234"),
        Some("ABCDEF1234"),
        None,
    );
    upper.file_idx = Some(2);

    let mut lower = mk_stream(
        Some("Lower hash"),
        Some("1080p"),
        Some("magnet:?xt=urn:btih:abcdef1234"),
        Some("abcdef1234"),
        None,
    );
    lower.file_idx = Some(2);

    // Prepare keys each stream; the merge stage owns dedup.
    let prepared = prepare_addon_streams(vec![upper, lower], "CaseTest", "addon-casetest");
    assert_eq!(prepared.len(), 2);

    let mut merged = Vec::new();
    let mut seen = std::collections::HashSet::new();
    merge_unique_streams(&mut merged, &mut seen, prepared);
    assert_eq!(merged.len(), 1);
}

#[test]
fn prepare_addon_streams_filters_labels_and_merge_dedupes() {
    let mut a = mk_stream(
        Some("Release A"),
        Some("1080p"),
        Some("magnet:?xt=urn:btih:abc"),
        Some("abc"),
        None,
    );
    a.file_idx = Some(1);

    let mut duplicate = a.clone();
    duplicate.title = Some("Duplicate entry".to_string());

    let blocked = mk_stream(
        Some("[BLOCKED] No Streams Available"),
        Some("No streams found for this content"),
        Some("data:text/plain,blocked"),
        None,
        Some("no_streams_available.txt"),
    );

    let prepared = prepare_addon_streams(
        vec![a, duplicate, blocked],
        "TestSource",
        "addon-testsource",
    );
    assert_eq!(prepared.len(), 2);

    let mut merged = Vec::new();
    let mut seen = std::collections::HashSet::new();
    merge_unique_streams(&mut merged, &mut seen, prepared);

    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0].source_name.as_deref(), Some("TestSource"));
    assert_eq!(merged[0].info_hash.as_deref(), Some("abc"));
    assert!(merged[0].stream_family.is_some());
}

#[test]
fn prepare_addon_streams_populates_stream_presentation() {
    let stream = mk_stream(
        Some("Show Complete Season Pack"),
        Some("2160p HDR10+ AV1 Dual Audio 1.4 GB"),
        Some("https://example.com/video.mkv"),
        None,
        Some("Show.S01E01-E12.2160p.HDR10+.mkv"),
    );

    let prepared = prepare_addon_streams(vec![stream], "TestSource", "addon-testsource");
    assert_eq!(prepared.len(), 1);

    let presentation = &prepared[0].presentation;
    assert_eq!(presentation.source_name, "Show Complete Season Pack");
    assert_eq!(presentation.resolution, StreamResolution::P2160);
    assert_eq!(presentation.hdr_label.as_deref(), Some("HDR10+"));
    assert_eq!(presentation.codec_label.as_deref(), Some("AV1"));
    assert_eq!(presentation.multi_audio_label.as_deref(), Some("DUAL"));
    assert_eq!(presentation.size_label.as_deref(), Some("1.4GB"));
    assert!(presentation.is_batch);
}

#[test]
fn stream_flags_share_badge_and_rank_vocabulary() {
    // Every spelling either side historically knew must set the shared flag —
    // a marker only the badge or only the ranker knew made them disagree.
    // `detect_stream_flags` probes an already-lowered haystack (the
    // `StreamMatchText` contract), so these literals stay lowercase.
    assert!(detect_stream_flags("show s01e01 dual.audio 1080p").dual_audio);
    assert!(detect_stream_flags("show s01e01 dub + sub 1080p").dual_audio);
    assert!(detect_stream_flags("show s01e01 dubbed/subbed 1080p").dual_audio);
    assert!(!detect_stream_flags("show s01e01 1080p").dual_audio);

    assert!(detect_stream_flags("show s01e01 multiaudio 1080p").multi_audio);
    assert!(detect_stream_flags("show s01e01 multi-lang 1080p").multi_audio);
    assert!(detect_stream_flags("show s01e01 multi subtitle 1080p").multi_sub);
    assert!(!detect_stream_flags("show s01e01 1080p").multi_audio);
    assert!(!detect_stream_flags("show s01e01 1080p").multi_sub);
}

#[test]
fn stream_language_bonus_shares_marker_vocabulary_with_badge() {
    // Every spelling the badge labels DUAL/MULTI must also earn the ranker's
    // language bonus — the private literal list this replaced missed the
    // dot/dash separator forms, so a DUAL-badged stream could rank below an
    // otherwise identical single-audio release.
    for (name, badge) in [
        ("Show 1080p dual.audio", Some("DUAL")),
        ("Show 1080p multi-lang", Some("MULTI")),
        ("Show 1080p", None),
    ] {
        let stream = mk_stream(
            Some(name),
            None,
            Some("https://example.com/video.mkv"),
            None,
            None,
        );
        let prepared = prepare_addon_streams(vec![stream], "TestSource", "addon-testsource");
        assert_eq!(prepared.len(), 1);
        let stream = &prepared[0];
        assert_eq!(stream.presentation.multi_audio_label.as_deref(), badge);
        let priority = stream_resolution_priority(stream, stream.match_texts().flags);
        assert_eq!(priority.language_bonus, u8::from(badge.is_some()));
    }
}

#[test]
fn stream_resolution_score_and_badge_share_one_tier_classifier() {
    // The quality score and the presentation badge must read the same
    // resolution tier: the duplicated literal lists this replaced scored
    // `480p` above SD while badging it "sd", and `4k`/`2160p` had to be
    // hand-kept in step on both sides.
    for (name, resolution, quality) in [
        ("Show 2160p", StreamResolution::P2160, 400),
        ("Show 4k", StreamResolution::P2160, 400),
        ("Show 1080p", StreamResolution::P1080, 300),
        ("Show 720p", StreamResolution::P720, 200),
        ("Show 480p", StreamResolution::Sd, 100),
        ("Show", StreamResolution::Sd, 0),
    ] {
        let stream = mk_stream(
            Some(name),
            None,
            Some("https://example.com/video.mkv"),
            None,
            None,
        );
        let prepared = prepare_addon_streams(vec![stream], "TestSource", "addon-testsource");
        assert_eq!(prepared.len(), 1, "{name}");
        let stream = &prepared[0];
        assert_eq!(stream.presentation.resolution, resolution, "{name}");
        let priority = stream_resolution_priority(stream, stream.match_texts().flags);
        assert_eq!(priority.quality, quality, "{name}");
    }
}

#[test]
fn stream_family_ignores_episode_number_noise() {
    let source_name = "Alpha";
    let stream_one = mk_stream(
        Some("Alpha Group S01E01 1080p WEB-DL"),
        Some("1.4 GB"),
        Some("magnet:?xt=urn:btih:alpha-1"),
        Some("alpha-1"),
        Some("Show.S01E01.1080p.WEB-DL-GROUP.mkv"),
    );
    let stream_two = mk_stream(
        Some("Alpha Group S01E02 1080p WEB-DL"),
        Some("1.5 GB"),
        Some("magnet:?xt=urn:btih:alpha-2"),
        Some("alpha-2"),
        Some("Show.S01E02.1080p.WEB-DL-GROUP.mkv"),
    );

    let family_one = streaming_helpers::derive_stream_family(&stream_one, source_name);
    let family_two = streaming_helpers::derive_stream_family(&stream_two, source_name);

    assert_eq!(family_one, family_two);

    // Underscore-joined names hit the `_`-defeats-`\b` pitfall the strip
    // regexes otherwise miss — they must resolve to the same family key.
    let underscore_one = mk_stream(
        Some("Alpha_Group_S01E01_1080p_WEB-DL"),
        Some("1.4 GB"),
        Some("magnet:?xt=urn:btih:alpha-1"),
        Some("alpha-1"),
        Some("Show_S01E01_1080p_WEB-DL-GROUP.mkv"),
    );
    let underscore_two = mk_stream(
        Some("Alpha_Group_S01E02_1080p_WEB-DL"),
        Some("1.5 GB"),
        Some("magnet:?xt=urn:btih:alpha-2"),
        Some("alpha-2"),
        Some("Show_S01E02_1080p_WEB-DL-GROUP.mkv"),
    );

    let family_one = streaming_helpers::derive_stream_family(&underscore_one, source_name);
    let family_two = streaming_helpers::derive_stream_family(&underscore_two, source_name);

    assert_eq!(family_one, family_two);
}

#[test]
fn magnet_only_stream_shares_hashed_viability() {
    // Magnet-only and infoHash-field spellings dedupe to one `h:`
    // identity, so viability must agree — otherwise which duplicate
    // survives merge order decides the rank input.
    let magnet = mk_stream(
        Some("Magnet-only"),
        Some("1080p"),
        Some("magnet:?xt=urn:btih:abc123"),
        None,
        None,
    );
    let hashed = mk_stream(
        Some("Hashed"),
        Some("1080p"),
        Some("magnet:?xt=urn:btih:abc123"),
        Some("abc123"),
        None,
    );
    let prepared = prepare_addon_streams(vec![magnet, hashed], "S", "addon-s");
    assert_eq!(prepared.len(), 2);
    let viability = |stream: &AddonStream| {
        stream_resolution_priority(stream, stream.match_texts().flags).viability
    };
    assert_eq!(viability(&prepared[0]), 2);
    assert_eq!(viability(&prepared[0]), viability(&prepared[1]));
}

#[test]
fn title_watch_history_rows_keep_every_episode_sorted_and_hydrated() {
    // Regression pin: the collapsed unique view only surfaced the latest
    // episode, so per-episode progress bars, spoiler gating, resume times,
    // the selector's exact `last_stream_key` match, and the undo snapshot's
    // per-row restore keys all lost every other episode of the title.
    let mut older = mk_watch_progress("tt123", "series", 1_000);
    older.season = Some(1);
    older.episode = Some(2);
    // Legacy row missing hydrated coordinates + lookup anchor.
    older.absolute_season = None;
    older.absolute_episode = None;
    older.last_stream_lookup_id = None;

    let mut latest = mk_watch_progress("tt123", "series", 2_000);
    latest.season = Some(1);
    latest.episode = Some(3);
    latest.absolute_season = Some(1);
    latest.absolute_episode = Some(3);
    latest.last_stream_key = Some("s:key".to_string());

    let rows = build_title_watch_history_rows(vec![older, latest]);

    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].episode, Some(3));
    assert_eq!(rows[1].episode, Some(2));
    // Hydration parity with `choose_latest_entry`: coordinates + lookup id.
    assert_eq!(rows[1].absolute_season, Some(1));
    assert_eq!(rows[1].absolute_episode, Some(2));
    assert_eq!(rows[1].last_stream_lookup_id.as_deref(), Some("tt123"));
}

#[test]
fn title_watch_history_rows_hydrate_lookup_id_within_series_gate() {
    let mut kitsu = mk_watch_progress("kitsu:42", "anime", 1_000);
    kitsu.season = Some(1);
    kitsu.episode = Some(1);

    let mut imdb = mk_watch_progress("tt999", "series", 2_000);
    imdb.season = Some(1);
    imdb.episode = Some(1);

    let rows = build_title_watch_history_rows(vec![kitsu, imdb]);

    // The `tt` resume-anchor gate mirrors `has_usable_resume_lookup_id`: a
    // kitsu: series id can't seed a lookup anchor; a tt id can.
    assert_eq!(rows[0].last_stream_lookup_id.as_deref(), Some("tt999"));
    assert_eq!(rows[1].last_stream_lookup_id, None);
}

#[test]
fn near_completion_progress_is_not_skipped() {
    let mut existing = mk_watch_progress("tt123", "series", 1_000);
    existing.season = Some(1);
    existing.episode = Some(2);
    existing.absolute_season = Some(1);
    existing.absolute_episode = Some(2);
    existing.position = 869.0;
    existing.duration = 900.0;

    let mut incoming = existing.clone();
    incoming.last_watched = 6_000;
    incoming.position = 871.0;

    assert!(!history_helpers::should_skip_watch_progress_save(
        &existing, &incoming,
    ));
}

#[test]
fn merge_unique_streams_skips_already_seen_entries() {
    let mut merged = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let mut first = mk_stream(
        Some("First"),
        Some("720p"),
        Some("magnet:?xt=urn:btih:first"),
        Some("firsthash"),
        None,
    );
    first.file_idx = Some(0);
    let second = mk_stream(
        Some("Second"),
        Some("1080p"),
        Some("magnet:?xt=urn:btih:second"),
        Some("secondhash"),
        None,
    );

    let mut dupe = first.clone();
    dupe.name = Some("Duplicate".to_string());

    // Merge keys on the prepare-stage `stream_key`; raw streams never merge.
    let first_prepared = prepare_addon_streams(vec![first], "S", "addon-s");
    let first_key = first_prepared[0].stream_key.clone();
    merge_unique_streams(&mut merged, &mut seen, first_prepared);
    merge_unique_streams(
        &mut merged,
        &mut seen,
        prepare_addon_streams(vec![second], "S", "addon-s"),
    );
    merge_unique_streams(
        &mut merged,
        &mut seen,
        prepare_addon_streams(vec![dupe.clone()], "S", "addon-s"),
    );

    assert_eq!(merged.len(), 2);
    assert_eq!(seen.len(), 2);

    // `seen` holds identities, not positions: a reordered re-merge of a
    // duplicate neither inserts nor rewrites the kept row.
    merged.reverse();
    merge_unique_streams(
        &mut merged,
        &mut seen,
        prepare_addon_streams(vec![dupe], "S", "addon-s"),
    );
    assert_eq!(merged.len(), 2);
    let kept = merged
        .iter()
        .find(|stream| stream.stream_key == first_key)
        .expect("first stream retained");
    assert_eq!(kept.source_id.as_deref(), Some("addon-s"));
}

#[test]
fn merge_unique_streams_preserves_source_transport_variants() {
    let mut merged = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // Same torrent identity, different serving transports: addon-a lists a
    // hash-only P2P row while addon-b serves a direct URL for the same file.
    let torrent = mk_stream(
        Some("Shared"),
        Some("1080p"),
        None,
        Some("sharedhash"),
        None,
    );
    let direct = mk_stream(
        Some("Shared"),
        Some("1080p"),
        Some("https://cdn.test/file.mkv"),
        Some("sharedhash"),
        None,
    );

    merge_unique_streams(
        &mut merged,
        &mut seen,
        prepare_addon_streams(vec![torrent], "Shared", "addon-a"),
    );
    merge_unique_streams(
        &mut merged,
        &mut seen,
        prepare_addon_streams(vec![direct], "Shared", "addon-b"),
    );

    assert_eq!(merged.len(), 2);
    assert_eq!(merged[0].source_id.as_deref(), Some("addon-a"));
    assert_eq!(merged[1].source_id.as_deref(), Some("addon-b"));
    assert_ne!(merged[0].stream_key, merged[1].stream_key);
    // The direct variant keeps its playable transport and presentation.
    assert_eq!(
        merged[1].presentation.delivery_kind,
        StreamDeliveryKind::Http
    );
    assert!(merged[1].presentation.is_instantly_playable);

    let identical = mk_stream(
        Some("Shared"),
        Some("1080p"),
        Some("https://cdn.test/shared.mkv"),
        None,
        None,
    );
    let mut source_scoped = Vec::new();
    let mut source_seen = std::collections::HashSet::new();
    merge_unique_streams(
        &mut source_scoped,
        &mut source_seen,
        prepare_addon_streams(vec![identical.clone()], "Shared", "addon-a"),
    );
    merge_unique_streams(
        &mut source_scoped,
        &mut source_seen,
        prepare_addon_streams(vec![identical], "Shared", "addon-b"),
    );
    assert_eq!(source_scoped.len(), 2);
    assert_ne!(source_scoped[0].stream_key, source_scoped[1].stream_key);
    assert_eq!(source_scoped[0].source_id.as_deref(), Some("addon-a"));
    assert_eq!(source_scoped[1].source_id.as_deref(), Some("addon-b"));

    // Same addon + same URL but different required request headers are
    // distinct transports: neither collapses into the other, and the header
    // secrets never appear in the issued keys.
    let mut header_a = mk_stream(
        Some("Shared"),
        Some("1080p"),
        Some("https://cdn.test/file.mkv"),
        None,
        None,
    );
    header_a.behavior_hints = Some(crate::providers::addons::BehaviorHints {
        proxy_headers: Some(serde_json::json!({
            "request": {"Authorization": "Bearer a"}
        })),
        ..Default::default()
    });
    let mut header_b = mk_stream(
        Some("Shared"),
        Some("1080p"),
        Some("https://cdn.test/file.mkv"),
        None,
        None,
    );
    header_b.behavior_hints = Some(crate::providers::addons::BehaviorHints {
        proxy_headers: Some(serde_json::json!({
            "request": {"Authorization": "Bearer b"}
        })),
        ..Default::default()
    });

    let mut merged = Vec::new();
    let mut seen = std::collections::HashSet::new();
    merge_unique_streams(
        &mut merged,
        &mut seen,
        prepare_addon_streams(vec![header_a, header_b], "A", "addon-a"),
    );

    assert_eq!(merged.len(), 2);
    assert_ne!(merged[0].stream_key, merged[1].stream_key);
    for stream in &merged {
        assert!(stream.stream_key.starts_with("s:"));
        assert!(!stream.stream_key.to_ascii_lowercase().contains("bearer"));
    }
}

/// Table-driven `build_stream_query_ids` cases: each row expands to its own
/// named `#[test]` so a failure still pins the input shape, and the produced
/// ids are echoed in assert messages for diagnosability.
macro_rules! query_ids_tests {
    ($($name:ident: ($media:expr, $id:expr, $season:expr, $episode:expr, $absolute:expr) => $check:expr;)*) => {
        $(
            #[test]
            fn $name() {
                let ids =
                    build_stream_query_ids($media, $id, $season, $episode, $absolute);
                let check: fn(&[String]) = $check;
                check(&ids);
            }
        )*
    };
}

query_ids_tests! {
    query_ids_movie_returns_single_id:
        ("movie", "tt1234567", None, None, None)
        => |ids: &[String]| assert_eq!(ids, ["tt1234567"], "{ids:?}");
    query_ids_series_no_anime_no_fallback:
        ("series", "tt9998887", Some(2), Some(5), None)
        => |ids: &[String]| assert_eq!(ids, ["tt9998887:2:5"], "{ids:?}");
    query_ids_anime_imdb_adds_season_zero_and_season_one_fallbacks:
        ("anime", "tt1111111", Some(2), Some(10), None)
        => |ids: &[String]| {
            for expected in ["tt1111111:2:10", "tt1111111:1:10", "tt1111111:0:10"] {
                assert!(
                    ids.iter().any(|id| id == expected),
                    "{expected} missing from {ids:?}"
                );
            }
        };
    query_ids_anime_season_one_no_duplicate_season_one:
        ("anime", "tt2222222", Some(1), Some(3), None)
        => |ids: &[String]| assert_eq!(
            ids.iter().filter(|s| s.as_str() == "tt2222222:1:3").count(),
            1,
            "canonical id should appear exactly once: {ids:?}"
        );
    query_ids_anime_adds_absolute_episode_fallback_when_different:
        ("anime", "tt0388629", Some(21), Some(5), Some(1000))
        => |ids: &[String]| {
            for expected in [
                "tt0388629:21:5",
                "tt0388629:1:5",
                "tt0388629:1:1000",
                "tt0388629:0:5",
            ] {
                assert!(
                    ids.iter().any(|id| id == expected),
                    "{expected} missing from {ids:?}"
                );
            }
        };
    // Kitsu-space addons index episodes flat (`kitsu:{id}:{episode}`); the
    // canonical season form stays first and the flat form is the fallback.
    query_ids_anime_namespaced_id_adds_flat_episode_fallback:
        ("anime", "kitsu:12345", Some(1), Some(7), Some(7))
        => |ids: &[String]| assert_eq!(ids, ["kitsu:12345:1:7", "kitsu:12345:7"], "{ids:?}");
    query_ids_anime_namespaced_id_adds_absolute_fallback_when_different:
        ("anime", "kitsu:42", Some(1), Some(12), Some(30))
        => |ids: &[String]| assert_eq!(
            ids,
            ["kitsu:42:1:12", "kitsu:42:12", "kitsu:42:30"],
            "{ids:?}"
        );
    // The flat-episode widening is anime-only: namespaced series ids
    // (tmdb:, …) get no extra probes.
    query_ids_series_namespaced_id_keeps_canonical_only:
        ("series", "tmdb:9", Some(1), Some(5), Some(5))
        => |ids: &[String]| assert_eq!(ids, ["tmdb:9:1:5"], "{ids:?}");
}

#[test]
fn resolve_addon_configs_pins_defaults_for_explicit_empty_list() {
    let resolved = resolve_addon_configs(Some(vec![]));

    // Both defaults are pinned and cannot be removed; an empty stored list
    // gains the enabled defaults instead of staying empty.
    assert_eq!(resolved.len(), 2);
    assert_eq!(resolved[0].url, "https://v3-cinemeta.strem.io");
    assert_eq!(resolved[1].url, "https://opensubtitles-v3.strem.io");
    assert!(resolved[0].enabled && resolved[1].enabled);
}

#[test]
fn resolve_addon_configs_seeds_defaults_when_uninitialized() {
    let resolved = resolve_addon_configs(None);

    assert_eq!(resolved.len(), 2);
    assert_eq!(resolved[0].id, "https://v3-cinemeta.strem.io");
    assert_eq!(resolved[0].url, "https://v3-cinemeta.strem.io");
    assert_eq!(resolved[0].name, "Cinemeta");
    assert_eq!(resolved[1].id, "https://opensubtitles-v3.strem.io");
    assert_eq!(resolved[1].url, "https://opensubtitles-v3.strem.io");
    assert_eq!(resolved[1].name, "OpenSubtitles");
    assert!(resolved[0].enabled && resolved[1].enabled);
}

#[test]
fn resolve_addon_configs_does_not_reseed_after_explicit_user_changes() {
    let disabled = resolve_addon_configs(Some(vec![
        AddonConfig {
            enabled: false,
            ..cinemeta_addon()
        },
        AddonConfig {
            id: "https://opensubtitles-v3.strem.io".to_string(),
            url: "https://opensubtitles-v3.strem.io".to_string(),
            name: "OpenSubtitles".to_string(),
            enabled: false,
            capabilities: None,
        },
    ]));
    assert_eq!(disabled.len(), 2);
    assert_eq!(disabled[0].url, "https://v3-cinemeta.strem.io");
    assert_eq!(disabled[1].url, "https://opensubtitles-v3.strem.io");
    assert!(!disabled[0].enabled && !disabled[1].enabled);

    let replaced = resolve_addon_configs(Some(vec![AddonConfig {
        id: "metadata-replacement".to_string(),
        url: "https://example-meta.test".to_string(),
        name: "Replacement".to_string(),
        enabled: true,
        capabilities: None,
    }]));
    // A replacement metadata addon is kept, but the pinned defaults stay on top.
    assert_eq!(replaced.len(), 3);
    assert_eq!(replaced[0].url, "https://v3-cinemeta.strem.io");
    assert_eq!(replaced[1].url, "https://opensubtitles-v3.strem.io");
    assert!(replaced[0].enabled && replaced[1].enabled);
    assert_eq!(replaced[2].id, "metadata-replacement");
    assert_eq!(replaced[2].url, "https://example-meta.test");
}

#[test]
fn resolve_addon_configs_moves_stored_defaults_first_preserving_toggle() {
    let resolved = resolve_addon_configs(Some(vec![
        AddonConfig {
            id: "stream-addon".to_string(),
            url: "https://stream-addon.test".to_string(),
            name: "Stream Addon".to_string(),
            enabled: true,
            capabilities: None,
        },
        AddonConfig {
            enabled: false,
            ..cinemeta_addon()
        },
    ]));

    assert_eq!(resolved.len(), 3);
    assert_eq!(resolved[0].url, "https://v3-cinemeta.strem.io");
    assert!(!resolved[0].enabled);
    assert_eq!(resolved[1].url, "https://opensubtitles-v3.strem.io");
    assert!(resolved[1].enabled);
    assert_eq!(resolved[2].url, "https://stream-addon.test");
}

#[test]
fn resolve_addon_configs_preserves_stored_capability_snapshot() {
    let resolved = resolve_addon_configs(Some(vec![classified_cinemeta_addon()]));

    assert_eq!(resolved.len(), 2);
    assert_eq!(resolved[0].capabilities, Some(cinemeta_manifest()));
}

#[test]
fn resolve_addon_configs_drops_nameless_stored_snapshots() {
    let resolved = resolve_addon_configs(Some(vec![AddonConfig {
        capabilities: Some(crate::providers::addon_manifest::AddonManifest {
            name: String::new(),
            resources: Vec::new(),
            catalogs: Vec::new(),
        }),
        ..cinemeta_addon()
    }]));

    assert_eq!(resolved.len(), 2);
    assert!(resolved[0].capabilities.is_none());
}

#[test]
fn resolve_addon_configs_drops_display_only_stored_snapshots() {
    let resolved = resolve_addon_configs(Some(vec![AddonConfig {
        capabilities: Some(crate::providers::addon_manifest::AddonManifest {
            name: "Cinemeta".to_string(),
            resources: Vec::new(),
            catalogs: Vec::new(),
        }),
        ..cinemeta_addon()
    }]));

    assert_eq!(resolved.len(), 2);
    assert!(resolved[0].capabilities.is_none());
}

#[test]
fn apply_manifest_snapshot_fills_only_the_host_fallback_name() {
    // The add flow seeds the URL host as a placeholder label: a classified
    // snapshot replaces it with the manifest's own name.
    let mut addon = AddonConfig {
        name: "v3-cinemeta.strem.io".to_string(),
        ..cinemeta_addon()
    };
    assert!(apply_manifest_snapshot(&mut addon, cinemeta_manifest()));
    assert_eq!(addon.name, "Cinemeta");
    assert_eq!(addon.capabilities, Some(cinemeta_manifest()));

    // JS `URL.host` keeps a non-default port, so the seeded fallback can be
    // `host:port` — the same placeholder rule must recognize it.
    let mut ported = AddonConfig {
        url: "https://example.com:8443".to_string(),
        name: "example.com:8443".to_string(),
        ..cinemeta_addon()
    };
    assert!(apply_manifest_snapshot(&mut ported, cinemeta_manifest()));
    assert_eq!(ported.name, "Cinemeta");

    // An explicit custom name is preserved.
    let mut custom = AddonConfig {
        name: "My Addon".to_string(),
        ..cinemeta_addon()
    };
    assert!(apply_manifest_snapshot(&mut custom, cinemeta_manifest()));
    assert_eq!(custom.name, "My Addon");
    assert!(custom.capabilities.is_some());
}

#[test]
fn apply_manifest_snapshot_rejects_unclassified_without_touching_name() {
    let mut addon = AddonConfig {
        name: "v3-cinemeta.strem.io".to_string(),
        ..cinemeta_addon()
    };
    let display_only = crate::providers::addon_manifest::AddonManifest {
        name: "Pretty Name".to_string(),
        resources: Vec::new(),
        catalogs: Vec::new(),
    };

    assert!(!apply_manifest_snapshot(&mut addon, display_only));
    assert_eq!(addon.name, "v3-cinemeta.strem.io");
    assert!(addon.capabilities.is_none());
}

/// Table-driven `normalize_addon_url` cases: `Ok(Some(url))` expects a
/// normalized value, `Err(needle)` expects a rejection containing it. Each
/// row keeps its own named `#[test]`, and the input is echoed in assert
/// messages for diagnosability.
macro_rules! addon_url_tests {
    ($($name:ident: [$($case:expr),+ $(,)?];)*) => {
        $(
            #[test]
            fn $name() {
                for (input, expected) in [$($case),+] {
                    match expected {
                        Ok::<Option<&str>, &str>(want) => assert_eq!(
                            normalize_addon_url(input)
                                .unwrap_or_else(|error| panic!("{input} must normalize: {error}"))
                                .as_deref(),
                            want,
                            "{input}"
                        ),
                        Err(needle) => {
                            let error = match normalize_addon_url(input) {
                                Err(error) => error,
                                Ok(normalized) => {
                                    panic!("{input} must be rejected, got {normalized:?}")
                                }
                            };
                            assert!(error.contains(needle), "{input}: {error}");
                        }
                    }
                }
            }
        )*
    };
}

addon_url_tests! {
    normalize_addon_url_strips_manifest_suffix_and_fragment: [
        (
            "https://example-addon.test/path/manifest.json?foo=bar#fragment",
            Ok(Some("https://example-addon.test/path?foo=bar"))
        ),
    ];
    normalize_addon_url_accepts_stremio_install_references: [
        (
            "stremio://v3-cinemeta.strem.io/manifest.json",
            Ok(Some("https://v3-cinemeta.strem.io"))
        ),
    ];
    normalize_addon_url_preserves_stremio_path_and_query: [
        (
            "STREMIO://stream-addon.test/configure/apikey=token/manifest.json?lang=en#ignored",
            Ok(Some("https://stream-addon.test/configure/apikey=token?lang=en"))
        ),
    ];
    normalize_addon_url_rejects_unsupported_schemes: [
        ("ftp://example-addon.test/manifest.json", Err("stremio://")),
    ];
    normalize_addon_url_unwraps_nested_http_transport: [
        (
            "stremio://https://v3-cinemeta.strem.io/manifest.json",
            Ok(Some("https://v3-cinemeta.strem.io"))
        ),
        (
            "stremio://http://127.0.0.1:11470/manifest.json",
            Ok(Some("http://127.0.0.1:11470"))
        ),
    ];
    normalize_addon_url_strips_manifest_suffix_case_insensitively: [
        (
            "https://example-addon.test/path/Manifest.json?foo=bar",
            Ok(Some("https://example-addon.test/path?foo=bar"))
        ),
    ];
    normalize_addon_url_rejects_nested_unsupported_scheme: [
        (
            "stremio://ftp://example-addon.test/manifest.json",
            Err("stremio://")
        ),
    ];
}

#[test]
fn resolve_addon_configs_normalizes_loaded_addons() {
    let resolved = resolve_addon_configs(Some(vec![AddonConfig {
        id: "   ".to_string(),
        url: "stream-addon.test/manifest.json".to_string(),
        name: "   ".to_string(),
        enabled: true,
        capabilities: None,
    }]));

    assert_eq!(resolved.len(), 3);
    assert_eq!(resolved[0].url, "https://v3-cinemeta.strem.io");
    assert_eq!(resolved[2].id, "https://stream-addon.test");
    assert_eq!(resolved[2].url, "https://stream-addon.test");
    assert_eq!(resolved[2].name, "stream-addon.test");
}

#[test]
fn resolve_addon_configs_dedupes_duplicate_urls() {
    let resolved = resolve_addon_configs(Some(vec![
        AddonConfig {
            id: "addon-primary".to_string(),
            url: "https://stream-addon.test/manifest.json".to_string(),
            name: "Addon A".to_string(),
            enabled: true,
            capabilities: None,
        },
        AddonConfig {
            id: "addon-secondary".to_string(),
            url: "stream-addon.test".to_string(),
            name: "Addon B".to_string(),
            enabled: false,
            capabilities: None,
        },
    ]));

    assert_eq!(resolved.len(), 3);
    assert_eq!(resolved[0].url, "https://v3-cinemeta.strem.io");
    assert_eq!(resolved[2].id, "addon-primary");
    assert_eq!(resolved[2].url, "https://stream-addon.test");
    assert_eq!(resolved[2].name, "Addon A");
}

#[test]
fn resolve_addon_configs_repairs_duplicate_ids_for_distinct_urls() {
    let resolved = resolve_addon_configs(Some(vec![
        AddonConfig {
            id: "shared-id".to_string(),
            url: "https://stream-addon.test".to_string(),
            name: "Stream Addon".to_string(),
            enabled: true,
            capabilities: None,
        },
        AddonConfig {
            id: "shared-id".to_string(),
            url: "https://example-addon.test/manifest.json".to_string(),
            name: "Example".to_string(),
            enabled: true,
            capabilities: None,
        },
    ]));

    assert_eq!(resolved.len(), 4);
    assert_eq!(resolved[0].url, "https://v3-cinemeta.strem.io");
    assert_eq!(resolved[2].id, "shared-id");
    assert_eq!(resolved[3].id, "https://example-addon.test");
    assert_eq!(resolved[3].url, "https://example-addon.test");
}

#[test]
fn choose_watch_history_entry_prefers_playable_resume_metadata() {
    let mut latest = mk_watch_progress("kitsu:42", "anime", 200);
    latest.season = Some(1);
    latest.episode = Some(12);

    let mut playable = mk_watch_progress("kitsu:42", "anime", 180);
    playable.season = Some(1);
    playable.episode = Some(12);
    playable.position = 512.0;
    playable.duration = 1_440.0;
    playable.last_stream_lookup_id = Some("tt1234567".to_string());
    playable.last_stream_url = Some("magnet:?xt=urn:btih:resume42".to_string());
    playable.last_stream_format = Some("video/mp4".to_string());

    let chosen = choose_entry(vec![latest, playable], HistoryEntryQuery::Latest, None)
        .expect("history entry");

    assert_eq!(chosen.last_watched, 200);
    assert_eq!(chosen.season, Some(1));
    assert_eq!(chosen.episode, Some(12));
    assert_eq!(chosen.position, 512.0);
    assert_eq!(chosen.duration, 1_440.0);
    assert_eq!(chosen.last_stream_lookup_id.as_deref(), Some("tt1234567"));
    // Stream URLs are credential-bearing and short-lived: donor URLs merge
    // position and identity metadata only, never the URL itself.
    assert_eq!(chosen.last_stream_url, None);
}

#[test]
fn choose_watch_history_entry_hydrates_lookup_from_imdb_id_for_series() {
    let mut latest = mk_watch_progress("tt7654321", "series", 200);
    latest.season = Some(1);
    latest.episode = Some(1);
    latest.position = 180.0;
    latest.duration = 1_200.0;
    latest.last_stream_url = Some("https://cdn.example/video.m3u8".to_string());

    let chosen =
        choose_entry(vec![latest], HistoryEntryQuery::Latest, None).expect("history entry");

    assert_eq!(chosen.last_stream_lookup_id.as_deref(), Some("tt7654321"));
}

#[test]
fn choose_watch_history_entry_prefers_same_episode_resume_donor() {
    let mut latest = mk_watch_progress("kitsu:42", "anime", 300);
    latest.season = Some(1);
    latest.episode = Some(12);

    let mut other_episode = mk_watch_progress("kitsu:42", "anime", 260);
    other_episode.season = Some(1);
    other_episode.episode = Some(11);
    other_episode.position = 420.0;
    other_episode.duration = 1_440.0;
    other_episode.last_stream_lookup_id = Some("tt-other-episode".to_string());
    other_episode.last_stream_url = Some("magnet:?xt=urn:btih:other11".to_string());

    let mut same_episode = mk_watch_progress("kitsu:42", "anime", 240);
    same_episode.season = Some(1);
    same_episode.episode = Some(12);
    same_episode.position = 512.0;
    same_episode.duration = 1_440.0;
    same_episode.last_stream_lookup_id = Some("tt-correct-episode".to_string());
    same_episode.last_stream_url = Some("magnet:?xt=urn:btih:same12".to_string());

    let chosen = choose_entry(
        vec![latest, other_episode, same_episode],
        HistoryEntryQuery::Latest,
        None,
    )
    .expect("history entry");

    assert_eq!(chosen.position, 512.0);
    assert_eq!(
        chosen.last_stream_lookup_id.as_deref(),
        Some("tt-correct-episode")
    );
    assert_eq!(chosen.last_stream_url, None);
}

#[test]
fn choose_watch_history_entry_avoids_cooldown_source_backfill_for_same_episode() {
    let mut latest = mk_watch_progress("tt7654321", "series", 300);
    latest.season = Some(1);
    latest.episode = Some(4);

    let mut cooldown_source = mk_watch_progress("tt7654321", "series", 280);
    cooldown_source.season = Some(1);
    cooldown_source.episode = Some(4);
    cooldown_source.position = 900.0;
    cooldown_source.duration = 2_400.0;
    cooldown_source.last_stream_lookup_id = Some("cooldown-lookup".to_string());
    cooldown_source.last_stream_url = Some("https://bad.example/episode-4.m3u8".to_string());
    cooldown_source.source_name = Some("Bad CDN".to_string());
    cooldown_source.source_id = Some("bad-cdn-id".to_string());

    let mut healthier_source = mk_watch_progress("tt7654321", "series", 260);
    healthier_source.season = Some(1);
    healthier_source.episode = Some(4);
    healthier_source.position = 860.0;
    healthier_source.duration = 2_400.0;
    healthier_source.last_stream_lookup_id = Some("healthy-lookup".to_string());
    healthier_source.source_name = Some("Good CDN".to_string());
    healthier_source.source_id = Some("good-cdn-id".to_string());

    let source_health_priorities = HashMap::from([
        ("bad-cdn-id".to_string(), 0_u8),
        ("good-cdn-id".to_string(), 3_u8),
    ]);

    let chosen = choose_entry(
        vec![latest, cooldown_source, healthier_source],
        HistoryEntryQuery::Latest,
        Some(&source_health_priorities),
    )
    .expect("history entry");

    assert_eq!(chosen.position, 860.0);
    assert_eq!(chosen.duration, 2_400.0);
    assert_eq!(chosen.source_name.as_deref(), Some("Good CDN"));
    // Donor merge carries the winning instance id, not just its label.
    assert_eq!(chosen.source_id.as_deref(), Some("good-cdn-id"));
    assert_eq!(chosen.last_stream_lookup_id.as_deref(), Some("tt7654321"));
    assert_eq!(chosen.last_stream_url, None);
}

#[test]
fn choose_watch_history_entry_does_not_borrow_resume_time_from_other_episode() {
    let mut latest = mk_watch_progress("kitsu:42", "anime", 300);
    latest.season = Some(1);
    latest.episode = Some(12);

    let mut other_episode = mk_watch_progress("kitsu:42", "anime", 260);
    other_episode.season = Some(1);
    other_episode.episode = Some(11);
    other_episode.position = 420.0;
    other_episode.duration = 1_440.0;
    other_episode.last_stream_lookup_id = Some("tt-other-episode".to_string());
    other_episode.last_stream_url = Some("magnet:?xt=urn:btih:other11".to_string());

    let chosen = choose_entry(vec![latest, other_episode], HistoryEntryQuery::Latest, None)
        .expect("history entry");

    assert_eq!(chosen.position, 0.0);
    assert_eq!(chosen.duration, 0.0);
    assert_eq!(
        chosen.last_stream_lookup_id.as_deref(),
        Some("tt-other-episode")
    );
    assert_eq!(chosen.last_stream_url, None);
}

#[test]
fn choose_watch_history_entry_requires_resume_threshold_before_treating_position_as_meaningful() {
    let mut latest = mk_watch_progress("tt7654321", "series", 300);
    latest.season = Some(1);
    latest.episode = Some(2);
    latest.position = 4.5;
    latest.duration = 1_200.0;

    let mut same_episode = mk_watch_progress("tt7654321", "series", 260);
    same_episode.season = Some(1);
    same_episode.episode = Some(2);
    same_episode.position = 420.0;
    same_episode.duration = 1_200.0;
    same_episode.last_stream_lookup_id = Some("tt7654321".to_string());
    same_episode.last_stream_url = Some("https://cdn.example/episode-2.m3u8".to_string());

    let chosen = choose_entry(vec![latest, same_episode], HistoryEntryQuery::Latest, None)
        .expect("history entry");

    assert_eq!(chosen.position, 420.0);
    assert_eq!(chosen.duration, 1_200.0);
}

#[test]
fn choose_continue_watching_entry_prefers_resumable_episode_over_newer_zero_progress_episode() {
    let newer_zero_progress = series_episode_progress(400, 1, 5, 0.0, 0.0);

    let mut resumable_episode = series_episode_progress(350, 1, 4, 1_020.0, 2_400.0);
    resumable_episode.last_stream_lookup_id = Some("tt7654321".to_string());
    resumable_episode.last_stream_url = Some("https://cdn.example/episode-4.m3u8".to_string());

    let chosen = choose_entry(
        vec![newer_zero_progress, resumable_episode],
        HistoryEntryQuery::ContinueWatching,
        None,
    )
    .expect("continue watching entry");

    assert_eq!(chosen.episode, Some(4));
    assert_eq!(chosen.position, 1_020.0);
}

#[test]
fn choose_continue_watching_entry_prefers_older_resume_over_newer_same_episode_startup_stub() {
    let startup_stub = series_episode_progress(420, 1, 4, 12.0, 2_400.0);

    let mut resumable_episode = series_episode_progress(350, 1, 4, 1_020.0, 2_400.0);
    resumable_episode.last_stream_lookup_id = Some("tt7654321".to_string());
    resumable_episode.last_stream_url = Some("https://cdn.example/episode-4.m3u8".to_string());

    let chosen = choose_entry(
        vec![startup_stub, resumable_episode],
        HistoryEntryQuery::ContinueWatching,
        None,
    )
    .expect("continue watching entry");

    assert_eq!(chosen.episode, Some(4));
    assert_eq!(chosen.position, 1_020.0);
}

#[test]
fn choose_continue_watching_entry_keeps_latest_episode_when_no_resumable_candidate_exists() {
    let latest = series_episode_progress(400, 1, 5, 180.0, 2_400.0);

    let older = series_episode_progress(300, 1, 4, 120.0, 2_400.0);

    let chosen = choose_entry(
        vec![latest, older],
        HistoryEntryQuery::ContinueWatching,
        None,
    )
    .expect("continue watching entry");

    assert_eq!(chosen.episode, Some(5));
    assert_eq!(chosen.last_watched, 400);
}

#[test]
fn choose_continue_watching_entry_prefers_newest_meaningful_episode() {
    let mut deeper_resume = series_episode_progress(350, 1, 4, 1_020.0, 2_400.0);
    deeper_resume.last_stream_lookup_id = Some("tt7654321".to_string());

    let newer = series_episode_progress(500, 1, 7, 920.0, 2_400.0);

    let chosen = choose_entry(
        vec![newer, deeper_resume],
        HistoryEntryQuery::ContinueWatching,
        None,
    )
    .expect("continue watching entry");

    assert_eq!(chosen.episode, Some(7));
    assert_eq!(chosen.position, 920.0);
    assert_eq!(chosen.last_watched, 500);
}

#[test]
fn choose_continue_watching_entry_prefers_newest_across_seasons_with_same_episode_number() {
    let mut older_fuller = series_episode_progress(350, 1, 5, 1_800.0, 2_400.0);
    older_fuller.last_stream_lookup_id = Some("tt7654321".to_string());

    let newer_shallower = series_episode_progress(500, 2, 5, 300.0, 2_400.0);

    let chosen = choose_entry(
        vec![older_fuller, newer_shallower],
        HistoryEntryQuery::ContinueWatching,
        None,
    )
    .expect("continue watching entry");

    assert_eq!(chosen.season, Some(2));
    assert_eq!(chosen.episode, Some(5));
    assert_eq!(chosen.absolute_season, Some(2));
    assert_eq!(chosen.absolute_episode, Some(5));
    assert_eq!(chosen.last_watched, 500);
}

#[test]
fn choose_continue_watching_entry_rewind_to_earlier_episode_follows_last_watched() {
    let older_later_episode = series_episode_progress(350, 1, 9, 1_500.0, 2_400.0);

    let recent_rewind = series_episode_progress(500, 1, 3, 600.0, 2_400.0);

    let chosen = choose_entry(
        vec![older_later_episode, recent_rewind],
        HistoryEntryQuery::ContinueWatching,
        None,
    )
    .expect("continue watching entry");

    assert_eq!(chosen.episode, Some(3));
    assert_eq!(chosen.last_watched, 500);
}

#[test]
fn choose_continue_watching_entry_newer_untagged_row_wins_older_richly_tagged_row() {
    let mut tagged = series_episode_progress(350, 1, 4, 1_020.0, 2_400.0);
    tagged.last_stream_lookup_id = Some("tt7654321".to_string());
    tagged.last_stream_key = Some("s:abc123".to_string());
    tagged.source_id = Some("addon-a".to_string());
    tagged.source_name = Some("CDN A".to_string());
    tagged.stream_family = Some("cdn|release:x".to_string());

    let untagged = series_episode_progress(500, 1, 7, 920.0, 2_400.0);

    let chosen = choose_entry(
        vec![tagged, untagged],
        HistoryEntryQuery::ContinueWatching,
        None,
    )
    .expect("continue watching entry");

    assert_eq!(chosen.episode, Some(7));
    assert_eq!(chosen.last_stream_key, None);
}

#[test]
fn choose_continue_watching_entry_exact_tie_keeps_first_input_row() {
    // Same confidence tier and `last_watched` must keep the loader's input
    // order — `min_by` returns the first equal minimum.
    let first = series_episode_progress(500, 1, 3, 600.0, 2_400.0);
    let second = series_episode_progress(500, 1, 7, 600.0, 2_400.0);

    let chosen = choose_entry(
        vec![first.clone(), second.clone()],
        HistoryEntryQuery::ContinueWatching,
        None,
    )
    .expect("continue watching entry");
    assert_eq!(chosen.episode, Some(3));

    let chosen = choose_entry(
        vec![second, first],
        HistoryEntryQuery::ContinueWatching,
        None,
    )
    .expect("continue watching entry");
    assert_eq!(chosen.episode, Some(7));
}

#[test]
fn choose_exact_watch_progress_entry_prefers_exact_episode_match() {
    let mut exact = mk_watch_progress("kitsu:42", "anime", 250);
    exact.season = Some(1);
    exact.episode = Some(12);
    exact.absolute_season = Some(1);
    exact.absolute_episode = Some(12);
    exact.position = 512.0;
    exact.duration = 1_440.0;

    let mut other = mk_watch_progress("kitsu:42", "anime", 300);
    other.season = Some(1);
    other.episode = Some(13);
    other.absolute_season = Some(1);
    other.absolute_episode = Some(13);
    other.position = 720.0;
    other.duration = 1_440.0;

    let chosen = choose_entry(
        vec![other, exact],
        HistoryEntryQuery::Exact {
            media_id: "kitsu:42",
            media_type: "anime",
            season: Some(1),
            episode: Some(12),
        },
        None,
    )
    .expect("exact watch progress entry");

    assert_eq!(chosen.episode, Some(12));
    assert_eq!(chosen.position, 512.0);
}

#[test]
fn choose_exact_watch_progress_entry_ignores_newer_same_episode_startup_stub() {
    let startup_stub = series_episode_progress(420, 1, 4, 12.0, 2_400.0);

    let mut resumable_episode = series_episode_progress(350, 1, 4, 1_020.0, 2_400.0);
    resumable_episode.last_stream_lookup_id = Some("tt7654321".to_string());
    resumable_episode.last_stream_url = Some("https://cdn.example/episode-4.m3u8".to_string());

    let chosen = choose_entry(
        vec![startup_stub, resumable_episode],
        HistoryEntryQuery::Exact {
            media_id: "tt7654321",
            media_type: "series",
            season: Some(1),
            episode: Some(4),
        },
        None,
    )
    .expect("exact watch progress entry");

    assert_eq!(chosen.episode, Some(4));
    assert_eq!(chosen.position, 1_020.0);
}

#[test]
fn continue_watching_candidate_filters_finished_items() {
    let mut item = mk_watch_progress("tt100", "movie", 10);
    item.position = 950.0;
    item.duration = 1_000.0;
    assert!(!is_continue_watching_candidate(&item));

    item.position = 940.0;
    assert!(is_continue_watching_candidate(&item));
}

#[test]
fn continue_watching_candidate_filters_low_progress_startup_stub() {
    let mut item = mk_watch_progress("tt101", "movie", 10);
    item.position = 4.0;
    item.duration = 1_000.0;

    assert!(!is_continue_watching_candidate(&item));

    item.position = 5.0;
    assert!(is_continue_watching_candidate(&item));
}

#[test]
fn sanitize_watch_progress_normalizes_anime_type_to_series() {
    let progress = mk_watch_progress("kitsu:99", "anime", 10);
    let sanitized = sanitize_watch_progress(progress).expect("valid anime progress");

    assert_eq!(sanitized.type_, "series");
}

#[test]
fn sanitize_watch_progress_rejects_invalid_type() {
    let progress = mk_watch_progress("bad:1", "unsupported", 10);

    assert!(sanitize_watch_progress(progress).is_none());
}

#[test]
fn stream_priority_prefers_user_source_order_when_quality_is_tied() {
    let addons = vec![
        AddonConfig {
            id: "alpha".to_string(),
            url: "https://alpha.example".to_string(),
            name: "Alpha".to_string(),
            enabled: true,
            capabilities: None,
        },
        AddonConfig {
            id: "beta".to_string(),
            url: "https://beta.example".to_string(),
            name: "Beta".to_string(),
            enabled: true,
            capabilities: None,
        },
    ];
    let priorities = build_addon_source_priority_map(&addons);

    let mut preferred = mk_stream(
        Some("1080p HEVC"),
        Some("Alpha Stream"),
        Some("magnet:?xt=urn:btih:alpha1"),
        Some("alpha1"),
        None,
    );
    preferred.cached = true;
    preferred.seeders = Some(10);
    preferred.size_bytes = Some(1_000);
    preferred.source_name = Some("Alpha".to_string());
    preferred.source_id = Some("alpha".to_string());

    let mut fallback = preferred.clone();
    fallback.url = Some("magnet:?xt=urn:btih:beta1".to_string());
    fallback.info_hash = Some("beta1".to_string());
    fallback.seeders = Some(300);
    fallback.source_name = Some("Beta".to_string());
    fallback.source_id = Some("beta".to_string());

    let preferred_priority = stream_source_priority(
        preferred
            .source_id
            .as_deref()
            .and_then(normalize_source_id)
            .as_deref(),
        &priorities,
    );
    let fallback_priority = stream_source_priority(
        fallback
            .source_id
            .as_deref()
            .and_then(normalize_source_id)
            .as_deref(),
        &priorities,
    );

    let preferred_score = stream_resolution_priority(&preferred, preferred.match_texts().flags);
    let fallback_score = stream_resolution_priority(&fallback, fallback.match_texts().flags);

    // Same tail order the recommendation key sorts on: source priority
    // decides before seeders, so the fallback's larger swarm cannot win.
    let preferred_rank = (
        preferred_score.viability,
        preferred_score.quality,
        preferred_score.language_bonus,
        preferred_priority,
        preferred_score.seeders,
        preferred_score.size_bytes,
    );
    let fallback_rank = (
        fallback_score.viability,
        fallback_score.quality,
        fallback_score.language_bonus,
        fallback_priority,
        fallback_score.seeders,
        fallback_score.size_bytes,
    );

    assert!(preferred_rank > fallback_rank);
}

#[test]
fn stream_priority_prefers_multi_audio_when_other_signals_match() {
    let mut dual_audio = mk_stream(
        Some("1080p HEVC"),
        Some("Dual Audio Release"),
        Some("magnet:?xt=urn:btih:dual1"),
        Some("dual1"),
        None,
    );
    dual_audio.cached = true;
    dual_audio.seeders = Some(50);
    dual_audio.size_bytes = Some(1_000);

    let mut standard = dual_audio.clone();
    standard.title = Some("Standard Release".to_string());
    standard.url = Some("magnet:?xt=urn:btih:std1".to_string());
    standard.info_hash = Some("std1".to_string());

    let dual_score = stream_resolution_priority(&dual_audio, dual_audio.match_texts().flags);
    let standard_score = stream_resolution_priority(&standard, standard.match_texts().flags);

    // Viability and quality tie; the multi-audio bonus is the decider.
    assert!(
        (
            dual_score.viability,
            dual_score.quality,
            dual_score.language_bonus,
        ) > (
            standard_score.viability,
            standard_score.quality,
            standard_score.language_bonus,
        )
    );
}

#[test]
fn quality_score_reads_resolution_from_name_or_title() {
    let name_only_1080 = mk_stream(
        Some("Release 1080p"),
        Some("feature"),
        Some("https://example.com/a.mp4"),
        None,
        None,
    );
    let title_only_720 = mk_stream(
        Some("release"),
        Some("720p"),
        Some("https://example.com/b.mp4"),
        None,
        None,
    );

    assert!(
        stream_quality_score(name_only_1080.match_texts().flags)
            > stream_quality_score(title_only_720.match_texts().flags)
    );

    let name_2160 = mk_stream(
        Some("Release 2160p"),
        Some("feature"),
        Some("https://example.com/c.mp4"),
        None,
        None,
    );
    let title_2160 = mk_stream(
        Some("release"),
        Some("2160p"),
        Some("https://example.com/d.mp4"),
        None,
        None,
    );

    assert_eq!(
        stream_quality_score(name_2160.match_texts().flags),
        stream_quality_score(title_2160.match_texts().flags)
    );
}

#[test]
fn backup_paths_must_be_absolute_json_files() {
    let absolute = std::env::temp_dir().join("stremiro-backup-test.json");
    let absolute = absolute.to_str().expect("temp path is utf-8").to_string();
    assert_eq!(
        normalize_backup_path(&absolute).as_deref(),
        Some(absolute.as_str())
    );
    // Extension check is case-insensitive and surrounding whitespace is trimmed.
    let upper = absolute.replace(".json", ".JSON");
    assert!(normalize_backup_path(&format!("  {upper}  ")).is_some());
    // Relative paths, other extensions, empty input, NUL bytes, and
    // overlong paths are rejected so direct IPC calls cannot reuse these
    // commands for arbitrary file access.
    assert!(normalize_backup_path("backup.json").is_none());
    assert!(normalize_backup_path("").is_none());
    let wrong_ext = std::env::temp_dir().join("backup.txt");
    assert!(normalize_backup_path(wrong_ext.to_str().expect("utf-8")).is_none());
    assert!(normalize_backup_path(&format!("{absolute}\0")).is_none());
    // Absolute with a `.json` suffix but beyond the length bound: only the
    // length check rejects this input.
    let overlong = std::env::temp_dir().join(format!("{}.json", "a".repeat(MAX_BACKUP_PATH_LEN)));
    assert!(normalize_backup_path(overlong.to_str().expect("utf-8")).is_none());
}

#[test]
fn watch_status_boundary_accepts_canonical_values_only() {
    use super::store_helpers::normalize_watch_status;

    // Canonical values pass through unchanged; matching is case-insensitive
    // with surrounding whitespace trimmed so direct IPC stays forgiving.
    assert_eq!(
        normalize_watch_status("watching").as_deref(),
        Some("watching")
    );
    assert_eq!(
        normalize_watch_status("  Watched ").as_deref(),
        Some("watched")
    );
    assert_eq!(
        normalize_watch_status("plan_to_watch").as_deref(),
        Some("plan_to_watch")
    );
    assert_eq!(
        normalize_watch_status("Plan To Watch").as_deref(),
        Some("plan_to_watch")
    );
    assert_eq!(
        normalize_watch_status("DROPPED").as_deref(),
        Some("dropped")
    );
    // Arbitrary strings must never persist: set/import/migration drop them.
    assert!(normalize_watch_status("").is_none());
    assert!(normalize_watch_status("watching soon").is_none());
    assert!(normalize_watch_status("plan-to-watch").is_none());
}

#[test]
fn backup_validate_import_capacity_counts_unique_growth_only() {
    let existing = vec!["a".to_string(), "b".to_string()];
    // Overlap plus a duplicate incoming id at capacity: no growth, so a
    // same-membership restore is allowed.
    assert!(validate_import_capacity(&existing, ["a", "b", "b"], 2, "library").is_ok());
    // One new unique id over the cap rejects.
    assert!(validate_import_capacity(&existing, ["c"], 2, "library").is_err());
    // An already over-cap store accepts a no-growth restore...
    let over = vec!["a".to_string(), "b".to_string(), "c".to_string()];
    assert!(validate_import_capacity(&over, ["a", "a"], 2, "library").is_ok());
    // ...but growth beyond it still fails.
    assert!(validate_import_capacity(&over, ["d"], 2, "library").is_err());
}

#[test]
fn backup_prepare_import_lists_normalizes_dedupes_and_skips_existing() {
    // Padded id/name normalize; embedded duplicate item ids dedupe
    // first-on-id; the untrusted declared `item_ids` are ignored in favor of
    // the surviving items.
    let list = serde_json::json!(UserListWithItems {
        id: "  list_a  ".to_string(),
        name: "  My List  ".to_string(),
        icon: "🎬".to_string(),
        item_ids: vec!["tt999".to_string()],
        items: vec![
            test_media_item("tt1", "series"),
            test_media_item("tt1", "series"),
            test_media_item("tt2", "movie"),
        ],
    });
    let prepared = prepare_import_lists(vec![list], &[]).expect("prepare");
    assert_eq!(prepared.len(), 1);
    let prepared = &prepared[0];
    assert_eq!(prepared.id, "list_a");
    assert_eq!(prepared.name, "My List");
    assert_eq!(
        prepared.item_ids,
        vec!["tt1".to_string(), "tt2".to_string()]
    );
    assert_eq!(prepared.items.len(), 2);

    // A repeat of the same valid backup id folds into the prepared list
    // instead of importing a second copy under a fresh uuid.
    let dup = || {
        serde_json::json!(UserListWithItems {
            id: "list_dup".to_string(),
            name: "Dup".to_string(),
            icon: "".to_string(),
            item_ids: vec![],
            items: vec![],
        })
    };
    let prepared = prepare_import_lists(vec![dup(), dup()], &[]).expect("prepare");
    assert_eq!(prepared.len(), 1);
    assert_eq!(prepared[0].id, "list_dup");

    // An existing id — padding included — keeps the local list untouched.
    let existing = vec!["list_here".to_string()];
    let incoming = vec![serde_json::json!(UserListWithItems {
        id: "  list_here ".to_string(),
        name: "Incoming".to_string(),
        icon: "".to_string(),
        item_ids: vec![],
        items: vec![],
    })];
    assert!(prepare_import_lists(incoming, &existing)
        .expect("prepare")
        .is_empty());

    // An id the live key gate rejects still imports under a fresh safe id.
    let hostile = vec![serde_json::json!(UserListWithItems {
        id: "bad id!!".to_string(),
        name: "Hostile".to_string(),
        icon: "".to_string(),
        item_ids: vec![],
        items: vec![],
    })];
    let prepared = prepare_import_lists(hostile, &[]).expect("prepare");
    assert_eq!(prepared.len(), 1);
    assert!(prepared[0].id.starts_with("list_"));
    assert_eq!(prepared[0].id.len(), "list_".len() + 32);
}

#[test]
fn backup_prepare_import_lists_enforces_live_limits() {
    // More unique items than the live per-list cap rejects instead of
    // silently truncating the backup's list.
    let over_items: Vec<_> = (0..=MAX_LIST_ITEMS)
        .map(|i| test_media_item(&format!("tt{i}"), "movie"))
        .collect();
    let oversized = serde_json::json!(UserListWithItems {
        id: "list_big".to_string(),
        name: "Big".to_string(),
        icon: "".to_string(),
        item_ids: vec![],
        items: over_items,
    });
    // The same over-cap payload behind a malformed name still skips as one
    // bad record instead of aborting the whole restore.
    let mut blank_named = oversized.clone();
    blank_named["id"] = serde_json::json!("list_blank");
    blank_named["name"] = serde_json::json!("   ");
    assert!(prepare_import_lists(vec![blank_named], &[])
        .expect("prepare")
        .is_empty());
    assert!(prepare_import_lists(vec![oversized], &[]).is_err());

    // A store already at the list cap accepts a same-id restore — no
    // growth, nothing imported.
    let full_order: Vec<String> = (0..MAX_LISTS).map(|i| format!("list_{i}")).collect();
    let same_id = vec![serde_json::json!(UserListWithItems {
        id: "list_0".to_string(),
        name: "Existing".to_string(),
        icon: "".to_string(),
        item_ids: vec![],
        items: vec![],
    })];
    assert!(prepare_import_lists(same_id, &full_order)
        .expect("prepare")
        .is_empty());
    // One new id past the cap rejects.
    let extra = vec![serde_json::json!(UserListWithItems {
        id: "list_new".to_string(),
        name: "New".to_string(),
        icon: "".to_string(),
        item_ids: vec![],
        items: vec![],
    })];
    assert!(prepare_import_lists(extra, &full_order).is_err());
}

#[test]
fn backup_validate_backup_size_bounds_payloads() {
    assert!(validate_backup_size(MAX_IMPORT_BYTES).is_ok());
    let error = validate_backup_size(MAX_IMPORT_BYTES + 1).expect_err("over the cap");
    assert!(error.contains(&MAX_IMPORT_BYTES.to_string()));
}
