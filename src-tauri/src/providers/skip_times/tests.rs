use super::{
    collect_skip_db_segments, normalize_skip_segments, SkipDbSegmentEntry, SkipDbSegmentsResponse,
    SkipSegment,
};

#[test]
fn normalize_skip_segments_merges_adjacent_same_type_entries() {
    let normalized = normalize_skip_segments(vec![
        SkipSegment {
            type_: "intro".to_string(),
            start_time: -4.0,
            end_time: 15.0,
        },
        SkipSegment {
            type_: "intro".to_string(),
            start_time: 14.9,
            end_time: 26.0,
        },
        SkipSegment {
            type_: "outro".to_string(),
            start_time: 89.5,
            end_time: 120.0,
        },
    ]);

    assert_eq!(
        normalized,
        vec![
            SkipSegment {
                type_: "intro".to_string(),
                start_time: 0.0,
                end_time: 26.0,
            },
            SkipSegment {
                type_: "outro".to_string(),
                start_time: 89.5,
                end_time: 120.0,
            },
        ],
    );
}

#[test]
fn normalize_skip_segments_sorts_and_trims_overlaps_between_types() {
    let normalized = normalize_skip_segments(vec![
        SkipSegment {
            type_: "recap".to_string(),
            start_time: 30.0,
            end_time: 60.0,
        },
        SkipSegment {
            type_: "intro".to_string(),
            start_time: 0.0,
            end_time: 25.0,
        },
        SkipSegment {
            type_: "intro".to_string(),
            start_time: 24.9,
            end_time: 40.0,
        },
        SkipSegment {
            type_: "outro".to_string(),
            start_time: 80.0,
            end_time: 79.0,
        },
    ]);

    assert_eq!(
        normalized,
        vec![
            SkipSegment {
                type_: "intro".to_string(),
                start_time: 0.0,
                end_time: 40.0,
            },
            SkipSegment {
                type_: "recap".to_string(),
                start_time: 40.0,
                end_time: 60.0,
            },
        ],
    );
}

#[test]
fn skipdb_response_converts_ms_and_keeps_all_submitted_segments() {
    let response: SkipDbSegmentsResponse = serde_json::from_str(
        r#"{
                "imdb_id": "tt0903747",
                "season": 1,
                "episode": 1,
                "segments": {
                    "intro": {
                        "start_ms": 61000, "end_ms": 91000,
                        "match": "agnostic", "adjusted": false,
                        "offset_ms": 0, "confidence": 0.93
                    },
                    "recap": null,
                    "outro": {
                        "start_ms": 2760000, "end_ms": 2820000,
                        "match": "agnostic", "adjusted": false,
                        "offset_ms": 0, "confidence": 0.6
                    },
                    "preview": {
                        "start_ms": 2000, "end_ms": 30000,
                        "match": "agnostic", "adjusted": false,
                        "offset_ms": 0, "confidence": 0.75
                    }
                }
            }"#,
    )
    .expect("skipdb response should parse");

    let entry = |value: Option<serde_json::Value>| {
        serde_json::from_value::<SkipDbSegmentEntry>(value.expect("entry")).expect("entry parses")
    };

    let segment = entry(response.segments.intro)
        .into_segment("intro")
        .expect("intro converts");
    assert_eq!(
        segment,
        SkipSegment {
            type_: "intro".to_string(),
            start_time: 61.0,
            end_time: 91.0,
        }
    );

    assert!(
        entry(response.segments.outro)
            .into_segment("outro")
            .is_some(),
        "agnostic matches carry the canonical submitted cut and always convert"
    );
    assert!(entry(response.segments.preview)
        .into_segment("preview")
        .is_some());
}

#[test]
fn skipdb_malformed_entry_drops_only_that_segment() {
    // A missing `start_ms` — or any wrong-typed field — must fail its own
    // entry parse, not the whole response decode.
    let response: SkipDbSegmentsResponse = serde_json::from_str(
        r#"{
            "segments": {
                "intro": { "end_ms": 91000, "match": "agnostic" },
                "outro": { "start_ms": 2760000, "end_ms": 2820000, "match": "agnostic" },
                "preview": "not-an-object"
            }
        }"#,
    )
    .expect("malformed entries must not fail the response decode");

    let segments = collect_skip_db_segments(response.segments);
    assert_eq!(
        segments,
        vec![SkipSegment {
            type_: "outro".to_string(),
            start_time: 2760.0,
            end_time: 2820.0,
        }],
    );
}

#[test]
fn skipdb_out_of_range_entry_is_dropped() {
    // The closest stored cut differs too much from this stream's duration —
    // its timestamps belong to a different cut and would skip wrongly.
    let entry = SkipDbSegmentEntry {
        start_ms: 2700000.0,
        end_ms: Some(2760000.0),
        match_: Some("out-of-range".to_string()),
    };
    assert!(entry.into_segment("preview").is_none());
}

#[test]
fn skipdb_entry_without_match_or_end_is_dropped() {
    // An end-less outro row only gets a real end when the request carries a
    // stream duration (the API substitutes duration_ms); without it there is
    // no usable cut.
    let entry = SkipDbSegmentEntry {
        start_ms: 2700000.0,
        end_ms: None,
        match_: None,
    };
    assert!(entry.into_segment("outro").is_none());
}
