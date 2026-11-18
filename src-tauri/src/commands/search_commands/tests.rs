use super::{
    apply_browse_filters, browse_year_catalog, catalog_browse_extras, catalog_fetch_genres,
    normalize_genres, rank_search_results, retain_matching_search_items, SearchFeed,
    SearchMediaType, SearchYearRange, CINEMETA_ANIME_GENRE,
};
use crate::commands::media_normalization::normalize_media_item;
use crate::providers::addon_manifest::parse_addon_manifest;
use crate::providers::MediaItem;
use crate::test_helpers::{addon_at, stalled_listener, test_media_item, TestHttpServer};

fn search_criteria(value: serde_json::Value) -> super::SearchCatalogCriteria {
    super::build_search_criteria(serde_json::from_value(value).unwrap()).unwrap()
}

fn browse_page(items: Vec<MediaItem>, next_skip: Option<u32>) -> super::CatalogFetchPage {
    super::CatalogFetchPage {
        items,
        partial: false,
        next_skip,
    }
}

type BrowseOutcome = Option<Result<(super::CatalogFetchPage, super::BrowseCursorClaims), String>>;

fn ok_page(
    items: Vec<MediaItem>,
    next_skip: Option<u32>,
    claims: super::BrowseCursorClaims,
) -> BrowseOutcome {
    Some(Ok((browse_page(items, next_skip), claims)))
}

fn err_page(error: &str) -> BrowseOutcome {
    Some(Err(error.into()))
}

fn all_cursors(
    movie: Option<u32>,
    series: Option<u32>,
    addon: Option<u32>,
) -> Option<super::AllBrowseCursors> {
    Some(super::AllBrowseCursors {
        movie,
        series,
        addon,
    })
}

fn all_browse_continuation(
    movie: Option<u32>,
    series: Option<u32>,
    addon: Option<u32>,
) -> super::SearchCatalogContinuation {
    super::SearchCatalogContinuation {
        all_cursors: all_cursors(movie, series, addon),
        ..Default::default()
    }
}

fn skip_continuation(skip: u32) -> super::SearchCatalogContinuation {
    super::SearchCatalogContinuation {
        skip: Some(skip),
        ..Default::default()
    }
}

fn genres_of(genres: &[&str]) -> Vec<String> {
    genres.iter().map(|genre| genre.to_string()).collect()
}

fn genre_item(id: &str, type_: &str, genres: &[&str]) -> MediaItem {
    MediaItem {
        genres: Some(genres_of(genres)),
        ..test_media_item(id, type_)
    }
}

#[test]
fn title_search_normalizes_and_rejects_links_before_provider_requests() {
    for query in [
        "The Age of Shadows",
        "the age of shadows",
        "  THE AGE OF SHADOWS\n",
    ] {
        let criteria = search_criteria(serde_json::json!({"query": query}));
        assert_eq!(criteria.query.as_deref(), Some("the age of shadows"));
    }
    let criteria = search_criteria(serde_json::json!({"query": "東京 Amélie"}));
    assert_eq!(criteria.query.as_deref(), Some("東京 amélie"));
    for query in [
        "stremiro://addon.example/test-token/manifest.json",
        "  STREMIRO://details/movie/tt1 ",
        "\u{feff}stremiro://addon.example/test-token",
    ] {
        let request = serde_json::from_value(serde_json::json!({"query": query})).unwrap();
        assert!(super::build_search_criteria(request).is_err(), "{query}");
    }
}

#[test]
fn all_browse_interleaves_without_cloning_and_stops_nonadvancing_cursors() {
    let page = |ids: &[&str], next_skip| {
        ok_page(
            ids.iter().map(|id| test_media_item(id, "movie")).collect(),
            next_skip,
            Default::default(),
        )
    };
    let merged = super::merge_all_browse_pages(
        all_browse_continuation(Some(0), Some(100), None),
        page(&["m1", "m2", "m3"], Some(100)),
        page(&["s1"], Some(100)),
        None,
    )
    .unwrap();
    assert_eq!(ids(&merged.items), ["m1", "s1", "m2", "m3"]);
    assert_eq!(
        serde_json::to_value(&merged).unwrap()["continuation"]["allCursors"],
        serde_json::json!({"movie": 100})
    );
    assert_eq!(merged.continuation.skip, None);
    assert!(!merged.exhausted);
    assert!(!merged.partial);
}

#[test]
fn all_browse_addon_cursor_advances_on_fresh_pages_and_old_continuations_parse() {
    // Continuations persisted before the addon branch existed still parse.
    let old = serde_json::from_value::<super::SearchCatalogContinuation>(serde_json::json!({
        "allCursors": {"movie": 0, "series": 100},
        "seenKeys": []
    }))
    .unwrap();
    assert_eq!(old.all_cursors, all_cursors(Some(0), Some(100), None));

    let continuation = || all_browse_continuation(None, None, Some(0));
    let addon_page = |next_skip| {
        ok_page(
            vec![test_media_item("c1", "Channel")],
            next_skip,
            search_claims(&[("channel:c1", Some(2))]),
        )
    };

    let merged =
        super::merge_all_browse_pages(continuation(), None, None, addon_page(Some(100))).unwrap();
    assert_eq!(ids(&merged.items), ["c1"]);
    // Manifest-faithful type survives the merge.
    assert_eq!(merged.items[0].type_, "Channel");
    assert_eq!(
        merged.continuation.all_cursors,
        all_cursors(None, None, Some(100))
    );
    assert!(!merged.exhausted);

    // A page that only replays an already-claimed item must exhaust the
    // branch instead of looping on the same skip forever.
    let replayed =
        super::merge_all_browse_pages(merged.continuation, None, None, addon_page(Some(200)))
            .unwrap();
    assert!(replayed.items.is_empty());
    assert_eq!(
        replayed.continuation.all_cursors,
        all_cursors(None, None, None)
    );
    assert!(replayed.exhausted);
}

#[test]
fn all_browse_keeps_partial_success_and_retries_only_active_failed_branches() {
    let continuation = || all_browse_continuation(Some(0), Some(100), None);
    let merged = super::merge_all_browse_pages(
        continuation(),
        err_page("movie offline"),
        ok_page(vec![], None, Default::default()),
        None,
    )
    .unwrap();
    assert!(merged.items.is_empty());
    assert!(merged.partial);
    assert_eq!(
        merged.continuation.all_cursors,
        all_cursors(Some(0), None, None)
    );
    assert!(!merged.exhausted);
    assert_eq!(
        super::merge_all_browse_pages(continuation(), err_page("first"), err_page("second"), None,)
            .unwrap_err(),
        "first"
    );
    assert_eq!(
        super::merge_all_browse_pages(merged.continuation, err_page("retry failed"), None, None)
            .unwrap_err(),
        "retry failed"
    );
    let merged = super::merge_all_browse_pages(
        all_browse_continuation(None, Some(100), None),
        None,
        ok_page(
            vec![test_media_item("s", "series")],
            Some(200),
            Default::default(),
        ),
        None,
    )
    .unwrap();
    assert_eq!(
        merged.continuation.all_cursors,
        all_cursors(None, Some(200), None)
    );
}

#[test]
fn all_browse_preserves_failures_inside_a_media_type() {
    let page = super::super::addon_registry::merge_catalog_pages(
        [
            Ok(browse_page(vec![test_media_item("tt1", "movie")], None)),
            Err("secondary catalog offline".into()),
        ],
        "catalog failed",
    )
    .unwrap();
    let page =
        super::super::addon_registry::merge_catalog_pages([Ok(page)], "catalog failed").unwrap();
    let merged = super::merge_all_browse_pages(
        all_browse_continuation(Some(0), None, None),
        Some(Ok((page, Default::default()))),
        None,
        None,
    )
    .unwrap();
    assert_eq!(ids(&merged.items), ["tt1"]);
    assert!(merged.partial);
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
        all_cursors(Some(0), Some(0), None)
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
        skip_continuation(0),
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
fn catalog_identity_preserves_delimiters_in_types_and_ids_across_pages() {
    let first = super::finish_catalog_page(
        vec![test_media_item("station", "radio:live")],
        skip_continuation(0),
        Some(1),
        None,
        None,
        Default::default(),
    );
    let second = super::finish_catalog_page(
        vec![
            test_media_item("live:station", "radio"),
            test_media_item("station", "radio:live"),
        ],
        first.continuation,
        Some(2),
        None,
        None,
        Default::default(),
    );
    assert_eq!(ids(&second.items), ["live:station"]);
    assert_eq!(second.continuation.seen_keys.len(), 2);
}

#[test]
fn all_browse_fresh_but_overlapping_pages_continue_and_replays_stop_independently() {
    let branch = |id, skip, index| {
        let key = super::catalog_dedup_key("movie", id);
        ok_page(
            vec![test_media_item(id, "movie")],
            Some(skip),
            search_claims(&[(&key, Some(index))]),
        )
    };
    let first = super::merge_all_browse_pages(
        all_browse_continuation(Some(0), Some(0), None),
        branch("a", 1, 0),
        branch("b", 1, 1),
        None,
    )
    .unwrap();
    let second = super::merge_all_browse_pages(
        first.continuation,
        branch("b", 2, 0),
        branch("b", 2, 1),
        None,
    )
    .unwrap();
    assert!(second.items.is_empty());
    assert_eq!(
        second.continuation.all_cursors,
        all_cursors(Some(2), None, None)
    );
    let last =
        super::merge_all_browse_pages(second.continuation, branch("c", 3, 0), None, None).unwrap();
    assert_eq!(ids(&last.items), ["c"]);
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
                seen_keys: vec!["5:movie:tt1".into()],
                ..skip_continuation(100)
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
        all_browse_continuation(Some(0), None, None),
        ok_page(vec![], None, Default::default()),
        None,
        None,
    )
    .unwrap();
    assert!(page.exhausted);
}

#[test]
fn all_browse_overlapping_filtered_items_keep_both_cursors_until_replayed() {
    let mut continuation = all_browse_continuation(Some(0), Some(0), None);
    for skip in [50, 100] {
        let branch = |index| {
            ok_page(
                vec![],
                Some(skip),
                search_claims(&[("5:movie:shared", Some(index))]),
            )
        };
        let page = super::merge_all_browse_pages(continuation, branch(0), branch(1), None).unwrap();
        let expected = (skip == 50).then_some(skip);
        assert_eq!(
            page.continuation.all_cursors,
            all_cursors(expected, expected, None)
        );
        assert_eq!(page.exhausted, skip != 50);
        assert!(page.items.is_empty());
        continuation = page.continuation;
    }
}

#[test]
fn browse_filtered_titles_advance_once_and_branches_stop_independently() {
    let claims = || search_claims(&[("5:movie:old", Some(0))]);
    let first = super::finish_catalog_page(
        vec![],
        skip_continuation(100),
        Some(200),
        None,
        None,
        claims(),
    );
    assert!(first.items.is_empty());
    assert_eq!(first.continuation.skip, Some(200));
    assert!(first.continuation.seen_keys.is_empty());
    assert!(!first.exhausted);
    let replayed =
        super::finish_catalog_page(vec![], first.continuation, Some(300), None, None, claims());
    assert!(replayed.exhausted);
    let merged = super::merge_all_browse_pages(
        super::SearchCatalogContinuation {
            all_cursors: all_cursors(Some(100), Some(100), None),
            source_pages: replayed.continuation.source_pages,
            ..Default::default()
        },
        ok_page(vec![], Some(200), claims()),
        ok_page(
            vec![],
            Some(200),
            search_claims(&[("6:series:new", Some(1))]),
        ),
        None,
    )
    .unwrap();
    assert!(merged.items.is_empty());
    assert_eq!(
        merged.continuation.all_cursors,
        all_cursors(None, Some(200), None)
    );
    assert!(!merged.exhausted);
}

#[test]
fn search_catalog_seen_key_bound_validates_and_ends_paging() {
    let seen_keys: Vec<_> = (0..super::MAX_CATALOG_SEEN_KEYS - 1)
        .map(|id| format!("5:movie:{id}"))
        .collect();
    let page = super::finish_catalog_page(
        vec![
            test_media_item("last", "movie"),
            test_media_item("overflow", "movie"),
        ],
        super::SearchCatalogContinuation {
            seen_keys,
            ..skip_continuation(100)
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
    let longest_key =
        super::catalog_dedup_key(&"😀".repeat(2_048), &"x".repeat(super::MEDIA_ID_MAX_CHARS));
    assert!(longest_key.starts_with("8192:"));
    assert_eq!(
        longest_key.chars().count(),
        super::MAX_CATALOG_SEEN_KEY_CHARS
    );
    assert!(super::build_search_criteria(request(&[longest_key])).is_ok());
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
        vec!["5:movie:duplicate".into(); super::MAX_CATALOG_SEEN_KEYS + 1],
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
        page_hash: None,
    }
}

#[test]
fn text_search_allows_a_later_verified_title_and_stops_replayed_pages() {
    let cursor = super::SearchSourceCursor {
        page_hash: Some("a".repeat(16)),
        ..search_cursor("0123456789abcdef", 100, false)
    };
    let first = super::finish_catalog_page(
        vec![],
        super::SearchCatalogContinuation::default(),
        None,
        None,
        Some(vec![
            cursor.clone(),
            search_cursor("1123456789abcdef", 0, true),
        ]),
        search_claims(&[("5:movie:tt1", Some(0))]),
    );
    assert!(!first.exhausted);
    assert!(first.continuation.seen_keys.is_empty());

    let criteria = search_criteria(serde_json::json!({
        "query": "Match",
        "continuation": serde_json::to_value(&first).unwrap()["continuation"],
    }));
    let later_source = super::SearchSourceCursor {
        key: "1123456789abcdef".into(),
        ..cursor
    };
    let next = super::finish_catalog_page(
        vec![genre_item("tt1", "movie", &["Action"])],
        criteria.continuation,
        None,
        None,
        Some(vec![super::SearchSourceCursor {
            skip: 200,
            ..later_source.clone()
        }]),
        search_claims(&[("5:movie:tt1", Some(0))]),
    );
    assert_eq!(ids(&next.items), ["tt1"]);
    assert!(!next.exhausted);

    let replayed = super::finish_catalog_page(
        vec![genre_item("tt1", "movie", &["Action"])],
        next.continuation,
        None,
        None,
        Some(vec![super::SearchSourceCursor {
            skip: 300,
            ..later_source
        }]),
        search_claims(&[("5:movie:tt1", Some(0))]),
    );
    assert!(replayed.items.is_empty());
    assert!(replayed.exhausted);
}

fn search_claims(claims: &[(&str, Option<usize>)]) -> super::BrowseCursorClaims {
    claims
        .iter()
        .map(|(key, claimant)| {
            (
                (*key).to_string(),
                claimant.map_or(0, |index| 1_u8 << index),
            )
        })
        .collect()
}

#[test]
fn text_search_without_skip_support_serves_page_one_and_exhausts() {
    let page = super::finish_catalog_page(
        vec![test_media_item("only", "movie")],
        skip_continuation(0),
        None,
        None,
        Some(Vec::new()),
        search_claims(&[("5:movie:only", None)]),
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
        poster: Some("https://example.com/poster.jpg".into()),
        description: Some("A title".into()),
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
fn search_regressions_rank_and_filter_provider_rows() {
    let rank = |query, items| rank_search_results(query, items, NO_RANGE);
    let up = vec![
        build_item("partial", "Upgrade", None),
        build_item("word", "Wake Up Dead Man", None),
    ];
    assert_eq!(ids(&rank("up", up)), ["word", "partial"]);
    let alien = vec![
        build_item("partial", "Alienated", None),
        build_item("plural", "Aliens", None),
    ];
    assert_eq!(ids(&rank("alien", alien)), ["plural", "partial"]);
    let mut posterless = build_item("posterless", "Naruto Extra", None);
    posterless.poster = None;
    // Search previews (Cinemeta included) carry no synopsis, so it is not a quality signal.
    let mut undescribed = build_item("undescribed", "Naruto More", None);
    undescribed.description = None;
    let rows = vec![
        build_item("real", "Naruto", Some("2002")),
        build_item("spoof", "Naruto: A Fandub Spoof", Some("2005")),
        posterless,
        undescribed,
    ];
    assert_eq!(ids(&rank("naruto", rows.clone())), ["real", "undescribed"]);
    assert_eq!(ids(&rank("naruto a fandub spoof", rows.clone())), ["spoof"]);
    assert_eq!(ids(&rank("naruto extra", rows.clone())), ["posterless"]);
    let dated_posterless = MediaItem {
        primary_year: Some(2002),
        ..rows[2].clone()
    };
    assert_eq!(
        ids(&rank(
            "naruto extra 2002",
            vec![rows[0].clone(), dated_posterless]
        )),
        ["posterless"]
    );
    // Fuzzy provider hits (typos, aliases) survive only when nothing matches by title.
    assert_eq!(ids(&rank("narto", rows[..2].to_vec())), ["real"]);
    let mut first = build_item("dup", "Naruto Shippuden", Some("2007"));
    first.poster = None;
    let mut credit = build_item("dup", "Other", Some("2020"));
    credit.matches_search_credit = true;
    let dup = rank("naruto", vec![first, credit]);
    assert_eq!(dup.len(), 1);
    assert!(dup[0].matches_search_credit && dup[0].poster.is_some());
}

#[test]
fn search_duplicates_keep_matching_titles_and_missing_preview_metadata() {
    let first = MediaItem {
        poster: None,
        description: None,
        matches_search_credit: true,
        ..build_item("same", "Sen to Chihiro no Kamikakushi", Some("2000"))
    };
    let matching = MediaItem {
        backdrop: Some("https://example.com/backdrop.jpg".into()),
        logo: Some("https://example.com/logo.png".into()),
        genres: Some(vec!["Animation".into()]),
        ..build_item("same", "Spirited Away", Some("2001"))
    };
    for query in ["spirited away", "spirited away 2001"] {
        for copies in [
            vec![first.clone(), matching.clone()],
            vec![matching.clone(), first.clone()],
        ] {
            let rows = rank_search_results(query, copies, NO_RANGE);
            assert_eq!(rows.len(), 1);
            let row = &rows[0];
            assert_eq!(
                serde_json::to_value(row).unwrap(),
                serde_json::to_value(&matching).unwrap()
            );
            assert!(row.matches_search_credit);
        }
    }
    let incomplete = MediaItem {
        poster: None,
        description: None,
        ..build_item("same", "Spirited Away", Some("TBA"))
    };
    let rows = rank_search_results(
        "spirited away",
        vec![incomplete, matching.clone()],
        NO_RANGE,
    );
    assert_eq!(
        serde_json::to_value(&rows[0]).unwrap(),
        serde_json::to_value(&matching).unwrap()
    );
    let without_credit = MediaItem {
        matches_search_credit: false,
        ..first
    };
    let related = build_item("related", "Spirited Away: Making Of", Some("2001"));
    assert_eq!(
        ids(&rank_search_results(
            "spirited away",
            vec![without_credit, related, matching],
            NO_RANGE
        )),
        ["same", "related"]
    );
}

#[test]
fn filtered_search_copies_do_not_hide_a_valid_duplicate() {
    let valid = build_item("same", "About Naruto", Some("2002"));
    let spoof = build_item("same", "Naruto Spoof", Some("2002"));
    for copies in [vec![valid.clone(), spoof.clone()], vec![spoof, valid]] {
        let rows = rank_search_results("naruto", copies, NO_RANGE);
        assert_eq!(ids(&rows), ["same"]);
        assert_eq!(rows[0].title, "About Naruto");
    }
}

#[test]
fn search_regressions_validate_result_type() {
    let rows = vec![
        build_item("m", "Film", None),
        MediaItem {
            type_: " SERIES ".into(),
            genres: Some(vec!["Animation".into()]),
            ..build_item("s", "Series", None)
        },
        MediaItem {
            type_: "channel".into(),
            genres: Some(vec!["Animation".into()]),
            ..build_item("c", "Channel", None)
        },
    ];
    for (media_type, expected) in [
        (Some(SearchMediaType::Movie), &["m"][..]),
        (Some(SearchMediaType::Series), &["s"]),
        (Some(SearchMediaType::Anime), &["s"]),
        (None, &["m", "s", "c"]),
    ] {
        assert_eq!(
            ids(&retain_matching_search_items(rows.clone(), &[], media_type)),
            expected
        );
    }
}

#[test]
fn empty_primary_titles_do_not_hide_titled_fallbacks() {
    let empty = build_item("tt1", "\u{feff}\0", Some("2024"));
    let fallback = build_item("tt1", "Fallback", Some("2024"));
    let visible = build_item("tt2", "Visible", Some("2024"));
    let merged = crate::commands::addon_registry::merge_catalog_pages(
        [vec![empty], vec![fallback, visible]].map(|items| Ok(browse_page(items, None))),
        "empty",
    )
    .unwrap();
    assert_eq!(
        ids(&super::retain_titled_catalog_items(merged.items)),
        ["tt1", "tt2"]
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
        ["film", "bio"]
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
            ["exact", "prefix", "word", "contains"],
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
        ("ΟΣ", ("ος", None), ("Οσμή", None)),
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
            ))[0],
            "first",
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
        ("ΟΣ ος οσ", "οσ οσ οσ"),
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
async fn browse_returns_matches_promptly_and_stops_replayed_empty_pages() {
    let first = r#"{"metas":[{"id":"a","name":"A","type":"movie","genres":["Drama"]}]}"#;
    let second = r#"{"metas":[{"id":"b","name":"B","type":"movie","genres":["Drama"]}]}"#;
    for filtered in [false, true] {
        let server = TestHttpServer::new(
            [
                first, second, second, second, second, second, second, second,
            ]
            .into_iter()
            .map(|body| (200, body, None))
            .collect(),
        );
        let snapshot = [addon_at(&server.url, "catalog", "Catalog")];
        let criteria = search_criteria(serde_json::json!({
            "mediaType": "movie",
            "genres": if filtered { vec!["Action"] } else { vec![] },
        }));
        let (page, claims) = super::fetch_browse_page(
            &snapshot,
            &super::AddonResourceClient::new(),
            &criteria,
            SearchMediaType::Movie,
            0,
        )
        .await
        .unwrap();
        let requests = server.finish();
        assert_eq!(requests.len(), if filtered { 3 } else { 1 }, "{requests:?}");
        assert_eq!(claims.len(), if filtered { 2 } else { 1 });
        assert_eq!(ids(&page.items), if filtered { vec![] } else { vec!["a"] });
        assert_eq!(page.next_skip, if filtered { None } else { Some(1) });
    }
}

#[tokio::test]
async fn browse_pages_past_overlap_without_requesting_offsets_from_static_catalogs() {
    let paged = TestHttpServer::new(vec![
        (
            200,
            r#"{"metas":[{"id":"a","name":"A","type":"movie"},{"id":"b","name":"B","type":"movie"}]}"#,
            None,
        ),
        (
            200,
            r#"{"metas":[{"id":"shared","name":"Shared","type":"movie"}]}"#,
            None,
        ),
        (
            200,
            r#"{"metas":[{"id":"later","name":"Later","type":"movie"}]}"#,
            None,
        ),
    ]);
    let fixed = TestHttpServer::new(vec![(
        200,
        r#"{"metas":[{"id":"shared","name":"Shared","type":"movie"}]}"#,
        None,
    )]);
    let addon = |url, id, manifest: &[u8]| super::AddonConfig {
        capabilities: Some(parse_addon_manifest(manifest).unwrap()),
        ..addon_at(url, id, id)
    };
    let addons = [
        addon(&paged.url, "paged", br#"{"name":"Paged","catalogs":[{"type":"movie","id":"top","extraSupported":["skip"]}]}"#),
        addon(&fixed.url, "fixed", br#"{"name":"Fixed","catalogs":[{"type":"movie","id":"top"}]}"#),
    ];
    let client = super::AddonResourceClient::new();
    let mut criteria = search_criteria(serde_json::json!({"mediaType":"movie"}));
    for (expected_ids, next_skip) in [
        (&["a", "b", "shared"][..], 2),
        (&[][..], 3),
        (&["later"][..], 4),
    ] {
        let (page, claims) = super::fetch_browse_page(
            &addons,
            &client,
            &criteria,
            SearchMediaType::Movie,
            criteria.continuation.skip.unwrap(),
        )
        .await
        .unwrap();
        let page = super::finish_catalog_page(
            page.items,
            criteria.continuation,
            page.next_skip,
            None,
            None,
            claims,
        );
        assert_eq!(ids(&page.items), expected_ids);
        assert_eq!(page.continuation.skip, Some(next_skip));
        // Verify the next page accepts the IPC's serialized continuation.
        criteria = search_criteria(serde_json::json!({
            "mediaType":"movie", "continuation": page.continuation
        }));
    }
    assert_eq!(fixed.finish(), ["/catalog/movie/top.json"]);
    assert_eq!(
        paged.finish(),
        [
            "/catalog/movie/top.json",
            "/catalog/movie/top/skip=2.json",
            "/catalog/movie/top/skip=3.json"
        ]
    );
}

#[tokio::test]
async fn anime_browse_filters_animation_pages_and_preserves_continuation() {
    let server = TestHttpServer::new(vec![
        (
            200,
            r#"{"metas":[
            {"id":"action","name":"Action","type":"series","year":"2026","genres":["Animation","Action"]},
            {"id":"comedy","name":"Comedy","type":"series","year":"2026","genres":["Animation","Comedy"]},
            {"id":"older","name":"Older","type":"series","year":"2025","genres":["Animation","Action"]},
            {"id":"live","name":"Live","type":"series","year":"2026","genres":["Action"]}
        ]}"#,
            None,
        ),
        (
            200,
            r#"{"metas":[
            {"id":"next","name":"Next","type":"series","year":"2026","genres":["Animation","Action"]}
        ]}"#,
            None,
        ),
    ]);
    let snapshot = [super::AddonConfig {
        capabilities: Some(parse_addon_manifest(br#"{
            "name":"Catalog","catalogs":[{"type":"series","id":"top","extra":[{"name":"genre"},{"name":"skip"}]}]
        }"#).unwrap()),
        ..addon_at(&server.url, "catalog", "Catalog")
    }];
    let criteria = search_criteria(serde_json::json!({
        "mediaType":"anime", "genres":["Action"], "yearFrom":2026, "yearTo":2026
    }));
    let client = super::AddonResourceClient::new();
    let (first, _) =
        super::fetch_browse_page(&snapshot, &client, &criteria, SearchMediaType::Anime, 0)
            .await
            .unwrap();
    assert_eq!(ids(&first.items), ["action"]);
    assert_eq!(first.next_skip, Some(4));
    let comedy_criteria = super::SearchCatalogCriteria {
        genres: vec!["Comedy".to_string()],
        ..search_criteria(serde_json::json!({"mediaType":"anime"}))
    };
    let (comedy, _) = super::fetch_browse_page(
        &snapshot,
        &client,
        &comedy_criteria,
        SearchMediaType::Anime,
        0,
    )
    .await
    .unwrap();
    assert_eq!(ids(&comedy.items), ["comedy"]);
    let (second, _) = super::fetch_browse_page(
        &snapshot,
        &client,
        &criteria,
        SearchMediaType::Anime,
        first.next_skip.unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(ids(&second.items), ["next"]);
    assert_eq!(second.next_skip, Some(5));
    assert_eq!(
        server.finish(),
        [
            "/catalog/series/top/genre=Animation.json",
            "/catalog/series/top/genre=Animation&skip=4.json",
        ]
    );
}

#[tokio::test]
async fn empty_filtered_browse_keeps_a_bounded_resumable_cursor() {
    let server = TestHttpServer::new(
        (0..8)
            .map(|index| {
                let body = format!(
                    r#"{{"metas":[{{"id":"{index}","name":"Filtered","type":"movie","genres":["Drama"]}}]}}"#
                );
                (200, Box::leak(body.into_boxed_str()) as &str, None)
            })
            .collect(),
    );
    let criteria = search_criteria(serde_json::json!({"mediaType":"movie","genres":["Action"]}));
    let snapshot = [addon_at(&server.url, "catalog", "Catalog")];
    let (page, claims) = super::fetch_browse_page(
        &snapshot,
        &super::AddonResourceClient::new(),
        &criteria,
        SearchMediaType::Movie,
        0,
    )
    .await
    .unwrap();
    assert!(page.items.is_empty());
    assert_eq!(claims.len(), 8);
    assert_eq!(page.next_skip, Some(8));
    assert_eq!(server.finish().len(), 8);
}

#[tokio::test]
async fn browse_trusts_only_declared_provider_genres_and_enforces_other_filters() {
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
            capabilities,
            ..addon_at(&server.url, "catalog", "Catalog")
        }];
        let page = super::fetch_registry_browse_pages(
            &snapshot,
            &super::AddonResourceClient::new(),
            SearchMediaType::Movie,
            "top",
            &[Some("Action")],
            &[0],
            None,
        )
        .await
        .pop()
        .unwrap()
        .unwrap();
        let genres = genres_of(&["Action", "Drama"]);
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
            ids(&retain_matching_search_items(
                page.items.clone(),
                &genres,
                Some(SearchMediaType::Movie),
            )),
            ["both"],
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
        assert_eq!(page.next_skip, declares_genre.is_none().then_some(5));
        let path = if declares_genre == Some(false) {
            "/catalog/movie/top.json"
        } else {
            "/catalog/movie/top/genre=Action.json"
        };
        assert_eq!(server.finish(), [path]);
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
        item.genres = (!genres.is_empty()).then(|| genres_of(genres));
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
            "unverified search hits do not bypass filters",
            (true, Anime, &["Action"][..], NO_RANGE),
            vec![
                item("tt1", "Solo Leveling", current, &[]),
                item("tt2", "Anime Action", current, &["Animation", "Action"]),
                item("tt3", "Live Action", current, &["Action"]),
            ],
            &["tt2"],
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
        let genres = genres_of(genres);
        let kept = if search {
            retain_matching_search_items(items, &genres, Some(media_type))
        } else {
            apply_browse_filters(items, media_type, &genres, range)
        };
        assert_eq!(ids(&kept), expected, "{label}");
    }
}

#[test]
fn anime_search_requires_verified_animation() {
    for genres in [vec![], vec!["animation".to_string()]] {
        let items = vec![
            test_media_item("unknown", "series"),
            genre_item("anime", "series", &["Animation"]),
            genre_item("live-action", "series", &["Drama"]),
        ];
        assert_eq!(
            ids(&retain_matching_search_items(
                items,
                &genres,
                Some(SearchMediaType::Anime)
            )),
            ["anime"],
        );
    }
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

#[tokio::test]
async fn filtered_search_uses_fallback_when_primary_has_no_genres() {
    let primary = TestHttpServer::new(vec![(
        200,
        r#"{"meta":{"id":"tt1","name":"Primary","type":"movie"}}"#,
        None,
    )]);
    let fallback = TestHttpServer::new(vec![(
        200,
        r#"{"meta":{"id":"tt1","name":"Fallback","type":"movie","genres":["Action"]}}"#,
        None,
    )]);
    let snapshot = [
        addon_at(&primary.url, "primary", "Primary"),
        addon_at(&fallback.url, "fallback", "Fallback"),
    ];
    let client = super::AddonResourceClient::new();
    let primary_details = super::super::addon_registry::fetch_meta_details_from_addons(
        &client, &snapshot, "movie", "tt1", None,
    )
    .await
    .unwrap();
    assert_eq!(primary_details.title, "Primary");
    assert!(primary_details.genres.is_none());
    let mut unknown = vec![test_media_item("tt1", "movie")];
    assert!(super::resolve_search_genres(&snapshot[..1], &client, &mut unknown, None).await);
    assert!(unknown[0].genres.is_none());
    for _ in 0..2 {
        let mut items = vec![test_media_item("tt1", "movie")];
        assert!(!super::resolve_search_genres(&snapshot, &client, &mut items, None).await);
        assert_eq!(items[0].genres, Some(genres_of(&["Action"])));
    }
    assert_eq!(primary.finish(), ["/meta/movie/tt1.json"]);
    assert_eq!(fallback.finish(), ["/meta/movie/tt1.json"]);
}

#[tokio::test]
async fn filtered_search_uses_ready_genres_before_batch_deadline() {
    use std::io::{BufRead, BufReader, Write};
    use std::time::Duration;

    let serve = |listener: std::net::TcpListener, delay: Duration, body: &'static str| {
        listener.set_nonblocking(true).unwrap();
        std::thread::spawn(move || {
            let started = std::time::Instant::now();
            let (mut socket, _) = loop {
                match listener.accept() {
                    Ok(connection) => break connection,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && started.elapsed() < Duration::from_secs(3) =>
                    {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("metadata connection failed: {error}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut reader = BufReader::new(&mut socket);
            let mut request = String::new();
            while !request.ends_with("\r\n\r\n") {
                assert!(reader.read_line(&mut request).unwrap() > 0);
            }
            std::thread::sleep(delay);
            let _ = write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        })
    };
    for primary_responds in [true, false] {
        let (primary, primary_url) = stalled_listener();
        let primary_server = primary_responds.then(|| {
            serve(
                primary.try_clone().unwrap(),
                Duration::from_millis(1500),
                r#"{"meta":{"id":"tt1","name":"Primary","type":"movie","genres":["Drama"]}}"#,
            )
        });
        let (fallback, fallback_url) = stalled_listener();
        let fallback_server = serve(
            fallback,
            Duration::from_millis(600),
            r#"{"meta":{"id":"tt1","name":"Fallback","type":"movie","genres":["Action"]}}"#,
        );
        let snapshot = [
            addon_at(&primary_url, "primary", "Primary"),
            addon_at(&fallback_url, "fallback", "Fallback"),
        ];
        let mut items = vec![test_media_item("tt1", "movie")];
        let client = super::AddonResourceClient::new();
        let partial = super::resolve_search_genres(&snapshot, &client, &mut items, None).await;
        fallback_server.join().unwrap();
        if let Some(server) = primary_server {
            server.join().unwrap();
        }
        assert!(!partial);
        let expected = if primary_responds { "Drama" } else { "Action" };
        assert_eq!(items[0].genres, Some(genres_of(&[expected])));
        assert!(!client.meta_is_recent_straggler(&snapshot[0].url, "movie", "tt1"));
    }
}

#[tokio::test]
async fn filtered_search_resolves_missing_genres_once_and_preserves_tagged_hits() {
    let server = TestHttpServer::new(vec![(
        200,
        r#"{"meta":{"id":"tt1","name":"Naruto","type":"series","genres":["Animation","Action"]}}"#,
        None,
    )]);
    let snapshot = [addon_at(&server.url, "meta", "Metadata")];
    let client = super::AddonResourceClient::new();
    let mut items = vec![
        test_media_item("tt1", "series"),
        genre_item("live-action", "series", &["Drama"]),
    ];
    assert!(!super::resolve_search_genres(&snapshot, &client, &mut items, None).await);
    assert_eq!(
        ids(&retain_matching_search_items(
            items.clone(),
            &[],
            Some(SearchMediaType::Anime)
        )),
        ["tt1"]
    );
    assert_eq!(
        ids(&retain_matching_search_items(
            items.clone(),
            &["Drama".into()],
            Some(SearchMediaType::Series)
        )),
        ["live-action"]
    );
    items[0].genres = None;
    assert!(!super::resolve_search_genres(&snapshot, &client, &mut items, None).await);
    assert_eq!(server.finish(), ["/meta/series/tt1.json"]);

    let mut unknown = vec![test_media_item("missing", "movie")];
    assert!(super::resolve_search_genres(&[], &client, &mut unknown, None).await);
    assert!(retain_matching_search_items(unknown.clone(), &["Drama".into()], None).is_empty());
    assert_eq!(
        ids(&retain_matching_search_items(unknown, &[], None)),
        ["missing"]
    );
}

#[tokio::test]
async fn filtered_search_duplicates_do_not_starve_cached_genres() {
    let server = TestHttpServer::new(vec![
        (
            200,
            r#"{"meta":{"id":"cached","name":"Movie","type":"movie","genres":["Action"]}}"#,
            None,
        ),
        (
            200,
            r#"{"meta":{"id":"cached","name":"Series","type":"series","genres":["Drama"]}}"#,
            None,
        ),
    ]);
    let cached_addon = addon_at(&server.url, "cached", "Cached");
    let client = super::AddonResourceClient::new();
    for type_ in ["movie", "series"] {
        super::super::addon_registry::fetch_meta_details_from_addons(
            &client,
            std::slice::from_ref(&cached_addon),
            type_,
            "cached",
            None,
        )
        .await
        .expect("metadata cache must be primed");
    }
    let (_stalled, stalled_url) = stalled_listener();
    let snapshot = [cached_addon, addon_at(&stalled_url, "stalled", "Stalled")];
    let mut items = vec![test_media_item("stalled", "movie"); 4];
    items.extend([
        test_media_item("cached", "movie"),
        MediaItem {
            title: "Second movie".into(),
            ..test_media_item("cached", "movie")
        },
        genre_item("cached", "movie", &["Comedy"]),
        test_media_item("cached", "series"),
    ]);

    assert!(super::resolve_search_genres(&snapshot, &client, &mut items, None).await);
    assert_eq!(items.len(), 8);
    assert!(items[..4].iter().all(|item| item.genres.is_none()));
    assert_eq!(items[4].genres, Some(genres_of(&["Action"])));
    assert_eq!(items[5].genres, items[4].genres);
    assert_eq!(items[5].title, "Second movie");
    assert_eq!(items[6].genres, Some(genres_of(&["Comedy"])));
    assert_eq!(items[7].genres, Some(genres_of(&["Drama"])));
    assert_eq!(
        ids(&retain_matching_search_items(
            items,
            &["Action".into()],
            None
        )),
        ["cached", "cached"]
    );
    assert!(server.finish().starts_with(&[
        "/meta/movie/cached.json".to_string(),
        "/meta/series/cached.json".to_string()
    ]));
}

#[tokio::test]
async fn filtered_search_groups_meta_fetches_across_type_casing_and_skips_other_types() {
    let server = TestHttpServer::new(vec![(
        200,
        r#"{"meta":{"id":"tt1","name":"Title","type":"movie","genres":["Action"]}}"#,
        None,
    )]);
    let snapshot = [addon_at(&server.url, "addon", "Addon")];
    let mut items = vec![
        test_media_item("tt1", "movie"),
        MediaItem {
            title: "Cased variant".into(),
            ..test_media_item("tt1", "Movie")
        },
    ];

    items.extend((0..4).map(|index| test_media_item(&format!("irrelevant-{index}"), "series")));
    assert!(
        !super::resolve_search_genres(
            &snapshot,
            &super::AddonResourceClient::new(),
            &mut items,
            Some(SearchMediaType::Movie),
        )
        .await
    );
    assert_eq!(items[0].genres, Some(genres_of(&["Action"])));
    assert_eq!(items[1].genres, items[0].genres);
    assert_eq!(items[1].title, "Cased variant");
    // Display dedup folds casing — the enrichment pass must not fan out twice.
    assert_eq!(server.finish(), ["/meta/movie/tt1.json".to_string()]);
}

#[tokio::test]
async fn filtered_search_bounds_stalled_metadata_and_keeps_completed_hits() {
    let (_stalled, stalled_url) = stalled_listener();
    let snapshot = [addon_at(&stalled_url, "stalled", "Stalled")];
    let mut items = vec![
        test_media_item("tt1", "movie"),
        genre_item("tagged", "movie", &["Action"]),
    ];
    tokio::time::timeout(
        super::SEARCH_GENRE_BUDGET + std::time::Duration::from_secs(1),
        async {
            assert!(
                super::resolve_search_genres(
                    &snapshot,
                    &super::AddonResourceClient::new(),
                    &mut items,
                    None
                )
                .await
            );
        },
    )
    .await
    .expect("metadata verification must respect the batch budget");
    assert_eq!(
        ids(&retain_matching_search_items(
            items,
            &["Action".into()],
            None
        )),
        ["tagged"]
    );
}

#[test]
fn catalog_fetch_genres_does_not_union_animation_with_extra_anime_filters() {
    for (media_type, genres, expected) in [
        (SearchMediaType::Anime, &[][..], &[CINEMETA_ANIME_GENRE][..]),
        (SearchMediaType::Anime, &["Action"], &["Action"]),
        (SearchMediaType::Movie, &["Action"], &["Action"]),
    ] {
        assert_eq!(
            catalog_fetch_genres(media_type, &genres_of(genres)),
            genres_of(expected)
        );
    }
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
