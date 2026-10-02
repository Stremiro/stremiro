use super::build_media_schedule;
use crate::providers::{Episode, MediaDetails};

fn episode(id: &str, season: u32, episode: u32, release_date: Option<&str>) -> Episode {
    Episode {
        id: id.to_string(),
        title: Some(format!("Episode {episode}")),
        season,
        episode,
        released: release_date.map(|value| value.to_string()),
        release_date: None,
        overview: None,
        thumbnail: None,
        stream_lookup_id: None,
        stream_season: None,
        stream_episode: None,
    }
}

#[test]
fn build_media_schedule_sorts_dated_episodes_first_and_keeps_undated_ones() {
    let schedule = build_media_schedule(MediaDetails {
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
                ..episode("ep-1", 1, 1, None)
            },
        ]),
    });

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
            ("ep-bad-date", None),
        ]
    );
}

#[test]
fn build_media_schedule_keeps_movie_release_date_without_episode_payload() {
    let schedule = build_media_schedule(MediaDetails {
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
        episodes: None,
    });

    assert_eq!(schedule.release_date.as_deref(), Some("2024-01-01"));
    assert!(schedule.episodes.is_empty());
}
