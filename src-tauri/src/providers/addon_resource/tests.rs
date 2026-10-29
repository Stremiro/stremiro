use super::*;
use crate::providers::addon_manifest::{parse_addon_manifest, snapshot_is_classified};
use crate::test_helpers::{cinemeta_manifest, TestHttpServer};

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
    let json = serde_json::to_string(&value).unwrap();
    parse_catalog_item(serde_json::from_str(&json).expect("catalog item"))
}

fn subtitle_item(value: serde_json::Value) -> Option<AddonSubtitle> {
    let json = serde_json::to_string(&value).ok()?;
    parse_subtitle_item(serde_json::from_str(&json).ok()?)
}

fn parse_meta_item(value: serde_json::Value) -> Option<MediaDetails> {
    super::parse_meta_item(&serde_json::value::to_raw_value(&value).ok()?)
}

#[test]
fn resource_ids_reject_oversized_values_without_aliasing() {
    let prefix = "x".repeat(MAX_ID_CHARS);
    for id in [
        format!("{prefix}a"),
        format!("{prefix}b"),
        format!("valid{}suffix", " ".repeat(MAX_STRING_CHARS)),
        "null".into(),
        " Undefined ".into(),
    ] {
        let value = serde_json::json!({"id": id, "name": "Title", "type": "movie"});
        assert!(catalog_item(value.clone()).is_none(), "catalog id: {id:?}");
        assert!(parse_meta_item(value).is_none(), "metadata id: {id:?}");
    }
    assert_eq!(
        catalog_item(serde_json::json!({
            "id": prefix, "name": "Title", "type": "movie"
        }))
        .unwrap()
        .id,
        prefix
    );
    let details = parse_meta_item(serde_json::json!({
        "id": "custom", "name": "Title", "type": "series",
        "imdb_id": format!("{prefix}a"), "imdbId": "tt1",
        "videos": [{"id": format!("{prefix}b")}, {"id": "tt1:1:1", "season": 1, "episode": 1}]
    }))
    .unwrap();
    assert_eq!(details.imdb_id.as_deref(), Some("tt1"));
    assert_eq!(
        details
            .episodes
            .unwrap()
            .iter()
            .map(|episode| episode.id.as_str())
            .collect::<Vec<_>>(),
        ["tt1:1:1"]
    );
}

#[test]
fn cached_catalog_page_applies_normalizer_and_counts_consumed_entries_before_the_cap() {
    let mut metas = vec![serde_json::json!(null)];
    metas.extend((0..=MAX_CATALOG_ITEMS).map(|index| {
        serde_json::json!({
            "id": format!("tt{index}"), "type": "movie", "name": "Title"
        })
    }));
    let bytes = serde_json::to_vec(&serde_json::json!({"metas": metas})).unwrap();
    let page = parse_catalog_page(
        serde_json::from_slice(&bytes).unwrap(),
        |mut item| {
            item.primary_year = Some(2024);
            if item.id == "tt0" {
                item.title.clear();
            }
            item
        },
        None,
    );
    assert_eq!(page.source_item_count, MAX_CATALOG_ITEMS + 1);
    assert_eq!(page.items.len(), MAX_CATALOG_ITEMS);
    assert!(page.items[0].title.is_empty());
    assert_eq!(page.items.last().unwrap().id, "tt499");
    assert!(page
        .items
        .iter()
        .all(|item| item.primary_year == Some(2024)));
}

#[tokio::test]
async fn request_errors_omit_urls_with_short_credentials() {
    let transport = crate::providers::addons::AddonTransport::new();
    let client = Client::new();
    let base = "ftp://user:pass@addon.test/key=short/blob?token=tiny";
    let resource_error = match fetch_bounded_json(&client, base, "catalog", CATALOG_MAX_BYTES).await
    {
        Err(FetchFailure::Fatal(error)) => error,
        Err(FetchFailure::Retryable(_)) => panic!("request builder failures must be fatal"),
        Ok(_) => panic!("unsupported scheme must fail"),
    };
    let manifest_error =
        crate::providers::addon_manifest::fetch_addon_manifest_snapshot(&client, base, false)
            .await
            .unwrap_err();
    let stream_error = transport
        .get_streams_fresh(
            "movie",
            "tt1",
            base,
            ("Addon", "addon"),
            None,
            |streams, _, _| streams,
        )
        .await
        .unwrap_err();
    for error in [resource_error, manifest_error, stream_error] {
        assert!(
            !["addon.test", "short", "tiny", "user:pass"]
                .iter()
                .any(|secret| error.contains(secret)),
            "{error}"
        );
    }
}

#[tokio::test]
async fn redirect_policy_failures_are_negative_cached_without_addon_cooldown() {
    let server = TestHttpServer::new(vec![(302, "", Some("http://169.254.169.254/blocked"))]);
    let url = server.url.clone();
    let mut client = AddonResourceClient::new();
    client.client = Client::builder()
        .no_proxy()
        .redirect(crate::providers::fetch_policy::ssrf_redirect_policy())
        .build()
        .unwrap();
    let error = client
        .fetch_catalog(&url, "movie", "top", &[], |item| item)
        .await
        .unwrap_err();
    assert!(error.contains("redirect"));
    assert!(!client.fetch_failures.cooling_down(&hash_segment(&url)));
    let resource_url = build_resource_url(&url, "catalog", "movie", "top", &[]).unwrap();
    assert_eq!(
        client
            .failure_cache
            .get(&resource_cache_key("catalog", &resource_url)),
        Some(error.clone())
    );
    assert_eq!(
        client
            .fetch_catalog(&url, "movie", "top", &[], |item| item)
            .await
            .unwrap_err(),
        error
    );
    assert_eq!(server.finish(), ["/catalog/movie/top.json"]);
}

#[tokio::test]
async fn cache_hits_skip_normalizers_and_keep_shared_metadata_request_agnostic() {
    let client = AddonResourceClient::new();
    let base = "https://addon.test";
    let catalog_url = build_resource_url(base, "catalog", "movie", "top", &[]).unwrap();
    let page = parse_catalog_page(
        serde_json::from_slice(
            br#"{"metas":[{"id":"tt1","name":" A\t title ","type":"movie","year":"2024"}]}"#,
        )
        .unwrap(),
        |item| item,
        None,
    );
    client.catalog_cache.put(
        &resource_cache_key("catalog", &catalog_url),
        Arc::new(page),
        false,
        || true,
    );
    let hit = client
        .fetch_catalog(base, "movie", "top", &[], |_| {
            panic!("cache hit normalized")
        })
        .await
        .unwrap();
    assert_eq!(hit.items[0].id, "tt1");

    let meta_url = build_resource_url(base, "meta", "series", "kitsu:1", &[]).unwrap();
    let details = parse_meta_item(serde_json::json!({
        "id": "tt1", "name": "Title", "type": "series"
    }))
    .unwrap();
    client.meta_cache.put(
        &resource_cache_key("meta", &meta_url),
        Arc::new(details),
        false,
        || true,
    );
    let hit = client
        .fetch_meta(base, "series", "kitsu:1", |_| {
            panic!("cache hit normalized")
        })
        .await
        .unwrap();
    let again = client
        .fetch_meta(base, "series", "kitsu:1", |_| {
            panic!("cache hit normalized")
        })
        .await
        .unwrap();
    assert!(Arc::ptr_eq(&hit, &again));
    assert_eq!(hit.imdb_id.as_deref(), Some("tt1"));
    assert_eq!(again.id, "tt1");
}

#[tokio::test(flavor = "current_thread")]
async fn uncached_resources_normalize_off_async_worker_and_join_failures_stay_request_local() {
    use std::cell::Cell;

    thread_local! {
        static ON_ASYNC_WORKER: Cell<bool> = const { Cell::new(false) };
    }
    ON_ASYNC_WORKER.set(true);
    let catalog = r#"{"metas":[{"id":"tt1","name":"Catalog title","type":"movie"}]}"#;
    let meta = r#"{"meta":{"id":"tt1","name":"Metadata title","type":"series"}}"#;
    let server = TestHttpServer::new(
        [catalog, meta, catalog, meta]
            .map(|body| (200, body, None))
            .to_vec(),
    );
    let base = server.url.clone();
    let mut client = AddonResourceClient::new();
    client.client = Client::builder().no_proxy().build().unwrap();
    let catalog = client
        .fetch_catalog(&base, "movie", "top", &[], |mut item| {
            assert!(!ON_ASYNC_WORKER.get());
            item.title = "Normalized catalog".to_string();
            item
        })
        .await
        .unwrap();
    assert_eq!(catalog.items[0].title, "Normalized catalog");
    let meta = client
        .fetch_meta(&base, "series", "tt1", |mut details| {
            assert!(!ON_ASYNC_WORKER.get());
            details.title = "Normalized metadata".to_string();
            details
        })
        .await
        .unwrap();
    assert_eq!(meta.title, "Normalized metadata");
    let catalog_error = client
        .fetch_catalog(&base, "movie", "panic", &[], |_| {
            panic!("private catalog processing detail")
        })
        .await
        .unwrap_err();
    let meta_error = client
        .fetch_meta(&base, "series", "panic", |_| {
            panic!("private metadata processing detail")
        })
        .await
        .unwrap_err();
    assert_eq!(
        server.finish(),
        [
            "/catalog/movie/top.json",
            "/meta/series/tt1.json",
            "/catalog/movie/panic.json",
            "/meta/series/panic.json",
        ]
    );
    for (resource, type_, error, expected) in [
        (
            "catalog",
            "movie",
            catalog_error,
            "Catalog response processing task failed.",
        ),
        (
            "meta",
            "series",
            meta_error,
            "Metadata response processing task failed.",
        ),
    ] {
        assert_eq!(error, expected);
        let url = build_resource_url(&base, resource, type_, "panic", &[]).unwrap();
        assert_eq!(
            client
                .failure_cache
                .get(&resource_cache_key(resource, &url)),
            Some(error)
        );
    }
    assert!(!client.fetch_failures.cooling_down(&hash_segment(&base)));
}

#[test]
fn build_resource_url_preserves_configured_path_and_query() {
    let url = build_resource_url(
        "https://example.com/addon/v1?token=abc",
        "catalog",
        "movie",
        "top",
        &[extra("search", "dune")],
    )
    .expect("url");

    assert_eq!(
        url,
        "https://example.com/addon/v1/catalog/movie/top/search=dune.json?token=abc"
    );
    assert_eq!(
        crate::providers::addon_manifest::build_manifest_url(
            "https://example.com/addon/v1?token=abc"
        )
        .expect("manifest url"),
        "https://example.com/addon/v1/manifest.json?token=abc"
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
    let id = "界".repeat(MAX_ID_CHARS);
    assert!(crate::commands::normalize_media_id(&id).is_some());
    let lookup = format!("{id}:{}:{}", u32::MAX, u32::MAX);
    for resource in ["stream", "subtitles"] {
        let url = build_resource_url("https://example.com", resource, "series", &lookup, &[])
            .expect("maximum lookup id");
        assert_eq!(
            url,
            format!(
                "https://example.com/{resource}/series/{}.json",
                encode_uri_component(&lookup)
            )
        );
    }
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
    let response: CatalogResponse<'_> = serde_json::from_slice(
        br#"{"metas": [
            {"id": "tt1", "name": "Valid", "type": "movie"},
            {"name": "Missing id"},
            null,
            42,
            {"id": "tt2", "name": "Also valid", "type": "series"}
        ]}"#,
    )
    .expect("catalog response");
    let page = parse_catalog_page(response, |item| item, None);
    assert_eq!(page.source_item_count, 5);
    assert_eq!(page.items.len(), 2);
    assert_eq!(page.items[0].id, "tt1");
    assert_eq!(page.items[1].id, "tt2");
}

#[test]
fn parse_catalog_caps_valid_rows_and_counts_consumed_source_rows() {
    let metas: Vec<_> = (0..=MAX_CATALOG_ITEMS)
        .flat_map(|index| {
            [
                serde_json::json!({"id": "missing-fields"}),
                serde_json::json!({"id": index, "name": index, "type": "movie"}),
            ]
        })
        .collect();
    let bytes = serde_json::to_vec(&serde_json::json!({"metas": metas})).unwrap();
    let page = parse_catalog_page(serde_json::from_slice(&bytes).unwrap(), |item| item, None);
    assert_eq!(page.source_item_count, MAX_CATALOG_ITEMS * 2);
    assert_eq!(page.items.len(), MAX_CATALOG_ITEMS);
    for (index, item) in page.items.iter().enumerate() {
        assert_eq!(item.id, index.to_string());
        assert_eq!(item.title, index.to_string());
    }
}

#[test]
fn resource_item_envelopes_keep_missing_and_invalid_field_behavior() {
    for bytes in [br#"{}"#.as_slice(), br#"{"metas":[],"subtitles":[]}"#] {
        let catalog = parse_catalog_page(
            serde_json::from_slice::<CatalogResponse<'_>>(bytes).unwrap(),
            |item| item,
            None,
        );
        assert_eq!(catalog.source_item_count, 0);
        assert!(catalog.items.is_empty());
        assert!(parse_subtitle_items(
            serde_json::from_slice::<SubtitleResponse<'_>>(bytes).unwrap()
        )
        .is_empty());
    }
    for field in ["metas", "subtitles"] {
        for value in ["null", "{}", "42", "\"invalid\""] {
            let bytes = format!(r#"{{"{field}":{value}}}"#);
            if field == "metas" {
                assert!(serde_json::from_str::<CatalogResponse<'_>>(&bytes).is_err());
            } else {
                assert!(serde_json::from_str::<SubtitleResponse<'_>>(&bytes).is_err());
            }
        }
    }
}

#[test]
fn parse_subtitles_skips_malformed_siblings_and_keeps_label_coercions() {
    let response = serde_json::from_slice(
        br#"{"subtitles":[
            {"id":"first","url":"https://subs.test/first.srt","label":{},"title":" ","name":42},
            {"id":42,"url":"https://subs.test/invalid.srt"},
            null,
            42,
            {"url":"http://127.0.0.1/blocked.srt"},
            {"id":"last","url":"https://subs.test/last.srt","label":" Preferred ","title":"Ignored"}
        ]}"#,
    )
    .unwrap();
    let subtitles = parse_subtitle_items(response);
    assert_eq!(subtitles.len(), 2);
    assert_eq!(subtitles[0].id, "first");
    assert_eq!(subtitles[0].label.as_deref(), Some("42"));
    assert_eq!(subtitles[1].id, "last");
    assert_eq!(subtitles[1].label.as_deref(), Some("Preferred"));
}

#[test]
fn subtitle_urls_reject_oversized_values_without_aliasing() {
    for character in ["a", "界"] {
        let base = "https://subs.test/subtitle?signature=";
        let prefix = format!("{base}{}", character.repeat(MAX_STRING_CHARS - base.len()));
        let subtitle = subtitle_item(serde_json::json!({"url": prefix})).unwrap();
        assert_eq!(subtitle.url, prefix);
        for suffix in ["a", "b"] {
            assert!(
                subtitle_item(serde_json::json!({"url": format!("{prefix}{suffix}")})).is_none()
            );
        }
    }
}

#[test]
fn parse_subtitles_caps_first_valid_rows_in_source_order() {
    let subtitles: Vec<_> = (0..=MAX_SUBTITLES_PER_ADDON)
        .flat_map(|index| {
            [
                serde_json::json!({"id": false, "url": "https://subs.test/invalid.srt"}),
                serde_json::json!({"url": "http://127.0.0.1/blocked.srt"}),
                serde_json::json!({
                    "id": format!("sub-{index}"), "url": format!("https://subs.test/{index}.srt")
                }),
            ]
        })
        .collect();
    let bytes = serde_json::to_vec(&serde_json::json!({"subtitles": subtitles})).unwrap();
    let decoded = parse_subtitle_items(serde_json::from_slice(&bytes).unwrap());
    assert_eq!(decoded.len(), MAX_SUBTITLES_PER_ADDON);
    for (index, subtitle) in decoded.iter().enumerate() {
        assert_eq!(subtitle.id, format!("sub-{index}"));
        assert_eq!(subtitle.url, format!("https://subs.test/{index}.srt"));
    }
}

#[test]
fn parse_catalog_reads_declared_genres_and_ignores_full_meta_fields() {
    for (label, input, (id, genres)) in [
        (
            "full meta",
            serde_json::json!({
                "id": "tt5607616", "name": "Re:Zero", "type": "series", "poster": "poster",
                "cast": ["Actor One", "Actor Two"],
                "trailers": [{"source": "abc", "type": "Trailer"}],
                "links": [{"name": "share", "url": "https://example.test"}],
                "behaviorHints": {"hasScheduledVideos": true},
                "genre": ["Animation", "Adventure", "Drama"]
            }),
            ("tt5607616", &["Animation", "Adventure", "Drama"][..]),
        ),
        (
            "genre array",
            serde_json::json!({
                "id": "tt5607616", "name": "Re:Zero", "type": "series",
                "genre": ["Animation", "Adventure", "Drama"]
            }),
            ("tt5607616", &["Animation", "Adventure", "Drama"][..]),
        ),
        (
            "genre string",
            serde_json::json!({
                "id": "tt2", "name": "String Genre", "type": "series", "genre": "Animation"
            }),
            ("tt2", &["Animation"][..]),
        ),
    ] {
        let item = catalog_item(input).expect(label);
        assert_eq!(item.id, id, "{label}");
        assert_eq!(item.genres.expect(label), genres, "{label}");
    }
}

#[test]
fn catalog_credit_matches_are_exact_bounded_and_search_only() {
    for (links, query, expected) in [
        (
            serde_json::json!([{"category":"Cast", "name":"Leonardo DiCaprio"}]),
            "leonardo dicaprio",
            true,
        ),
        (
            serde_json::json!([{"category":"Directors", "name":"Chloé Zhao"}]),
            "chloe zhao",
            true,
        ),
        (
            serde_json::json!([null, {"category":"cast", "name":"Tom Hanks"}]),
            "tom hanks",
            true,
        ),
        (
            serde_json::json!([{"category":"Cast", "name":"Tom Hanks Jr."}]),
            "tom hanks",
            false,
        ),
        (
            serde_json::json!([{"category":"Genres", "name":"Tom Hanks"}]),
            "tom hanks",
            false,
        ),
        (
            serde_json::json!([{"name":"Tom Hanks"}]),
            "tom hanks",
            false,
        ),
        (
            serde_json::json!({"category":"Cast", "name":"Tom Hanks"}),
            "tom hanks",
            false,
        ),
    ] {
        let bytes = serde_json::to_vec(&serde_json::json!({"metas":[{"id":"tt1", "type":"movie", "name":"Film", "links":links}]})).unwrap();
        for search in [None, Some(query)] {
            let page =
                parse_catalog_page(serde_json::from_slice(&bytes).unwrap(), |item| item, search);
            assert_eq!(page.items.len(), 1);
            assert_eq!(
                page.items[0].matches_search_credit,
                search.is_some() && expected,
                "{links}"
            );
        }
    }
    let mut links = vec![serde_json::json!({}); MAX_CAST + MAX_CREDITS + MAX_GENRES];
    links.push(serde_json::json!({"category":"Cast", "name":"Tom Hanks"}));
    let raw = serde_json::value::to_raw_value(&links).unwrap();
    assert!(!catalog_matches_search_credit(Some(&raw), "tom hanks"));
}

#[test]
fn parse_meta_skips_malformed_episode_siblings() {
    let details = parse_meta_item(serde_json::json!({
        "id": "tt1",
        "name": "Show",
        "type": "series",
        "videos": [
            {"id": "tt1:1:1", "name": "Pilot", "season": 1, "episode": 1},
            null, 42, [], {"id": false}, {"id": " "},
            {"name": "missing-id"},
            {"id": "tt1:1:2", "title": "Next", "season": 1, "number": 2}
        ]
    }))
    .expect("meta");
    let episodes = details.episodes.expect("episodes");
    assert_eq!(episodes.len(), 2);
    assert_eq!(episodes[1].episode, 2);
    for videos in serde_json::json!([null, 42, {}, "bad", []])
        .as_array()
        .unwrap()
    {
        let details = parse_meta_item(serde_json::json!({
            "id": "tt1", "name": "Show", "type": "series", "videos": videos
        }))
        .unwrap();
        assert!(details.episodes.is_none());
        assert!(details.seasons.is_none());
    }
}

#[test]
fn meta_decode_caps_valid_episodes_before_sorting_and_rejects_invalid_tail_json() {
    let videos: Vec<_> = (0..=MAX_EPISODES)
        .flat_map(|index| {
            [
                serde_json::json!({"id": false}),
                serde_json::json!({
                    "id": index, "season": if index == MAX_EPISODES { 0 } else { 1 },
                    "episode": MAX_EPISODES - index
                }),
            ]
        })
        .collect();
    let bytes = serde_json::to_vec(&serde_json::json!({
        "meta": {"id": "tt1", "name": "Show", "type": "series", "videos": videos}
    }))
    .unwrap();
    let response: MetaResponse<'_> = serde_json::from_slice(&bytes).unwrap();
    let details = response.meta.and_then(super::parse_meta_item).unwrap();
    let episodes = details.episodes.unwrap();
    assert_eq!(episodes.len(), MAX_EPISODES);
    assert_eq!(episodes.first().unwrap().id, (MAX_EPISODES - 1).to_string());
    assert_eq!(episodes.last().unwrap().id, "0");
    let seasons = details.seasons.unwrap();
    assert_eq!(seasons.len(), 1);
    assert_eq!(
        (seasons[0].number, seasons[0].episode_count),
        (1, MAX_EPISODES as u32)
    );
    let invalid = String::from_utf8(bytes)
        .unwrap()
        .replace(&format!(r#""id":{MAX_EPISODES}"#), r#""id":"#);
    assert!(serde_json::from_str::<MetaResponse<'_>>(&invalid).is_err());
}

#[test]
fn meta_credits_prefer_direct_fields_and_fall_back_to_link_names() {
    let mut value = serde_json::json!({
        "id": "tt1", "name": "Title", "type": "movie", "runtime": 142,
        "director": "Primary Director",
        "links": [
            {"name": "Actor", "category": "cAsT", "url": "https://example.test"},
            {"name": "Drama", "category": "Genres"},
            {"name": "Link Director", "category": "DIRECTORS"},
            {"name": "Ignored", "category": "imdb"}
        ]
    });
    let direct = parse_meta_item(value.clone()).unwrap();
    assert_eq!(direct.runtime.as_deref(), Some("142"));
    assert_eq!(direct.cast.unwrap(), ["Actor"]);
    assert_eq!(direct.genres.unwrap(), ["Drama"]);
    assert_eq!(direct.directors.unwrap(), ["Primary Director"]);
    value.as_object_mut().unwrap().remove("director");
    let fallback = parse_meta_item(value).unwrap();
    assert_eq!(fallback.directors.unwrap(), ["Link Director"]);
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

    // The season summary mirrors those contiguous sorted runs.
    let seasons = details.seasons.expect("seasons");
    assert_eq!(
        seasons
            .iter()
            .map(|season| (season.number, season.episode_count))
            .collect::<Vec<_>>(),
        [(0, 2), (1, 3), (2, 1)]
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
        "runtime": "45 min",
        "cast": ["Actor"],
        "director": ["Director"],
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
    assert!(lite.seasons.is_none());
    assert_eq!(lite.cast.as_deref().unwrap(), ["Actor"]);
    assert_eq!(lite.directors.as_deref().unwrap(), ["Director"]);
    assert_eq!(lite.runtime.as_deref(), Some("45 min"));
    assert_eq!(full.cast.as_deref().unwrap(), ["Actor"]);
    assert_eq!(full.directors.as_deref().unwrap(), ["Director"]);
    assert_eq!(full.episodes.as_ref().map(Vec::len), Some(2));
    // The parse-derived season summary rides the full shape only.
    assert_eq!(
        serde_json::to_value(&full.seasons).expect("serialize seasons"),
        serde_json::json!([{ "number": 1, "episodeCount": 2 }])
    );

    // Shaping never mutates the cached entry — full hits stay servable.
    let still_cached = client.meta_cache.get("meta:x").expect("cached meta");
    assert!(Arc::ptr_eq(&hit, &still_cached));
    assert!(still_cached.episodes.is_some());

    // Card shaping drops episodes, keeping all other fields.
    let lite_json = serde_json::to_value(&lite).expect("serialize lite");
    let mut full_json = serde_json::to_value(&full).expect("serialize full");
    let full_object = full_json.as_object_mut().unwrap();
    full_object.remove("episodes");
    full_object.remove("seasons");
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
    assert!(is_fetchable_http_url(
        "https://[2606:4700:4700::1111]/video.m3u8"
    ));
    for blocked in [
        "http://127.0.0.1:9999/video.mp4",
        "http://169.254.169.254/latest/meta-data",
        "http://192.168.1.1/video.mp4",
        "http://[::1]/video.mp4",
        "http://[::ffff:127.0.0.1]/video.mp4",
        "http://[fc00::1]/video.mp4",
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
fn artwork_urls_bound_raw_and_canonical_values_without_truncation() {
    let base = "https://cdn.test/image?signature=";
    let prefix = format!("{base}{}", "a".repeat(MAX_STRING_CHARS - base.len()));
    for (url, accepted) in [
        (prefix.clone(), true),
        (format!("{prefix}a"), true),
        (format!("{prefix}'"), false),
        (format!(" {prefix}"), false),
        (
            format!(
                "{base}{}",
                "a".repeat(MAX_SERIALIZED_IMAGE_URL_CHARS - base.len())
            ),
            true,
        ),
        (
            format!(
                "{base}{}",
                "a".repeat(MAX_SERIALIZED_IMAGE_URL_CHARS - base.len() + 1)
            ),
            false,
        ),
    ] {
        let expected = accepted.then_some(url.as_str());
        let item = catalog_item(serde_json::json!({
            "id": "tt1", "name": "Title", "type": "movie",
            "poster": url, "background": url, "logo": url
        }))
        .unwrap();
        assert_eq!(item.poster.as_deref(), expected);
        assert_eq!(item.backdrop.as_deref(), expected);
        assert_eq!(item.logo.as_deref(), expected);
        let details = parse_meta_item(serde_json::json!({
            "id": "tt1", "name": "Title", "type": "series",
            "poster": url, "background": url, "logo": url,
            "videos": [{"id": "tt1:1:1", "season": 1, "episode": 1, "thumbnail": url}]
        }))
        .unwrap();
        assert_eq!(details.poster.as_deref(), expected);
        assert_eq!(details.backdrop.as_deref(), expected);
        assert_eq!(details.logo.as_deref(), expected);
        assert_eq!(details.episodes.unwrap()[0].thumbnail.as_deref(), expected);
    }
}

#[test]
fn trailer_source_rejects_non_youtube_tokens() {
    let valid = parse_trailers(
        Some(&serde_json::json!([
            {"source": "dQw4w9WgXcQ", "type": "Trailer"}
        ])),
        None,
    )
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
            parse_trailers(
                Some(&serde_json::json!([
                    {"source": source, "type": "Trailer"}
                ])),
                Some(&serde_json::json!([{"ytId": source, "title": "Trailer"}])),
            )
            .is_none(),
            "{source} must be rejected"
        );
    }
}

#[test]
fn trailers_merge_names_in_source_order_and_keep_unique_bounded_ids() {
    let trailers = parse_trailers(
        Some(&serde_json::json!([
            {"source": "dQw4w9WgXcQ", "type": "Trailer"},
            {"source": "dQw4w9WgXcQ", "type": "Trailer"},
            {"source": "abcdefghijk", "type": "Trailer"},
            {"source": "xxxxxxxxxxx", "type": "Clip"}
        ])),
        Some(&serde_json::json!([
            {"ytId": "abcdefghijk", "title": " \t Official  trailer \n"},
            {"ytId": "dQw4w9WgXcQ", "title": "   "},
            {"ytId": "dQw4w9WgXcQ", "title": "Teaser"},
            {"ytId": "12345678901", "title": "n".repeat(200)},
            {"ytId": "12345678901", "title": "Duplicate"}
        ])),
    )
    .unwrap();
    assert_eq!(trailers.len(), 3);
    assert_eq!(trailers[0].id, "dQw4w9WgXcQ");
    assert_eq!(trailers[0].name.as_deref(), Some("Teaser"));
    assert_eq!(trailers[1].name.as_deref(), Some("Official trailer"));
    assert_eq!(trailers[2].name.as_ref().unwrap().chars().count(), 80);
    let streams = serde_json::json!((0..40)
        .map(|index| serde_json::json!({"ytId": format!("{index:011}"), "title": "Trailer"}))
        .collect::<Vec<_>>());
    let bounded = parse_trailers(None, Some(&streams)).unwrap();
    assert_eq!(bounded.len(), MAX_TRAILERS);
    assert_eq!(bounded.last().unwrap().id, "00000000031");
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
    cache.clear();
    assert_eq!(cache.len(), 0);
    for index in 0..5 {
        assert_eq!(cache.get(&format!("key-{index}")), None);
    }
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
    assert!(subtitle_item(serde_json::json!({
        "id": "en",
        "url": "https://subs.test/en.srt",
        "lang": "en"
    }))
    .is_some());
    for blocked in [
        "http://127.0.0.1:11470/subs/en.srt",
        "http://169.254.169.254/latest/meta-data",
        "http://192.168.1.1/subs/en.srt",
        "http://[::1]/subs/en.srt",
        "http://[::ffff:127.0.0.1]/subs/en.srt",
        "file:///etc/passwd",
        "https://user:pass@subs.test/en.srt",
    ] {
        assert!(
            subtitle_item(serde_json::json!({"id": "x", "url": blocked})).is_none(),
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

    assert!(!client.fetch_failures.cooling_down(&addon_key));
    client
        .fetch_failures
        .note(&addon_key, &client.generation, 0);
    assert!(client.fetch_failures.cooling_down(&addon_key));
    assert!(client.meta_is_recent_straggler("https://dead-addon.test", "movie", "tt1"));

    // A record written under a superseded generation is dropped: a fetch
    // that outlived a clear_cache must not reinstall the wiped cooldown.
    client.clear_cache();
    assert!(!client.fetch_failures.cooling_down(&addon_key));
    assert!(!client.meta_is_recent_straggler("https://dead-addon.test", "movie", "tt1"));
    client
        .fetch_failures
        .note(&addon_key, &client.generation, 0);
    assert!(!client.fetch_failures.cooling_down(&addon_key));
    client
        .fetch_failures
        .note(&addon_key, &client.generation, 1);
    assert!(client.fetch_failures.cooling_down(&addon_key));
}

#[test]
fn deterministic_failures_negative_cache_until_clear() {
    let client = AddonResourceClient::new();
    let base = "https://slow-addon.test";
    client.note_meta_straggler(base, "movie", "tt1", client.cache_generation());
    assert!(client.meta_is_recent_straggler(base, "movie", "tt1"));
    assert!(!client.meta_is_recent_straggler(base, "movie", "tt2"));
    client.fetch_contract().cache_failure("meta:x", "boom", 0);
    assert_eq!(client.failure_cache.get("meta:x").as_deref(), Some("boom"));

    // Same generation guard as the value caches: a clear_cache mid-fetch
    // revokes the negative-cache write too.
    client.clear_cache();
    assert!(!client.meta_is_recent_straggler(base, "movie", "tt1"));
    client.note_meta_straggler(base, "movie", "tt1", 0);
    assert!(!client.meta_is_recent_straggler(base, "movie", "tt1"));
    assert_eq!(client.failure_cache.get("meta:x"), None);
    client.fetch_contract().cache_failure("meta:x", "boom", 0);
    assert_eq!(client.failure_cache.get("meta:x"), None);
}

struct SubtitleDiskTest(PathBuf);

impl SubtitleDiskTest {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("stremiro-subtitles-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn client(&self) -> AddonResourceClient {
        let mut client = AddonResourceClient::with_subtitle_cache_dir(Some(self.0.clone()));
        client.client = Client::builder().no_proxy().build().unwrap();
        client
    }

    fn file(&self, base: &str, type_: &str, id: &str) -> PathBuf {
        let url = build_resource_url(base, "subtitles", type_, id, &[]).unwrap();
        self.0.join("subtitles-v1").join(format!(
            "{}.json",
            hash_segment(&resource_cache_key("subtitles", &url))
        ))
    }
}

impl Drop for SubtitleDiskTest {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const DISK_SUBTITLE_RESPONSE: &str =
    r#"{"subtitles":[{"id":"en","url":"https://subs.test/en.srt?token=signed","lang":"eng"}]}"#;

#[tokio::test]
async fn subtitle_disk_cache_reuses_positive_response_after_restart_without_rewriting_expiration() {
    let disk = SubtitleDiskTest::new();
    let baseline = TestHttpServer::new(vec![(200, DISK_SUBTITLE_RESPONSE, None); 2]);
    for _ in 0..2 {
        let mut client = disk.client();
        client.subtitle_disk_dir = None;
        client
            .fetch_subtitles(&baseline.url, "series", "tt1:1:2")
            .await
            .unwrap();
    }
    assert_eq!(baseline.finish().len(), 2, "memory-only clients each fetch");
    let server = TestHttpServer::new(vec![(200, DISK_SUBTITLE_RESPONSE, None)]);
    let first = disk
        .client()
        .fetch_subtitles(&server.url, "series", "tt1:1:2")
        .await
        .unwrap();
    let path = disk.file(&server.url, "series", "tt1:1:2");
    let original = std::fs::read(&path).unwrap();
    let restarted = disk.client();
    for _ in 0..2 {
        assert_eq!(
            restarted
                .fetch_subtitles(&server.url, "series", "tt1:1:2")
                .await
                .unwrap(),
            first
        );
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }
    assert_eq!(server.finish(), ["/subtitles/series/tt1%3A1%3A2.json"]);
}

#[tokio::test]
async fn subtitle_disk_cache_isolates_configured_source_type_and_episode() {
    let disk = SubtitleDiskTest::new();
    let server = TestHttpServer::new(vec![(200, DISK_SUBTITLE_RESPONSE, None); 4]);
    let configured = format!("{}?lang=fra&hash=different", server.url);
    for (base, type_, id) in [
        (server.url.as_str(), "series", "tt1:1:2"),
        (configured.as_str(), "series", "tt1:1:2"),
        (server.url.as_str(), "movie", "tt1:1:2"),
        (server.url.as_str(), "series", "tt1:1:3"),
    ] {
        for _ in 0..2 {
            assert_eq!(
                disk.client()
                    .fetch_subtitles(base, type_, id)
                    .await
                    .unwrap()
                    .len(),
                1
            );
        }
    }
    assert_eq!(
        server.finish(),
        [
            "/subtitles/series/tt1%3A1%3A2.json",
            "/subtitles/series/tt1%3A1%3A2.json?lang=fra&hash=different",
            "/subtitles/movie/tt1%3A1%3A2.json",
            "/subtitles/series/tt1%3A1%3A3.json",
        ]
    );
}

#[tokio::test]
async fn subtitle_disk_hits_do_not_extend_signed_url_lifetime_in_memory() {
    let disk = SubtitleDiskTest::new();
    let fresh = r#"{"subtitles":[{"id":"en","url":"https://subs.test/en.srt?token=fresh"}]}"#;
    let server = TestHttpServer::new(vec![
        (200, DISK_SUBTITLE_RESPONSE, None),
        (200, fresh, None),
    ]);
    disk.client()
        .fetch_subtitles(&server.url, "movie", "tt1")
        .await
        .unwrap();
    let path = disk.file(&server.url, "movie", "tt1");
    let mut entry: SubtitleDiskEntry =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    entry.expires_at = SystemTime::now() + Duration::from_millis(500);
    std::fs::write(&path, serde_json::to_vec(&entry).unwrap()).unwrap();
    let restarted = disk.client();
    assert!(restarted
        .fetch_subtitles(&server.url, "movie", "tt1")
        .await
        .unwrap()[0]
        .url
        .ends_with("token=signed"));
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(restarted
        .fetch_subtitles(&server.url, "movie", "tt1")
        .await
        .unwrap()[0]
        .url
        .ends_with("token=fresh"));
    assert_eq!(server.finish().len(), 2);
}

#[tokio::test]
async fn subtitle_disk_corruption_oversize_and_unsafe_urls_fall_back_to_http() {
    let disk = SubtitleDiskTest::new();
    let server = TestHttpServer::new(vec![(200, DISK_SUBTITLE_RESPONSE, None); 5]);
    disk.client()
        .fetch_subtitles(&server.url, "movie", "tt1")
        .await
        .unwrap();
    let path = disk.file(&server.url, "movie", "tt1");
    let unsafe_entry = serde_json::to_vec(&SubtitleDiskEntry {
        expires_at: SystemTime::now() + RESOURCE_CACHE_TTL,
        response: serde_json::from_str(
            r#"{"subtitles":[{"id":"en","url":"http://127.0.0.1/private"}]}"#,
        )
        .unwrap(),
    })
    .unwrap();
    let future_entry = serde_json::to_vec(&SubtitleDiskEntry {
        expires_at: SystemTime::now() + RESOURCE_CACHE_TTL * 2,
        response: serde_json::from_str(DISK_SUBTITLE_RESPONSE).unwrap(),
    })
    .unwrap();
    for bytes in [
        b"broken json".to_vec(),
        vec![b' '; SUBTITLE_DISK_MAX_BYTES + 1],
        unsafe_entry,
        future_entry,
    ] {
        std::fs::write(&path, bytes).unwrap();
        assert_eq!(
            disk.client()
                .fetch_subtitles(&server.url, "movie", "tt1")
                .await
                .unwrap()[0]
                .url,
            "https://subs.test/en.srt?token=signed"
        );
    }
    assert_eq!(server.finish().len(), 5);
}

#[tokio::test]
async fn subtitle_disk_cache_does_not_persist_empty_or_failed_responses_and_write_errors_are_optional(
) {
    let disk = SubtitleDiskTest::new();
    let server = TestHttpServer::new(vec![
        (200, r#"{"subtitles":[]}"#, None),
        (404, "{}", None),
        (200, "broken json", None),
        (200, DISK_SUBTITLE_RESPONSE, None),
        (200, DISK_SUBTITLE_RESPONSE, None),
    ]);
    for attempt in 0..3 {
        let result = disk
            .client()
            .fetch_subtitles(&server.url, "movie", "tt1")
            .await;
        if attempt == 0 {
            assert!(result.unwrap().is_empty());
        } else {
            assert!(result.is_err());
        }
        assert!(!disk.file(&server.url, "movie", "tt1").exists());
    }
    let blocked = disk.0.join("blocked");
    std::fs::write(&blocked, "not a directory").unwrap();
    for _ in 0..2 {
        let mut client = disk.client();
        client.subtitle_disk_dir = Some(blocked.join("subtitles-v1"));
        assert_eq!(
            client
                .fetch_subtitles(&server.url, "movie", "tt1")
                .await
                .unwrap()
                .len(),
            1
        );
    }
    assert_eq!(server.finish().len(), 5);
}

#[tokio::test]
async fn subtitle_disk_cache_bounds_files_under_concurrent_writers() {
    use futures_util::StreamExt;

    let disk = SubtitleDiskTest::new();
    let count = SUBTITLE_CACHE_MAX_ENTRIES + 4;
    let server = TestHttpServer::new(vec![(200, DISK_SUBTITLE_RESPONSE, None); count]);
    let client = disk.client();
    futures_util::stream::iter(0..count)
        .map(|index| {
            let client = &client;
            let base = &server.url;
            async move {
                client
                    .fetch_subtitles(base, "movie", &format!("tt{index}"))
                    .await
                    .unwrap()
            }
        })
        .buffer_unordered(8)
        .collect::<Vec<_>>()
        .await;
    let files: Vec<_> = std::fs::read_dir(disk.0.join("subtitles-v1"))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(files.len(), SUBTITLE_CACHE_MAX_ENTRIES);
    assert!(files
        .iter()
        .all(|file| file.metadata().unwrap().len() <= SUBTITLE_DISK_MAX_BYTES as u64));
    assert_eq!(server.finish().len(), count);
}
