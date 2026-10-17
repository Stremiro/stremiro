use super::{
    additional_episode_video_id, build_source_episode_coordinates, get_episode_navigation,
    EpisodeNavigation, EpisodeNavigationRequest, NavigationCoordinate,
};
use crate::providers::Episode;

fn episode(season: u32, episode: u32) -> Episode {
    Episode {
        id: format!("{}:{}", season, episode),
        title: Some(format!("Episode {}", episode)),
        season,
        episode,
        released: None,
        release_date: None,
        overview: None,
        thumbnail: None,
        stream_lookup_id: None,
        stream_season: None,
        stream_episode: None,
    }
}

#[test]
fn source_coordinates_prefer_backend_normalized_fields() {
    let mut normalized = episode(1, 2);
    normalized.stream_lookup_id = Some("tt999".to_string());
    normalized.stream_season = Some(4);
    normalized.stream_episode = Some(12);

    let source = build_source_episode_coordinates(&normalized, "fallback-id");
    assert_eq!(source.lookup_id, "tt999");
    assert_eq!(source.season, 4);
    assert_eq!(source.episode, 12);
}

#[test]
fn source_coordinates_skip_blank_addon_ids() {
    let mut blank = episode(1, 2);
    blank.stream_lookup_id = Some("   ".to_string());

    let source = build_source_episode_coordinates(&blank, "fallback-id");
    assert_eq!(source.lookup_id, "fallback-id");
}

#[test]
fn additional_video_ids_preserve_source_mapping_and_reject_unusable_ids() {
    let mut episode = episode(1, 2);
    let source = build_source_episode_coordinates(&episode, "tt123");
    for (id, expected) in [
        ("\u{feff} tt999:4:12 \u{feff}", Some("tt999:4:12")),
        ("kitsu:42:12", Some("kitsu:42:12")),
        ("tt123:1:2", None),
        ("tt123", None),
        (" \u{feff} ", None),
    ] {
        episode.id = id.into();
        assert_eq!(
            additional_episode_video_id(&episode, &source).as_deref(),
            expected
        );
        assert_eq!(source.lookup_id, "tt123");
    }
    for len in [256, 257] {
        episode.id = "x".repeat(len);
        assert!(additional_episode_video_id(&episode, &source).is_none());
    }
}

fn request(season: u32, episode: u32) -> EpisodeNavigationRequest {
    EpisodeNavigationRequest {
        episodes: Vec::new(),
        season,
        episode,
        today: "2026-10-15".to_string(),
    }
}

fn navigation(episodes: &[Episode], request: &EpisodeNavigationRequest) -> EpisodeNavigation {
    get_episode_navigation(EpisodeNavigationRequest {
        episodes: episodes
            .iter()
            .map(|episode| NavigationCoordinate {
                season: episode.season,
                episode: episode.episode,
                release_date: episode.release_date.clone(),
            })
            .collect(),
        season: request.season,
        episode: request.episode,
        today: request.today.clone(),
    })
    .unwrap()
}

#[test]
fn player_episode_navigation_includes_specials_and_ungated_previous() {
    let mut special = episode(0, 1);
    special.release_date = Some("2099-01-01".to_string());
    let episodes = [special, episode(1, 1)];
    let result = navigation(&episodes, &request(1, 1));
    assert_eq!(result.previous_index, Some(0));
    assert!(result.next_index.is_none());
    let result = navigation(&episodes, &request(0, 1));
    assert_eq!(result.next_index, Some(1));
}

#[test]
fn player_episode_navigation_gates_only_immediate_successor_without_skipping() {
    let mut future = episode(1, 2);
    future.release_date = Some("2026-10-16".to_string());
    let mut later = episode(1, 3);
    later.release_date = Some("2026-10-14".to_string());
    let episodes = [episode(1, 1), future, later];
    assert!(navigation(&episodes, &request(1, 1)).next_index.is_none());
    let mut tomorrow = request(1, 1);
    tomorrow.today = "2026-10-16".to_string();
    assert_eq!(navigation(&episodes, &tomorrow).next_index, Some(1));
}

#[test]
fn player_episode_navigation_accepts_undated_and_invalid_dates() {
    for date in [None, Some("invalid"), Some("2026-02-30"), Some("")] {
        let mut successor = episode(1, 2);
        successor.release_date = date.map(str::to_string);
        let episodes = [episode(1, 1), successor];
        assert_eq!(navigation(&episodes, &request(1, 1)).next_index, Some(1));
    }
}

#[test]
fn player_episode_navigation_uses_calendar_day_not_timestamp_offset() {
    for (date, aired) in [
        ("2026-10-15", true),
        ("2026-10-15T23:59:59-12:00", true),
        ("2026-10-16T00:00:00+14:00", false),
    ] {
        let mut successor = episode(1, 2);
        successor.release_date = Some(date.to_string());
        assert_eq!(
            navigation(&[episode(1, 1), successor], &request(1, 1))
                .next_index
                .is_some(),
            aired
        );
    }
}

#[test]
fn player_episode_navigation_orders_unsorted_input() {
    let episodes = [
        episode(2, 2),
        episode(0, 1),
        episode(1, 2),
        episode(2, 1),
        episode(1, 1),
    ];
    let result = navigation(&episodes, &request(1, 2));
    assert_eq!(result.previous_index, Some(4));
    assert_eq!(result.next_index, Some(3));
}

#[test]
fn player_episode_navigation_preserves_coordinate_ties_and_camel_case_index_dto() {
    let episodes = [
        episode(1, 1),
        episode(1, 1),
        episode(1, 2),
        episode(1, 3),
        episode(1, 3),
    ];
    let result = navigation(&episodes, &request(1, 2));
    assert_eq!(result.previous_index, Some(1));
    assert_eq!(result.next_index, Some(3));
    let dto = serde_json::to_value(result).unwrap();
    assert_eq!(
        dto,
        serde_json::json!({ "previousIndex": 1, "nextIndex": 3 })
    );
    assert_eq!(
        serde_json::to_value(get_episode_navigation(request(1, 1)).unwrap()).unwrap(),
        serde_json::json!({ "previousIndex": null, "nextIndex": null })
    );
    let request: EpisodeNavigationRequest = serde_json::from_value(serde_json::json!({
        "episodes": [{ "season": 1, "episode": 3, "releaseDate": "2026-10-15" }],
        "season": 1,
        "episode": 2,
        "today": "2026-10-15",
    }))
    .unwrap();
    assert_eq!(request.season, 1);
    assert_eq!(request.episode, 2);
    assert_eq!(request.episodes[0].season, 1);
    assert_eq!(request.episodes[0].episode, 3);
    assert_eq!(
        request.episodes[0].release_date.as_deref(),
        Some("2026-10-15")
    );
}

#[test]
fn player_episode_navigation_bounds_episode_input_and_validates_local_day() {
    for (count, valid) in [(2_000, true), (2_001, false)] {
        let mut coordinates = request(1, 1);
        coordinates.episodes = (0..count)
            .map(|_| NavigationCoordinate {
                season: 1,
                episode: 1,
                release_date: None,
            })
            .collect();
        assert_eq!(get_episode_navigation(coordinates).is_ok(), valid);
    }
    let mut invalid = request(1, 1);
    invalid.today = "2026-02-30".to_string();
    assert!(get_episode_navigation(invalid).is_err());
}
