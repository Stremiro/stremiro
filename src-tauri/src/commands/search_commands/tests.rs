use super::{
    apply_browse_filters, browse_genres, browse_year_catalog, catalog_browse_extras,
    catalog_fetch_genres, normalize_genres, rank_search_results,
    retain_search_items_matching_genres, should_continue_browse_fetch, SearchFeed, SearchMediaType,
    SearchYearRange, CINEMETA_ANIME_GENRE,
};
use crate::commands::media_normalization::normalize_media_item;
use crate::providers::MediaItem;
use crate::test_helpers::test_media_item;

#[test]
fn all_browse_interleaves_without_cloning_and_stops_nonadvancing_cursors() {
    let page = |ids: &[&str], next_skip| {
        Ok((
            super::CatalogFetchPage {
                items: ids.iter().map(|id| test_media_item(id, "movie")).collect(),
                next_skip,
            },
            Default::default(),
        ))
    };
    let merged = super::merge_all_browse_pages(
        super::SearchCatalogContinuation {
            all_cursors: Some(super::AllBrowseCursors {
                movie: Some(0),
                series: Some(100),
            }),
            ..Default::default()
        },
        Some(page(&["m1", "m2", "m3"], Some(100))),
        Some(page(&["s1"], Some(100))),
    )
    .unwrap();
    assert_eq!(ids(&merged.items), ["m1", "s1", "m2", "m3"]);
    assert_eq!(
        serde_json::to_value(&merged).unwrap()["continuation"]["allCursors"],
        serde_json::json!({"movie": 100})
    );
    assert_eq!(merged.continuation.skip, None);
    assert!(!merged.exhausted);
}

#[test]
fn all_browse_keeps_partial_success_and_retries_only_active_failed_branches() {
    let continuation = || super::SearchCatalogContinuation {
        all_cursors: Some(super::AllBrowseCursors {
            movie: Some(0),
            series: Some(100),
        }),
        ..Default::default()
    };
    let merged = super::merge_all_browse_pages(
        continuation(),
        Some(Err("movie offline".into())),
        Some(Ok((
            super::CatalogFetchPage {
                items: vec![],
                next_skip: None,
            },
            Default::default(),
        ))),
    )
    .unwrap();
    assert!(merged.items.is_empty());
    assert_eq!(
        merged.continuation.all_cursors,
        Some(super::AllBrowseCursors {
            movie: Some(0),
            series: None
        })
    );
    assert!(!merged.exhausted);
    assert_eq!(
        super::merge_all_browse_pages(
            continuation(),
            Some(Err("first".into())),
            Some(Err("second".into()))
        )
        .unwrap_err(),
        "first"
    );
    assert_eq!(
        super::merge_all_browse_pages(merged.continuation, Some(Err("retry failed".into())), None)
            .unwrap_err(),
        "retry failed"
    );
    let merged = super::merge_all_browse_pages(
        super::SearchCatalogContinuation {
            all_cursors: Some(super::AllBrowseCursors {
                movie: None,
                series: Some(100),
            }),
            ..Default::default()
        },
        None,
        Some(Ok((
            super::CatalogFetchPage {
                items: vec![test_media_item("s", "series")],
                next_skip: Some(200),
            },
            Default::default(),
        ))),
    )
    .unwrap();
    assert_eq!(
        merged.continuation.all_cursors,
        Some(super::AllBrowseCursors {
            movie: None,
            series: Some(200)
        })
    );
}

#[test]
fn all_browse_wire_cursors_are_typed_and_cannot_mix_request_modes() {
    let request = |value| serde_json::from_value::<super::SearchCatalogRequest>(value).unwrap();
    let criteria = super::build_search_criteria(request(serde_json::json!({
        "continuation": {"allCursors": {"movie": 0}, "seenKeys":[]},
        "feed": "featured", "genres": [" Drama "],
        "yearFrom": 2026, "yearTo": 2026,
    })))
    .unwrap();
    assert_eq!(criteria.continuation.all_cursors.unwrap().movie, Some(0));
    assert_eq!(criteria.feed, SearchFeed::Featured);
    assert_eq!(criteria.genres, ["Drama"]);
    assert_eq!(criteria.year_range.single_year(), Some(2026));
    for extra in [
        serde_json::json!({"query":"test"}),
        serde_json::json!({"mediaType":"movie"}),
        serde_json::json!({"continuation":{"skip":0,"allCursors":{"movie":0},"seenKeys":[]}}),
    ] {
        let mut value = serde_json::json!({
            "continuation":{"allCursors":{"movie":0,"series":0},"seenKeys":[]}
        });
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        assert!(super::build_search_criteria(request(value)).is_err());
    }
    for cursor in [
        serde_json::json!(-1),
        serde_json::json!(4_294_967_296_u64),
        serde_json::json!("0"),
    ] {
        assert!(serde_json::from_value::<super::SearchCatalogRequest>(
            serde_json::json!({"continuation":{"allCursors":{"movie":cursor},"seenKeys":[]}})
        )
        .is_err());
    }
    let initial = super::build_search_criteria(request(serde_json::json!({}))).unwrap();
    assert_eq!(
        initial.continuation.all_cursors,
        Some(super::AllBrowseCursors {
            movie: Some(0),
            series: Some(0)
        })
    );
}

#[test]
fn search_catalog_cross_page_dedup_uses_trimmed_ascii_identity() {
    let first = super::finish_catalog_page(
        vec![
            test_media_item(" TT1 ", "movie"),
            test_media_item("Ä", "series"),
            test_media_item("custom", "OTHER:TYPE"),
        ],
        super::SearchCatalogContinuation {
            skip: Some(0),
            ..Default::default()
        },
        Some(100),
        None,
        None,
        Default::default(),
    );
    assert!(!first.exhausted);
    let second = super::finish_catalog_page(
        vec![
            test_media_item("tt1", "movie"),
            test_media_item("\u{feff}tt1", "movie"),
            test_media_item("tt1", "series"),
            test_media_item("Ä", "series"),
            test_media_item("ä", "series"),
            test_media_item("tt2", "movie"),
            test_media_item("TT2", "movie"),
            test_media_item("CUSTOM", "other:type"),
        ],
        first.continuation,
        Some(200),
        None,
        None,
        Default::default(),
    );
    assert_eq!(ids(&second.items), ["tt1", "ä", "tt2"]);
    assert_eq!(second.items[0].type_, "series");
    assert_eq!(second.continuation.skip, Some(200));
    assert_eq!(second.continuation.seen_keys.len(), 6);
    assert!(!second.exhausted);
    assert!(super::build_search_criteria(
        serde_json::from_value(serde_json::json!({
            "mediaType": "movie", "continuation": &second.continuation,
        }))
        .unwrap(),
    )
    .is_ok());
    let wire = serde_json::to_value(second).unwrap();
    assert_eq!(wire["continuation"]["skip"], 200);
    assert!(wire["continuation"]["seenKeys"].is_array());
    assert_eq!(wire["exhausted"], false);
}

#[test]
fn search_catalog_duplicate_only_branch_stops_independently() {
    let page = super::merge_all_browse_pages(
        super::SearchCatalogContinuation {
            all_cursors: Some(super::AllBrowseCursors {
                movie: Some(100),
                series: Some(100),
            }),
            seen_keys: vec!["movie:tt1".into()],
            ..Default::default()
        },
        Some(Ok((
            super::CatalogFetchPage {
                items: vec![test_media_item("TT1", "movie")],
                next_skip: Some(200),
            },
            search_claims(&[("movie:tt1", Some(0))]),
        ))),
        Some(Ok((
            super::CatalogFetchPage {
                items: vec![test_media_item("tt2", "series")],
                next_skip: Some(200),
            },
            search_claims(&[("series:tt2", Some(1))]),
        ))),
    )
    .unwrap();
    assert_eq!(ids(&page.items), ["tt2"]);
    assert_eq!(
        page.continuation.all_cursors,
        Some(super::AllBrowseCursors {
            movie: None,
            series: Some(200),
        })
    );
    assert!(!page.exhausted);
}

#[test]
fn browse_catalog_exhausts_duplicate_empty_and_nonadvancing_pages() {
    for (items, next_skip) in [
        (vec![test_media_item("TT1", "movie")], Some(200)),
        (vec![], Some(200)),
        (vec![test_media_item("new", "movie")], Some(100)),
        (vec![test_media_item("new", "movie")], None),
    ] {
        let page = super::finish_catalog_page(
            items,
            super::SearchCatalogContinuation {
                skip: Some(100),
                seen_keys: vec!["movie:tt1".into()],
                ..Default::default()
            },
            next_skip,
            None,
            None,
            Default::default(),
        );
        assert!(page.exhausted);
        assert_eq!(page.continuation.skip, None);
    }
    let page = super::merge_all_browse_pages(
        super::SearchCatalogContinuation {
            all_cursors: Some(super::AllBrowseCursors {
                movie: Some(0),
                series: None,
            }),
            ..Default::default()
        },
        Some(Ok((
            super::CatalogFetchPage {
                items: vec![],
                next_skip: None,
            },
            Default::default(),
        ))),
        None,
    )
    .unwrap();
    assert!(page.exhausted);
}

#[test]
fn browse_filtered_titles_advance_once_and_branches_stop_independently() {
    let claims = || search_claims(&[("movie:old", Some(0))]);
    let first = super::finish_catalog_page(
        vec![],
        super::SearchCatalogContinuation {
            skip: Some(100),
            ..Default::default()
        },
        Some(200),
        None,
        None,
        claims(),
    );
    assert!(first.items.is_empty());
    assert_eq!(first.continuation.skip, Some(200));
    assert_eq!(first.continuation.seen_keys, ["movie:old"]);
    assert!(!first.exhausted);
    let replayed =
        super::finish_catalog_page(vec![], first.continuation, Some(300), None, None, claims());
    assert!(replayed.exhausted);
    let merged = super::merge_all_browse_pages(
        super::SearchCatalogContinuation {
            all_cursors: Some(super::AllBrowseCursors {
                movie: Some(100),
                series: Some(100),
            }),
            seen_keys: replayed.continuation.seen_keys,
            ..Default::default()
        },
        Some(Ok((
            super::CatalogFetchPage {
                items: vec![],
                next_skip: Some(200),
            },
            claims(),
        ))),
        Some(Ok((
            super::CatalogFetchPage {
                items: vec![],
                next_skip: Some(200),
            },
            search_claims(&[("series:new", Some(1))]),
        ))),
    )
    .unwrap();
    assert!(merged.items.is_empty());
    assert_eq!(
        merged.continuation.all_cursors,
        Some(super::AllBrowseCursors {
            movie: None,
            series: Some(200)
        })
    );
    assert!(!merged.exhausted);
}

#[test]
fn search_catalog_seen_key_bound_validates_and_ends_paging() {
    let seen_keys: Vec<_> = (0..super::MAX_CATALOG_SEEN_KEYS - 1)
        .map(|id| format!("movie:{id}"))
        .collect();
    let page = super::finish_catalog_page(
        vec![
            test_media_item("last", "movie"),
            test_media_item("overflow", "movie"),
        ],
        super::SearchCatalogContinuation {
            skip: Some(100),
            seen_keys,
            ..Default::default()
        },
        Some(200),
        None,
        None,
        Default::default(),
    );
    assert_eq!(ids(&page.items), ["last"]);
    assert_eq!(
        page.continuation.seen_keys.len(),
        super::MAX_CATALOG_SEEN_KEYS
    );
    assert!(page.exhausted);
    let request = |keys: &[String]| {
        serde_json::from_value::<super::SearchCatalogRequest>(
            serde_json::json!({"mediaType":"movie","continuation":{"skip":200,"seenKeys":keys}}),
        )
        .unwrap()
    };
    assert!(
        super::build_search_criteria(request(&page.continuation.seen_keys))
            .unwrap()
            .continuation
            .is_exhausted()
    );
    assert!(super::build_search_criteria(request(&[
        "😀".repeat(super::MAX_CATALOG_SEEN_KEY_CHARS)
    ]))
    .is_ok());
    for keys in [
        vec!["movie:duplicate".into(); super::MAX_CATALOG_SEEN_KEYS + 1],
        vec!["😀".repeat(super::MAX_CATALOG_SEEN_KEY_CHARS + 1)],
        vec![String::new()],
    ] {
        assert!(super::build_search_criteria(request(&keys)).is_err());
    }
}

fn search_cursor(key: &str, skip: u32, retry: bool) -> super::SearchSourceCursor {
    super::SearchSourceCursor {
        key: key.into(),
        skip,
        retry,
    }
}

fn search_claims(claims: &[(&str, Option<usize>)]) -> super::SearchCursorClaims {
    claims
        .iter()
        .map(|(key, claimant)| ((*key).to_string(), *claimant))
        .collect()
}

#[test]
fn text_search_source_cursors_continue_only_while_adding_titles() {
    const PAGED: &str = "0123456789abcdef";
    const FILTERED: &str = "1123456789abcdef";
    const RETRY: &str = "2123456789abcdef";
    let ranked = rank_search_results(
        "Match",
        vec![
            build_item("prefix", "Match sequel", Some("2024")),
            build_item("TT1", "Match", Some("2020")),
            build_item("old", "Match", Some("1990")),
        ],
        SearchYearRange {
            year_from: Some(2020),
            year_to: None,
        },
    );
    let first = super::finish_catalog_page(
        ranked,
        super::SearchCatalogContinuation::default(),
        None,
        None,
        Some(vec![
            search_cursor(PAGED, 100, false),
            search_cursor(FILTERED, 50, false),
            search_cursor(RETRY, 0, true),
        ]),
        search_claims(&[
            ("movie:prefix", Some(0)),
            ("movie:tt1", Some(0)),
            ("movie:old", Some(1)),
        ]),
    );
    assert_eq!(ids(&first.items), ["TT1", "prefix"]);
    assert!(!first.exhausted);
    // The year-filtered title still counts as its source's progress and is remembered.
    assert_eq!(first.continuation.seen_keys.len(), 3);
    assert!(first.continuation.seen_keys.contains(&"movie:old".into()));
    let wire = serde_json::to_value(&first).unwrap();
    assert_eq!(
        wire["continuation"]["searchCursors"],
        serde_json::json!([
            {"key": PAGED, "skip": 100, "retry": false},
            {"key": FILTERED, "skip": 50, "retry": false},
            {"key": RETRY, "skip": 0, "retry": true},
        ])
    );
    assert!(wire["continuation"].get("skip").is_none());
    let criteria = super::build_search_criteria(
        serde_json::from_value(serde_json::json!({
            "query": "Match", "continuation": wire["continuation"],
        }))
        .unwrap(),
    )
    .unwrap();

    let second = super::finish_catalog_page(
        vec![
            test_media_item("tt1", "movie"),
            test_media_item("fresh", "movie"),
        ],
        criteria.continuation,
        None,
        None,
        Some(vec![
            search_cursor(PAGED, 200, false),
            search_cursor(FILTERED, 100, false),
            search_cursor(RETRY, 20, false),
        ]),
        search_claims(&[
            ("movie:tt1", Some(0)),
            ("movie:old", Some(1)),
            ("movie:fresh", Some(2)),
        ]),
    );
    assert_eq!(ids(&second.items), ["fresh"]);
    assert!(!second.exhausted);
    assert_eq!(
        second.continuation.search_cursors,
        Some(vec![search_cursor(RETRY, 20, false)])
    );
    assert_eq!(second.continuation.seen_keys.len(), 4);

    let replayed = super::finish_catalog_page(
        vec![test_media_item("FRESH", "movie")],
        second.continuation,
        None,
        None,
        Some(vec![search_cursor(RETRY, 40, false)]),
        search_claims(&[("movie:fresh", Some(0))]),
    );
    assert!(replayed.items.is_empty());
    assert!(replayed.exhausted);
    assert_eq!(replayed.continuation.search_cursors, Some(Vec::new()));
}

#[test]
fn text_search_without_skip_support_serves_page_one_and_exhausts() {
    let page = super::finish_catalog_page(
        vec![test_media_item("only", "movie")],
        super::SearchCatalogContinuation {
            skip: Some(0),
            ..Default::default()
        },
        None,
        None,
        Some(Vec::new()),
        search_claims(&[("movie:only", None)]),
    );
    assert_eq!(ids(&page.items), ["only"]);
    assert!(page.exhausted);
    assert_eq!(page.continuation.skip, None);
}

#[test]
fn text_search_cursor_validation_bounds_keys_count_and_request_mode() {
    let request = |cursors: &[serde_json::Value]| {
        serde_json::json!({
            "query": "dune",
            "continuation": {"searchCursors": cursors, "seenKeys": []}
        })
    };
    let valid: Vec<_> = (0..super::MAX_SEARCH_SOURCE_CURSORS)
        .map(|index| serde_json::json!({"key": format!("{index:016x}"), "skip": 1}))
        .collect();
    let build = |value| super::build_search_criteria(serde_json::from_value(value).unwrap());
    assert!(!build(request(&valid)).unwrap().continuation.is_exhausted());
    assert!(build(request(&[])).unwrap().continuation.is_exhausted());
    assert!(build(request(&[serde_json::json!(
        {"key":"0123456789abcdef", "skip":0, "retry":true}
    )]))
    .is_ok());
    let mut too_many = valid.clone();
    too_many.push(serde_json::json!({"key": format!("{:016x}", valid.len()), "skip": 1}));
    for invalid in [
        too_many,
        vec![valid[0].clone(), valid[0].clone()],
        vec![serde_json::json!({"key": "", "skip": 1})],
        vec![serde_json::json!({"key": "0".repeat(17), "skip": 1})],
        vec![serde_json::json!({"key": "g".repeat(16), "skip": 1})],
        vec![serde_json::json!({"key": "0123456789abcdef", "skip": 0})],
    ] {
        assert!(build(request(&invalid)).is_err());
    }
    for extra in [
        serde_json::json!({"skip": 0}),
        serde_json::json!({"allCursors": {"movie": 0}}),
    ] {
        let mut value = request(&valid);
        value["continuation"]
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        assert!(build(value).is_err());
    }
    let mut browse = request(&valid);
    browse.as_object_mut().unwrap().remove("query");
    browse["mediaType"] = serde_json::json!("movie");
    assert!(build(browse).is_err());
    for skip in [
        serde_json::json!(-1),
        serde_json::json!(4_294_967_296_u64),
        serde_json::json!("1"),
    ] {
        assert!(
            serde_json::from_value::<super::SearchCatalogRequest>(request(&[
                serde_json::json!({"key": "0123456789abcdef", "skip": skip})
            ]))
            .is_err()
        );
    }
}

// Mirrors production: year filters and ordering read `primary_year`,
// which normalization computes from the raw year string.
fn build_item(id: &str, title: &str, year: Option<&str>) -> MediaItem {
    normalize_media_item(MediaItem {
        title: title.to_string(),
        year: year.map(str::to_string),
        ..test_media_item(id, "movie")
    })
}

/// No year constraint — the range most browse-filter tests pass through.
const NO_RANGE: SearchYearRange = SearchYearRange {
    year_from: None,
    year_to: None,
};

fn ids(items: &[MediaItem]) -> Vec<&str> {
    items.iter().map(|item| item.id.as_str()).collect()
}

#[test]
fn cached_empty_titles_are_filtered_only_after_duplicate_selection() {
    let empty = build_item("tt1", "\u{feff}\0", Some("2024"));
    let fallback = build_item("tt1", "Fallback", Some("2024"));
    let visible = build_item("tt2", "Visible", Some("2024"));
    let merged = crate::commands::addon_registry::merge_catalog_pages(
        [vec![empty], vec![fallback, visible]].map(|items| {
            Ok(crate::commands::addon_registry::CatalogFetchPage {
                items,
                next_skip: None,
            })
        }),
        "empty",
    )
    .unwrap();
    assert_eq!(
        ids(&super::retain_titled_catalog_items(merged.items)),
        ["tt2"]
    );
}

#[test]
fn search_ranking_preserves_catalog_order_and_year_filter_policy() {
    let mut items = vec![
        build_item("first", "Match", Some("2024")),
        build_item("partial", "Match sequel", Some("2026")),
        build_item("older", "Match", Some("2020")),
        build_item("second", "Match", Some("2024")),
        build_item("unknown", "Match", None),
    ];
    assert_eq!(
        ids(&rank_search_results("match", items.clone(), NO_RANGE)),
        ["first", "older", "second", "unknown", "partial"]
    );
    // Keep the existing year-filter checks independent of relevance ordering.
    items.swap(2, 3);
    for (year_from, expected) in [
        (None, vec!["first", "second", "older", "unknown"]),
        (Some(2021), vec!["first", "second"]),
    ] {
        assert_eq!(
            ids(&rank_search_results(
                "match",
                items.clone(),
                SearchYearRange {
                    year_from,
                    year_to: Some(2024)
                },
            )),
            expected
        );
    }
}

#[test]
fn search_ranking_prioritizes_exact_titles_and_provider_relevance() {
    let movies = [
        ("movie-1936", "The Walking Dead", Some("1936")),
        ("movie-1995", "The Walking Dead", Some("1995")),
        ("return", "The Walking Dead: The Return", Some("2024")),
        ("deceased", "The Walking Deceased", Some("2015")),
        ("vampires", "Strange Love of the Vampires", Some("1975")),
        ("dead-man", "Dead Man Walking", Some("1995")),
        ("girls", "The Walking Dead Girls", Some("2011")),
    ]
    .into_iter()
    .map(|(id, title, year)| build_item(id, title, year));
    let series = [
        ("tt1520211", "The Walking Dead", Some("2010")),
        ("dead-city", "The Walking Dead: Dead City", Some("2023")),
        ("origins", "The Walking Dead: Origins", Some("2021")),
    ]
    .into_iter()
    .map(|(id, title, year)| MediaItem {
        type_: "series".to_string(),
        ..build_item(id, title, year)
    });
    let ranked = rank_search_results("The Walking Dead", movies.chain(series).collect(), NO_RANGE);
    assert_eq!(
        (
            ranked[0].title.as_str(),
            ranked[0].type_.as_str(),
            ranked[0].primary_year,
        ),
        ("The Walking Dead", "series", Some(2010))
    );
    assert_eq!(ids(&ranked[..3]), ["tt1520211", "movie-1936", "movie-1995"]);
    assert_eq!(
        ids(&rank_search_results("walking dead", ranked.clone(), NO_RANGE)[..3]),
        ["tt1520211", "movie-1936", "movie-1995"]
    );
    assert_eq!(
        ids(&rank_search_results(
            "dead",
            vec![
                build_item("embedded", "Undead", None),
                build_item("word", "The Dead", None),
            ],
            NO_RANGE,
        )),
        ["word", "embedded"]
    );
    for (query, exact, prefix, word, embedded) in [
        (
            "the walking dead",
            "Walking Dead",
            "Walking Dead: Origins",
            "Fear the Walking Dead",
            "Outwalking Dead",
        ),
        (
            "walking dead",
            "The Walking Dead",
            "The Walking Dead: Origins",
            "Fear the Walking Dead",
            "Outwalking Dead",
        ),
        (
            "amelie",
            "Amélie",
            "Amélie: The Story",
            "About Amélie",
            "Damélie",
        ),
        (
            "grey’s anatomy",
            "Grey's Anatomy",
            "Grey’s Anatomy: Special",
            "Inside Grey's Anatomy",
            "McGrey's Anatomy",
        ),
        (
            "an education",
            "Education",
            "An Education: Special",
            "About Education",
            "Coeducation",
        ),
        (
            "a quiet place",
            "Quiet Place",
            "A Quiet Place: Part II",
            "Another Quiet Place",
            "Unquiet Place",
        ),
    ] {
        assert_eq!(
            ids(&rank_search_results(
                query,
                vec![
                    build_item("unrelated", "Unrelated", None),
                    build_item("contains", embedded, None),
                    build_item("word", word, None),
                    build_item("prefix", prefix, None),
                    build_item("exact", exact, None),
                ],
                NO_RANGE,
            )),
            ["exact", "prefix", "word", "contains", "unrelated"],
            "{query}",
        );
    }
    assert_eq!(
        ids(&rank_search_results(
            "dead walk",
            vec![
                build_item("contains", "Undead Walkthrough", None),
                build_item("words", "Walking with the Dead", None),
                build_item("prefix", "Dead Walking", None),
            ],
            NO_RANGE,
        )),
        ["prefix", "words", "contains"],
    );
    for (query, first, other) in [
        ("shogun", ("Shōgun", None), ("Shogun Assassin", None)),
        (
            "fast and furious",
            ("Fast & Furious", None),
            ("Fast Five", None),
        ),
        ("spiderman", ("Spider-Man", None), ("Superman", None)),
        ("dune 2021", ("Dune", Some("2021")), ("Dune", Some("1984"))),
        (
            "blade runner 2049",
            ("Blade Runner 2049", Some("2017")),
            ("Blade Runner", Some("1982")),
        ),
    ] {
        assert_eq!(
            ids(&rank_search_results(
                query,
                vec![
                    build_item("other", other.0, other.1),
                    build_item("first", first.0, first.1),
                ],
                NO_RANGE,
            )),
            ["first", "other"],
            "{query}",
        );
    }
    for title in ["The Walking Dead Girls", "Dead Man Walking"] {
        let position = ranked.iter().position(|item| item.title == title).unwrap();
        for (index, item) in ranked.iter().enumerate() {
            if item.title.starts_with("The Walking Dead:") {
                assert!(position > index, "{title} must rank below {}", item.title);
            }
        }
    }
    for (title, expected) in [
        ("Amélie", "amelie"),
        ("Ame\u{301}lie", "amelie"),
        ("İstanbul", "istanbul"),
        ("Pok\u{e9}mon", "pokemon"),
        ("Grey's Anatomy", "greys anatomy"),
        ("Pokémon: The Movie", "pokemon the movie"),
        ("  GREY’S---ANATOMY!  ", "greys anatomy"),
        ("ÉÀÇÑØÜÝŸẞÆŒ", "eacnouyyssaeoe"),
        ("東京物語 / МОСКВА", "東京物語 москва"),
        ("Shōgun", "shogun"),
        ("Diriliş: Ertuğrul", "dirilis ertugrul"),
        ("Łódź", "lodz"),
        ("Fast & Furious", "fast and furious"),
        ("ガンダム", "カ\u{3099}ンタ\u{3099}ム"),
    ] {
        assert_eq!(super::normalize_search_text(title), expected);
    }
}

#[test]
fn normalize_genres_owns_unicode_bound_deduplication_and_count_limit() {
    let bounded = "😀".repeat(120);
    let normalized = normalize_genres(Some(vec![
        "  ".to_string(),
        format!(" {bounded}A "),
        format!("{bounded}B"),
        " Action ".to_string(),
        "ACTION".to_string(),
        "Comedy".to_string(),
        "Drama".to_string(),
        "Thriller".to_string(),
        "Mystery".to_string(),
        "Adventure".to_string(),
    ]));
    assert_eq!(
        normalized,
        vec![
            bounded,
            "Action".to_string(),
            "Comedy".to_string(),
            "Drama".to_string(),
            "Thriller".to_string(),
            "Mystery".to_string()
        ]
    );
}

#[test]
fn apply_browse_filters_enforces_requested_genres_provider_independently() {
    let mut horror = build_item("tt1", "Horror Night", Some("2024"));
    horror.genres = Some(vec!["Horror".to_string()]);
    let mut horror_comedy = build_item("tt2", "Horror Comedy", Some("2024"));
    horror_comedy.genres = Some(vec!["Horror".to_string(), "Comedy".to_string()]);
    let unlabeled = build_item("tt3", "Mystery", Some("2024"));

    let kept = apply_browse_filters(
        vec![horror, horror_comedy, unlabeled.clone()],
        SearchMediaType::Movie,
        &["Horror".to_string()],
        NO_RANGE,
    );
    assert_eq!(ids(&kept), vec!["tt1", "tt2"]);

    let mut animated = build_item("tt4", "Anime", Some("2024"));
    animated.genres = Some(vec!["Animation".to_string(), "Action".to_string()]);
    let mut live_action = build_item("tt5", "Live Action", Some("2024"));
    live_action.genres = Some(vec!["Action".to_string()]);
    // Animation is also a real movie/series catalog genre — it enforces
    // like any other; the anime paths' marker gate sits on top, not here.
    let kept_animation_only = apply_browse_filters(
        vec![animated, live_action, unlabeled],
        SearchMediaType::Movie,
        &["Animation".to_string()],
        NO_RANGE,
    );
    assert_eq!(ids(&kept_animation_only), vec!["tt4"]);
}

#[test]
fn search_genre_filter_keeps_hits_without_declared_genres() {
    // Cinemeta search hits carry no genres: anime search must not drop them.
    let unlabeled = build_item("tt1", "Solo Leveling", Some("2024"));
    let mut animated = build_item("tt2", "Anime Action", Some("2024"));
    animated.genres = Some(vec!["Animation".to_string(), "Action".to_string()]);
    let mut live_action = build_item("tt3", "Live Action", Some("2024"));
    live_action.genres = Some(vec!["Action".to_string()]);

    let required = browse_genres(SearchMediaType::Anime, &["Action".to_string()]);
    let kept =
        retain_search_items_matching_genres(vec![unlabeled, animated, live_action], &required);
    assert_eq!(ids(&kept), vec!["tt1", "tt2"]);
}

#[test]
fn browse_genres_injects_cinemeta_animation_for_anime() {
    assert_eq!(
        browse_genres(SearchMediaType::Anime, &[]),
        vec![CINEMETA_ANIME_GENRE]
    );
    assert_eq!(
        browse_genres(SearchMediaType::Anime, &["Action".to_string()]),
        vec![CINEMETA_ANIME_GENRE, "Action"]
    );
    assert_eq!(
        browse_genres(SearchMediaType::Anime, &["animation".to_string()]),
        vec!["animation"]
    );
    assert!(browse_genres(SearchMediaType::Series, &[]).is_empty());
    assert_eq!(
        browse_genres(SearchMediaType::Movie, &["Action".to_string()]),
        vec!["Action"]
    );
}

#[test]
fn catalog_browse_extras_send_skip_only_when_advancing() {
    let first = catalog_browse_extras(Some("Animation"), 0);
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].name, "genre");
    assert_eq!(first[0].value, "Animation");

    let next = catalog_browse_extras(Some("Animation"), 50);
    assert_eq!(next.len(), 2);
    assert_eq!(next[1].name, "skip");
    assert_eq!(next[1].value, "50");

    assert!(catalog_browse_extras(None, 0).is_empty());
    assert_eq!(catalog_browse_extras(None, 24)[0].value, "24");
}

#[test]
fn catalog_fetch_genres_does_not_union_animation_with_extra_anime_filters() {
    assert_eq!(
        catalog_fetch_genres(SearchMediaType::Anime, &[]),
        vec![CINEMETA_ANIME_GENRE]
    );
    assert_eq!(
        catalog_fetch_genres(SearchMediaType::Anime, &["Action".to_string()]),
        vec!["Action"]
    );
    assert_eq!(
        catalog_fetch_genres(SearchMediaType::Movie, &["Action".to_string()]),
        vec!["Action"]
    );
}

#[test]
fn apply_browse_filters_year_range_excludes_unknown_years_when_active() {
    let items = vec![
        build_item("tt1", "Match", Some("2024")),
        build_item("tt2", "Unknown", None),
        build_item("tt3", "Older", Some("2019")),
    ];
    let kept = apply_browse_filters(
        items,
        SearchMediaType::Movie,
        &[],
        SearchYearRange {
            year_from: Some(2024),
            year_to: Some(2024),
        },
    );
    assert_eq!(ids(&kept), vec!["tt1"]);
}

#[test]
fn apply_browse_filters_intersects_extra_anime_genres_with_animation() {
    let mut animated_action = build_item("tt1", "Anime Action", Some("2024"));
    animated_action.genres = Some(vec!["Animation".to_string(), "Action".to_string()]);
    let mut live_action = build_item("tt2", "Live Action", Some("2024"));
    live_action.genres = Some(vec!["Action".to_string()]);
    // Genre+marker matches that fail the year gate still drop.
    let mut old_match = build_item("tt3", "Old Anime Action", Some("2019"));
    old_match.genres = Some(vec!["Animation".to_string(), "Action".to_string()]);
    let mut unknown_year = build_item("tt4", "Undated Anime Action", None);
    unknown_year.genres = Some(vec!["Animation".to_string(), "Action".to_string()]);
    let mut wrong_genre = build_item("tt5", "Animated Comedy", Some("2024"));
    wrong_genre.genres = Some(vec!["Animation".to_string(), "Comedy".to_string()]);

    let kept = apply_browse_filters(
        vec![
            live_action,
            old_match,
            animated_action,
            unknown_year,
            wrong_genre,
        ],
        SearchMediaType::Anime,
        &["Action".to_string()],
        SearchYearRange {
            year_from: Some(2024),
            year_to: Some(2024),
        },
    );
    assert_eq!(ids(&kept), vec!["tt1"]);
}

#[test]
fn apply_browse_filters_intersects_multiple_movie_genres() {
    let mut action_only = build_item("tt1", "Action Only", Some("2024"));
    action_only.genres = Some(vec!["Action".to_string()]);
    let mut comedy_only = build_item("tt2", "Comedy Only", Some("2024"));
    comedy_only.genres = Some(vec!["Comedy".to_string()]);
    let mut both = build_item("tt3", "Action Comedy", Some("2024"));
    both.genres = Some(vec!["Action".to_string(), "Comedy".to_string()]);

    let kept = apply_browse_filters(
        vec![action_only, comedy_only, both],
        SearchMediaType::Movie,
        &["Action".to_string(), "Comedy".to_string()],
        NO_RANGE,
    );
    assert_eq!(ids(&kept), vec!["tt3"]);
}

#[test]
fn apply_browse_filters_enforces_animation_for_genre_free_anime_browse() {
    let mut animated = build_item("tt1", "Anime", Some("2024"));
    animated.genres = Some(vec![CINEMETA_ANIME_GENRE.to_string()]);
    let live_action = build_item("tt2", "Live Action", Some("2024"));

    let kept = apply_browse_filters(
        vec![animated, live_action],
        SearchMediaType::Anime,
        &["aNiMaTiOn".to_string()],
        NO_RANGE,
    );
    assert_eq!(ids(&kept), vec!["tt1"]);
}

#[test]
fn should_continue_browse_fetch_fills_sparse_pages_until_bound() {
    let browse = super::build_search_criteria(
        serde_json::from_value(serde_json::json!({
            "mediaType": "movie", "genres": ["Action"], "singlePage": true
        }))
        .unwrap(),
    )
    .unwrap();
    let max_fetches = browse.max_browse_fetches;
    assert_eq!(max_fetches, 8);
    assert!(should_continue_browse_fetch(0, Some(50), 1, max_fetches));
    // Sparse intersections fill until the page is a usable batch.
    assert!(should_continue_browse_fetch(3, Some(50), 1, max_fetches));
    assert!(!should_continue_browse_fetch(24, Some(50), 1, max_fetches));
    assert!(!should_continue_browse_fetch(0, None, 1, max_fetches));
    assert!(!should_continue_browse_fetch(0, Some(50), 8, max_fetches));

    let recommendation = super::build_search_criteria(super::SearchCatalogRequest::for_genre(
        "movie",
        "Action".into(),
    ))
    .unwrap();
    assert_eq!(recommendation.max_browse_fetches, 1);
    assert!(!should_continue_browse_fetch(
        0,
        Some(50),
        1,
        recommendation.max_browse_fetches,
    ));
}

#[test]
fn browse_year_catalog_serves_only_single_year_genre_free_popular_browse() {
    let single_2024 = SearchYearRange {
        year_from: Some(2024),
        year_to: Some(2024),
    };
    let range = SearchYearRange {
        year_from: Some(2020),
        year_to: Some(2024),
    };
    let none = NO_RANGE;
    let action = vec!["Action".to_string()];

    assert_eq!(
        browse_year_catalog(
            SearchFeed::Popular,
            SearchMediaType::Movie,
            &[],
            single_2024
        ),
        Some(2024)
    );
    assert_eq!(
        browse_year_catalog(
            SearchFeed::Popular,
            SearchMediaType::Series,
            &[],
            single_2024
        ),
        Some(2024)
    );
    // Featured keeps its feed ordering; anime keeps Animation routing.
    assert_eq!(
        browse_year_catalog(
            SearchFeed::Featured,
            SearchMediaType::Movie,
            &[],
            single_2024
        ),
        None
    );
    assert_eq!(
        browse_year_catalog(
            SearchFeed::Popular,
            SearchMediaType::Anime,
            &[],
            single_2024
        ),
        None
    );
    // Combined genre or range filters stay on the feed path.
    assert_eq!(
        browse_year_catalog(
            SearchFeed::Popular,
            SearchMediaType::Movie,
            &action,
            single_2024
        ),
        None
    );
    assert_eq!(
        browse_year_catalog(SearchFeed::Popular, SearchMediaType::Movie, &[], range),
        None
    );
    assert_eq!(
        browse_year_catalog(SearchFeed::Popular, SearchMediaType::Movie, &[], none),
        None
    );
}
