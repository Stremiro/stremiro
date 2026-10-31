use super::{
    build_media_schedule, enrich_episode_targets, episode_search_indices, search_episodes,
    subtitle_lookup_ids, DetailsPrefetchBundle, EpisodeSearchFields,
    PlaybackEpisodeMappingSnapshot,
};
use crate::commands::media_normalization::{normalize_media_details, normalize_media_item};
use crate::commands::watch_history_commands::TitleWatchProgress;
use crate::providers::{Episode, MediaDetails, MediaSeason};
use crate::test_helpers::{test_details, test_episode};

fn search_episode(
    season: u32,
    episode: u32,
    title: Option<&str>,
    overview: Option<&str>,
) -> EpisodeSearchFields {
    EpisodeSearchFields {
        season,
        episode,
        title: title.map(str::to_string),
        overview: overview.map(str::to_string),
    }
}

#[test]
fn episode_search_accepts_each_coordinate_form() {
    let episodes = [
        search_episode(1, 5, None, None),
        search_episode(2, 5, None, None),
        search_episode(2, 15, None, None),
        search_episode(0, 0, None, None),
    ];
    for query in ["S2E5", "s02 e005", "2x5", "02 \tX 005", "s2\u{feff}e5"] {
        assert_eq!(episode_search_indices(query, &episodes), [1], "{query}");
    }
    for query in ["E05", "e5", "ep 5", "EP005", "episode 005", "EPISODE\t5"] {
        assert_eq!(episode_search_indices(query, &episodes), [0, 1], "{query}");
    }
    assert_eq!(episode_search_indices("s0e0", &episodes), [3]);
}

#[test]
fn episode_search_matches_partial_numbers_titles_and_overviews_in_input_order() {
    let episodes = [
        search_episode(3, 15, None, None),
        search_episode(2, 1, Some("The 5th Witness"), None),
        search_episode(1, 5, None, Some("A secret witness arrives.")),
        search_episode(1, 2, Some("S2E5 revisited"), None),
        search_episode(1, 3, None, Some("An S2E5 callback.")),
    ];
    assert_eq!(episode_search_indices("5", &episodes), [0, 1, 2, 3, 4]);
    assert_eq!(episode_search_indices("WITNESS", &episodes), [1, 2]);
    assert_eq!(episode_search_indices(" s2e5 ", &episodes), [3, 4]);
    assert!(episode_search_indices("05", &episodes).is_empty());
}

#[test]
fn episode_search_preserves_unicode_lowercasing_and_ecmascript_whitespace() {
    let episodes = [
        search_episode(1, 1, Some("ÉCOLE İSTANBUL ΟΣ"), None),
        search_episode(1, 2, None, Some("ПРИВЕТ 世界")),
        search_episode(1, 3, Some("Straße"), None),
    ];
    for query in ["école", "\u{feff}ÉCOLE\u{00a0}", "i\u{0307}stanbul", "ος"] {
        assert_eq!(episode_search_indices(query, &episodes), [0], "{query}");
    }
    for query in ["привет", "世界"] {
        assert_eq!(episode_search_indices(query, &episodes), [1], "{query}");
    }
    for query in ["ecole", "istanbul", "οσ", "STRASSE", "\u{0085}école"] {
        assert!(
            episode_search_indices(query, &episodes).is_empty(),
            "{query}"
        );
    }
}

#[test]
fn episode_search_blank_queries_return_all_and_unmatched_queries_return_none() {
    let episodes = [
        search_episode(1, 1, None, None),
        search_episode(1, 2, Some(""), Some("")),
    ];
    for query in ["", " \t\r\n", "\u{feff}\u{2028}\u{3000}"] {
        assert_eq!(episode_search_indices(query, &episodes), [0, 1], "{query}");
    }
    assert!(episode_search_indices("missing", &episodes).is_empty());
    assert!(episode_search_indices("", &[]).is_empty());
}

#[test]
fn episode_search_rejects_non_ascii_digits_and_invalid_coordinate_grammar() {
    let episodes = [search_episode(2, 5, None, None)];
    for query in [
        "s 2e5",
        "s2e 5",
        "2 x 5 extra",
        "episode:5",
        "s٢e٥",
        "s2\u{0085}e5",
        "s4294967296e5",
        "e4294967296",
    ] {
        assert!(
            episode_search_indices(query, &episodes).is_empty(),
            "{query}"
        );
    }
    assert_eq!(
        episode_search_indices("s000000000000000000002e0000000000005", &episodes),
        [0]
    );
}

#[test]
fn episode_search_bounds_ipc_inputs_without_truncating_valid_payloads() {
    let episode = search_episode(1, 1, None, Some(&"界".repeat(4_096)));
    assert_eq!(
        search_episodes("界".repeat(4_096), vec![episode.clone()]).unwrap(),
        [0]
    );
    assert_eq!(
        search_episodes(String::new(), vec![episode.clone(); 2_000])
            .unwrap()
            .len(),
        2_000
    );
    assert!(search_episodes(String::new(), vec![episode; 2_001]).is_err());
    assert!(search_episodes("x".repeat(4_097), vec![]).is_err());
    assert_eq!(
        search_episodes(
            "x".into(),
            vec![search_episode(1, 1, Some(&"x".repeat(4_097)), None)]
        )
        .unwrap(),
        [0]
    );
}

#[test]
fn details_prefetch_bundle_serializes_nullable_details_and_camel_case_progress() {
    let bundle = DetailsPrefetchBundle {
        details: None,
        progress: TitleWatchProgress {
            episode_progress: std::collections::HashMap::new(),
            watched_episode_ceiling: std::collections::HashMap::new(),
            series_resume_entry: None,
            movie_resume_entry: None,
            up_next_source: None,
            latest_series_entry: None,
            latest_movie_entry: None,
        },
    };

    let value = serde_json::to_value(&bundle).unwrap();
    // `details` always serializes (null on a degraded prefetch); the
    // progress shape must stay identical to `get_title_watch_progress`.
    assert_eq!(value["details"], serde_json::Value::Null);
    assert!(value["progress"].get("history").is_none());
    assert!(value["progress"].get("continueWatching").is_none());
    assert_eq!(value["progress"]["episodeProgress"], serde_json::json!({}));
    assert_eq!(
        value["progress"]["watchedEpisodeCeiling"],
        serde_json::json!({})
    );
}

#[test]
fn subtitle_lookup_preserves_scoped_ids_and_appends_only_complete_coordinates() {
    for (media_type, id, season, episode, expected) in [
        ("movie", "tt1", Some(1), Some(2), vec!["tt1"]),
        ("series", "tt1", Some(1), Some(2), vec!["tt1:1:2"]),
        (
            "series",
            "kitsu:48316",
            Some(1),
            Some(2),
            vec!["kitsu:48316:1:2", "kitsu:48316:2"],
        ),
        ("series", "tt1:1:2", Some(3), Some(4), vec!["tt1:1:2"]),
        (
            "series",
            "kitsu:48316:0:02",
            Some(1),
            Some(2),
            vec!["kitsu:48316:0:02"],
        ),
        (
            "anime",
            "kitsu:48316:02",
            Some(3),
            Some(4),
            vec!["kitsu:48316:02"],
        ),
        (
            "anime",
            "tt1",
            Some(2),
            Some(3),
            vec!["tt1:2:3", "tt1:1:3", "tt1:0:3"],
        ),
        (
            "series",
            "tt1:cut:2",
            Some(1),
            Some(2),
            vec!["tt1:cut:2:1:2"],
        ),
        ("series", "tt1", None, Some(2), vec!["tt1"]),
        ("series", "tt1", Some(1), None, vec!["tt1"]),
        ("series", "tt1", Some(0), Some(0), vec!["tt1:0:0"]),
    ] {
        let (type_, actual) = subtitle_lookup_ids(media_type, id, season, episode).unwrap();
        assert_eq!(
            type_,
            if media_type == "movie" {
                "movie"
            } else {
                "series"
            }
        );
        assert_eq!(actual, expected);
    }
}

#[test]
fn subtitle_lookup_preserves_composed_ipc_trimming() {
    for (prefix, suffix, valid) in [
        (" \t\u{feff}\u{a0}", "\u{2028}\u{feff}\r\n ", true),
        ("\u{feff}\u{85}", "\u{85}\u{feff}", true),
        ("\u{85}\u{feff}", "\u{feff}\u{85}", false),
    ] {
        let media_type = format!("{prefix}SeRiEs{suffix}");
        let id = format!("{prefix}tt123{suffix}");
        let actual = subtitle_lookup_ids(&media_type, &id, Some(1), Some(2));
        assert_eq!(
            actual,
            subtitle_lookup_ids(
                crate::commands::js_trim(&media_type),
                crate::commands::js_trim(&id),
                Some(1),
                Some(2),
            )
        );
        assert_eq!(actual.is_ok(), valid);
        if valid {
            assert_eq!(actual.unwrap(), ("series", vec!["tt123:1:2".to_string()]));
        }
    }
}

fn episode(id: &str, season: u32, episode: u32, release_date: Option<&str>) -> Episode {
    Episode {
        title: Some(format!("Episode {episode}")),
        released: release_date.map(|value| value.to_string()),
        release_date: crate::commands::media_normalization::build_release_date(release_date),
        ..test_episode(id, season, episode)
    }
}

#[test]
fn episode_targets_retain_metadata_and_fall_back_when_the_mapping_hop_fails() {
    let plain = episode("addon-episode", 1, 2, Some("2024-01-01"));
    let mut remapped = episode("remapped", 2, 3, None);
    remapped.stream_lookup_id = Some("source:123".into());
    remapped.stream_season = Some(4);
    remapped.stream_episode = Some(5);
    let mut blank = episode("blank", 0, 1, None);
    blank.stream_lookup_id = Some("   ".into());
    let episodes = vec![plain, remapped, blank];
    let mut expected = episodes.clone();
    expected[0].stream_lookup_id = Some("tt123".into());
    expected[0].stream_season = Some(1);
    expected[0].stream_episode = Some(2);
    expected[2].stream_lookup_id = Some("tt123".into());
    expected[2].stream_season = Some(0);
    expected[2].stream_episode = Some(1);
    let expected = serde_json::to_value(expected).unwrap();
    for result in [
        Err("Background persistence timed out.".into()),
        Err("Background persistence task failed.".into()),
        Err("Mapping store unavailable.".into()),
        Ok(None),
    ] {
        let enriched = enrich_episode_targets(episodes.clone(), "tt123", result);
        assert_eq!(serde_json::to_value(enriched).unwrap(), expected);
    }
}

#[test]
fn episode_targets_keep_successful_mapping_snapshots() {
    let episodes = vec![episode("addon-episode", 1, 2, None)];
    let snapshot = PlaybackEpisodeMappingSnapshot {
        media_id: "tt123".into(),
        media_type: "series".into(),
        canonical_season: 1,
        canonical_episode: 2,
        source_lookup_id: "source:456".into(),
        source_season: 3,
        source_episode: 4,
        updated_at: 1,
    };
    let enriched = enrich_episode_targets(episodes, "tt123", Ok(Some(vec![snapshot])));
    assert_eq!(enriched[0].stream_lookup_id.as_deref(), Some("source:456"));
    assert_eq!(enriched[0].stream_season, Some(3));
    assert_eq!(enriched[0].stream_episode, Some(4));
}

#[test]
fn intrinsic_normalization_is_idempotent_and_requested_identity_stays_outside_shared_payload() {
    let details = MediaDetails {
        imdb_id: Some("tt1".into()),
        title: " \u{feff}A\t title ".into(),
        poster: Some("https://cdn.test".into()),
        year: Some(format!("2024{} tail", "y".repeat(27))),
        release_date: Some("2024-02-30".into()),
        description: Some(format!("{} tail", "d".repeat(4095))),
        rating: Some(format!("{} tail", "r".repeat(63))),
        cast: Some(vec![format!("{} tail", "c".repeat(127))]),
        genres: Some(vec![format!("{} tail", "g".repeat(63))]),
        episodes: Some(vec![Episode {
            id: format!("{} tail", "i".repeat(255)),
            overview: Some(format!("{} tail", "o".repeat(4095))),
            thumbnail: Some(format!("{} tail", "t".repeat(2047))),
            ..episode("ep1", 1, 1, Some("2024-02-30"))
        }]),
        seasons: Some(vec![MediaSeason {
            number: 1,
            episode_count: 1,
        }]),
        ..test_details("tt1", "series")
    };
    let once = normalize_media_details(details);
    let twice = normalize_media_details(once.clone());
    assert_eq!(
        serde_json::to_value(&once).unwrap(),
        serde_json::to_value(twice).unwrap()
    );
    assert_eq!(once.title, "A title");
    assert_eq!(once.poster.as_deref(), Some("https://cdn.test/"));
    assert_eq!(once.release_date.as_deref(), Some("2024-01-01"));
    assert_eq!(once.episodes.as_ref().unwrap()[0].release_date, None);
    let requested = super::with_requested_media_id(super::meta_for_shape(&once, true), "kitsu:1");
    assert_eq!(requested.id, "kitsu:1");
    assert_eq!(requested.imdb_id.as_deref(), Some("tt1"));
    assert!(requested.is_anime);
    assert!(!once.is_anime);
    assert_eq!(once.id, "tt1");
    assert_eq!(once.episodes.as_ref().unwrap()[0].stream_lookup_id, None);

    let item = normalize_media_item(crate::providers::MediaItem {
        title: once.title,
        poster: once.poster,
        year: once.year,
        genres: once.genres,
        ..crate::test_helpers::test_media_item("tt1", "series")
    });
    assert_eq!(item.primary_year, Some(2024));
    assert_eq!(
        serde_json::to_value(&item).unwrap(),
        serde_json::to_value(normalize_media_item(item)).unwrap()
    );
}

#[test]
fn build_media_schedule_sorts_dated_episodes_first_and_keeps_undated_ones() {
    let details = MediaDetails {
        title: "Test Show".to_string(),
        poster: Some("poster".to_string()),
        year: Some("2025".to_string()),
        release_date: Some("2025-01-01".to_string()),
        episodes: Some(vec![
            Episode {
                thumbnail: Some("https://img.test/ep-2.jpg".to_string()),
                ..episode("ep-2", 1, 2, Some("2025-02-12"))
            },
            episode("ep-0", 1, 0, None),
            // An invalid matched date stays undated rather than pinning Jan 1.
            episode("ep-bad-date", 1, 3, Some("2025-02-30")),
            Episode {
                release_date: Some("2025-01-14".to_string()),
                stream_season: Some(9),
                stream_episode: Some(99),
                ..episode("ep-1", 1, 1, None)
            },
            episode("ep-2", 1, 2, None),
        ]),
        seasons: Some(vec![MediaSeason {
            number: 1,
            episode_count: 5,
        }]),
        ..test_details("tt123", "series")
    };
    let original = serde_json::to_value(&details).unwrap();
    let schedule = build_media_schedule(&details, "kitsu:123", true);
    assert_eq!(schedule.id, "kitsu:123");
    assert_eq!(serde_json::to_value(&details).unwrap(), original);
    assert_eq!(schedule.episodes[0].season, 1);
    assert_eq!(schedule.episodes[0].episode, 1);

    let order: Vec<_> = schedule
        .episodes
        .iter()
        .map(|episode| (episode.id.as_str(), episode.release_date.as_deref()))
        .collect();
    assert_eq!(
        order,
        [
            ("ep-1", Some("2025-01-14")),
            ("ep-2", Some("2025-02-12")),
            ("ep-0", None),
            ("ep-2", None),
            ("ep-bad-date", None),
        ]
    );
}

#[test]
fn build_media_schedule_keeps_movie_release_date_without_episode_payload() {
    let details = MediaDetails {
        imdb_id: Some("tt999".to_string()),
        title: "Test Movie".to_string(),
        poster: Some("poster".to_string()),
        year: Some("2024".to_string()),
        display_year: Some("2024".to_string()),
        release_date: Some("2024-01-01".to_string()),
        episodes: Some(vec![episode("unexpected", 1, 1, Some("2024-01-01"))]),
        ..test_details("tt999", "movie")
    };
    let schedule = build_media_schedule(&details, "requested-movie", false);

    assert_eq!(schedule.id, "requested-movie");
    assert_eq!(schedule.release_date.as_deref(), Some("2024-01-01"));
    assert!(schedule.episodes.is_empty());
}
