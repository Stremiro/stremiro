use super::*;
use crate::providers::addon_manifest::{parse_addon_manifest, snapshot_is_classified};
use crate::test_helpers::cinemeta_manifest;

fn snapshot() -> AddonManifest {
    cinemeta_manifest()
}

fn extra(name: &str, value: &str) -> CatalogExtra {
    CatalogExtra {
        name: name.to_string(),
        value: value.to_string(),
    }
}

fn catalog_item(value: serde_json::Value) -> Option<MediaItem> {
    parse_catalog_item(serde_json::from_value(value).expect("catalog item"))
}

#[test]
fn build_resource_url_preserves_configured_path_and_query() {
    let url = build_resource_url(
        "https://example.com/stremio/v1?token=abc",
        "catalog",
        "movie",
        "top",
        &[extra("search", "dune")],
    )
    .expect("url");

    assert_eq!(
        url,
        "https://example.com/stremio/v1/catalog/movie/top/search=dune.json?token=abc"
    );
}

#[test]
fn build_resource_url_encodes_id_and_extras() {
    let url = build_resource_url(
        "https://v3-cinemeta.strem.io",
        "meta",
        "series",
        "tt0944947:1:2",
        &[],
    )
    .expect("url");
    assert_eq!(
        url,
        "https://v3-cinemeta.strem.io/meta/series/tt0944947%3A1%3A2.json"
    );
}

#[test]
fn build_resource_url_encodes_genre_and_skip_catalog_extras() {
    let url = build_resource_url(
        "https://v3-cinemeta.strem.io",
        "catalog",
        "series",
        "top",
        &[extra("genre", "Animation"), extra("skip", "50")],
    )
    .expect("url");
    assert_eq!(
        url,
        "https://v3-cinemeta.strem.io/catalog/series/top/genre=Animation&skip=50.json"
    );
}

#[test]
fn snapshot_rejects_undeclared_search_extra() {
    let snapshot = snapshot();
    let extras = [extra("search", "dune")];
    snapshot_supports_catalog(&snapshot, "movie", "top", &extras).expect("top allows search");
    let error = snapshot_supports_catalog(&snapshot, "movie", "imdbRating", &extras)
        .expect_err("featured does not declare search");
    assert!(error.contains("does not declare extra search"));
}

#[test]
fn skip_is_transport_only_and_catalog_id_is_case_insensitive() {
    let snapshot = snapshot();
    snapshot_supports_catalog(&snapshot, "movie", "TOP", &[extra("genre", "Action")])
        .expect("catalog id matches case-insensitively");

    // Single-page addon declaring only `genre` must still serve page 2:
    // `skip` is transport pagination, never a capability gate.
    let genre_only_snapshot = parse_addon_manifest(
        br#"{
                "name": "SinglePage",
                "resources": ["catalog"],
                "types": ["movie"],
                "catalogs": [
                    {"type": "movie", "id": "top", "extra": [{"name": "genre"}]}
                ]
            }"#,
    )
    .expect("snapshot");
    snapshot_supports_catalog(
        &genre_only_snapshot,
        "movie",
        "top",
        &[extra("genre", "Action"), extra("skip", "50")],
    )
    .expect("skip never gates routing");
}

#[test]
fn parse_catalog_skips_malformed_siblings() {
    let page: CatalogResponse = serde_json::from_value(serde_json::json!({
        "metas": [
            {"id": "tt1", "name": "Valid", "type": "movie"},
            {"name": "Missing id"},
            null,
            42,
            {"id": "tt2", "name": "Also valid", "type": "series"},
        ],
    }))
    .expect("catalog response");
    let items: Vec<_> = page
        .metas
        .into_iter()
        .filter_map(|value| serde_json::from_value::<CatalogItemJson>(value).ok())
        .filter_map(parse_catalog_item)
        .collect();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].id, "tt1");
    assert_eq!(items[1].id, "tt2");
}

#[test]
fn parse_catalog_ignores_full_meta_payload_fields() {
    let item = catalog_item(serde_json::json!({
            "id": "tt5607616",
            "name": "Re:Zero",
            "type": "series",
            "poster": "poster",
            "cast": ["Actor One", "Actor Two"],
            "trailers": [{"source": "abc", "type": "Trailer"}],
            "links": [{"name": "share", "url": "https://example.test"}],
            "behaviorHints": {"hasScheduledVideos": true},
            "genre": ["Animation", "Adventure", "Drama"]
    }))
    .expect("item");
    assert_eq!(item.id, "tt5607616");
    assert_eq!(
        item.genres,
        Some(vec![
            "Animation".to_string(),
            "Adventure".to_string(),
            "Drama".to_string()
        ])
    );
}

#[test]
fn parse_catalog_reads_declared_genres() {
    let item = catalog_item(serde_json::json!({
            "id": "tt5607616",
            "name": "Re:Zero",
            "type": "series",
            "genre": ["Animation", "Adventure", "Drama"]
    }))
    .expect("item");
    assert_eq!(
        item.genres,
        Some(vec![
            "Animation".to_string(),
            "Adventure".to_string(),
            "Drama".to_string()
        ])
    );

    let string_genre = catalog_item(serde_json::json!({
            "id": "tt2",
            "name": "String Genre",
            "type": "series",
            "genre": "Animation"
    }))
    .expect("item");
    assert_eq!(string_genre.genres, Some(vec!["Animation".to_string()]));
}

#[test]
fn parse_meta_skips_malformed_episode_siblings() {
    let details = parse_meta_item(serde_json::json!({
        "id": "tt1",
        "name": "Show",
        "type": "series",
        "videos": [
            {"id": "tt1:1:1", "name": "Pilot", "season": 1, "episode": 1},
            {"name": "missing-id"},
            {"id": "tt1:1:2", "title": "Next", "season": 1, "number": 2}
        ]
    }))
    .expect("meta");
    let episodes = details.episodes.expect("episodes");
    assert_eq!(episodes.len(), 2);
    assert_eq!(episodes[1].episode, 2);
}

#[test]
fn parse_meta_prefers_episode_over_number() {
    let details = parse_meta_item(serde_json::json!({
        "id": "tt1",
        "name": "Show",
        "type": "series",
        "videos": [
            {"id": "tt1:1:1", "season": 1, "episode": 1, "number": 99}
        ]
    }))
    .expect("meta");
    assert_eq!(details.episodes.expect("episodes")[0].episode, 1);
}

#[test]
fn parse_meta_orders_episodes_by_season_episode_with_stable_duplicates() {
    let details = parse_meta_item(serde_json::json!({
        "id": "tt1",
        "name": "Show",
        "type": "series",
        "videos": [
            {"id": "tt1:2:1", "season": 2, "episode": 1},
            {"id": "tt1:1:3", "season": 1, "episode": 3},
            {"name": "missing-id", "season": 0, "episode": 1},
            {"id": "tt1:0:2", "season": 0, "episode": 2},
            {"id": "tt1:1:1", "season": 1, "episode": 1},
            {"id": "tt1:0:1", "season": 0, "episode": 1},
            {"id": "tt1:1:1-alt", "season": 1, "episode": 1}
        ]
    }))
    .expect("meta");

    // Sorted once natively — specials (season 0) lead, malformed siblings
    // drop, and the stable sort keeps addon order for duplicate coordinates.
    let episodes = details.episodes.expect("episodes");
    let ids: Vec<&str> = episodes.iter().map(|episode| episode.id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "tt1:0:1",
            "tt1:0:2",
            "tt1:1:1",
            "tt1:1:1-alt",
            "tt1:1:3",
            "tt1:2:1"
        ]
    );
}

#[test]
fn meta_cache_shares_one_arc_and_lite_shape_drops_episodes() {
    let client = AddonResourceClient::new();
    let details = parse_meta_item(serde_json::json!({
        "id": "tt1",
        "name": "Show",
        "type": "series",
        "description": "A show",
        "videos": [
            {"id": "tt1:1:1", "season": 1, "episode": 1},
            {"id": "tt1:1:2", "season": 1, "episode": 2}
        ]
    }))
    .expect("meta");
    assert!(details.episodes.as_ref().is_some_and(|e| !e.is_empty()));

    client
        .meta_cache
        .put("meta:x", Arc::new(details), false, || true);

    // Every hit hands back the same allocation — no deep clone per shape.
    let hit = client.meta_cache.get("meta:x").expect("cached meta");
    let hit_again = client.meta_cache.get("meta:x").expect("cached meta");
    assert!(Arc::ptr_eq(&hit, &hit_again));

    let lite = meta_for_shape(hit.as_ref(), false);
    let full = meta_for_shape(hit.as_ref(), true);
    assert!(lite.episodes.is_none());
    assert_eq!(full.episodes.as_ref().map(Vec::len), Some(2));

    // Shaping never mutates the cached entry — full hits stay servable.
    let still_cached = client.meta_cache.get("meta:x").expect("cached meta");
    assert!(Arc::ptr_eq(&hit, &still_cached));
    assert!(still_cached.episodes.is_some());

    // Lite and full disagree only on `episodes` — every other serialized
    // field is identical.
    let lite_json = serde_json::to_value(&lite).expect("serialize lite");
    let mut full_json = serde_json::to_value(&full).expect("serialize full");
    full_json.as_object_mut().unwrap().remove("episodes");
    assert_eq!(lite_json, full_json);
}

#[test]
fn episode_numbers_reject_u32_overflow_instead_of_wrapping() {
    // 2^32+1 would wrap to 1 under a plain `as u32`, aliasing episodes.
    let details = parse_meta_item(serde_json::json!({
        "id": "tt1",
        "name": "Show",
        "type": "series",
        "videos": [
            {"id": "tt1:1:1", "season": 4294967297u64, "episode": 4294967301u64}
        ]
    }))
    .expect("meta");
    let episode = &details.episodes.expect("episodes")[0];
    assert_eq!(episode.season, 0);
    assert_eq!(episode.episode, 0);
}

#[test]
fn fetchable_http_gate_blocks_private_targets_and_userinfo() {
    assert!(is_fetchable_http_url("https://cdn.test/video.m3u8"));
    for blocked in [
        "http://127.0.0.1:9999/video.mp4",
        "http://169.254.169.254/latest/meta-data",
        "http://192.168.1.1/video.mp4",
        "file:///etc/passwd",
        "https://user:pass@cdn.test/video.mp4",
    ] {
        assert!(!is_fetchable_http_url(blocked), "{blocked} must be blocked");
    }
}

#[test]
fn catalog_images_degrade_to_none_instead_of_dropping_rows() {
    let item = catalog_item(serde_json::json!({
            "id": "tt1",
            "name": "Gated",
            "type": "movie",
            "poster": "file:///etc/passwd",
            "background": "http://127.0.0.1:11470/backdrop.jpg",
            "logo": "https://cdn.test/logo.png"
    }))
    .expect("row survives gated images");
    assert_eq!(item.poster, None);
    assert_eq!(item.backdrop, None);
    assert_eq!(item.logo.as_deref(), Some("https://cdn.test/logo.png"));
}

#[test]
fn meta_images_and_thumbnails_are_fetch_gated() {
    let details = parse_meta_item(serde_json::json!({
        "id": "tt1",
        "name": "Gated",
        "type": "series",
        "poster": "javascript:alert(1)",
        "background": "https://cdn.test/backdrop.jpg",
        "videos": [
            {"id": "tt1:1:1", "season": 1, "episode": 1, "thumbnail": "data:text/html,evil"}
        ]
    }))
    .expect("meta");
    assert_eq!(details.poster, None);
    assert_eq!(
        details.backdrop.as_deref(),
        Some("https://cdn.test/backdrop.jpg")
    );
    assert_eq!(details.episodes.expect("episodes")[0].thumbnail, None);
}

#[test]
fn trailer_source_rejects_non_youtube_tokens() {
    let valid = parse_trailers(Some(&serde_json::json!([
        {"source": "dQw4w9WgXcQ", "type": "Trailer"}
    ])))
    .expect("valid trailer list");
    assert_eq!(valid.len(), 1);
    assert_eq!(valid[0].id, "dQw4w9WgXcQ");
    // Query-smuggling, overlong, short, and non-token values drop the
    // row instead of interpolating attacker bytes into the embed URL.
    for source in [
        "abc&list=evil",
        "dQw4w9WgXcQextra",
        "short",
        "not a token!!",
        "",
    ] {
        assert!(
            parse_trailers(Some(&serde_json::json!([
                {"source": source, "type": "Trailer"}
            ])))
            .is_none(),
            "{source} must be rejected"
        );
    }
}

#[test]
fn resource_cache_roundtrips_and_stays_bounded() {
    let cache = TtlCache::new(4, RESOURCE_CACHE_TTL, RESOURCE_CACHE_EMPTY_TTL);
    for index in 0..4 {
        cache.put(&format!("key-{index}"), index, false, || true);
    }
    assert_eq!(cache.get("key-0"), Some(0));
    assert_eq!(cache.get("key-3"), Some(3));

    // Overflow evicts a victim instead of growing past the cap.
    cache.put("key-4", 4, false, || true);
    assert_eq!(cache.len(), 4, "cache must stay at max_entries");
    assert_eq!(cache.get("key-4"), Some(4));
}

#[test]
fn resource_cache_clear_empties_all_entries() {
    let cache = TtlCache::new(8, RESOURCE_CACHE_TTL, RESOURCE_CACHE_EMPTY_TTL);
    cache.put("a", 1, false, || true);
    cache.put("b", 2, false, || true);
    cache.clear();
    assert_eq!(cache.get("a"), None);
    assert_eq!(cache.get("b"), None);
}

#[test]
fn resource_cache_drops_superseded_puts() {
    let cache = TtlCache::new(8, RESOURCE_CACHE_TTL, RESOURCE_CACHE_EMPTY_TTL);
    // A clear_cache mid-fetch revokes the write — the freshness closure runs
    // under the entries lock so the stale value can never be stored.
    cache.put("stale", 1, false, || false);
    assert_eq!(cache.get("stale"), None);
    cache.put("fresh", 2, false, || true);
    assert_eq!(cache.get("fresh"), Some(2));
}

#[test]
fn resource_cache_key_is_stable_distinct_and_credential_free() {
    let key_a = resource_cache_key("meta", "https://user:pass@addon.test/meta/series/tt1.json");
    let key_b = resource_cache_key("meta", "https://addon.test/meta/series/tt1.json");
    let key_c = resource_cache_key("meta", "https://addon.test/meta/series/tt2.json");

    assert_eq!(
        key_a,
        resource_cache_key("meta", "https://user:pass@addon.test/meta/series/tt1.json"),
        "same request must key identically"
    );
    assert_ne!(key_b, key_c, "distinct urls must not alias");
    // The URL can carry credentials — keys must keep only a hash segment.
    assert!(!key_a.contains("addon.test"));
    assert!(!key_a.contains("pass"));
    assert!(!key_a.contains("https"));
}

#[test]
fn subtitle_item_rejects_private_targets_and_userinfo() {
    // Plain public subtitle URLs pass, but mpv-fetchable targets aiming at
    // loopback, LAN, metadata IPs, non-http schemes, or embedded
    // credentials are dropped at parse time.
    assert!(parse_subtitle_item(serde_json::json!({
        "id": "en",
        "url": "https://subs.test/en.srt",
        "lang": "en"
    }))
    .is_some());
    for blocked in [
        "http://127.0.0.1:11470/subs/en.srt",
        "http://169.254.169.254/latest/meta-data",
        "http://192.168.1.1/subs/en.srt",
        "file:///etc/passwd",
        "https://user:pass@subs.test/en.srt",
    ] {
        assert!(
            parse_subtitle_item(serde_json::json!({"id": "x", "url": blocked})).is_none(),
            "{blocked} must be rejected"
        );
    }
}

#[test]
fn catalogs_only_manifest_classifies_and_serves_catalogs() {
    // `catalogs[]` alone is a complete capability declaration: a manifest
    // that omits the redundant `resources` entry must still classify and
    // route instead of sitting unclassified forever.
    let snapshot =
        parse_addon_manifest(br#"{"name": "Cat", "catalogs": [{"type": "movie", "id": "top"}]}"#)
            .expect("snapshot");

    assert!(snapshot_is_classified(&snapshot));
    snapshot_supports_catalog(&snapshot, "movie", "top", &[]).expect("catalogs[] is authoritative");
    snapshot_supports_catalog(&snapshot, "series", "top", &[])
        .expect_err("undeclared type must still gate");
}

#[test]
fn undeclared_advisory_extra_does_not_gate_catalog() {
    // Servers drop extras they never declared and callers re-filter locally,
    // so a missing `year`/`skip` declaration must not drop a servable
    // source. `search` stays a hard gate: an addon that never declared it
    // echoes its normal rows back as bogus results.
    let snapshot = parse_addon_manifest(
        br#"{
            "name": "Advisory",
            "catalogs": [{"type": "movie", "id": "top", "extra": [{"name": "genre"}]}]
        }"#,
    )
    .expect("snapshot");

    snapshot_supports_catalog(&snapshot, "movie", "top", &[extra("year", "2024")])
        .expect("undeclared advisory extra must not gate");
    snapshot_supports_catalog(&snapshot, "movie", "top", &[extra("search", "dune")])
        .expect_err("undeclared search must still gate");
}

#[test]
fn required_extra_still_gates_catalog() {
    let snapshot = parse_addon_manifest(
        br#"{
            "name": "Required",
            "catalogs": [{
                "type": "movie",
                "id": "gated",
                "extra": [{"name": "genre", "isRequired": true}]
            }]
        }"#,
    )
    .expect("snapshot");

    snapshot_supports_catalog(&snapshot, "movie", "gated", &[])
        .expect_err("missing required extra must fail");
    snapshot_supports_catalog(&snapshot, "movie", "gated", &[extra("genre", "Action")])
        .expect("required extra satisfied");
}

#[test]
fn transport_failures_cool_down_and_clear_recovers() {
    let client = AddonResourceClient::new();
    let addon_key = hash_segment("https://dead-addon.test");

    assert!(!client.fetch_failure_cooling_down(&addon_key));
    client.note_fetch_failure(&addon_key, 0);
    assert!(client.fetch_failure_cooling_down(&addon_key));

    // A record written under a superseded generation is dropped: a fetch
    // that outlived a clear_cache must not reinstall the wiped cooldown.
    client.clear_cache();
    assert!(!client.fetch_failure_cooling_down(&addon_key));
    client.note_fetch_failure(&addon_key, 0);
    assert!(!client.fetch_failure_cooling_down(&addon_key));
    client.note_fetch_failure(&addon_key, 1);
    assert!(client.fetch_failure_cooling_down(&addon_key));
}

#[test]
fn deterministic_failures_negative_cache_until_clear() {
    let client = AddonResourceClient::new();
    client.cache_failure("meta:x", "boom", 0);
    assert_eq!(client.failure_cache.get("meta:x").as_deref(), Some("boom"));

    // Same generation guard as the value caches: a clear_cache mid-fetch
    // revokes the negative-cache write too.
    client.clear_cache();
    assert_eq!(client.failure_cache.get("meta:x"), None);
    client.cache_failure("meta:x", "boom", 0);
    assert_eq!(client.failure_cache.get("meta:x"), None);
}
