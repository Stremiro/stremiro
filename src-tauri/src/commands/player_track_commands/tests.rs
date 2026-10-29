use super::*;

fn track(id: i64, track_type: PlayerTrackType) -> PlayerTrack {
    PlayerTrack {
        id,
        r#type: track_type,
        display_label: format!("Track {id}"),
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
        display_label: "EN".to_string(),
        lang: Some("en".to_string()),
        selected: true,
        default_track: true,
        external_filename: Some("https://subs.example/1".to_string()),
        ..track(7, PlayerTrackType::Sub)
    };

    let json = serde_json::to_value(&sample).unwrap();
    assert_eq!(json["id"], 7);
    assert_eq!(json["type"], "sub");
    assert_eq!(json["displayLabel"], "EN");
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

#[test]
fn track_changes_allow_only_audio_subtitle_ids_off_and_cycle() {
    use serde_json::json;

    for (kind, target, command, args) in [
        ("audio", json!(2), "set", json!(["aid", 2])),
        ("sub", json!(3), "set", json!(["sid", 3])),
        ("sub", json!("no"), "set", json!(["sid", "no"])),
        ("audio", json!("cycle"), "cycle", json!(["aid"])),
        ("sub", json!("cycle"), "cycle", json!(["sub"])),
    ] {
        let (actual, values) = track_change_command(kind, &target).unwrap();
        assert_eq!(actual, command);
        assert_eq!(json!(values), args);
    }
    for (kind, target) in [
        ("video", json!(1)),
        ("audio", json!("no")),
        ("sub", json!(0)),
        ("sub", json!(-1)),
        ("sub", json!(1.5)),
        ("sub", json!("auto")),
        ("sub", json!("1")),
        ("sub", json!(null)),
        ("sub", json!(true)),
    ] {
        assert!(
            track_change_command(kind, &target).is_err(),
            "{kind}/{target}"
        );
    }
    let tracks = [PlayerTrack {
        selected: true,
        ..track(3, PlayerTrackType::Sub)
    }];
    assert!(track_selection_matches(&tracks, "sub", &json!(3)));
    assert!(!track_selection_matches(&tracks, "sub", &json!(2)));
    assert!(!track_selection_matches(&tracks, "sub", &json!("no")));
    assert!(track_selection_matches(&tracks, "audio", &json!("no")));
}
