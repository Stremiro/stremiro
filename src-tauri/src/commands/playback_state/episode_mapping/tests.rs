use super::*;

#[test]
fn episode_mapping_key_merge_matches_single_insert_semantics() {
    for (existing, incoming) in [
        (vec![], vec![]),
        (vec![], vec!["b", "a", "b"]),
        (vec!["a", "c"], vec!["c", "a", "c"]),
        (vec!["a", "c"], vec!["d", "b", "a", "b"]),
        (vec!["a", "c"], vec![]),
    ] {
        let mut index: Vec<String> = existing.into_iter().map(str::to_string).collect();
        let mut expected = index.clone();
        let mut expected_changed = false;
        for key in &incoming {
            expected_changed |= super::super::insert_sorted_unique(&mut expected, key);
        }
        assert_eq!(
            merge_sorted_unique(
                &mut index,
                incoming.into_iter().map(str::to_string).collect()
            ),
            expected_changed
        );
        assert_eq!(index, expected);
        assert!(index.windows(2).all(|pair| pair[0] < pair[1]));
    }
}

// ── mapping_index_key_canonical_season ────────────────────────────────

#[test]
fn reads_season_from_the_right_of_an_index_key() {
    assert_eq!(
        mapping_index_key_canonical_season("series:tt2560140:1:4"),
        Some(1)
    );
    assert_eq!(
        mapping_index_key_canonical_season("series:tt2560140:12:9"),
        Some(12)
    );
    // Media ids may themselves contain `:`: the season is read from the
    // right, so only the two trailing coordinate segments are stripped.
    assert_eq!(
        mapping_index_key_canonical_season("series:tt:2560:140:4:1"),
        Some(4)
    );
    // Not a snapshot key: no two trailing coordinate segments.
    assert_eq!(mapping_index_key_canonical_season("series:tt1"), None);
    assert_eq!(mapping_index_key_canonical_season(""), None);
}

// ── max_mapped_canonical_season ───────────────────────────────────────

#[test]
fn max_mapped_season_takes_the_highest_canonical_season() {
    let index = vec![
        "series:tt2560140:1:1".to_string(),
        "series:tt2560140:4:1".to_string(),
        "series:tt2560140:3:1".to_string(),
    ];
    assert_eq!(
        max_mapped_canonical_season(&index, "series", "tt2560140"),
        Some(4)
    );
}

#[test]
fn max_mapped_season_scope_prefix_cannot_nibble_a_longer_id() {
    // Opaque ids may include colons: neither spelling belongs to the
    // shorter title, even when the longer id starts at a `:` boundary.
    let mut index = vec![
        "series:tt25601409:1:1".to_string(),
        "series:tt2560140:cut:9:1".to_string(),
    ];
    assert_eq!(
        max_mapped_canonical_season(&index, "series", "tt2560140"),
        None
    );
    assert_eq!(
        max_mapped_canonical_season(&index, "series", "tt25601409"),
        Some(1)
    );
    assert_eq!(
        max_mapped_canonical_season(&index, "series", "tt2560140:cut"),
        Some(9)
    );
    index.push("series:tt2560140:4:1".to_string());
    assert_eq!(
        max_mapped_canonical_season(&index, "series", "tt2560140"),
        Some(4)
    );
}

#[test]
fn max_mapped_season_is_type_scoped() {
    let index = vec![
        "series:tt2560140:4:1".to_string(),
        "movie:tt2560140:1:1".to_string(),
    ];
    assert_eq!(
        max_mapped_canonical_season(&index, "series", "tt2560140"),
        Some(4)
    );
    assert_eq!(
        max_mapped_canonical_season(&index, "movie", "tt2560140"),
        Some(1)
    );
}

#[test]
fn max_mapped_season_canonicalizes_the_watch_progress_scope() {
    // Watch-progress types funnel through the normalizers: anime is a
    // series here, and an unknown type is no scope at all.
    let index = vec!["series:tt2560140:4:1".to_string()];
    assert_eq!(
        max_mapped_canonical_season(&index, "anime", "tt2560140"),
        Some(4)
    );
    assert_eq!(
        max_mapped_canonical_season(&index, "short", "tt2560140"),
        None
    );
}

#[test]
fn max_mapped_season_degrades_to_none_when_unmapped() {
    // An unmapped title yields `None`, which the final-season fact caller
    // turns into "not final": never a false positive.
    let index = vec!["series:tt2560140:4:1".to_string()];
    assert_eq!(
        max_mapped_canonical_season(&index, "series", "tt9999999"),
        None
    );
    assert_eq!(
        max_mapped_canonical_season(&[], "series", "tt2560140"),
        None
    );
}
