use super::build_source_episode_coordinates;
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
