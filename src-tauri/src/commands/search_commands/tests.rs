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
        (None, vec!["first", "second", "older"]),
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
fn search_ranking_puts_verified_credits_ahead_of_person_title_matches() {
    let mut film = build_item("film", "Inception", Some("2010"));
    film.matches_search_credit = true;
    let biography = build_item("bio", "Christopher Nolan: A Biography", Some("2024"));
    let unrelated = build_item("other", "Another Film", Some("2025"));
    assert_eq!(
        ids(&rank_search_results(
            "Christopher Nolan",
            vec![biography, film.clone(), unrelated],
            NO_RANGE
        )),
        ["film", "bio", "other"]
    );
    let wire = serde_json::to_value(&film).unwrap();
    assert!(wire.get("matches_search_credit").is_none());
    assert!(wire.get("matchesSearchCredit").is_none());
    assert!(
        !serde_json::from_value::<MediaItem>(wire)
            .unwrap()
            .matches_search_credit
    );
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

#[tokio::test]
async fn browse_trusts_only_declared_provider_genres_and_enforces_other_filters() {
    use crate::providers::{
        addon_manifest::parse_addon_manifest, addon_resource::AddonResourceClient,
    };
    use crate::test_helpers::{test_addon, TestHttpServer};

    let body = r#"{"metas":[
        {"id":"sent-only","name":"Sent only","type":"movie","year":"2024","genres":["Drama"]},
        {"id":"missing-second","name":"Missing second","type":"movie","year":"2024","genres":["Action"]},
        {"id":"both","name":"Both","type":"movie","year":"2024","genres":["Action","Drama"]},
        {"id":"unknown","name":"Unknown","type":"movie","year":"2024"},
        {"id":"older","name":"Older","type":"movie","year":"2019","genres":["Drama"]}
    ]}"#;
    for declares_genre in [Some(true), Some(false), None] {
        let server = TestHttpServer::new(vec![(200, body, None)]);
        let capabilities = declares_genre.map(|declares| {
            parse_addon_manifest(if declares {
                br#"{"name":"Catalog","catalogs":[{"type":"movie","id":"top","extra":[{"name":"genre"}]}]}"#
            } else {
                br#"{"name":"Catalog","catalogs":[{"type":"movie","id":"top"}]}"#
            })
            .unwrap()
        });
        let snapshot = [super::AddonConfig {
            url: server.url.clone(),
            capabilities,
            ..test_addon("catalog", "Catalog")
        }];
        let page = super::fetch_registry_browse_pages(
            &snapshot,
            &AddonResourceClient::new(),
            SearchMediaType::Movie,
            "top",
            &[Some("Action")],
            0,
        )
        .await
        .pop()
        .unwrap()
        .unwrap();
        let genres = ["Action", "Drama"].map(str::to_string);
        let kept = apply_browse_filters(
            page.items.clone(),
            SearchMediaType::Movie,
            &genres,
            SearchYearRange::resolve(Some(2024), Some(2024)),
        );
        let expected = if declares_genre == Some(true) {
            vec!["sent-only", "both"]
        } else {
            vec!["both"]
        };
        assert_eq!(
            ids(&kept),
            expected,
            "genre declaration: {declares_genre:?}"
        );
        assert_eq!(
            ids(&retain_search_items_matching_genres(
                page.items.clone(),
                &genres
            )),
            ["both", "unknown"],
        );
        let single =
            apply_browse_filters(page.items, SearchMediaType::Movie, &genres[..1], NO_RANGE);
        let expected = if declares_genre == Some(true) {
            vec!["sent-only", "missing-second", "both", "unknown", "older"]
        } else {
            vec!["missing-second", "both"]
        };
        assert_eq!(
            ids(&single),
            expected,
            "genre declaration: {declares_genre:?}"
        );
        assert_eq!(page.next_skip, Some(5));
        assert_eq!(server.finish(), ["/catalog/movie/top/genre=Action.json"]);
    }
}

#[test]
fn compound_genres_match_whole_labels_or_trimmed_parts_without_prefixes() {
    for (label, matches, misses) in [
        (
            " Action & Adventure ",
            &["action", " Adventure ", "Action & Adventure"][..],
            &["Act", "Action&Adventure"][..],
        ),
        (
            "Sci-Fi & Fantasy",
            &["Sci-Fi", "Fantasy"][..],
            &["Sci", "Science Fiction"][..],
        ),
        (
            "War & Politics",
            &["War", "Politics"][..],
            &["Political"][..],
        ),
    ] {
        let item = MediaItem {
            genres: Some(vec![label.to_string()]),
            ..test_media_item("series", "series")
        };
        for genre in matches {
            assert!(super::item_has_genre(&item, genre), "{label}: {genre}");
        }
        for genre in misses {
            assert!(!super::item_has_genre(&item, genre), "{label}: {genre}");
        }
    }
}

#[test]
fn anime_still_requires_animation_when_the_provider_filtered_animation() {
    let item = MediaItem {
        catalog_genre: Some(CINEMETA_ANIME_GENRE.to_string()),
        ..test_media_item("unlabeled", "series")
    };
    assert!(apply_browse_filters(
        vec![item],
        SearchMediaType::Anime,
        &[CINEMETA_ANIME_GENRE.to_string()],
        NO_RANGE,
    )
    .is_empty());
}

#[test]
fn genre_and_year_filters_preserve_browse_and_search_contracts() {
    use SearchMediaType::{Anime, Movie};
    fn item(id: &str, title: &str, year: Option<&str>, genres: &[&str]) -> MediaItem {
        let mut item = build_item(id, title, year);
        item.genres = (!genres.is_empty()).then(|| genres.iter().map(|s| s.to_string()).collect());
        item
    }
    let current = Some("2024");
    let single = SearchYearRange {
        year_from: Some(2024),
        year_to: Some(2024),
    };
    for (label, (search, media_type, genres, range), items, expected) in [
        (
            "Horror filtering",
            (false, Movie, &["Horror"][..], NO_RANGE),
            vec![
                item("tt1", "Horror Night", current, &["Horror"]),
                item("tt2", "Horror Comedy", current, &["Horror", "Comedy"]),
                item("tt3", "Mystery", current, &[]),
            ],
            &["tt1", "tt2"][..],
        ),
        (
            "movie Animation filtering",
            (false, Movie, &["Animation"][..], NO_RANGE),
            vec![
                item("tt4", "Anime", current, &["Animation", "Action"]),
                item("tt5", "Live Action", current, &["Action"]),
                item("tt3", "Mystery", current, &[]),
            ],
            &["tt4"],
        ),
        (
            "unlabeled search hits",
            (true, Anime, &["Action"][..], NO_RANGE),
            vec![
                item("tt1", "Solo Leveling", current, &[]),
                item("tt2", "Anime Action", current, &["Animation", "Action"]),
                item("tt3", "Live Action", current, &["Action"]),
            ],
            &["tt1", "tt2"],
        ),
        (
            "active-year exclusion",
            (false, Movie, &[][..], single),
            vec![
                item("tt1", "Match", current, &[]),
                item("tt2", "Unknown", None, &[]),
                item("tt3", "Older", Some("2019"), &[]),
            ],
            &["tt1"],
        ),
        (
            "Anime genre/year intersection",
            (false, Anime, &["Action"][..], single),
            vec![
                item("tt2", "Live Action", current, &["Action"]),
                item(
                    "tt3",
                    "Old Anime Action",
                    Some("2019"),
                    &["Animation", "Action"],
                ),
                item("tt1", "Anime Action", current, &["Animation", "Action"]),
                item(
                    "tt4",
                    "Undated Anime Action",
                    None,
                    &["Animation", "Action"],
                ),
                item("tt5", "Animated Comedy", current, &["Animation", "Comedy"]),
            ],
            &["tt1"],
        ),
        (
            "multiple movie genres",
            (false, Movie, &["Action", "Comedy"][..], NO_RANGE),
            vec![
                item("tt1", "Action Only", current, &["Action"]),
                item("tt2", "Comedy Only", current, &["Comedy"]),
                item("tt3", "Action Comedy", current, &["Action", "Comedy"]),
            ],
            &["tt3"],
        ),
        (
            "case-insensitive Animation",
            (false, Anime, &["aNiMaTiOn"][..], NO_RANGE),
            vec![
                item("tt1", "Anime", current, &[CINEMETA_ANIME_GENRE]),
                item("tt2", "Live Action", current, &[]),
            ],
            &["tt1"],
        ),
    ] {
        let genres: Vec<_> = genres.iter().map(|genre| genre.to_string()).collect();
        let kept = if search {
            retain_search_items_matching_genres(items, &browse_genres(media_type, &genres))
        } else {
            apply_browse_filters(items, media_type, &genres, range)
        };
        assert_eq!(ids(&kept), expected, "{label}");
    }
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
fn should_continue_browse_fetch_fills_sparse_pages_until_bound() {
    assert!(should_continue_browse_fetch(0, Some(50), 1));
    // Sparse intersections fill until the page is a usable batch.
    assert!(should_continue_browse_fetch(3, Some(50), 1));
    assert!(!should_continue_browse_fetch(24, Some(50), 1));
    assert!(!should_continue_browse_fetch(0, None, 1));
    assert!(!should_continue_browse_fetch(0, Some(50), 8));
}

#[test]
fn browse_year_catalog_serves_only_single_year_genre_free_popular_browse() {
    use SearchFeed::{Featured, Popular};
    use SearchMediaType::{Anime, Movie, Series};
    let single = SearchYearRange {
        year_from: Some(2024),
        year_to: Some(2024),
    };
    let range = SearchYearRange {
        year_from: Some(2020),
        year_to: Some(2024),
    };
    let action = vec!["Action".to_string()];
    for (label, feed, media_type, genres, range, expected) in [
        ("Popular movie", Popular, Movie, &[][..], single, Some(2024)),
        (
            "Popular series",
            Popular,
            Series,
            &[][..],
            single,
            Some(2024),
        ),
        ("Featured ordering", Featured, Movie, &[][..], single, None),
        ("Anime routing", Popular, Anime, &[][..], single, None),
        ("genre-filtered", Popular, Movie, &action, single, None),
        ("multi-year", Popular, Movie, &[][..], range, None),
        ("unrestricted-year", Popular, Movie, &[][..], NO_RANGE, None),
    ] {
        assert_eq!(
            browse_year_catalog(feed, media_type, genres, range),
            expected,
            "{label}"
        );
    }
}
