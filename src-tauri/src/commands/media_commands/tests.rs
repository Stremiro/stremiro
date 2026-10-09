use super::{build_media_schedule, subtitle_lookup_id};
use crate::commands::media_normalization::{normalize_media_details, normalize_media_item};
use crate::providers::{Episode, MediaDetails};

#[test]
fn subtitle_lookup_preserves_scoped_ids_and_appends_only_complete_coordinates() {
    for (media_type, id, season, episode, expected) in [
        ("movie", "tt1", Some(1), Some(2), "tt1"),
        ("series", "tt1", Some(1), Some(2), "tt1:1:2"),
        ("series", "kitsu:48316", Some(1), Some(2), "kitsu:48316:1:2"),
        ("series", "tt1:1:2", Some(3), Some(4), "tt1:1:2"),
        (
            "series",
            "kitsu:48316:0:02",
            Some(1),
            Some(2),
            "kitsu:48316:0:02",
        ),
        ("series", "tt1:cut:2", Some(1), Some(2), "tt1:cut:2:1:2"),
        ("series", "tt1", None, Some(2), "tt1"),
        ("series", "tt1", Some(1), None, "tt1"),
        ("series", "tt1", Some(0), Some(0), "tt1:0:0"),
    ] {
        assert_eq!(
            subtitle_lookup_id(media_type, id.to_string(), season, episode),
            expected
        );
    }
}

fn episode(id: &str, season: u32, episode: u32, release_date: Option<&str>) -> Episode {
    Episode {
        id: id.to_string(),
        title: Some(format!("Episode {episode}")),
        season,
        episode,
        released: release_date.map(|value| value.to_string()),
        release_date: crate::commands::media_normalization::build_release_date(release_date),
        overview: None,
        thumbnail: None,
        stream_lookup_id: None,
        stream_season: None,
        stream_episode: None,
    }
}

#[test]
fn intrinsic_normalization_is_idempotent_and_requested_identity_stays_outside_shared_payload() {
    let details = MediaDetails {
        id: "tt1".into(),
        imdb_id: Some("tt1".into()),
        title: " \u{feff}A\t title ".into(),
        poster: Some("https://cdn.test".into()),
        backdrop: None,
        logo: None,
        year: Some(format!("2024{} tail", "y".repeat(27))),
        display_year: None,
        release_date: Some("2024-02-30".into()),
        type_: "series".into(),
        description: Some(format!("{} tail", "d".repeat(4095))),
        rating: Some(format!("{} tail", "r".repeat(63))),
        cast: Some(vec![format!("{} tail", "c".repeat(127))]),
        genres: Some(vec![format!("{} tail", "g".repeat(63))]),
        trailers: None,
        episodes: Some(vec![Episode {
            id: format!("{} tail", "i".repeat(255)),
            overview: Some(format!("{} tail", "o".repeat(4095))),
            thumbnail: Some(format!("{} tail", "t".repeat(2047))),
            ..episode("ep1", 1, 1, Some("2024-02-30"))
        }]),
    };
    let once = normalize_media_details(details, "tt1");
    let twice = normalize_media_details(once.clone(), "tt1");
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
        serde_json::to_value(normalize_media_item(item.clone())).unwrap()
    );
}

#[test]
fn build_media_schedule_sorts_dated_episodes_first_and_keeps_undated_ones() {
    let details = MediaDetails {
        id: "tt123".to_string(),
        imdb_id: None,
        title: "Test Show".to_string(),
        poster: Some("poster".to_string()),
        backdrop: None,
        logo: None,
        year: Some("2025".to_string()),
        display_year: None,
        release_date: Some("2025-01-01".to_string()),
        type_: "series".to_string(),
        description: None,
        rating: None,
        cast: None,
        genres: None,
        trailers: None,
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
        id: "tt999".to_string(),
        imdb_id: Some("tt999".to_string()),
        title: "Test Movie".to_string(),
        poster: Some("poster".to_string()),
        backdrop: None,
        logo: None,
        year: Some("2024".to_string()),
        display_year: Some("2024".to_string()),
        release_date: Some("2024-01-01".to_string()),
        type_: "movie".to_string(),
        description: None,
        rating: None,
        cast: None,
        genres: None,
        trailers: None,
        episodes: Some(vec![episode("unexpected", 1, 1, Some("2024-01-01"))]),
    };
    let schedule = build_media_schedule(&details, "requested-movie", false);

    assert_eq!(schedule.id, "requested-movie");
    assert_eq!(schedule.release_date.as_deref(), Some("2024-01-01"));
    assert!(schedule.episodes.is_empty());
}
