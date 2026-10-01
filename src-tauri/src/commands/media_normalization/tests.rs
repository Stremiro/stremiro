use super::{
    build_display_year, build_release_date, extract_primary_year, normalize_episode_metadata_list,
    normalize_media_details, normalize_media_item,
};
use crate::providers::{Episode, MediaDetails, MediaItem, Trailer};

#[test]
fn extract_primary_year_reads_first_valid_year() {
    assert_eq!(extract_primary_year(Some("2019-04-06")), Some(2019));
    assert_eq!(extract_primary_year(Some("Premiered in 2021")), Some(2021));
    assert_eq!(extract_primary_year(Some("Unknown")), None);
    assert_eq!(extract_primary_year(Some("Café 2019")), Some(2019));
    assert_eq!(extract_primary_year(Some("日本 2021-04-06")), Some(2021));
    assert_eq!(extract_primary_year(Some("Été 1999")), Some(1999));
    assert_eq!(extract_primary_year(Some("🙂 2018")), Some(2018));
    assert_eq!(extract_primary_year(Some("1232019")), Some(2019));
    assert_eq!(extract_primary_year(Some("１２３４")), None);
    assert_eq!(extract_primary_year(Some("12")), None);
    assert_eq!(extract_primary_year(Some("1888")), None);
    assert_eq!(extract_primary_year(Some("2101")), None);
}

#[test]
fn build_display_year_uses_first_valid_numeric_year() {
    assert_eq!(
        build_display_year(Some("2019-04-06")).as_deref(),
        Some("2019")
    );
    assert_eq!(
        build_display_year(Some("2019-2020")).as_deref(),
        Some("2019")
    );
    assert_eq!(build_display_year(Some("Unknown")), None);
}

#[test]
fn normalize_media_item_sets_display_year() {
    let item = normalize_media_item(MediaItem {
        id: "tt1".to_string(),
        title: "Demo".to_string(),
        poster: None,
        backdrop: None,
        logo: None,
        description: None,
        year: Some("2024-10-01".to_string()),
        primary_year: None,
        display_year: None,
        genres: None,
        type_: "movie".to_string(),
    });

    assert_eq!(item.primary_year, Some(2024));
    assert_eq!(item.display_year.as_deref(), Some("2024"));
}

#[test]
fn normalize_media_details_normalizes_years_and_episodes() {
    let details = MediaDetails {
        id: "tt123".to_string(),
        imdb_id: None,
        title: "Attack on Titan".to_string(),
        poster: None,
        backdrop: None,
        logo: None,
        year: Some("2013-04-07".to_string()),
        display_year: None,
        release_date: None,
        type_: "series".to_string(),
        description: None,
        rating: None,
        cast: None,
        genres: None,
        trailers: None,
        episodes: Some(vec![
            Episode {
                id: "ep-1".to_string(),
                title: Some("Episode 1".to_string()),
                season: 1,
                episode: 1,
                released: Some("2013-04-07".to_string()),
                release_date: None,
                overview: None,
                thumbnail: None,
                stream_lookup_id: None,
                stream_season: None,
                stream_episode: None,
            },
            Episode {
                id: "ep-2".to_string(),
                title: Some("Episode 2".to_string()),
                season: 1,
                episode: 2,
                released: Some("2014-01-05".to_string()),
                release_date: None,
                overview: None,
                thumbnail: None,
                stream_lookup_id: None,
                stream_season: None,
                stream_episode: None,
            },
        ]),
    };

    let normalized = normalize_media_details(details);

    assert_eq!(normalized.display_year.as_deref(), Some("2013"));
    assert_eq!(normalized.release_date.as_deref(), Some("2013-04-07"));
    assert_eq!(
        normalized
            .episodes
            .as_ref()
            .and_then(|episodes| episodes.first())
            .and_then(|episode| episode.release_date.as_deref()),
        Some("2013-04-07")
    );
}

#[test]
fn build_release_date_prefers_explicit_date_and_falls_back_to_year_start() {
    assert_eq!(
        build_release_date(Some("Premiered 2024-10-05 on TV")).as_deref(),
        Some("2024-10-05")
    );
    assert_eq!(
        build_release_date(Some("2024")).as_deref(),
        Some("2024-01-01")
    );
    assert_eq!(build_release_date(Some("Unknown")), None);
    // Invalid matched dates reject instead of degrading to the year fallback.
    for invalid in [
        "2025-02-29",
        "2024-02-30",
        "2024-00-10",
        "2024-13-01",
        "2024-01-00",
        "2024-04-31",
    ] {
        assert_eq!(build_release_date(Some(invalid)), None, "{invalid}");
    }
    assert_eq!(
        build_release_date(Some("2024-02-29")).as_deref(),
        Some("2024-02-29")
    );
}

#[test]
fn normalize_episode_metadata_list_sets_episode_release_dates() {
    let episode = |id: &str, released: &str| Episode {
        id: id.to_string(),
        title: Some("Episode 1".to_string()),
        season: 1,
        episode: 1,
        released: Some(released.to_string()),
        release_date: None,
        overview: None,
        thumbnail: None,
        stream_lookup_id: None,
        stream_season: None,
        stream_episode: None,
    };
    let episodes = normalize_episode_metadata_list(vec![
        episode("ep-1", "2024"),
        episode("ep-2", "2024-13-40"),
    ]);

    assert_eq!(episodes[0].release_date.as_deref(), Some("2024-01-01"));
    assert_eq!(episodes[1].release_date, None);
}

#[test]
fn normalize_media_details_prefers_full_release_date_over_year() {
    let details = |release_date: Option<&str>| MediaDetails {
        id: "tt1".to_string(),
        imdb_id: None,
        title: "Movie".to_string(),
        poster: None,
        backdrop: None,
        logo: None,
        year: Some("2024".to_string()),
        display_year: None,
        release_date: release_date.map(|value| value.to_string()),
        type_: "movie".to_string(),
        description: None,
        rating: None,
        cast: None,
        genres: None,
        trailers: None,
        episodes: None,
    };

    // A full `released` stamp keeps its exact day; without it the year-only
    // fallback still produces a schedulable Jan 1 date.
    assert_eq!(
        normalize_media_details(details(Some("2024-07-18T00:00:00.000Z")))
            .release_date
            .as_deref(),
        Some("2024-07-18")
    );
    assert_eq!(
        normalize_media_details(details(None))
            .release_date
            .as_deref(),
        Some("2024-01-01")
    );
}

#[test]
fn normalize_media_item_bounds_text_and_gates_images() {
    let item = normalize_media_item(MediaItem {
        id: "tt1".to_string(),
        title: format!("  {}  ", "t".repeat(900)),
        poster: Some("javascript:alert(1)".to_string()),
        backdrop: Some("https://cdn.test/back.jpg".to_string()),
        logo: None,
        description: Some("d".repeat(9_999)),
        year: Some("2024".to_string()),
        primary_year: None,
        display_year: None,
        genres: Some(
            (0..40)
                .map(|index| format!("genre-{index}"))
                .chain(std::iter::once("   ".to_string()))
                .collect(),
        ),
        type_: "movie".to_string(),
    });

    assert_eq!(item.title.chars().count(), 512);
    assert_eq!(item.poster, None);
    assert_eq!(item.backdrop.as_deref(), Some("https://cdn.test/back.jpg"));
    assert_eq!(
        item.description.as_deref().map(str::len),
        Some(super::MEDIA_DESCRIPTION_MAX_CHARS)
    );
    assert_eq!(
        item.genres.as_ref().map(Vec::len),
        Some(super::MEDIA_GENRES_MAX)
    );
}

#[test]
fn normalize_media_details_bounds_lists_and_episode_fields() {
    let episode = |number: u32| Episode {
        id: "e".repeat(600),
        title: Some("t".repeat(900)),
        season: 1,
        episode: number,
        released: Some("2024-01-05".to_string()),
        release_date: None,
        overview: Some("o".repeat(9_999)),
        thumbnail: Some("t".repeat(4_096)),
        stream_lookup_id: None,
        stream_season: None,
        stream_episode: None,
    };
    let details = MediaDetails {
        id: "tt123".to_string(),
        imdb_id: Some("i".repeat(900)),
        title: "Series".to_string(),
        poster: None,
        backdrop: None,
        logo: None,
        year: Some("2024".to_string()),
        display_year: None,
        release_date: None,
        type_: "series".to_string(),
        description: None,
        rating: Some("r".repeat(500)),
        cast: Some((0..200).map(|index| format!("actor-{index}")).collect()),
        genres: None,
        trailers: Some(
            (0..64)
                .map(|index| Trailer {
                    id: format!("tr-{index}"),
                    source: "youtube".to_string(),
                    url: format!("https://youtube.test/{}", "u".repeat(4_096)),
                })
                .collect(),
        ),
        episodes: Some((1..=2).map(episode).collect()),
    };

    let normalized = normalize_media_details(details);

    assert_eq!(normalized.imdb_id.as_deref().map(str::len), Some(256));
    assert_eq!(normalized.rating.as_deref().map(str::len), Some(64));
    assert_eq!(normalized.cast.as_ref().map(Vec::len), Some(64));
    assert_eq!(normalized.trailers.as_ref().map(Vec::len), Some(32));
    assert_eq!(normalized.trailers.as_ref().unwrap()[0].url.len(), 2_048);
    let episodes = normalized.episodes.expect("episodes");
    assert_eq!(episodes.len(), 2);
    assert_eq!(episodes[0].id.len(), 256);
    assert_eq!(episodes[0].title.as_deref().map(str::len), Some(512));
    assert_eq!(episodes[0].overview.as_deref().map(str::len), Some(4_096));
    assert_eq!(episodes[0].thumbnail.as_deref().map(str::len), Some(2_048));
}
