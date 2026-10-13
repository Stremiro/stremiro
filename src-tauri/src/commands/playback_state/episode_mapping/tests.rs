use super::*;

#[test]
fn shorter_episode_lists_remove_only_stale_mappings_in_the_replaced_scope() {
    let store = crate::commands::DurableStoreRegistry::default()
        .open_path(
            std::env::temp_dir().join(format!("stremiro-mappings-{}.json", uuid::Uuid::new_v4())),
        )
        .unwrap();
    let scope = "series:tt2560140";
    let digest_key = playback_episode_mapping_digest_item_key(scope);
    let mut index = Vec::new();
    for (media_type, media_id, season, episode) in [
        ("series", "tt2560140", 1, 1),
        ("series", "tt2560140", 1, 2),
        ("series", "tt2560140", 2, 1),
        ("series", "tt2560140", 3, 1),
        ("series", "tt2560140", 4, 1),
        ("series", "tt2560140:cut", 4, 1),
        ("movie", "tt2560140", 4, 1),
    ] {
        let key = playback_episode_mapping_snapshot_key(media_type, media_id, season, episode);
        store.set(
            playback_episode_mapping_item_key(&key),
            json!(PlaybackEpisodeMappingSnapshot {
                media_id: media_id.to_string(),
                media_type: media_type.to_string(),
                canonical_season: season,
                canonical_episode: episode,
                source_lookup_id: media_id.to_string(),
                source_season: season,
                source_episode: episode,
                updated_at: 1,
            }),
        );
        index.push(key);
    }
    index.sort_unstable();
    store.set(PLAYBACK_EPISODE_MAPPING_INDEX_KEY, json!(index));
    store.set(&digest_key, json!(1));
    assert!(!mapped_canonical_season_is_final(
        &store,
        "series",
        "tt2560140",
        1
    ));
    let episodes = [Episode {
        id: "tt2560140:1:1".to_string(),
        title: None,
        season: 1,
        episode: 1,
        released: None,
        release_date: None,
        overview: None,
        thumbnail: None,
        stream_lookup_id: None,
        stream_season: None,
        stream_episode: None,
    }];
    let snapshots = [build_episode_mapping_snapshot(
        "series",
        "tt2560140",
        None,
        &episodes[0],
        2,
    )];
    let (writes, deletes, changed) = collect_episode_mapping_writes(
        &store,
        "series",
        "tt2560140",
        &episodes,
        &snapshots,
        &mut index,
    );
    assert!(writes.is_empty());
    assert!(changed);
    assert_eq!(
        max_mapped_canonical_season(&index, "series", "tt2560140"),
        Some(1)
    );
    assert_eq!(deletes.len(), 4);
    for key in deletes {
        assert!(load_playback_episode_mapping_snapshot(&store, &key).is_some());
        store.delete(playback_episode_mapping_item_key(&key));
        assert!(load_playback_episode_mapping_snapshot(&store, &key).is_none());
    }
    assert_eq!(index.len(), 3);
    for key in &index {
        assert!(load_playback_episode_mapping_snapshot(&store, key).is_some());
    }
    store.set(PLAYBACK_EPISODE_MAPPING_INDEX_KEY, json!(index));
    let digest = episode_mappings_digest("series", "tt2560140", None, &episodes);
    store.set(
        &digest_key,
        json!(EpisodeMappingDigestRecord { digest, seen_at: 2 }),
    );
    assert!(mapped_canonical_season_is_final(
        &store,
        "series",
        "tt2560140",
        1
    ));
    assert!(stored_episode_mapping_digest_matches(
        &store,
        &digest_key,
        digest,
        3
    ));
    let unchanged_index = index.clone();
    let (writes, deletes, changed) =
        collect_episode_mapping_writes(&store, "series", "tt2560140", &[], &[], &mut index);
    assert!(writes.is_empty());
    assert!(deletes.is_empty());
    assert!(!changed);
    assert_eq!(index, unchanged_index);
    assert!(stored_episode_mapping_digest_matches(
        &store,
        &digest_key,
        digest,
        4
    ));
}

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

#[test]
fn partial_mapping_eviction_cannot_promote_a_surviving_season_to_final() {
    let store = crate::commands::DurableStoreRegistry::default()
        .open_path(
            std::env::temp_dir().join(format!("stremiro-mappings-{}.json", uuid::Uuid::new_v4())),
        )
        .unwrap();
    let scope = "series:tt2560140";
    let digest_key = playback_episode_mapping_digest_item_key(scope);
    let mut index = Vec::new();
    for (season, updated_at) in [(1, 10), (4, 0)] {
        let key = playback_episode_mapping_snapshot_key("series", "tt2560140", season, 1);
        store.set(
            playback_episode_mapping_item_key(&key),
            json!(PlaybackEpisodeMappingSnapshot {
                media_id: "tt2560140".to_string(),
                media_type: "series".to_string(),
                canonical_season: season,
                canonical_episode: 1,
                source_lookup_id: "tt2560140".to_string(),
                source_season: season,
                source_episode: 1,
                updated_at,
            }),
        );
        index.push(key);
    }
    index.extend((0..PLAYBACK_EPISODE_MAPPING_MAX_ENTRIES - 1).map(|i| format!("series:z:1:{i}")));
    index.sort_unstable();
    store.set(PLAYBACK_EPISODE_MAPPING_INDEX_KEY, json!(index));
    assert!(!mapped_canonical_season_is_final(
        &store,
        "series",
        "tt2560140",
        4
    ));
    store.set(&digest_key, json!("invalid"));
    assert!(!mapped_canonical_season_is_final(
        &store,
        "series",
        "tt2560140",
        4
    ));
    for digest in [
        json!(7),
        json!(EpisodeMappingDigestRecord {
            digest: 7,
            seen_at: 0
        }),
    ] {
        store.set(&digest_key, digest);
        assert!(mapped_canonical_season_is_final(
            &store,
            "anime",
            "tt2560140",
            4
        ));
        assert!(!mapped_canonical_season_is_final(
            &store,
            "series",
            "tt2560140",
            1
        ));
    }
    assert_eq!(
        prune_episode_mapping_index(&store, &mut index, scope),
        (true, true)
    );
    store.set(PLAYBACK_EPISODE_MAPPING_INDEX_KEY, json!(index));
    assert!(store.get(&digest_key).is_none());
    assert_eq!(
        max_mapped_canonical_season(&index, "series", "tt2560140"),
        Some(1)
    );
    assert!(!mapped_canonical_season_is_final(
        &store,
        "series",
        "tt2560140",
        1
    ));
}
