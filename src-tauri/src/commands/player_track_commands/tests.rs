use super::*;

fn track(id: i64, track_type: PlayerTrackType) -> PlayerTrack {
    PlayerTrack {
        id,
        r#type: track_type,
        lang: None,
        title: None,
        selected: false,
        default_track: false,
        forced: false,
        hearing_impaired: false,
        external: false,
        external_filename: None,
    }
}

#[test]
fn merge_track_variants_prefers_next_non_blank_strings_and_ors_flags() {
    let mut existing = PlayerTrack {
        title: Some("English".to_string()),
        forced: true,
        ..track(2, PlayerTrackType::Sub)
    };
    let next = PlayerTrack {
        lang: Some("en".to_string()),
        external: true,
        external_filename: Some("https://subs.example/1".to_string()),
        ..track(2, PlayerTrackType::Sub)
    };

    merge_track_variants(&mut existing, next);

    assert_eq!(existing.title.as_deref(), Some("English"));
    assert_eq!(existing.lang.as_deref(), Some("en"));
    assert!(existing.forced);
    assert!(existing.external);
    assert_eq!(
        existing.external_filename.as_deref(),
        Some("https://subs.example/1")
    );
}

#[test]
fn merge_track_variants_lets_next_string_win() {
    let mut existing = PlayerTrack {
        title: Some("Old".to_string()),
        ..track(1, PlayerTrackType::Audio)
    };
    let next = PlayerTrack {
        title: Some("New".to_string()),
        ..track(1, PlayerTrackType::Audio)
    };

    merge_track_variants(&mut existing, next);

    assert_eq!(existing.title.as_deref(), Some("New"));
}

#[test]
fn player_track_serializes_with_frontend_field_names() {
    let sample = PlayerTrack {
        lang: Some("en".to_string()),
        selected: true,
        default_track: true,
        external_filename: Some("https://subs.example/1".to_string()),
        ..track(7, PlayerTrackType::Sub)
    };

    let json = serde_json::to_value(&sample).unwrap();
    assert_eq!(json["id"], 7);
    assert_eq!(json["type"], "sub");
    assert_eq!(json["lang"], "en");
    assert_eq!(json["selected"], true);
    assert_eq!(json["defaultTrack"], true);
    assert_eq!(json["externalFilename"], "https://subs.example/1");
    // Absent optionals are omitted, matching the frontend's `field?` shape.
    assert!(json.get("externalFilename").is_some());
    let minimal = serde_json::to_value(track(1, PlayerTrackType::Video)).unwrap();
    assert!(minimal.get("lang").is_none());
    assert!(minimal.get("title").is_none());
    assert!(minimal.get("externalFilename").is_none());
}
