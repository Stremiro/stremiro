use super::*;
use crate::test_helpers::test_episode;

#[test]
fn duplicate_episode_coordinates_keep_the_first_source_mapping_and_video_id() {
    let fixture = crate::test_helpers::test_store();
    let store = &fixture.store;
    let mut episodes = [
        test_episode("video:first", 1, 2),
        test_episode("video:alternate", 1, 2),
    ];
    episodes[0].stream_lookup_id = Some("tt111".into());
    episodes[0].stream_season = Some(4);
    episodes[0].stream_episode = Some(12);
    episodes[1].stream_lookup_id = Some("tt222".into());
    episodes[1].stream_season = Some(5);
    episodes[1].stream_episode = Some(13);
    let snapshots: Vec<_> = episodes
        .iter()
        .map(|episode| build_episode_mapping_snapshot("series", "show", None, episode, 1))
        .collect();
    let mut index = Vec::new();
    let (writes, deletes, changed) =
        collect_episode_mapping_writes(store, "series", "show", &episodes, &snapshots, &mut index);
    assert!(changed && deletes.is_empty());
    for (key, cached) in writes {
        store.set(playback_episode_mapping_item_key(&key), json!(cached));
    }
    let key = playback_episode_mapping_snapshot_key("series", "show", 1, 2);
    let cached: CachedEpisodeMapping = store
        .get_typed(playback_episode_mapping_item_key(&key))
        .unwrap();
    assert_eq!(cached.snapshot, snapshots[0]);
    assert_eq!(cached.video_id.as_deref(), Some("video:first"));
    let (writes, deletes, changed) =
        collect_episode_mapping_writes(store, "series", "show", &episodes, &snapshots, &mut index);
    assert!(writes.is_empty() && deletes.is_empty() && !changed);
    let digest = episode_mappings_digest("series", "show", None, &episodes);
    assert_eq!(
        digest,
        episode_mappings_digest("series", "show", None, &episodes[..1])
    );
    episodes.swap(0, 1);
    assert_ne!(
        digest,
        episode_mappings_digest("series", "show", None, &episodes)
    );
}

#[test]
fn shorter_episode_lists_remove_only_stale_mappings_in_the_replaced_scope() {
    let fixture = crate::test_helpers::test_store();
    let store = &fixture.store;
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
        store,
        "series",
        "tt2560140",
        1
    ));
    let mut episodes = [test_episode("tt2560140:1:1", 1, 1)];
    let snapshots = [build_episode_mapping_snapshot(
        "series",
        "tt2560140",
        None,
        &episodes[0],
        2,
    )];
    let (writes, deletes, changed) = collect_episode_mapping_writes(
        store,
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
        assert!(load_playback_episode_mapping_snapshot(store, &key).is_some());
        store.delete(playback_episode_mapping_item_key(&key));
        assert!(load_playback_episode_mapping_snapshot(store, &key).is_none());
    }
    assert_eq!(index.len(), 3);
    for key in &index {
        assert!(load_playback_episode_mapping_snapshot(store, key).is_some());
    }
    store.set(PLAYBACK_EPISODE_MAPPING_INDEX_KEY, json!(index));
    let digest = episode_mappings_digest("series", "tt2560140", None, &episodes);
    store.set(
        &digest_key,
        json!(EpisodeMappingDigestRecord {
            digest,
            seen_at: 2,
            ..Default::default()
        }),
    );
    assert!(mapped_canonical_season_is_final(
        store,
        "series",
        "tt2560140",
        1
    ));
    assert!(stored_episode_mapping_digest_matches(
        store,
        &digest_key,
        &EpisodeMappingDigestRecord {
            digest,
            seen_at: 3,
            ..Default::default()
        }
    ));
    let unchanged_index = index.clone();
    let (writes, deletes, changed) =
        collect_episode_mapping_writes(store, "series", "tt2560140", &[], &[], &mut index);
    assert!(writes.is_empty());
    assert!(deletes.is_empty());
    assert!(!changed);
    assert_eq!(index, unchanged_index);
    assert!(stored_episode_mapping_digest_matches(
        store,
        &digest_key,
        &EpisodeMappingDigestRecord {
            digest,
            seen_at: 4,
            ..Default::default()
        }
    ));
    episodes[0].id = "video:4:12".into();
    assert_ne!(
        digest,
        episode_mappings_digest("series", "tt2560140", None, &episodes)
    );
    let (writes, _, _) = collect_episode_mapping_writes(
        store,
        "series",
        "tt2560140",
        &episodes,
        &snapshots,
        &mut index,
    );
    assert_eq!(writes.len(), 1);
    let (key, cached) = &writes[0];
    assert_eq!(cached.video_id.as_deref(), Some("video:4:12"));
    assert_eq!(cached.snapshot.source_lookup_id, "tt2560140");
    store.set(playback_episode_mapping_item_key(key), json!(cached));
    assert_eq!(
        load_playback_episode_mapping_snapshot(store, key)
            .unwrap()
            .source_season,
        1
    );
    let (unchanged, _, _) = collect_episode_mapping_writes(
        store,
        "series",
        "tt2560140",
        &episodes,
        &snapshots,
        &mut index,
    );
    assert!(unchanged.is_empty());
    episodes[0].id = "video:4:13".into();
    let (changed, _, _) = collect_episode_mapping_writes(
        store,
        "series",
        "tt2560140",
        &episodes,
        &snapshots,
        &mut index,
    );
    assert_eq!(changed[0].1.video_id.as_deref(), Some("video:4:13"));
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

// ── max_mapped_canonical_season ───────────────────────────────────────

#[test]
fn max_mapped_season_reads_only_the_titles_own_scope() {
    // (index keys, lookups of (type, id, expected))
    for (index, lookups) in [
        (
            vec![
                "series:tt2560140:1:1",
                "series:tt2560140:4:1",
                "series:tt2560140:3:1",
            ],
            vec![("series", "tt2560140", Some(4))],
        ),
        // Opaque ids may include colons: neither spelling belongs to the
        // shorter title, even when the longer id starts at a `:` boundary.
        (
            vec!["series:tt25601409:1:1", "series:tt2560140:cut:9:1"],
            vec![
                ("series", "tt2560140", None),
                ("series", "tt25601409", Some(1)),
                ("series", "tt2560140:cut", Some(9)),
            ],
        ),
        (
            vec!["series:tt2560140:4:1", "movie:tt2560140:1:1"],
            vec![
                ("series", "tt2560140", Some(4)),
                ("movie", "tt2560140", Some(1)),
            ],
        ),
        // Watch-progress types funnel through the normalizers: anime is a
        // series here, and an unknown type is no scope at all.
        (
            vec!["series:tt2560140:4:1"],
            vec![
                ("anime", "tt2560140", Some(4)),
                ("short", "tt2560140", None),
            ],
        ),
        // An unmapped title yields `None`, which the final-season fact caller
        // turns into "not final": never a false positive.
        (
            vec!["series:tt2560140:4:1"],
            vec![("series", "tt9999999", None)],
        ),
        (vec![], vec![("series", "tt2560140", None)]),
    ] {
        let index: Vec<String> = index.iter().map(|key| key.to_string()).collect();
        for (media_type, id, expected) in lookups {
            assert_eq!(
                max_mapped_canonical_season(&index, media_type, id),
                expected
            );
        }
    }
}

#[test]
fn partial_mapping_eviction_cannot_promote_a_surviving_season_to_final() {
    let fixture = crate::test_helpers::test_store();
    let store = &fixture.store;
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
        store,
        "series",
        "tt2560140",
        4
    ));
    store.set(&digest_key, json!("invalid"));
    assert!(!mapped_canonical_season_is_final(
        store,
        "series",
        "tt2560140",
        4
    ));
    for digest in [
        json!(7),
        json!(EpisodeMappingDigestRecord {
            digest: 7,
            seen_at: 0,
            ..Default::default()
        }),
    ] {
        store.set(&digest_key, digest);
        assert!(mapped_canonical_season_is_final(
            store,
            "anime",
            "tt2560140",
            4
        ));
        assert!(!mapped_canonical_season_is_final(
            store,
            "series",
            "tt2560140",
            1
        ));
    }
    assert_eq!(
        prune_episode_mapping_index(store, &mut index, scope),
        (true, true)
    );
    store.set(PLAYBACK_EPISODE_MAPPING_INDEX_KEY, json!(index));
    assert!(store.get(&digest_key).is_none());
    assert_eq!(
        max_mapped_canonical_season(&index, "series", "tt2560140"),
        Some(1)
    );
    assert!(!mapped_canonical_season_is_final(
        store,
        "series",
        "tt2560140",
        1
    ));
}

#[test]
fn accepted_work_years_use_premiere_and_bounded_season_or_completed_work_ranges() {
    let seasons = BTreeMap::from([(1, (2005, 2006)), (3, (2007, 2008)), (4, (2000, 2050))]);
    assert_eq!(
        accepted_work_years(Some(2005), Some(2008), &seasons, "series", Some(1)),
        [2005, 2006]
    );
    assert_eq!(
        accepted_work_years(Some(2005), Some(2008), &seasons, "anime", Some(3)),
        [2005, 2007, 2008]
    );
    assert_eq!(
        accepted_work_years(Some(2005), Some(2008), &seasons, "series", Some(4)),
        [2005, 2006, 2007, 2008]
    );
    assert_eq!(
        accepted_work_years(Some(2005), None, &BTreeMap::new(), "series", Some(2)),
        [2005]
    );
    assert_eq!(
        accepted_work_years(Some(2005), Some(2050), &BTreeMap::new(), "series", None),
        [2005]
    );
    assert_eq!(
        accepted_work_years(Some(2005), Some(2004), &BTreeMap::new(), "series", None),
        [2005]
    );
    assert_eq!(
        accepted_work_years(Some(2005), Some(2008), &seasons, "movie", Some(1)),
        [2005]
    );
}

#[test]
fn work_year_metadata_parsing_and_season_ranges_share_the_persisted_rules() {
    for (year, expected) in [
        ("2005", (Some(2005), None)),
        ("2005–2008", (Some(2005), Some(2008))),
        ("2005-2008", (Some(2005), Some(2008))),
        ("2005–", (Some(2005), None)),
    ] {
        assert_eq!(metadata_work_years(Some(year), None), expected, "{year}");
    }
    let mut episodes = [
        test_episode("a", 1, 1),
        test_episode("b", 1, 2),
        test_episode("c", 3, 1),
    ];
    episodes[0].release_date = Some("2006-01-01".into());
    episodes[1].release_date = Some("2005-02-01".into());
    episodes[2].release_date = Some("2007-01-01".into());
    let seasons = episode_season_years(&episodes);
    assert_eq!(
        accepted_work_years(Some(2005), None, &seasons, "series", Some(1)),
        [2005, 2006]
    );
    assert_eq!(
        accepted_work_years(Some(2005), None, &seasons, "series", Some(3)),
        [2005, 2007]
    );
    assert_eq!(
        accepted_work_years(Some(2005), None, &seasons, "series", Some(2)),
        [2005]
    );
    assert_eq!(
        metadata_work_years(None, Some("2005-02-21")),
        (Some(2005), None)
    );
}

#[test]
fn legacy_mapping_digests_remain_readable_but_need_a_refresh_for_canonical_years() {
    let fixture = crate::test_helpers::test_store();
    let store = &fixture.store;
    let key = playback_episode_mapping_digest_item_key("series:tt0417299");
    let next = EpisodeMappingDigestRecord {
        digest: 42,
        seen_at: 10,
        premiere_year: Some(2005),
        end_year: Some(2008),
        season_years: BTreeMap::from([(1, (2005, 2006))]),
    };
    for legacy in [json!(42), json!({"digest": 42, "seen_at": 1})] {
        assert_eq!(
            read_episode_mapping_digest(legacy.clone()).unwrap().digest,
            42
        );
        store.set(&key, legacy);
        assert!(!stored_episode_mapping_digest_matches(store, &key, &next));
    }
    store.set(&key, json!(next));
    assert!(stored_episode_mapping_digest_matches(store, &key, &next));
    let stored = read_episode_mapping_digest(store.get(&key).unwrap()).unwrap();
    assert_eq!(stored.premiere_year, Some(2005));
    assert_eq!(stored.end_year, Some(2008));
    assert_eq!(stored.season_years, next.season_years);
    assert_eq!(stored.seen_at, 10);
    let old = serde_json::to_value(EpisodeMappingDigestRecord::default()).unwrap();
    assert!(
        old.get("premiere_year").is_none()
            && old.get("end_year").is_none()
            && old.get("season_years").is_none()
    );
}

#[test]
fn details_final_season_matches_persisted_season_rule() {
    let details = MediaDetails {
        episodes: Some(vec![
            test_episode("a", 1, 1),
            test_episode("b", 4, 1),
            test_episode("c", 2, 1),
        ]),
        ..crate::test_helpers::test_details("tt2560140", "series")
    };
    assert!(!PlaybackStateService::episode_is_final_season_from_details(
        &details, None
    ));
    assert!(!PlaybackStateService::episode_is_final_season_from_details(
        &details,
        Some(1)
    ));
    assert!(PlaybackStateService::episode_is_final_season_from_details(
        &details,
        Some(4)
    ));
    assert!(PlaybackStateService::episode_is_final_season_from_details(
        &details,
        Some(5)
    ));
    let empty = crate::test_helpers::test_details("tt2560140", "series");
    assert!(!PlaybackStateService::episode_is_final_season_from_details(
        &empty,
        Some(1)
    ));
}
