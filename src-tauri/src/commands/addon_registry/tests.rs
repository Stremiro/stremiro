use super::{
    add_subtitle_if_unique, addon_allows_catalog, addon_allows_resource,
    catalog_fetch_page_from_source, catalog_page_next_skip, catalog_search_extras,
    collect_catalog_outcomes, collect_with_deadline, extra_skip_value,
    fetch_catalog_pages_for_target_groups, fetch_subtitles_for_addon, merge_catalog_pages,
    merge_search_catalog_pages, run_catalog_work_pool, searchable_catalogs,
    select_search_catalog_work, AddonResourceError, AddonResourceErrorKind, CatalogFetchPage,
    CatalogGraceStart, CatalogGroupSelection, CatalogTarget, CatalogWorkItem, SearchCatalogSource,
    SearchSourceCursor, SourcedAddonSubtitle, CATALOG_STRAGGLER_GRACE,
};
use crate::commands::config_store::{resolve_addon_configs, AddonConfig};
use crate::providers::addon_manifest::parse_addon_manifest;
use crate::providers::addon_resource::{
    AddonResourceClient, AddonSubtitle, CatalogExtra, CatalogPage,
};
use crate::test_helpers::{
    addon_at, cinemeta_addon, classified_cinemeta_addon, stalled_listener, test_addon,
    test_media_item, TestHttpServer,
};
use futures_util::StreamExt;
use std::collections::HashSet;
use std::time::Duration;

fn catalog_page(items: Vec<crate::providers::MediaItem>, source_item_count: usize) -> CatalogPage {
    CatalogPage {
        items,
        source_item_count,
    }
}

#[test]
fn pinned_defaults_route_before_manifest_fetch_and_cinemeta_searches_each_type_once() {
    let addons = resolve_addon_configs(Some(vec![
        cinemeta_addon(),
        addon_at("https://catalog.test", "custom", "Custom"),
    ]));
    let [cinemeta, opensubtitles, custom] = addons.as_slice() else {
        panic!("expected both defaults and the custom addon");
    };
    assert!(addon_allows_resource(cinemeta, "meta", "series", "tt123"));
    assert!(!addon_allows_resource(
        cinemeta,
        "stream",
        "series",
        "tt123:1:1"
    ));
    assert!(addon_allows_resource(
        opensubtitles,
        "subtitles",
        "series",
        "tt123:1:1"
    ));
    assert!(!addon_allows_resource(
        opensubtitles,
        "subtitles",
        "series",
        "kitsu:1:1"
    ));

    let (work, sources) = select_search_catalog_work(
        &addons,
        "dune",
        &["movie"],
        &[Some("Animation".into()), Some("Comedy".into())],
        None,
        false,
    );
    let cinemeta_work: Vec<_> = work
        .iter()
        .filter(|item| item.addon_url == cinemeta.url)
        .collect();
    assert_eq!(cinemeta_work.len(), 1);
    assert_eq!(cinemeta_work[0].extras.len(), 1);
    assert_eq!(cinemeta_work[0].extras[0].name, "search");
    assert!(sources[0][0].supports_skip);
    assert_eq!(
        work.iter()
            .filter(|item| item.addon_url == custom.url)
            .count(),
        2
    );
}

fn item_page(id: &str, source_item_count: usize) -> CatalogPage {
    catalog_page(vec![test_media_item(id, "movie")], source_item_count)
}

fn extra(name: &str, value: &str) -> CatalogExtra {
    CatalogExtra {
        name: name.into(),
        value: value.into(),
    }
}

fn source_cursor(key: &str, skip: u32) -> SearchSourceCursor {
    SearchSourceCursor {
        key: key.into(),
        skip,
        retry: false,
        page_hash: None,
    }
}

fn search_source(key: &str, skip: u32) -> SearchCatalogSource {
    SearchCatalogSource {
        cursor: source_cursor(key, skip),
        supports_skip: true,
    }
}

#[tokio::test]
async fn resource_grace_waits_for_success_after_fast_failure() {
    let outcomes = futures_util::stream::iter([Err(()), Ok(())]).then(|result| async move {
        if result.is_ok() {
            tokio::time::sleep(Duration::from_millis(60)).await;
        }
        result
    });
    futures_util::pin_mut!(outcomes);
    let collected = collect_with_deadline(outcomes, Duration::from_millis(10), Result::is_ok).await;
    assert_eq!(collected, vec![Err(()), Ok(())]);

    let (_stalled, stalled_url) = stalled_listener();
    let server = TestHttpServer::new(vec![(
        200,
        r#"{"meta":{"id":"tt1","name":"Fallback","type":"movie"}}"#,
        None,
    )]);
    let addons = [
        addon_at(&stalled_url, "primary", "Primary"),
        addon_at(&server.url, "fallback", "Fallback"),
    ];
    let client = AddonResourceClient::new();
    for attempt in 0..2 {
        let started = std::time::Instant::now();
        let details = super::fetch_meta_details_from_addons(&client, &addons, "movie", "tt1", None)
            .await
            .unwrap();
        let elapsed = started.elapsed();
        assert_eq!(details.title, "Fallback");
        if attempt == 0 {
            assert!(elapsed >= super::META_HEDGE_DELAY + super::META_FALLBACK_GRACE);
        } else {
            assert!(elapsed < super::META_HEDGE_DELAY);
        }
    }
    assert!(client.meta_is_recent_straggler(&addons[0].url, "movie", "tt1"));
    assert!(!client.meta_is_recent_straggler(&addons[0].url, "movie", "tt2"));
    assert!(!client.meta_is_recent_straggler(&addons[0].url, "series", "tt1"));
    client.note_meta_straggler(&addons[1].url, "movie", "tt1", client.cache_generation());
    let cached_primary = [addons[1].clone(), addons[0].clone()];
    let started = std::time::Instant::now();
    assert_eq!(
        super::fetch_meta_details_from_addons(&client, &cached_primary, "movie", "tt1", None)
            .await
            .unwrap()
            .title,
        "Fallback"
    );
    assert!(started.elapsed() < super::META_HEDGE_DELAY);
    assert_eq!(server.finish(), ["/meta/movie/tt1.json"]);
}

#[tokio::test]
async fn metadata_imdb_anchor_rejects_wrong_titles_but_allows_provider_id_mapping() {
    for (requested, response, accepted) in [
        (
            "tt0388629",
            r#"{"meta":{"id":"tt9999999","name":"Wrong","type":"series"}}"#,
            false,
        ),
        (
            "tt0388629",
            r#"{"meta":{"id":"kitsu:1","imdb_id":"tt9999999","name":"Wrong","type":"series"}}"#,
            false,
        ),
        (
            "tt0388629",
            r#"{"meta":{"id":"kitsu:1","imdb_id":"tt0388629","name":"One Piece","type":"series"}}"#,
            true,
        ),
        (
            "kitsu:1",
            r#"{"meta":{"id":"tt0388629","name":"One Piece","type":"series"}}"#,
            true,
        ),
    ] {
        let server = TestHttpServer::new(vec![(200, response, None)]);
        let (_, result) = super::fetch_ranked_meta(
            &AddonResourceClient::new(),
            &server.url,
            "series",
            requested,
            0,
        )
        .await;
        assert_eq!(result.is_ok(), accepted, "{requested}: {response}");
        assert_eq!(server.finish().len(), 1);
    }
}

#[tokio::test]
async fn metadata_source_selection_rejects_cross_kind_payloads_and_keeps_anime_aliases() {
    let wrong = TestHttpServer::new(vec![(
        200,
        r#"{"meta":{"id":"tt1","name":"Wrong movie","type":"movie"}}"#,
        None,
    )]);
    let fallback = TestHttpServer::new(vec![(
        200,
        r#"{"meta":{"id":"kitsu:1","name":"Series fallback","type":" AnImE ","videos":[{"id":"kitsu:1:1","season":1,"episode":1}]}}"#,
        None,
    )]);
    let addons = [
        addon_at(&wrong.url, "primary", "Primary"),
        addon_at(&fallback.url, "fallback", "Fallback"),
    ];
    let client = AddonResourceClient::new();
    let details = super::fetch_meta_details_from_addons(&client, &addons, "series", "tt1", None)
        .await
        .unwrap();
    assert_eq!(details.title, "Series fallback");
    assert_eq!(details.type_, "anime");
    assert!(details.is_anime);
    assert_eq!(details.episodes.as_ref().unwrap().len(), 1);
    assert_eq!(details.id, "kitsu:1");
    assert_eq!(wrong.finish(), ["/meta/series/tt1.json"]);
    assert_eq!(fallback.finish(), ["/meta/series/tt1.json"]);
}

#[tokio::test]
async fn anime_metadata_uses_declared_type_and_preserves_series_fallbacks() {
    for (types, expected_type) in [
        (Some(vec!["anime"]), "anime"),
        (Some(vec!["series"]), "series"),
        (Some(vec!["anime", "series"]), "anime"),
        (None, "series"),
    ] {
        let server = TestHttpServer::new(vec![(
            200,
            r#"{"meta":{"id":"kitsu:1","name":"Anime","type":"anime"}}"#,
            None,
        )]);
        let addon = AddonConfig {
            capabilities: types.map(|types| {
                parse_addon_manifest(
                    serde_json::json!({
                        "id": "anime", "name": "Anime",
                        "resources": [{"name": "meta", "types": types, "idPrefixes": ["kitsu:"]}],
                        "types": types,
                    })
                    .to_string()
                    .as_bytes(),
                )
                .unwrap()
            }),
            ..addon_at(&server.url, "anime", "Anime")
        };
        let details = super::fetch_meta_details_from_addons(
            &AddonResourceClient::new(),
            &[addon],
            "anime",
            "kitsu:1",
            None,
        )
        .await
        .unwrap();
        assert_eq!(details.title, "Anime");
        assert_eq!(
            server.finish(),
            [format!("/meta/{expected_type}/kitsu%3A1.json")]
        );
    }
}

#[tokio::test]
async fn catalog_pool_bounds_all_groups_and_restores_source_order() {
    let work = |urls: &[String]| {
        (0..3)
            .flat_map(|group| {
                (0..4 - group).map(move |order| CatalogWorkItem {
                    group,
                    order,
                    addon_url: urls[order].clone(),
                    media_type: "series".into(),
                    catalog_id: format!("group-{group}-source-{order}"),
                    extras: Vec::new(),
                    catalog_genre: None,
                })
            })
            .rev()
            .collect()
    };
    let client = AddonResourceClient::new();
    let (stalled, stalled_url) = stalled_listener();
    stalled.set_nonblocking(true).unwrap();
    {
        let pending = run_catalog_work_pool(
            &client,
            work(&vec![stalled_url; 4]),
            3,
            None,
            CatalogGraceStart::AllGroupsReady,
        );
        tokio::pin!(pending);
        let observe = async {
            let mut connections = Vec::new();
            while connections.len() < 4 {
                match stalled.accept() {
                    Ok((socket, _)) => connections.push(socket),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        tokio::time::sleep(Duration::from_millis(1)).await;
                    }
                    Err(error) => panic!("{error}"),
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert!(
                matches!(stalled.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock),
                "all catalog groups must share the four-request limit"
            );
        };
        tokio::select! {
            _ = &mut pending => panic!("unanswered catalogs must remain pending"),
            result = tokio::time::timeout(Duration::from_secs(3), observe) => result.unwrap(),
        }
    }

    let servers: Vec<_> = [
        r#"{"metas":[{"id":"source-0","name":"First","type":"series"}]}"#,
        r#"{"metas":[{"id":"source-1","name":"Second","type":"series"}]}"#,
        r#"{"metas":[{"id":"source-2","name":"Third","type":"series"}]}"#,
        r#"{"metas":[{"id":"source-3","name":"Fourth","type":"series"}]}"#,
    ]
    .into_iter()
    .map(|body| TestHttpServer::new(vec![(200, body, None); 3]))
    .collect();
    let urls: Vec<_> = servers.iter().map(|server| server.url.clone()).collect();
    let groups = run_catalog_work_pool(
        &client,
        work(&urls),
        3,
        None,
        CatalogGraceStart::AllGroupsReady,
    )
    .await;
    for (group, bucket) in groups.into_iter().enumerate() {
        assert_eq!(bucket.len(), 4 - group);
        for (expected_order, (order, page)) in bucket.into_iter().enumerate() {
            assert_eq!(order, expected_order);
            assert_eq!(page.unwrap().items[0].id, format!("source-{order}"));
        }
    }
    for (order, server) in servers.into_iter().enumerate() {
        assert_eq!(server.finish().len(), (4 - order).min(3));
    }
}

#[tokio::test(start_paused = true)]
async fn catalog_grace_preserves_unanswered_groups_and_drops_stragglers() {
    let page = || item_page("tt1", 1);
    let outcomes = futures_util::stream::iter([
        (0, 0, Ok(CatalogPage::default())),
        (2, 0, Err("offline".to_string())),
        (1, 0, Ok(page())),
        (0, 1, Ok(page())),
    ])
    .then(|outcome| async move {
        if outcome.0 == 0 && outcome.1 == 1 {
            tokio::time::sleep(Duration::from_millis(60)).await;
        }
        outcome
    })
    .chain(futures_util::stream::pending());
    futures_util::pin_mut!(outcomes);
    let collected = tokio::time::timeout(
        Duration::from_secs(2),
        collect_catalog_outcomes(
            outcomes,
            vec![3, 1, 1],
            Duration::from_millis(10),
            CatalogGraceStart::AllGroupsReady,
        ),
    )
    .await
    .expect("answered groups must still bound a pending secondary source");
    assert_eq!(collected.len(), 4);
    assert_eq!(collected[3].0, 0);
    assert!(collected[3].2.is_ok());

    for (grace, expected_count) in [(Duration::from_secs(10), 2), (CATALOG_STRAGGLER_GRACE, 1)] {
        let outcomes = futures_util::stream::iter([0, 1])
            .map(|order| async move {
                if order == 1 {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
                (order, 0, Ok(page()))
            })
            .buffer_unordered(2);
        let started = tokio::time::Instant::now();
        let collected =
            collect_catalog_outcomes(outcomes, vec![1, 1], grace, CatalogGraceStart::FirstResults)
                .await;
        let elapsed = started.elapsed();
        assert_eq!(collected.len(), expected_count);
        assert!(elapsed >= grace.min(Duration::from_secs(5)));
        if expected_count == 1 {
            assert!(elapsed < Duration::from_secs(5));
            let page = merge_search_catalog_pages(
                vec![
                    vec![search_source("primary", 50)],
                    vec![search_source("straggler", 50)],
                ],
                vec![
                    collected
                        .into_iter()
                        .map(|(_, order, result)| (order, result))
                        .collect(),
                    Vec::new(),
                ],
                false,
            )
            .unwrap();
            assert_eq!(page.cursors[0].skip, 51);
            assert!(!page.cursors[0].retry);
            assert_eq!(page.cursors[1].skip, 50);
            assert!(page.cursors[1].retry);
        }
    }
}

#[tokio::test]
async fn catalog_group_merge_marks_dropped_straggler_partial() {
    let ready = TestHttpServer::new(vec![
        (
            200,
            r#"{"metas":[{"id":"fast-1","name":"Fast","type":"movie"}]}"#,
            None,
        ),
        (
            200,
            r#"{"metas":[{"id":"fast-2","name":"Second","type":"movie"}]}"#,
            None,
        ),
    ]);
    let (_stalled, stalled_url) = stalled_listener();
    let client = AddonResourceClient::new();
    let target = |url: &str, catalog_id: &str| CatalogTarget {
        url: url.to_string(),
        media_type: "movie".to_string(),
        catalog_id: catalog_id.to_string(),
        catalog_genre: None,
        extras: Vec::new(),
        supports_skip: true,
    };
    let groups = |targets: Vec<CatalogTarget>| -> Vec<CatalogGroupSelection> {
        vec![Ok((targets, Vec::new()))]
    };

    // A source dropped by the straggler grace keeps the answered page but
    // must flag it partial so browse surfaces the notice.
    let mut results = tokio::time::timeout(
        Duration::from_secs(10),
        fetch_catalog_pages_for_target_groups(
            &client,
            groups(vec![target(&ready.url, "top"), target(&stalled_url, "top")]),
            None,
        ),
    )
    .await
    .expect("straggler grace must bound an unanswered catalog source");
    assert_eq!(results.len(), 1);
    let page = results.pop().unwrap().unwrap();
    assert_eq!(page.next_skip, Some(1));
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].id, "fast-1");
    assert!(page.partial, "unanswered source must mark the page partial");

    // Every source answering leaves the merged page complete.
    let mut results = fetch_catalog_pages_for_target_groups(
        &client,
        groups(vec![
            target(&ready.url, "top"),
            target(&ready.url, "popular"),
        ]),
        None,
    )
    .await;
    assert_eq!(results.len(), 1);
    let page = results.pop().unwrap().unwrap();
    assert_eq!(page.items.len(), 2);
    assert!(!page.partial);

    // A strict scan deadline still fails an incomplete bucket outright.
    let deadline = tokio::time::Instant::now() + Duration::from_millis(200);
    let mut results = fetch_catalog_pages_for_target_groups(
        &client,
        groups(vec![target(&ready.url, "top"), target(&stalled_url, "top")]),
        Some(deadline),
    )
    .await;
    assert_eq!(results.len(), 1);
    assert_eq!(
        results.pop().unwrap().unwrap_err(),
        "Catalog scan incomplete."
    );
}

#[test]
fn classified_search_uses_only_declared_search_catalogs() {
    let addon = classified_cinemeta_addon();
    assert!(searchable_catalogs(&addon, "movie").eq([("movie", "top", true)]));
    assert!(searchable_catalogs(&addon, "series").next().is_none());

    let search = [extra("search", "dune")];
    let with_genre = [extra("search", "dune"), extra("genre", "Animation")];
    assert!(addon_allows_catalog(&addon, "movie", "top", &search));
    assert!(addon_allows_catalog(&addon, "movie", "top", &with_genre));
    assert!(!addon_allows_catalog(
        &addon,
        "movie",
        "imdbRating",
        &search
    ));
}

#[test]
fn unclassified_addon_is_not_skipped() {
    let addon = cinemeta_addon();
    let extras = [extra("search", "dune")];
    assert!(addon_allows_catalog(&addon, "movie", "top", &extras));
    assert!(searchable_catalogs(&addon, "movie").eq([("movie", "top", false)]));
}

#[test]
fn query_extras_include_skip_only_on_later_pages() {
    let first = catalog_search_extras("dune", Some(" Drama "), 0);
    assert_eq!(
        first
            .iter()
            .map(|extra| (extra.name.as_str(), extra.value.as_str()))
            .collect::<Vec<_>>(),
        [("search", "dune"), ("genre", "Drama")]
    );
    let next = catalog_search_extras("dune", None, 50);
    assert_eq!(next[0].name, "search");
    assert_eq!(next[0].value, "dune");
    assert_eq!(next[1].name, "skip");
    assert_eq!(extra_skip_value(&next), 50);
}

#[test]
fn search_supplies_required_zero_offset_without_changing_optional_extras() {
    for required in [false, true] {
        let addon = AddonConfig {
            capabilities: Some(
                parse_addon_manifest(
                    serde_json::json!({
                        "id": "search", "name": "Search", "types": ["movie"],
                        "catalogs": [{"type": "movie", "id": "search", "extra": [
                            {"name": "search", "isRequired": true},
                            {"name": "skip", "isRequired": required},
                        ]}],
                    })
                    .to_string()
                    .as_bytes(),
                )
                .unwrap(),
            ),
            ..test_addon("search", "Search")
        };
        let (work, _) =
            select_search_catalog_work(&[addon], "dune", &["movie"], &[None], None, false);
        assert_eq!(work.len(), 1, "required skip={required}");
        assert_eq!(
            work[0]
                .extras
                .iter()
                .any(|extra| extra.name == "skip" && extra.value == "0"),
            required,
        );
    }
}

#[tokio::test]
async fn search_uses_manifest_spelling_and_retries_a_single_page_source_once() {
    let body = r#"{"metas":[{"id":"tt1","name":"Dune","type":"movie"}]}"#;
    let server = TestHttpServer::new(vec![(200, body, None)]);
    let addon = AddonConfig {
        capabilities: Some(
            parse_addon_manifest(
                br#"{
            "name":"Catalog", "catalogs":[{"type":"Movie","id":"Find",
            "extra":[{"name":"search"},{"name":"genre","options":["Science Fiction"]}]}]
        }"#,
            )
            .unwrap(),
        ),
        ..addon_at(&server.url, "catalog", "Catalog")
    };
    let snapshot = [addon];
    let select = |cursors| {
        select_search_catalog_work(
            &snapshot,
            "dune",
            &["movie"],
            &[Some("science fiction".into())],
            cursors,
            false,
        )
    };
    let (_, sources) = select(None);
    let first = merge_search_catalog_pages(sources, vec![vec![]], false).unwrap();
    assert!(first.cursors[0].retry);

    let (_, sources) = select(Some(&first.cursors));
    let failed = merge_search_catalog_pages(sources, vec![vec![]], false).unwrap();
    assert!(failed.partial && failed.cursors.is_empty());

    let (work, sources) = select(Some(&first.cursors));
    let outcomes = run_catalog_work_pool(
        &AddonResourceClient::new(),
        work,
        1,
        None,
        CatalogGraceStart::FirstResults,
    )
    .await;
    let page = merge_search_catalog_pages(sources, outcomes, false).unwrap();
    assert_eq!(page.items.len(), 1);
    assert!(page.cursors.is_empty());
    assert_eq!(
        server.finish(),
        ["/catalog/Movie/Find/search=dune&genre=Science%20Fiction.json"]
    );
}

#[test]
fn search_deduplicates_requests_when_catalog_does_not_accept_genres() {
    let addon = mixed_catalog_addon();
    let (work, _) = select_search_catalog_work(
        &[addon],
        "dune",
        &[],
        &[Some("Comedy".into()), Some("Drama".into())],
        None,
        true,
    );
    assert_eq!(work.len(), 1);
    assert_eq!(work[0].extras, [extra("search", "dune")]);
}

#[tokio::test]
async fn browse_supplies_required_zero_offset_for_typed_year_and_custom_catalogs() {
    for required in [None, Some(false), Some(true)] {
        for (media_type, catalog_id, genre) in [
            ("movie", "top", None),
            ("movie", "year", Some("2026")),
            ("Podcast", "custom", Some("Tech")),
        ] {
            let server = TestHttpServer::new(vec![(
                200,
                r#"{"metas":[{"id":"one","name":"One","type":"movie"}]}"#,
                None,
            )]);
            let mut declared_extras = Vec::new();
            if let Some(required) = required {
                declared_extras.push(serde_json::json!({"name":"skip", "isRequired":required}));
            }
            if let Some(genre) = genre {
                declared_extras.push(
                    serde_json::json!({"name":"genre", "isRequired":true, "options":[genre]}),
                );
            }
            let addon = AddonConfig {
                url: server.url.clone(),
                capabilities: Some(
                    parse_addon_manifest(
                        serde_json::json!({
                            "name":"Catalog", "catalogs":[{
                                "type":media_type, "id":catalog_id, "extra":declared_extras
                            }]
                        })
                        .to_string()
                        .as_bytes(),
                    )
                    .unwrap(),
                ),
                ..test_addon("catalog", "Catalog")
            };
            let extras = crate::commands::search_commands::catalog_browse_extras(genre, 0);
            let targets = if media_type == "Podcast" {
                super::select_addon_catalog_targets(&[addon], &extras)
            } else {
                super::select_catalog_targets(
                    &[addon],
                    media_type,
                    &catalog_id.to_uppercase(),
                    &extras,
                )
            }
            .unwrap();
            let page = super::fetch_catalog_pages_for_target_groups(
                &AddonResourceClient::new(),
                vec![Ok((targets, extras))],
                None,
            )
            .await
            .remove(0)
            .unwrap();
            assert_eq!(page.items.len(), 1);
            let mut sent_extras = genre
                .map(|genre| format!("genre={genre}"))
                .into_iter()
                .collect::<Vec<_>>();
            if required == Some(true) {
                sent_extras.push("skip=0".into());
            }
            let suffix = if sent_extras.is_empty() {
                String::new()
            } else {
                format!("/{}", sent_extras.join("&"))
            };
            assert_eq!(
                server.finish(),
                [format!("/catalog/{media_type}/{catalog_id}{suffix}.json")]
            );
        }
    }
}

#[test]
fn search_merge_preserves_candidates_and_independent_offsets() {
    let primary = classified_cinemeta_addon();
    let mut secondary = primary.clone();
    secondary.id = "secondary".into();
    secondary.url = "https://secondary.example/manifest.json".into();
    let (work, sources) = select_search_catalog_work(
        &[primary, secondary],
        "dune",
        &["movie"],
        &[None],
        None,
        false,
    );
    assert_eq!(work.len(), 2);
    assert_ne!(work[0].addon_url, work[1].addon_url);
    let item = |id, type_, title: &str| {
        let mut item = test_media_item(id, type_);
        item.title = title.into();
        item
    };
    let page = merge_search_catalog_pages(
        sources,
        vec![vec![
            (
                0,
                Ok(catalog_page(
                    vec![
                        item("tt1", "movie", "Primary title"),
                        item(" TT1 ", "MOVIE", "Duplicate in primary"),
                    ],
                    2,
                )),
            ),
            (
                1,
                Ok(catalog_page(
                    vec![
                        item("TT1", "movie", "Secondary title"),
                        item("tt1", "series", "Primary title"),
                        item("tt2", "movie", "Primary title"),
                    ],
                    3,
                )),
            ),
        ]],
        true,
    )
    .unwrap();
    assert_eq!(
        page.items
            .iter()
            .map(|item| (item.id.as_str(), item.type_.as_str(), item.title.as_str()))
            .collect::<Vec<_>>(),
        [
            ("tt1", "movie", "Primary title"),
            ("TT1", "movie", "Secondary title"),
            (" TT1 ", "MOVIE", "Duplicate in primary"),
            ("tt1", "series", "Primary title"),
            ("tt2", "movie", "Primary title"),
        ]
    );
    assert_eq!(
        page.cursors
            .iter()
            .map(|cursor| cursor.skip)
            .collect::<Vec<_>>(),
        [2, 3]
    );
    assert!(!page.partial);
}

#[test]
fn search_sources_advance_independently_and_drop_exhausted_sources() {
    let mut addon = classified_cinemeta_addon();
    addon.capabilities = Some(
        parse_addon_manifest(
            br#"{
                "name": "Search catalogs",
                "resources": ["catalog"], "types": ["movie"],
                "catalogs": [
                    {"id": "single", "type": "movie", "extraSupported": ["search"]},
                    {"id": "paged", "type": "movie", "extra": [{"name": "search"}, {"name": "skip"}]},
                    {"id": "larger", "type": "movie", "extraSupported": ["search", "skip"]}
                ]
            }"#,
        )
        .unwrap(),
    );
    assert!(searchable_catalogs(&addon, "movie").eq([
        ("movie", "single", false),
        ("movie", "paged", true),
        ("movie", "larger", true)
    ]));
    let (work, sources) =
        select_search_catalog_work(&[addon.clone()], "dune", &["movie"], &[None], None, false);
    assert_eq!(work.len(), 3);
    assert!(work.iter().all(|item| extra_skip_value(&item.extras) == 0));
    let page = merge_search_catalog_pages(
        sources,
        vec![vec![
            (0, Ok(item_page("single", 1))),
            (1, Ok(catalog_page(vec![], 2))),
            (2, Ok(catalog_page(vec![], 4))),
        ]],
        true,
    )
    .unwrap();
    assert_eq!(
        page.cursors
            .iter()
            .map(|cursor| cursor.skip)
            .collect::<Vec<_>>(),
        [2, 4]
    );
    assert!(!page.partial);
    let mut added = addon.clone();
    added.url = "https://new.example/manifest.json".into();
    let snapshot = [added, addon];
    let (work, sources) = select_search_catalog_work(
        &snapshot,
        "dune",
        &["movie"],
        &[None],
        Some(&page.cursors),
        false,
    );
    assert_eq!(
        work.iter()
            .map(|item| item.catalog_id.as_str())
            .collect::<Vec<_>>(),
        ["paged", "larger"]
    );
    assert_eq!(
        work.iter()
            .map(|item| extra_skip_value(&item.extras))
            .collect::<Vec<_>>(),
        [2, 4]
    );
    assert!(work.iter().all(|item| item.addon_url == snapshot[1].url));
    let page = merge_search_catalog_pages(
        sources,
        vec![vec![
            (0, Ok(CatalogPage::default())),
            (1, Ok(item_page("next", 3))),
        ]],
        false,
    )
    .unwrap();
    assert_eq!(page.cursors.len(), 1);
    assert_eq!(page.cursors[0].skip, 7);
    let (work, sources) = select_search_catalog_work(
        &snapshot,
        "dune",
        &["movie"],
        &[None],
        Some(&page.cursors),
        false,
    );
    assert_eq!(work.len(), 1);
    assert_eq!(work[0].catalog_id, "larger");
    assert_eq!(extra_skip_value(&work[0].extras), 7);
    assert!(merge_search_catalog_pages(
        sources,
        vec![vec![(0, Ok(CatalogPage::default()))]],
        false
    )
    .unwrap()
    .cursors
    .is_empty());
}

#[test]
fn overlapping_search_sources_keep_their_later_unique_titles() {
    use crate::commands::search_commands::{finish_catalog_page, SearchCatalogContinuation};

    for primary_pages in [false, true] {
        let sources = |cursors: Option<Vec<SearchSourceCursor>>| {
            vec![cursors
                .unwrap_or_else(|| {
                    vec![
                        source_cursor("0123456789abcdef", 0),
                        source_cursor("1123456789abcdef", 0),
                    ]
                })
                .into_iter()
                .map(|cursor| SearchCatalogSource {
                    supports_skip: cursor.key != "0123456789abcdef" || primary_pages,
                    cursor,
                })
                .collect()]
        };
        let shared = || item_page("shared", 1);
        let merged = merge_search_catalog_pages(
            sources(None),
            vec![vec![(0, Ok(shared())), (1, Ok(shared()))]],
            true,
        )
        .unwrap();
        let first = finish_catalog_page(
            merged.items,
            SearchCatalogContinuation::default(),
            None,
            None,
            Some(merged.cursors),
            Default::default(),
        );
        assert_eq!(first.items.len(), 1);
        let continuation = serde_json::to_value(&first.continuation).unwrap();
        let cursors: Vec<SearchSourceCursor> =
            serde_json::from_value(continuation["searchCursors"].clone()).unwrap();
        assert_eq!(cursors.len(), if primary_pages { 2 } else { 1 });
        let outcomes = cursors
            .iter()
            .enumerate()
            .map(|(index, cursor)| {
                (
                    index,
                    Ok(if cursor.key == "0123456789abcdef" {
                        shared()
                    } else {
                        item_page("later-unique", 1)
                    }),
                )
            })
            .collect();
        let merged =
            merge_search_catalog_pages(sources(Some(cursors)), vec![outcomes], false).unwrap();
        let next = finish_catalog_page(
            merged.items,
            first.continuation,
            None,
            None,
            Some(merged.cursors),
            Default::default(),
        );
        assert_eq!(
            next.items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["later-unique"]
        );
        let wire = serde_json::to_value(&next).unwrap();
        assert_eq!(
            wire["continuation"]["searchCursors"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            wire["continuation"]["searchCursors"][0]["key"],
            "1123456789abcdef"
        );
    }
}

#[test]
fn all_search_sources_survive_overlap_but_stop_replayed_pages() {
    use crate::commands::search_commands::{finish_catalog_page, SearchCatalogContinuation};

    let mut continuation = SearchCatalogContinuation::default();
    for round in 0..2 {
        let sources = (0..6)
            .map(|group| {
                (0..8)
                    .map(|order| search_source(&format!("{:016x}", group * 8 + order), round))
                    .collect()
            })
            .collect();
        let outcomes = (0..6)
            .map(|_| {
                (0..8)
                    .map(|order| (order, Ok(item_page("shared", 1))))
                    .collect()
            })
            .collect();
        let merged = merge_search_catalog_pages(sources, outcomes, round == 0).unwrap();
        let page = finish_catalog_page(
            merged.items,
            continuation,
            None,
            None,
            Some(merged.cursors),
            Default::default(),
        );
        let wire = serde_json::to_value(&page).unwrap();
        assert_eq!(page.items.len(), if round == 0 { 1 } else { 0 });
        assert_eq!(page.exhausted, round != 0);
        assert_eq!(
            wire["continuation"]["searchCursors"]
                .as_array()
                .unwrap()
                .len(),
            if round == 0 { 48 } else { 0 }
        );
        continuation = page.continuation;
    }
}

#[test]
fn search_failures_retry_once_reset_after_success_and_bound_stragglers() {
    let sources = |cursors: Vec<SearchSourceCursor>| {
        vec![cursors
            .into_iter()
            .map(|cursor| SearchCatalogSource {
                cursor,
                supports_skip: true,
            })
            .collect()]
    };
    let page = merge_search_catalog_pages(
        sources(vec![source_cursor("0123456789abcdef", 50)]),
        vec![vec![(0, Err("offline".into()))]],
        false,
    )
    .unwrap();
    assert!(page.items.is_empty());
    assert_eq!(page.cursors[0].skip, 50);
    assert!(page.cursors[0].retry);
    assert!(!page.partial);
    let page = merge_search_catalog_pages(
        sources(page.cursors),
        vec![vec![(0, Ok(catalog_page(vec![], 3)))]],
        false,
    )
    .unwrap();
    assert_eq!(page.cursors[0].skip, 53);
    assert!(!page.cursors[0].retry);
    assert!(!page.partial);
    let page = merge_search_catalog_pages(sources(page.cursors), vec![vec![]], false).unwrap();
    assert!(page.cursors[0].retry);
    assert!(!page.partial);
    let page = merge_search_catalog_pages(
        sources(page.cursors),
        vec![vec![(0, Err("still offline".into()))]],
        false,
    )
    .unwrap();
    assert!(page.cursors.is_empty());
    assert!(page.partial);
    assert!(merge_search_catalog_pages(vec![], vec![], false)
        .unwrap()
        .cursors
        .is_empty());
    assert!(merge_search_catalog_pages(vec![], vec![], true).is_err());
    let page = merge_search_catalog_pages(
        sources(vec![source_cursor("0123456789abcdef", u32::MAX)]),
        vec![vec![(0, Ok(catalog_page(vec![], 3)))]],
        false,
    )
    .unwrap();
    assert!(page.cursors.is_empty());
}

#[test]
fn catalog_page_next_skip_continues_on_any_non_empty_page() {
    // Live Cinemeta series `top` page 1 is full with `hasMore: false`
    // while `skip=100` still returns titles: only an empty page ends
    // pagination, never the `hasMore` hint.
    for (skip, count, expected) in [
        (0, 50, Some(50)),
        (50, 50, Some(100)),
        (0, 24, Some(24)),
        (0, 49, Some(49)),
        (0, 0, None),
        (100, 0, None),
    ] {
        assert_eq!(catalog_page_next_skip(skip, count), expected);
    }
}

#[test]
fn catalog_cursor_counts_source_entries_before_cards_are_dropped() {
    let page = catalog_fetch_page_from_source(item_page("tt1", 3), 50);
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.next_skip, Some(53));

    let rejected_page = catalog_fetch_page_from_source(catalog_page(vec![], 3), 50);
    assert_eq!(rejected_page.next_skip, Some(53));
    assert_eq!(
        catalog_fetch_page_from_source(CatalogPage::default(), 50).next_skip,
        None
    );
}

#[test]
fn extra_skip_value_reads_the_declared_skip_extra() {
    for (extras, expected) in [
        (vec![], 0),
        (vec![extra("genre", "Animation")], 0),
        (vec![extra("genre", "Animation"), extra("skip", "50")], 50),
    ] {
        assert_eq!(extra_skip_value(&extras), expected);
    }
}

#[test]
fn catalog_merge_preserves_candidates_and_the_earliest_next_skip() {
    let page = merge_catalog_pages(
        vec![
            Ok(CatalogFetchPage {
                items: vec![
                    test_media_item("tt1", "series"),
                    test_media_item("tt2", "series"),
                ],
                partial: false,
                next_skip: Some(50),
            }),
            Err("offline addon".to_string()),
            Ok(CatalogFetchPage {
                items: vec![
                    test_media_item("tt2", "series"),
                    test_media_item("tt3", "series"),
                ],
                partial: false,
                next_skip: Some(24),
            }),
        ],
        "Failed to load catalog.",
    )
    .expect("partial success");

    assert_eq!(
        page.items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        vec!["tt1", "tt2", "tt2", "tt3"]
    );
    assert_eq!(page.next_skip, Some(24));
}

#[test]
fn empty_search_pages_preserve_constituent_failures_for_retry() {
    let sources = || {
        vec![(0..2)
            .map(|index| search_source(&format!("{index:016x}"), 0))
            .collect()]
    };
    for failure_first in [false, true] {
        let mut pages = vec![
            Ok(CatalogPage::default()),
            Err("movie search unavailable".to_string()),
        ];
        if failure_first {
            pages.reverse();
        }
        assert_eq!(
            merge_search_catalog_pages(
                sources(),
                vec![pages.into_iter().enumerate().collect()],
                true
            )
            .unwrap_err(),
            "movie search unavailable"
        );
    }
    let page = merge_search_catalog_pages(
        sources(),
        vec![vec![
            (0, Ok(CatalogPage::default())),
            (1, Ok(CatalogPage::default())),
        ]],
        true,
    )
    .expect("all-success empty search");
    assert!(page.items.is_empty());
    assert!(page.cursors.is_empty());
    assert!(!page.partial);
    let mut sources = sources();
    sources[0][1].supports_skip = false;
    let page = merge_search_catalog_pages(
        sources,
        vec![vec![
            (0, Ok(item_page("available", 1))),
            (1, Err("single-page source offline".into())),
        ]],
        true,
    )
    .unwrap();
    assert!(!page.partial);
    assert_eq!(page.cursors.len(), 2);
    assert_eq!(page.cursors[1].skip, 0);
    assert!(page.cursors[1].retry);
}

#[test]
fn classified_catalog_allows_skip_and_animation_genre() {
    let addon = classified_cinemeta_addon();
    let extras = [extra("genre", "Animation"), extra("skip", "50")];
    assert!(addon_allows_catalog(&addon, "movie", "top", &extras));
    assert!(addon_allows_catalog(&addon, "movie", "imdbRating", &extras));
}

/// Mixed-type catalog addon: a required-`search` Podcast catalog, a required-
/// `genre` Podcast catalog with closed options, a `tv` channel, and Cinemeta's
/// usual movie catalog.
fn mixed_catalog_addon() -> AddonConfig {
    AddonConfig {
        capabilities: Some(
            parse_addon_manifest(
                br#"{
                    "name": "Mixed",
                    "resources": ["catalog"],
                    "types": ["movie", "Podcast", "tv"],
                    "catalogs": [
                        {"id": "top", "type": "movie"},
                        {
                            "id": "podcast",
                            "type": "Podcast",
                            "extra": [
                                {"name": "genre", "isRequired": true, "options": ["All", "Tech", "Science"]},
                                {"name": "skip"}
                            ]
                        },
                        {
                            "id": "podcast-search",
                            "type": "Podcast",
                            "extra": [
                                {"name": "search", "isRequired": true},
                                {"name": "genre", "options": ["Tech"]}
                            ]
                        },
                        {"id": "channel", "type": "tv", "extra": [{"name": "genre", "options": ["News"]}]}
                    ]
                }"#,
            )
            .unwrap(),
        ),
        ..test_addon("mixed", "Mixed")
    }
}

#[test]
fn addon_targets_select_custom_catalogs_accepting_the_sent_genre() {
    let addons = [mixed_catalog_addon()];
    let extras = |genre: &str| {
        vec![CatalogExtra {
            name: "genre".to_string(),
            value: genre.to_string(),
        }]
    };
    let ids = |extras: &[CatalogExtra]| {
        super::select_addon_catalog_targets(&addons, extras)
            .unwrap()
            .into_iter()
            .map(|target| (target.catalog_id, target.media_type))
            .collect::<Vec<_>>()
    };

    // `podcast-search` always needs `search`; `channel` rejects "Tech".
    assert_eq!(
        ids(&extras("tech")),
        [("podcast".to_string(), "Podcast".to_string())]
    );
    assert_eq!(
        ids(&extras("News")),
        [("channel".to_string(), "tv".to_string())]
    );
    // No custom catalog accepts "Drama"; movie/series catalogs never qualify.
    assert!(super::select_addon_catalog_targets(&addons, &extras("Drama")).is_err());
    assert!(super::select_addon_catalog_targets(&addons, &[]).is_err());
}

#[test]
fn all_search_expands_to_addon_declared_search_types() {
    let addon = mixed_catalog_addon();
    // Fixed types alone never reach the Podcast search catalog.
    let (work, _) = select_search_catalog_work(
        std::slice::from_ref(&addon),
        "dune",
        &["movie", "series"],
        &[None],
        None,
        false,
    );
    assert!(work.is_empty());

    // All-tab search adds the addon's own search-capable types.
    let (work, _) =
        select_search_catalog_work(&[addon], "dune", &["movie", "series"], &[None], None, true);
    assert_eq!(work.len(), 1);
    assert_eq!(work[0].media_type, "Podcast");
    assert_eq!(work[0].catalog_id, "podcast-search");
    assert_eq!(
        work[0]
            .extras
            .iter()
            .map(|extra| (extra.name.as_str(), extra.value.as_str()))
            .collect::<Vec<_>>(),
        [("search", "dune")]
    );

    // Unclassified addons keep only the fixed types — no per-type `top` fan-out.
    let (work, _) = select_search_catalog_work(
        &[cinemeta_addon()],
        "dune",
        &["movie", "series"],
        &[None],
        None,
        true,
    );
    assert_eq!(work.len(), 2);
    assert!(work.iter().all(|item| item.catalog_id == "top"));
}

#[test]
fn catalog_targets_stamp_the_sent_genre_only_when_the_options_accept_it() {
    let genre = |value: &str| CatalogExtra {
        name: "genre".to_string(),
        value: value.to_string(),
    };

    let addons = [mixed_catalog_addon()];
    let stamped = super::select_addon_catalog_targets(&addons, &[genre("tech")]).unwrap();
    assert_eq!(stamped[0].catalog_id, "podcast");
    assert_eq!(stamped[0].media_type, "Podcast");
    assert_eq!(stamped[0].catalog_genre.as_deref(), Some("Tech"));

    // Typed path: a closed options list rejecting the sent genre stamps nothing.
    let cinemeta = [classified_cinemeta_addon()];
    let rejected =
        super::select_catalog_targets(&cinemeta, "movie", "top", &[genre("Tech")]).unwrap();
    assert_eq!(rejected[0].catalog_genre, None);
    // ...while a free-form `genre` extra stamps whatever was sent.
    let free_form =
        super::select_catalog_targets(&cinemeta, "movie", "imdbRating", &[genre("Tech")]).unwrap();
    assert_eq!(free_form[0].catalog_genre.as_deref(), Some("Tech"));
    // An accepted option uses the manifest's spelling.
    let matched =
        super::select_catalog_targets(&cinemeta, "movie", "top", &[genre("animation")]).unwrap();
    assert_eq!(matched[0].catalog_genre.as_deref(), Some("Animation"));
}

fn sub_addon(url: &str) -> AddonConfig {
    AddonConfig {
        url: url.into(),
        ..subtitle_addon()
    }
}

fn subtitle_addon() -> AddonConfig {
    AddonConfig {
        url: "https://subtitles-addon.test".to_string(),
        capabilities: Some(
            parse_addon_manifest(
                br#"{
                        "name": "Subtitles Addon",
                        "resources": ["subtitles"],
                        "types": ["movie", "series"],
                        "idPrefixes": ["tt"]
                    }"#,
            )
            .expect("snapshot"),
        ),
        ..test_addon("https://subtitles-addon.test", "Subtitles Addon")
    }
}

#[tokio::test]
async fn empty_subtitle_sources_do_not_cancel_the_first_usable_answer() {
    use std::io::{Read, Write};

    let empty = TestHttpServer::new(vec![(200, r#"{"subtitles":[]}"#, None)]);
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut connection, _) = listener.accept().unwrap();
        connection
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut request = Vec::new();
        let mut buffer = [0; 2048];
        while !request.ends_with(b"\r\n\r\n") {
            let count = connection.read(&mut buffer).unwrap();
            assert!(count > 0);
            request.extend_from_slice(&buffer[..count]);
        }
        std::thread::sleep(Duration::from_millis(80));
        let body =
            r#"{"subtitles":[{"id":"found","url":"https://subs.test/found.srt","lang":"eng"}]}"#;
        let _ = write!(
            connection,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
    });
    let addons = [
        sub_addon(&empty.url),
        AddonConfig {
            id: "slow".into(),
            ..sub_addon(&url)
        },
    ];
    let result = super::fetch_subtitles_from_addons(
        &AddonResourceClient::new(),
        &addons,
        "movie",
        &["tt1".into()],
        Duration::from_millis(10),
    )
    .await
    .unwrap();
    server.join().unwrap();
    assert_eq!(empty.finish(), ["/subtitles/movie/tt1.json"]);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].source_id, "slow");

    let ready = TestHttpServer::new(vec![(
        200,
        r#"{"subtitles":[{"id":"found","url":"https://subs.test/found.srt"}]}"#,
        None,
    )]);
    let (_stalled, stalled_url) = stalled_listener();
    let addons = [sub_addon(&ready.url), sub_addon(&stalled_url)];
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        super::fetch_subtitles_from_addons(
            &AddonResourceClient::new(),
            &addons,
            "movie",
            &["tt1".into()],
            Duration::from_millis(10),
        ),
    )
    .await
    .expect("a usable answer must still bound a stalled source")
    .unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(ready.finish(), ["/subtitles/movie/tt1.json"]);
}

#[tokio::test]
async fn capability_gaps_are_tagged_and_other_failures_are_not() {
    let subtitles_only = [subtitle_addon()];
    let client = AddonResourceClient::new();
    let gaps = [
        super::select_catalog_targets(&subtitles_only, "movie", "top", &[])
            .map(|_| ())
            .unwrap_err(),
        super::fetch_meta_details_from_addons(&client, &subtitles_only, "movie", "tt1", None)
            .await
            .map(|_| ())
            .unwrap_err(),
    ];
    for message in gaps {
        assert!(message.ends_with("in Settings → Addons."), "{message}");
        assert!(!message.contains("://"), "{message}");
        let value = serde_json::to_value(AddonResourceError::from(message.clone())).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"kind": "no_capable_addon", "message": message})
        );
    }
    for message in [
        "Configured addon returned HTTP 500. Check the addon URL in Settings → Addons.",
        "Metadata not found.",
    ] {
        assert_eq!(
            AddonResourceError::from(message.to_string()).kind,
            AddonResourceErrorKind::Failed
        );
    }
}
fn allows_subtitles(addon: &AddonConfig, type_: &str, id: &str) -> bool {
    addon_allows_resource(addon, "subtitles", type_, id)
}

#[test]
fn subtitle_routing_follows_declared_resource_type_and_prefix() {
    let addon = subtitle_addon();
    for (type_, id, expected) in [
        ("movie", "tt1234567", true),
        ("series", "tt1234567:1:2", true),
        ("movie", "kitsu:42", false),
        ("anime", "tt1234567:1:2", false),
    ] {
        assert_eq!(
            allows_subtitles(&addon, type_, id),
            expected,
            "{type_} {id}"
        );
    }

    let catalog_only = classified_cinemeta_addon();
    assert!(!allows_subtitles(&catalog_only, "movie", "tt1234567"));

    let unclassified = AddonConfig {
        capabilities: None,
        ..addon
    };
    assert!(allows_subtitles(&unclassified, "movie", "tt1234567"));
}

#[tokio::test]
async fn anime_subtitles_use_each_addons_declared_type_and_prefix() {
    let body = r#"{"subtitles":[{"id":"sub","url":"https://subs.test/sub.srt","lang":"eng"}]}"#;
    let anime = TestHttpServer::new(vec![(200, body, None)]);
    let series = TestHttpServer::new(vec![(200, body, None)]);
    let addon = |url: &str, id: &str, manifest| AddonConfig {
        capabilities: Some(parse_addon_manifest(manifest).unwrap()),
        ..addon_at(url, id, id)
    };
    let addons = [
        addon(&anime.url, "anime", br#"{"name":"Anime","resources":[{"name":"subtitles","types":["Anime"],"idPrefixes":["kitsu:"]}]}"#),
        addon(&series.url, "series", br#"{"name":"Series","resources":[{"name":"subtitles","types":["series"],"idPrefixes":["tt"]}]}"#),
    ];
    let result = super::fetch_subtitles_from_addons(
        &AddonResourceClient::new(),
        &addons,
        "anime",
        &["tt1:2:3".into(), "kitsu:42:3".into()],
        Duration::from_secs(2),
    )
    .await
    .unwrap();
    assert_eq!(
        result
            .iter()
            .map(|item| item.source_id.as_str())
            .collect::<Vec<_>>(),
        ["anime", "series"]
    );
    assert_eq!(anime.finish(), ["/subtitles/Anime/kitsu%3A42%3A3.json"]);
    assert_eq!(series.finish(), ["/subtitles/series/tt1%3A2%3A3.json"]);
}

#[tokio::test]
async fn subtitle_queries_fall_back_in_order_and_cache_each_requested_id() {
    let server = TestHttpServer::new(vec![
        (200, r#"{"subtitles":[]}"#, None),
        (
            200,
            r#"{"subtitles":[{"id":"flat","url":"https://subs.test/flat.srt","lang":"eng"}]}"#,
            None,
        ),
    ]);
    let addon = AddonConfig {
        capabilities: None,
        ..sub_addon(&server.url)
    };
    let client = AddonResourceClient::new();
    let ids = vec!["kitsu:48316:1:2".to_string(), "kitsu:48316:2".to_string()];
    for _ in 0..2 {
        let result = fetch_subtitles_for_addon(&client, "series", &ids, &addon)
            .await
            .unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "flat");
    }
    assert!(client
        .fetch_subtitles(&addon.url, "series", &ids[0])
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        client
            .fetch_subtitles(&addon.url, "series", &ids[1])
            .await
            .unwrap()[0]
            .id,
        "flat"
    );
    assert_eq!(
        server.finish(),
        [
            "/subtitles/series/kitsu%3A48316%3A1%3A2.json",
            "/subtitles/series/kitsu%3A48316%3A2.json",
        ]
    );
}

#[tokio::test]
async fn subtitle_queries_stop_at_first_nonempty_candidate_and_preserve_partial_success() {
    let empty = r#"{"subtitles":[]}"#;
    let found =
        r#"{"subtitles":[{"id":"found","url":"https://subs.test/found.srt","lang":"eng"}]}"#;
    for (responses, count, result_count, fails) in [
        (vec![(200, found), (200, found)], 1, 1, false),
        (vec![(404, "{}"), (200, found)], 2, 1, false),
        (vec![(200, empty), (404, "{}")], 2, 0, false),
        (vec![(404, "{}"), (200, empty)], 2, 0, false),
        (vec![(200, empty), (200, empty)], 2, 0, false),
        (vec![(404, "{}"), (404, "{}")], 2, 0, true),
    ] {
        let server = TestHttpServer::new(
            responses
                .into_iter()
                .map(|(status, body)| (status, body, None))
                .collect(),
        );
        let addon = AddonConfig {
            capabilities: None,
            ..sub_addon(&server.url)
        };
        let ids = vec!["kitsu:48316:1:2".to_string(), "kitsu:48316:2".to_string()];
        let result =
            fetch_subtitles_for_addon(&AddonResourceClient::new(), "series", &ids, &addon).await;
        assert_eq!(server.finish().len(), count);
        assert_eq!(result.is_err(), fails);
        if !fails {
            assert_eq!(result.unwrap().len(), result_count);
        }
    }
}

#[tokio::test]
async fn subtitle_queries_apply_resource_type_and_prefix_gates_to_each_candidate() {
    let server = TestHttpServer::new(vec![(
        200,
        r#"{"subtitles":[{"id":"flat","url":"https://subs.test/flat.srt"}]}"#,
        None,
    )]);
    let addon = AddonConfig {
        capabilities: Some(
            parse_addon_manifest(
                br#"{
                    "name":"Flat Subtitles",
                    "resources":[{"name":"subtitles","types":["series"],"idPrefixes":["kitsu:48316:2"]}],
                    "types":["movie","series"],
                    "idPrefixes":["tt"]
                }"#,
            )
            .unwrap(),
        ),
        ..sub_addon(&server.url)
    };
    let client = AddonResourceClient::new();
    let ids = vec!["kitsu:48316:1:2".to_string(), "kitsu:48316:2".to_string()];
    assert!(!allows_subtitles(&addon, "series", &ids[0]));
    assert!(allows_subtitles(&addon, "series", &ids[1]));
    assert!(fetch_subtitles_for_addon(&client, "movie", &ids, &addon)
        .await
        .unwrap()
        .is_empty());
    assert!(
        fetch_subtitles_for_addon(&client, "series", &ids, &classified_cinemeta_addon())
            .await
            .unwrap()
            .is_empty()
    );
    let result = fetch_subtitles_for_addon(&client, "series", &ids, &addon)
        .await
        .unwrap();
    assert_eq!(result[0].id, "flat");
    assert_eq!(
        server.finish(),
        ["/subtitles/series/kitsu%3A48316%3A2.json"]
    );
}

#[test]
fn subtitle_merge_dedupes_by_source_identity() {
    let addon = subtitle_addon();
    let mut subtitles: Vec<SourcedAddonSubtitle> = Vec::new();
    let mut seen = HashSet::new();
    let item = AddonSubtitle {
        id: "sub-1".to_string(),
        url: "https://subtitles-addon.test/subs/en.srt".to_string(),
        lang: Some("eng".to_string()),
        label: None,
    };

    add_subtitle_if_unique(&mut subtitles, &mut seen, &addon, &item);
    add_subtitle_if_unique(&mut subtitles, &mut seen, &addon, &item);
    assert_eq!(subtitles.len(), 1);
    assert_eq!(subtitles[0].source_id, addon.id);
    assert_eq!(subtitles[0].source_name, addon.name);
    assert_eq!(subtitles[0].lang.as_deref(), Some("eng"));
    assert_eq!(
        serde_json::to_value(&subtitles[0]).unwrap()["selectionKey"],
        r#"["https://subtitles-addon.test","sub-1","https://subtitles-addon.test/subs/en.srt","eng"]"#
    );
}

fn sourced_subtitle(id: &str, label: Option<&str>) -> SourcedAddonSubtitle {
    let item = AddonSubtitle {
        id: id.to_string(),
        url: "https://subtitles-addon.test/subs/en.srt".to_string(),
        lang: None,
        label: label.map(str::to_string),
    };
    let mut subtitles = Vec::new();
    add_subtitle_if_unique(
        &mut subtitles,
        &mut HashSet::new(),
        &subtitle_addon(),
        &item,
    );
    subtitles.pop().unwrap()
}

#[test]
fn subtitle_mpv_title_uses_js_trimmed_label_or_original_id() {
    for (label, expected) in [
        (None, " sub-1 "),
        (Some(""), " sub-1 "),
        (Some("\u{feff} \t\n\u{a0}"), " sub-1 "),
        (Some("\u{feff}  English \t"), "English"),
        (Some("\u{85}English\u{85}"), "\u{85}English\u{85}"),
    ] {
        assert_eq!(
            serde_json::to_value(sourced_subtitle(" sub-1 ", label)).unwrap()["mpvTitle"],
            expected,
            "{label:?}"
        );
    }
}

#[test]
fn subtitle_detail_strips_extensions_and_preserves_release_separators() {
    for (label, expected) in [
        (
            Some(" \u{feff} Release..__Name.SrT \t"),
            Some("Release..__Name"),
        ),
        (Some("Release.AsS"), Some("Release")),
        (Some("Release.SsA"), Some("Release")),
        (Some("Release.VtT"), Some("Release")),
        (Some("Release.SuB"), Some("Release")),
        (Some("Release.IdX"), Some("Release")),
        (Some("Release.SmI"), Some("Release")),
        (Some("Release.TxT"), Some("Release")),
        (Some(" Release \u{a0}.srt "), Some("Release")),
        (
            Some(" Name_without_extension "),
            Some("Name_without_extension"),
        ),
        (Some("Release.srt.zip"), Some("Release.srt.zip")),
        (Some("Release.srt.srt"), Some("Release.srt")),
        (Some("Release.\u{17f}rt"), Some("Release.\u{17f}rt")),
        (
            Some("\u{85}Release.srt\u{85}"),
            Some("\u{85}Release.srt\u{85}"),
        ),
        (Some("\u{feff} \t\n\u{a0}"), None),
        (Some(" .srt "), None),
        (Some(""), None),
        (None, None),
    ] {
        let subtitle = sourced_subtitle("sub-1", label);
        assert_eq!(subtitle.detail.as_deref(), expected, "{label:?}");
        assert_eq!(subtitle.label.as_deref(), label);
        let serialized = serde_json::to_value(&subtitle).unwrap();
        assert_eq!(
            serialized.get("detail").and_then(serde_json::Value::as_str),
            expected
        );
        assert_eq!(serialized.get("detail").is_none(), expected.is_none());
    }
}

#[test]
fn subtitle_merge_preserves_delimiter_containing_identities() {
    let identities = [("source|variant", "entry"), ("source", "variant|entry")];
    let addons = resolve_addon_configs(Some(
        identities
            .iter()
            .enumerate()
            .map(|(index, (source_id, _))| AddonConfig {
                id: (*source_id).to_string(),
                ..sub_addon(&format!("https://subtitles-addon.test/{index}"))
            })
            .collect(),
    ));
    let mut subtitles = Vec::new();
    let mut seen = HashSet::new();
    for (source_id, subtitle_id) in identities {
        let addon = addons.iter().find(|addon| addon.id == source_id).unwrap();
        add_subtitle_if_unique(
            &mut subtitles,
            &mut seen,
            addon,
            &AddonSubtitle {
                id: subtitle_id.to_string(),
                url: "https://subtitles-addon.test/file.srt".to_string(),
                lang: Some("eng".to_string()),
                label: None,
            },
        );
    }
    assert_eq!(subtitles.len(), 2);
    assert_eq!(
        subtitles[0].selection_key,
        r#"["source|variant","entry","https://subtitles-addon.test/file.srt","eng"]"#
    );
    assert_eq!(
        subtitles[1].selection_key,
        r#"["source","variant|entry","https://subtitles-addon.test/file.srt","eng"]"#
    );
}

#[test]
fn subtitle_merge_keeps_language_variants_of_same_url() {
    let addon = subtitle_addon();
    let mut subtitles: Vec<SourcedAddonSubtitle> = Vec::new();
    let mut seen = HashSet::new();
    let subtitle = |lang: &str| AddonSubtitle {
        id: "sub-1".to_string(),
        url: "https://subtitles-addon.test/subs/multi.srt".to_string(),
        lang: Some(lang.to_string()),
        label: None,
    };

    add_subtitle_if_unique(&mut subtitles, &mut seen, &addon, &subtitle("eng"));
    add_subtitle_if_unique(&mut subtitles, &mut seen, &addon, &subtitle("English"));
    // Same language in different case is still the same variant.
    add_subtitle_if_unique(&mut subtitles, &mut seen, &addon, &subtitle(" ENG "));
    assert_eq!(subtitles.len(), 2);
}
