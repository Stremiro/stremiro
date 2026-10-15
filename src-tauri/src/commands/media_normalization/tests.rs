use super::{
    build_display_year, build_release_date, extract_primary_year, normalize_episode_metadata_list,
    normalize_media_details, normalize_media_item, normalize_rating, normalize_runtime,
    normalize_title,
};
use crate::providers::{Episode, MediaDetails, MediaItem, MediaSeason};

#[test]
fn title_cleanup_preserves_names_and_bounds_visible_characters() {
    for (input, expected) in [
        (" \u{feff}The\t  Office\r\n", "The Office"),
        (
            "Spider-Man:\u{a0} Across  the Spider-Verse",
            "Spider-Man: Across the Spider-Verse",
        ),
        (
            "Amélie — 千と千尋の神隠し 👩‍🚀",
            "Amélie — 千と千尋の神隠し 👩‍🚀",
        ),
        ("1917 (2019)", "1917 (2019)"),
        ("A\0B\u{7}C", "ABC"),
        (" \u{feff}\t\0 ", ""),
    ] {
        assert_eq!(normalize_title(input, 512), expected);
    }
    assert_eq!(normalize_title("🙂🙂🙂", 2), "🙂🙂");
    assert_eq!(normalize_title("A  B", 2), "A");
    assert_eq!(normalize_title("A  B", 3), "A B");
}

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
fn media_item_wire_emits_primary_year_and_ignores_inbound_values() {
    let item = normalize_media_item(MediaItem {
        year: Some("Premiered in 2021".to_string()),
        ..crate::test_helpers::test_media_item("tt1", "series")
    });
    let wire = serde_json::to_value(&item).expect("serialize");
    assert_eq!(wire["primaryYear"], serde_json::json!(2021));
    // Undated items omit the key entirely rather than emitting null.
    let undated = serde_json::to_value(crate::test_helpers::test_media_item("tt2", "movie"))
        .expect("serialize");
    assert!(undated.get("primaryYear").is_none());

    // Inbound values never land: `skip_deserializing` drops the field and
    // normalization re-derives it from `year`.
    let inbound: MediaItem = serde_json::from_value(serde_json::json!({
        "id": "tt3", "title": "T", "type": "series",
        "year": "Premiered in 2021", "primaryYear": 1888
    }))
    .expect("deserialize");
    assert_eq!(inbound.primary_year, None);
    assert_eq!(normalize_media_item(inbound).primary_year, Some(2021));
}

#[test]
fn normalize_media_details_normalizes_years_and_episodes() {
    let details = MediaDetails {
        id: "tt123".to_string(),
        imdb_id: Some("tt123".to_string()),
        title: "Attack on Titan".to_string(),
        poster: None,
        backdrop: None,
        logo: None,
        year: Some("2013-04-07".to_string()),
        display_year: None,
        release_date: None,
        type_: "series".to_string(),
        description: None,
        rating: Some(" 8.30 ".into()),
        runtime: Some("142 min".into()),
        cast: Some(vec![" Actor ".into(), "actor".into(), "Other".into()]),
        directors: Some(vec![" Director ".into(), "DIRECTOR".into()]),
        genres: Some(vec![" Drama ".into(), "drama".into()]),
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
        seasons: Some(vec![MediaSeason {
            number: 1,
            episode_count: 2,
        }]),
    };

    let normalized = normalize_media_details(details, "kitsu:123");

    assert_eq!(normalized.id, "kitsu:123");
    assert_eq!(normalized.imdb_id.as_deref(), Some("tt123"));
    assert_eq!(normalized.rating.as_deref(), Some("8.30"));
    assert_eq!(normalized.runtime.as_deref(), Some("2h 22m"));
    assert_eq!(normalized.cast.unwrap(), ["Actor", "Other"]);
    assert_eq!(normalized.directors.unwrap(), ["Director"]);
    assert_eq!(normalized.genres.unwrap(), ["Drama"]);
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
        runtime: None,
        cast: None,
        directors: None,
        genres: None,
        trailers: None,
        episodes: None,
        seasons: None,
    };

    // A full `released` stamp keeps its exact day; without it the year-only
    // fallback still produces a schedulable Jan 1 date.
    assert_eq!(
        normalize_media_details(details(Some("2024-07-18T00:00:00.000Z")), "tt1")
            .release_date
            .as_deref(),
        Some("2024-07-18")
    );
    assert_eq!(
        normalize_media_details(details(None), "tt1")
            .release_date
            .as_deref(),
        Some("2024-01-01")
    );
    for (released, expected) in [
        ("2023-07-18T00:00:00.000Z", Some("2023")),
        ("2024-02-29", Some("2024")),
        ("2023-02-29", None),
        ("2024", None),
        ("Unknown", None),
    ] {
        let mut input = details(Some(released));
        input.year = None;
        assert_eq!(
            normalize_media_details(input, "tt1")
                .display_year
                .as_deref(),
            expected,
            "{released}"
        );
    }
}

#[test]
fn runtime_and_rating_reject_invalid_display_values() {
    for (input, expected) in [
        ("142 min", "2h 22m"),
        ("142", "2h 22m"),
        ("142m", "2h 22m"),
        ("45 mins", "45m"),
        ("2h 22min", "2h 22m"),
        (" 2 h 22 m ", "2h 22m"),
        ("120", "2h"),
        ("1", "1m"),
        ("1440", "24h"),
    ] {
        assert_eq!(
            normalize_runtime(Some(input.into())).as_deref(),
            Some(expected)
        );
        assert_eq!(
            normalize_runtime(Some(expected.into())).as_deref(),
            Some(expected)
        );
    }
    for invalid in ["N/A", "0", "1441", "-1", "1.5", "2h 60m", "999999999999h"] {
        assert_eq!(normalize_runtime(Some(invalid.into())), None, "{invalid}");
    }
    for valid in ["0", "10", "8.30"] {
        assert_eq!(
            normalize_rating(Some(format!(" {valid} "))).as_deref(),
            Some(valid)
        );
    }
    for invalid in ["N/A", "83", "-0.1", "10.1", "8.3/10", "NaN", "inf", ""] {
        assert_eq!(normalize_rating(Some(invalid.into())), None, "{invalid}");
    }
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
        runtime: None,
        cast: Some((0..200).map(|index| format!("actor-{index}")).collect()),
        directors: Some(
            (0..16)
                .map(|index| format!("{index}{}", "d".repeat(200)))
                .collect(),
        ),
        genres: None,
        trailers: None,
        episodes: Some((1..=2).map(episode).collect()),
        seasons: Some(vec![MediaSeason {
            number: 1,
            episode_count: 2,
        }]),
    };

    let normalized = normalize_media_details(details, "tt123");

    assert_eq!(normalized.imdb_id.as_deref().map(str::len), Some(256));
    assert_eq!(normalized.rating, None);
    assert_eq!(normalized.cast.as_ref().map(Vec::len), Some(64));
    let directors = normalized.directors.unwrap();
    assert_eq!(directors.len(), 8);
    assert!(directors.iter().all(|name| name.chars().count() == 128));
    let episodes = normalized.episodes.expect("episodes");
    assert_eq!(episodes.len(), 2);
    assert_eq!(episodes[0].id.len(), 256);
    assert_eq!(episodes[0].title.as_deref().map(str::len), Some(512));
    assert_eq!(episodes[0].overview.as_deref().map(str::len), Some(4_096));
    assert_eq!(episodes[0].thumbnail.as_deref().map(str::len), Some(2_048));
}
