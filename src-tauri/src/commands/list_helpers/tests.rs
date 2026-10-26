use super::{
    normalize_list_id, normalize_smart_list_library, reorder_known_ids, smart_list_items,
    validate_smart_list_rules, ListErrorKind, SmartListRules, UserList, WatchStatus,
    MAX_LIST_ITEMS,
};
use crate::test_helpers::test_media_item;
use std::collections::HashMap;

#[test]
fn smart_list_rules_validate_bounds_and_dedupe_facets() {
    for rules in [
        SmartListRules::default(),
        SmartListRules {
            year_from: Some(1888),
            ..Default::default()
        },
        SmartListRules {
            year_to: Some(2101),
            ..Default::default()
        },
        SmartListRules {
            year_from: Some(2025),
            year_to: Some(2020),
            ..Default::default()
        },
        SmartListRules {
            genres: ids(&[" "]),
            ..Default::default()
        },
        SmartListRules {
            genres: vec!["x".repeat(65)],
            ..Default::default()
        },
        SmartListRules {
            genres: vec!["Drama".into(); 13],
            ..Default::default()
        },
        SmartListRules {
            media_type: Some("other".into()),
            ..Default::default()
        },
    ] {
        assert_eq!(
            validate_smart_list_rules(rules).unwrap_err().kind,
            ListErrorKind::InvalidRules
        );
    }
    let rules = validate_smart_list_rules(SmartListRules {
        media_type: Some(" ANIME ".into()),
        genres: ids(&[" Drama ", "DRAMA", "Comedy"]),
        statuses: vec![
            WatchStatus::Watching,
            WatchStatus::Watching,
            WatchStatus::Dropped,
        ],
        year_from: Some(1889),
        year_to: Some(2100),
    })
    .unwrap();
    assert_eq!(rules.media_type.as_deref(), Some("series"));
    assert_eq!(rules.genres, ids(&["Drama", "Comedy"]));
    assert_eq!(
        rules.statuses,
        [WatchStatus::Watching, WatchStatus::Dropped]
    );
}

#[test]
fn smart_list_evaluation_intersects_rules_preserves_order_and_caps_members() {
    let mut anime = test_media_item("anime", "anime");
    anime.genres = Some(ids(&["drAMA"]));
    anime.primary_year = Some(2020);
    let mut series = anime.clone();
    series.id = "series".into();
    series.type_ = "series".into();
    series.primary_year = Some(2024);
    let mut movie = anime.clone();
    movie.id = "movie".into();
    movie.type_ = "movie".into();
    let mut unknown = series.clone();
    unknown.id = "unknown".into();
    unknown.primary_year = None;
    let library = vec![series, movie, anime, unknown];
    let statuses = HashMap::from([
        ("series".into(), "watching".into()),
        ("anime".into(), "watched".into()),
        ("unknown".into(), "watching".into()),
    ]);
    let mut rules = validate_smart_list_rules(SmartListRules {
        media_type: Some("series".into()),
        genres: ids(&["Drama", "Comedy"]),
        statuses: vec![WatchStatus::Watching, WatchStatus::Watched],
        year_from: Some(2020),
        year_to: Some(2024),
    })
    .unwrap();
    let normalized_library = normalize_smart_list_library(&library);
    let member_ids = |rules: &SmartListRules, statuses: &HashMap<String, String>| {
        smart_list_items(rules, &normalized_library, statuses)
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>()
    };
    assert_eq!(member_ids(&rules, &statuses), ["series", "anime"]);
    assert!(member_ids(&rules, &HashMap::new()).is_empty());
    rules.year_to = Some(2020);
    assert_eq!(member_ids(&rules, &statuses), ["anime"]);
    rules.genres = ids(&["Horror"]);
    assert!(member_ids(&rules, &statuses).is_empty());
    let rules = SmartListRules {
        media_type: Some("movie".into()),
        ..Default::default()
    };
    assert_eq!(member_ids(&rules, &statuses), ["movie"]);
    assert_eq!(
        smart_list_items(
            &rules,
            &normalize_smart_list_library(&vec![library[1].clone(); MAX_LIST_ITEMS + 1]),
            &statuses
        )
        .count(),
        MAX_LIST_ITEMS
    );
}

#[test]
fn smart_list_manual_membership_gate_is_typed_and_backup_rules_are_optional() {
    let mut list: UserList = serde_json::from_value(serde_json::json!({
        "id": "list_a", "name": "List", "icon": "list", "item_ids": [],
    }))
    .unwrap();
    assert!(list.require_manual().is_ok());
    list.rules = Some(SmartListRules {
        year_from: Some(2020),
        ..Default::default()
    });
    let error = list.require_manual().unwrap_err();
    assert_eq!(error.kind, ListErrorKind::SmartListReadOnly);
    let fixture = crate::test_helpers::test_store();
    let mut wire = serde_json::to_value(&list).unwrap();
    wire["items"] = serde_json::json!([]);
    let prepared = crate::commands::backup_commands::prepare_import_lists(
        vec![wire.clone()],
        &[],
        &fixture.store,
    )
    .unwrap();
    assert_eq!(prepared[0].rules, list.rules);
    wire["rules"] = serde_json::json!({ "statuses": ["invalid"] });
    let prepared =
        crate::commands::backup_commands::prepare_import_lists(vec![wire], &[], &fixture.store)
            .unwrap();
    assert!(prepared[0].rules.is_none());
}

#[test]
fn list_id_gate_accepts_generated_shape_and_rejects_key_probes() {
    assert_eq!(
        normalize_list_id("list_0123456789abcdef0123456789abcdef").as_deref(),
        Some("list_0123456789abcdef0123456789abcdef")
    );
    // Store keys are `list:{id}` — separators or prefixes would probe or
    // collide onto another key namespace.
    for hostile in [
        "",
        "   ",
        "null",
        "list:other",
        "list_item:x:y",
        "../escape",
        &"a".repeat(65),
    ] {
        assert_eq!(normalize_list_id(hostile), None, "input: {hostile:?}");
    }
}

fn ids(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

#[test]
fn reorder_known_ids_keeps_requested_order_and_appends_omitted() {
    let current = ids(&["a", "b", "c"]);
    // Omitted ids keep their items, appended in current order — a stale
    // snapshot payload must not drop entries added after it was captured.
    assert_eq!(
        reorder_known_ids(&current, ids(&["c", "a"])),
        ids(&["c", "a", "b"])
    );
}

#[test]
fn reorder_known_ids_ignores_unknown_and_duplicate_requested_ids() {
    let current = ids(&["a", "b", "c"]);
    assert_eq!(
        reorder_known_ids(&current, ids(&["ghost", "b", "b", "a"])),
        ids(&["b", "a", "c"])
    );
}

#[test]
fn reorder_known_ids_empty_request_preserves_current_order() {
    let current = ids(&["a", "b"]);
    assert_eq!(reorder_known_ids(&current, Vec::new()), ids(&["a", "b"]));
}

#[test]
fn reorder_known_ids_dedupes_corrupt_repeated_current_ids() {
    let current = ids(&["a", "b", "a"]);
    assert_eq!(
        reorder_known_ids(&current, ids(&["b", "a"])),
        ids(&["b", "a"])
    );
    // Even an empty request cannot resurrect the corrupt duplicate.
    assert_eq!(reorder_known_ids(&current, Vec::new()), ids(&["a", "b"]));
}
