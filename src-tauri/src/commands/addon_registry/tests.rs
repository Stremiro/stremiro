use super::{
    add_subtitle_if_unique, addon_allows_catalog, addon_allows_subtitles,
    catalog_fetch_page_from_source, catalog_page_next_skip, extra_skip_value, merge_catalog_pages,
    searchable_catalog_ids, CatalogFetchPage, SourcedAddonSubtitle,
};
use crate::commands::config_store::AddonConfig;
use crate::providers::addon_manifest::parse_addon_manifest;
use crate::providers::addon_resource::{AddonSubtitle, CatalogExtra, CatalogPage};
use crate::test_helpers::{cinemeta_addon, classified_cinemeta_addon, test_media_item};
use std::collections::HashSet;

#[test]
fn classified_search_uses_only_declared_search_catalogs() {
    let addon = classified_cinemeta_addon();
    assert_eq!(searchable_catalog_ids(&addon, "movie"), vec!["top"]);
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
    assert_eq!(searchable_catalog_ids(&addon, "movie"), vec!["top"]);
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
    assert_eq!(catalog_page_next_skip(0, 50), Some(50));
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

#[test]
fn subtitle_routing_follows_declared_resource_type_and_prefix() {
    let addon = subtitle_addon();
    assert!(addon_allows_subtitles(&addon, "movie", "tt1234567"));
    assert!(addon_allows_subtitles(&addon, "series", "tt1234567:1:2"));
    assert!(!addon_allows_subtitles(&addon, "movie", "kitsu:42"));

    let catalog_only = classified_cinemeta_addon();
    assert!(!addon_allows_subtitles(&catalog_only, "movie", "tt1234567"));

    let unclassified = AddonConfig {
        capabilities: None,
        ..addon
    };
    assert!(addon_allows_subtitles(&unclassified, "movie", "tt1234567"));
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
    add_subtitle_if_unique(&mut subtitles, &mut seen, &addon, subtitle("ENG"));
    assert_eq!(subtitles.len(), 2);
}
