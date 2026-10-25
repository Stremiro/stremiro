use super::{
    add_subtitle_if_unique, addon_allows_catalog, addon_allows_resource,
    catalog_fetch_page_from_source, catalog_page_next_skip, catalog_search_extras,
    collect_catalog_outcomes, collect_with_deadline, extra_skip_value, fetch_subtitles_for_addon,
    merge_catalog_pages, merge_search_catalog_pages, run_catalog_work_pool, searchable_catalog_ids,
    select_search_catalog_work, AddonResourceError, AddonResourceErrorKind, CatalogFetchPage,
    CatalogWorkItem, SearchCatalogSource, SearchSourceCursor, SourcedAddonSubtitle,
    CATALOG_STRAGGLER_GRACE,
};
use crate::commands::config_store::{resolve_addon_configs, AddonConfig};
use crate::providers::addon_manifest::parse_addon_manifest;
use crate::providers::addon_resource::{
    AddonResourceClient, AddonSubtitle, CatalogExtra, CatalogPage,
};
use crate::test_helpers::{
    cinemeta_addon, classified_cinemeta_addon, test_media_item, TestHttpServer,
};
use futures_util::StreamExt;
use std::collections::HashSet;
use std::time::Duration;

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

    let stalled = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let server = TestHttpServer::new(vec![(
        200,
        r#"{"meta":{"id":"tt1","name":"Fallback","type":"movie"}}"#,
        None,
    )]);
    let addons = [
        AddonConfig {
            id: "primary".into(),
            url: format!("http://{}", stalled.local_addr().unwrap()),
            name: "Primary".into(),
            enabled: true,
            capabilities: None,
        },
        AddonConfig {
            id: "fallback".into(),
            url: server.url.clone(),
            name: "Fallback".into(),
            enabled: true,
            capabilities: None,
        },
    ];
    let client = AddonResourceClient::new();
    for attempt in 0..2 {
        let started = std::time::Instant::now();
        let details = super::fetch_meta_details_from_addons(&client, &addons, "movie", "tt1")
            .await
            .unwrap();
        let elapsed = started.elapsed();
        eprintln!("metadata stalled primary attempt {attempt}: {elapsed:?}");
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
        super::fetch_meta_details_from_addons(&client, &cached_primary, "movie", "tt1")
            .await
            .unwrap()
            .title,
        "Fallback"
    );
    assert!(started.elapsed() < super::META_HEDGE_DELAY);
    assert_eq!(server.finish(), ["/meta/movie/tt1.json"]);
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
                })
            })
            .rev()
            .collect()
    };
    let client = AddonResourceClient::new();
    let stalled = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    stalled.set_nonblocking(true).unwrap();
    let stalled_url = format!("http://{}", stalled.local_addr().unwrap());
    {
        let pending = run_catalog_work_pool(&client, work(&vec![stalled_url; 4]), 3);
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
    let groups = run_catalog_work_pool(&client, work(&urls), 3).await;
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
    let page = || CatalogPage {
        items: vec![test_media_item("tt1", "movie")],
        source_item_count: 1,
    };
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
        collect_catalog_outcomes(outcomes, vec![3, 1, 1], Duration::from_millis(10)),
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
                (0, order, Ok(page()))
            })
            .buffer_unordered(2);
        let started = tokio::time::Instant::now();
        let collected = collect_catalog_outcomes(outcomes, vec![2], grace).await;
        let elapsed = started.elapsed();
        eprintln!(
            "catalog grace {grace:?}: {elapsed:?}, {} outcomes",
            collected.len()
        );
        assert_eq!(collected.len(), expected_count);
        assert!(elapsed >= grace.min(Duration::from_secs(5)));
        if expected_count == 1 {
            assert!(elapsed < Duration::from_secs(5));
            let page = merge_search_catalog_pages(
                vec![vec![
                    SearchCatalogSource {
                        cursor: SearchSourceCursor {
                            key: "primary".into(),
                            skip: 50,
                            retry: false,
                        },
                        supports_skip: true,
                    },
                    SearchCatalogSource {
                        cursor: SearchSourceCursor {
                            key: "straggler".into(),
                            skip: 50,
                            retry: false,
                        },
                        supports_skip: true,
                    },
                ]],
                vec![collected
                    .into_iter()
                    .map(|(_, order, result)| (order, result))
                    .collect()],
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

#[test]
fn classified_search_uses_only_declared_search_catalogs() {
    let addon = classified_cinemeta_addon();
    assert_eq!(searchable_catalog_ids(&addon, "movie"), vec![("top", true)]);
    assert!(searchable_catalog_ids(&addon, "series").is_empty());

    let search = [CatalogExtra {
        name: "search".to_string(),
        value: "dune".to_string(),
    }];
    assert!(addon_allows_catalog(&addon, "movie", "top", &search));
    assert!(addon_allows_catalog(
        &addon,
        "movie",
        "top",
        &[
            CatalogExtra {
                name: "search".to_string(),
                value: "dune".to_string(),
            },
            CatalogExtra {
                name: "genre".to_string(),
                value: "Animation".to_string(),
            },
        ]
    ));
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
    let extras = [CatalogExtra {
        name: "search".to_string(),
        value: "dune".to_string(),
    }];
    assert!(addon_allows_catalog(&addon, "movie", "top", &extras));
    assert_eq!(
        searchable_catalog_ids(&addon, "movie"),
        vec![("top", false)]
    );
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
fn search_merges_addon_duplicates_by_identity_without_merging_titles_or_types() {
    let primary = classified_cinemeta_addon();
    let mut secondary = primary.clone();
    secondary.id = "secondary".into();
    secondary.url = "https://secondary.example/manifest.json".into();
    let (work, sources) =
        select_search_catalog_work(&[primary, secondary], "dune", &["movie"], &[None], None);
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
                Ok(CatalogPage {
                    items: vec![
                        item("tt1", "movie", "Primary title"),
                        item(" TT1 ", "MOVIE", "Duplicate in primary"),
                    ],
                    source_item_count: 2,
                }),
            ),
            (
                1,
                Ok(CatalogPage {
                    items: vec![
                        item("TT1", "movie", "Secondary title"),
                        item("tt1", "series", "Primary title"),
                        item("tt2", "movie", "Primary title"),
                    ],
                    source_item_count: 3,
                }),
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
            ("tt1", "series", "Primary title"),
            ("tt2", "movie", "Primary title"),
        ]
    );
    assert_eq!(page.claims.len(), 3);
    assert_eq!(page.claims["movie:tt1"], Some(0));
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
    assert_eq!(
        searchable_catalog_ids(&addon, "movie"),
        [("single", false), ("paged", true), ("larger", true)]
    );
    let (work, sources) =
        select_search_catalog_work(&[addon.clone()], "dune", &["movie"], &[None], None);
    assert_eq!(work.len(), 3);
    assert!(work.iter().all(|item| extra_skip_value(&item.extras) == 0));
    let page = merge_search_catalog_pages(
        sources,
        vec![vec![
            (
                0,
                Ok(CatalogPage {
                    items: vec![test_media_item("single", "movie")],
                    source_item_count: 1,
                }),
            ),
            (
                1,
                Ok(CatalogPage {
                    items: vec![],
                    source_item_count: 2,
                }),
            ),
            (
                2,
                Ok(CatalogPage {
                    items: vec![],
                    source_item_count: 4,
                }),
            ),
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
    assert_eq!(page.claims.get("movie:single"), Some(&None));
    assert!(!page.partial);
    let mut added = addon.clone();
    added.url = "https://new.example/manifest.json".into();
    let snapshot = [added, addon];
    let (work, sources) =
        select_search_catalog_work(&snapshot, "dune", &["movie"], &[None], Some(&page.cursors));
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
            (
                1,
                Ok(CatalogPage {
                    items: vec![test_media_item("next", "movie")],
                    source_item_count: 3,
                }),
            ),
        ]],
        false,
    )
    .unwrap();
    assert_eq!(page.cursors.len(), 1);
    assert_eq!(page.cursors[0].skip, 7);
    assert_eq!(page.claims.get("movie:next"), Some(&Some(0)));
    let (work, sources) =
        select_search_catalog_work(&snapshot, "dune", &["movie"], &[None], Some(&page.cursors));
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
        sources(vec![SearchSourceCursor {
            key: "0123456789abcdef".into(),
            skip: 50,
            retry: false,
        }]),
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
        vec![vec![(
            0,
            Ok(CatalogPage {
                items: vec![],
                source_item_count: 3,
            }),
        )]],
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
        sources(vec![SearchSourceCursor {
            key: "0123456789abcdef".into(),
            skip: u32::MAX,
            retry: false,
        }]),
        vec![vec![(
            0,
            Ok(CatalogPage {
                items: vec![],
                source_item_count: 3,
            }),
        )]],
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
    assert_eq!(catalog_page_next_skip(0, 50), Some(50));
    assert_eq!(catalog_page_next_skip(50, 50), Some(100));
    assert_eq!(catalog_page_next_skip(0, 24), Some(24));
    assert_eq!(catalog_page_next_skip(0, 49), Some(49));
    assert_eq!(catalog_page_next_skip(0, 0), None);
    assert_eq!(catalog_page_next_skip(100, 0), None);
}

#[test]
fn catalog_cursor_counts_source_entries_before_cards_are_dropped() {
    let page = catalog_fetch_page_from_source(
        CatalogPage {
            source_item_count: 3,
            items: vec![test_media_item("tt1", "movie")],
        },
        50,
    );
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.next_skip, Some(53));

    let rejected_page = catalog_fetch_page_from_source(
        CatalogPage {
            source_item_count: 3,
            items: Vec::new(),
        },
        50,
    );
    assert_eq!(rejected_page.next_skip, Some(53));
    assert_eq!(
        catalog_fetch_page_from_source(CatalogPage::default(), 50).next_skip,
        None
    );
}

#[test]
fn extra_skip_value_reads_the_declared_skip_extra() {
    assert_eq!(extra_skip_value(&[]), 0);
    assert_eq!(
        extra_skip_value(&[CatalogExtra {
            name: "genre".to_string(),
            value: "Animation".to_string(),
        }]),
        0
    );
    assert_eq!(
        extra_skip_value(&[
            CatalogExtra {
                name: "genre".to_string(),
                value: "Animation".to_string(),
            },
            CatalogExtra {
                name: "skip".to_string(),
                value: "50".to_string(),
            },
        ]),
        50
    );
}

#[test]
fn merge_catalog_pages_keeps_partial_success_and_the_earliest_next_skip() {
    let page = merge_catalog_pages(
        vec![
            Ok(CatalogFetchPage {
                items: vec![
                    test_media_item("tt1", "series"),
                    test_media_item("tt2", "series"),
                ],
                next_skip: Some(50),
            }),
            Err("offline addon".to_string()),
            Ok(CatalogFetchPage {
                items: vec![
                    test_media_item("tt2", "series"),
                    test_media_item("tt3", "series"),
                ],
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
        vec!["tt1", "tt2", "tt3"]
    );
    assert_eq!(page.next_skip, Some(24));
}

#[test]
fn empty_search_pages_preserve_constituent_failures_for_retry() {
    let sources = || {
        vec![(0..2)
            .map(|index| SearchCatalogSource {
                cursor: SearchSourceCursor {
                    key: format!("{index:016x}"),
                    skip: 0,
                    retry: false,
                },
                supports_skip: true,
            })
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
            (
                0,
                Ok(CatalogPage {
                    items: vec![test_media_item("available", "movie")],
                    source_item_count: 1,
                }),
            ),
            (1, Err("single-page source offline".into())),
        ]],
        true,
    )
    .unwrap();
    assert!(page.partial);
    assert_eq!(page.cursors.len(), 1);
}

#[test]
fn classified_catalog_allows_skip_and_animation_genre() {
    let addon = classified_cinemeta_addon();
    let extras = [
        CatalogExtra {
            name: "genre".to_string(),
            value: "Animation".to_string(),
        },
        CatalogExtra {
            name: "skip".to_string(),
            value: "50".to_string(),
        },
    ];
    assert!(addon_allows_catalog(&addon, "movie", "top", &extras));
    assert!(addon_allows_catalog(&addon, "movie", "imdbRating", &extras));
}

fn subtitle_addon() -> AddonConfig {
    AddonConfig {
        id: "https://subtitles-addon.test".to_string(),
        url: "https://subtitles-addon.test".to_string(),
        name: "Subtitles Addon".to_string(),
        enabled: true,
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
    }
}

#[tokio::test]
async fn capability_gaps_are_tagged_and_other_failures_are_not() {
    let subtitles_only = [subtitle_addon()];
    let client = AddonResourceClient::new();
    let gaps = [
        super::select_catalog_targets(&subtitles_only, "movie", "top", &[])
            .map(|_| ())
            .unwrap_err(),
        super::fetch_meta_details_from_addons(&client, &subtitles_only, "movie", "tt1")
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
    assert!(allows_subtitles(&addon, "movie", "tt1234567"));
    assert!(allows_subtitles(&addon, "series", "tt1234567:1:2"));
    assert!(!allows_subtitles(&addon, "movie", "kitsu:42"));
    assert!(!allows_subtitles(&addon, "anime", "tt1234567:1:2"));

    let catalog_only = classified_cinemeta_addon();
    assert!(!allows_subtitles(&catalog_only, "movie", "tt1234567"));

    let unclassified = AddonConfig {
        capabilities: None,
        ..addon
    };
    assert!(allows_subtitles(&unclassified, "movie", "tt1234567"));
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
        url: server.url.clone(),
        capabilities: None,
        ..subtitle_addon()
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
            url: server.url.clone(),
            capabilities: None,
            ..subtitle_addon()
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
        url: server.url.clone(),
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
        ..subtitle_addon()
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

    add_subtitle_if_unique(&mut subtitles, &mut seen, &addon, item.clone());
    add_subtitle_if_unique(&mut subtitles, &mut seen, &addon, item);
    assert_eq!(subtitles.len(), 1);
    assert_eq!(subtitles[0].source_id, addon.id);
    assert_eq!(subtitles[0].source_name, addon.name);
    assert_eq!(subtitles[0].lang.as_deref(), Some("eng"));
    assert_eq!(
        serde_json::to_value(&subtitles[0]).unwrap()["selectionKey"],
        r#"["https://subtitles-addon.test","sub-1","https://subtitles-addon.test/subs/en.srt","eng"]"#
    );
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
        let mut subtitles = Vec::new();
        add_subtitle_if_unique(
            &mut subtitles,
            &mut HashSet::new(),
            &subtitle_addon(),
            AddonSubtitle {
                id: " sub-1 ".to_string(),
                url: "https://subtitles-addon.test/subs/en.srt".to_string(),
                lang: None,
                label: label.map(str::to_string),
            },
        );
        assert_eq!(
            serde_json::to_value(&subtitles[0]).unwrap()["mpvTitle"],
            expected
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
        let mut subtitles = Vec::new();
        add_subtitle_if_unique(
            &mut subtitles,
            &mut HashSet::new(),
            &subtitle_addon(),
            AddonSubtitle {
                id: "sub-1".to_string(),
                url: "https://subtitles-addon.test/subs/en.srt".to_string(),
                lang: None,
                label: label.map(str::to_string),
            },
        );
        assert_eq!(subtitles[0].detail.as_deref(), expected, "{label:?}");
        assert_eq!(subtitles[0].label.as_deref(), label);
        let serialized = serde_json::to_value(&subtitles[0]).unwrap();
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
                url: format!("https://subtitles-addon.test/{index}"),
                ..subtitle_addon()
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
            AddonSubtitle {
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

    add_subtitle_if_unique(&mut subtitles, &mut seen, &addon, subtitle("eng"));
    add_subtitle_if_unique(&mut subtitles, &mut seen, &addon, subtitle("English"));
    // Same language in different case is still the same variant.
    add_subtitle_if_unique(&mut subtitles, &mut seen, &addon, subtitle(" ENG "));
    assert_eq!(subtitles.len(), 2);
}
