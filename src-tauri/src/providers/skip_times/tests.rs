use super::{
    collect_skip_db_segments, normalize_skip_segments, skip_times_fetch_failure,
    skip_times_http_failure, FetchFailure, SkipDbSegmentEntry, SkipDbSegmentsResponse, SkipSegment,
    SkipTimesResult, TRANSIENT_ERROR,
};

#[test]
fn skipdb_http_failures_retry_timeouts_rate_limits_and_all_server_errors() {
    for status in [408, 429, 500, 501, 502, 503, 504, 505, 599] {
        assert_eq!(
            skip_times_http_failure(reqwest::StatusCode::from_u16(status).unwrap()).unwrap_err(),
            TRANSIENT_ERROR,
            "{status}"
        );
    }
    for status in [301, 400, 401, 403, 404, 409, 422] {
        assert!(
            skip_times_http_failure(reqwest::StatusCode::from_u16(status).unwrap())
                .unwrap()
                .segments
                .is_empty(),
            "{status}"
        );
    }
}

#[test]
fn skipdb_transport_failures_retry_reads_but_not_fatal_inputs() {
    crate::providers::ensure_rustls_crypto_provider();
    let error = reqwest::Client::new().get("not a URL").build().unwrap_err();
    for (failure, retry) in [
        (FetchFailure::Retryable("offline".into()), true),
        (FetchFailure::Fatal("invalid".into()), false),
        (
            FetchFailure::from_send_error(&error, "invalid".into()),
            false,
        ),
        (
            crate::providers::BoundedBodyError::Read("disconnect".into()).into(),
            true,
        ),
        (
            crate::providers::BoundedBodyError::TooLarge("oversize".into()).into(),
            false,
        ),
    ] {
        assert_eq!(
            skip_times_fetch_failure(failure),
            if retry {
                Err(TRANSIENT_ERROR.to_string())
            } else {
                Ok(SkipTimesResult::default())
            }
        );
    }
}

#[test]
fn normalize_skip_segments_sorts_and_trims_overlaps_between_types() {
    let normalized = normalize_skip_segments(
        vec![
            SkipSegment {
                type_: "recap",
                start_time: 30.0,
                end_time: 60.0,
                uncertain: false,
            },
            SkipSegment {
                type_: "intro",
                start_time: -4.0004,
                end_time: 40.0,
                uncertain: false,
            },
            SkipSegment {
                type_: "outro",
                start_time: 80.0,
                end_time: 79.0,
                uncertain: false,
            },
        ],
        None,
    );

    assert_eq!(
        normalized,
        vec![
            SkipSegment {
                type_: "intro",
                start_time: 0.0,
                end_time: 40.0,
                uncertain: false,
            },
            SkipSegment {
                type_: "recap",
                start_time: 40.0,
                end_time: 60.0,
                uncertain: false,
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
        .into_segment("intro", None)
        .expect("intro converts");
    assert_eq!(
        segment,
        SkipSegment {
            type_: "intro",
            start_time: 61.0,
            end_time: 91.0,
            uncertain: false,
        }
    );

    assert!(
        entry(response.segments.outro)
            .into_segment("outro", None)
            .is_some(),
        "agnostic matches carry the canonical submitted cut and always convert"
    );
    assert!(entry(response.segments.preview)
        .into_segment("preview", None)
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

    assert_eq!(
        collect_skip_db_segments(response, None).segments,
        vec![SkipSegment {
            type_: "outro",
            start_time: 2760.0,
            end_time: 2820.0,
            uncertain: false,
        }],
    );
}

#[test]
fn skipdb_intro_estimate_backs_only_a_missing_intro() {
    let collect = |json: &str| {
        collect_skip_db_segments(
            serde_json::from_str::<SkipDbSegmentsResponse>(json).expect("response parses"),
            Some(2820.0),
        )
    };
    let outro = SkipSegment {
        type_: "outro",
        start_time: 2760.0,
        end_time: 2820.0,
        uncertain: false,
    };
    for (label, json, expected) in [
        (
            "season median when the episode has no intro",
            r#"{"segments":{"intro":null,"outro":{"start_ms":2760000,"end_ms":2820000,"match":"exact"}},"intro_length_estimate_ms":30000}"#,
            Some(27.0),
        ),
        (
            "an out-of-range intro still measures this episode",
            r#"{"segments":{"intro":{"start_ms":229500,"end_ms":246500,"match":"out-of-range"}},"intro_length_estimate_ms":30000}"#,
            Some(14.0),
        ),
        (
            "confirmed-absent sentinel suppresses the median",
            r#"{"segments":{"intro":{"start_ms":0,"end_ms":0,"match":"exact"}},"intro_length_estimate_ms":30000}"#,
            None,
        ),
        (
            "a usable intro needs no estimate",
            r#"{"segments":{"intro":{"start_ms":61000,"end_ms":91000,"match":"exact"}},"intro_length_estimate_ms":30000}"#,
            None,
        ),
        (
            "too short after lead time",
            r#"{"segments":{},"intro_length_estimate_ms":7000}"#,
            None,
        ),
        (
            "longer than any valid intro",
            r#"{"segments":{},"intro_length_estimate_ms":400000}"#,
            None,
        ),
        (
            "malformed estimate keeps the segments",
            r#"{"segments":{"outro":{"start_ms":2760000,"end_ms":2820000}},"intro_length_estimate_ms":"30s"}"#,
            None,
        ),
    ] {
        assert_eq!(collect(json).intro_estimate_secs, expected, "{label}");
    }
    assert_eq!(
        collect(
            r#"{"segments":{"outro":{"start_ms":2760000,"end_ms":2820000}},"intro_length_estimate_ms":"30s"}"#
        ),
        SkipTimesResult {
            segments: vec![outro],
            intro_estimate_secs: None,
        }
    );
}

#[test]
fn skipdb_out_of_range_keeps_only_edge_anchored_segments_as_uncertain() {
    // Live SkipDB answer for Avatar S1E17 requested with an 88.5 s shorter cut (1380 s).
    let response: SkipDbSegmentsResponse = serde_json::from_str(
        r#"{"segments":{
            "intro":{"start_ms":0,"end_ms":52600,"offset_ms":-88500,"match":"out-of-range"},
            "recap":null,
            "outro":{"start_ms":1420000,"end_ms":1468500,"offset_ms":-88500,"match":"out-of-range"},
            "preview":null},
          "intro_length_estimate_ms":52700}"#,
    )
    .expect("response parses");
    assert_eq!(
        collect_skip_db_segments(response, Some(1380.0)),
        SkipTimesResult {
            segments: vec![
                SkipSegment {
                    type_: "intro",
                    start_time: 0.0,
                    end_time: 52.6,
                    uncertain: true,
                },
                SkipSegment {
                    type_: "outro",
                    start_time: 1331.5,
                    end_time: 1380.0,
                    uncertain: true,
                },
            ],
            // This episode's own intro is known, so no relative "skip ~Xs" guess.
            intro_estimate_secs: None,
        }
    );

    let entry = |start_ms: f64, end_ms: Option<f64>, offset_ms: Option<f64>| SkipDbSegmentEntry {
        start_ms,
        end_ms,
        match_: Some("out-of-range".to_string()),
        offset_ms,
    };
    // Mid-stream timestamps belong to a different cut and would skip the wrong scene.
    assert!(entry(229_500.0, Some(246_500.0), Some(-88_500.0))
        .into_segment("intro", Some(1380.0))
        .is_none());
    assert!(entry(2_700_000.0, Some(2_760_000.0), Some(-60_000.0))
        .into_segment("preview", Some(2760.0))
        .is_none());
    // A closing segment can't be located without the stored cut's length or a stream duration.
    assert!(entry(1_420_000.0, Some(1_468_500.0), None)
        .into_segment("outro", Some(1380.0))
        .is_none());
    assert!(entry(0.0, Some(52_600.0), Some(-88_500.0))
        .into_segment("intro", None)
        .is_none());
    // An end-less outro runs to the stored end, so it re-anchors too.
    assert_eq!(
        entry(1_420_000.0, None, Some(-88_500.0)).into_segment("outro", Some(1380.0)),
        Some(SkipSegment {
            type_: "outro",
            start_time: 1331.5,
            end_time: 1380.0,
            uncertain: true,
        }),
    );
}

#[test]
fn skipdb_end_less_outro_runs_to_requested_duration_only() {
    let end_less = || SkipDbSegmentEntry {
        start_ms: 2700000.0,
        end_ms: None,
        match_: None,
        offset_ms: None,
    };
    assert_eq!(
        end_less().into_segment("outro", Some(2820.0)),
        Some(SkipSegment {
            type_: "outro",
            start_time: 2700.0,
            end_time: 2820.0,
            uncertain: false,
        }),
    );
    // Without a stream duration there is no usable cut, and only outros run to the end.
    assert!(end_less().into_segment("outro", None).is_none());
    assert!(end_less().into_segment("preview", Some(2820.0)).is_none());
}

#[test]
fn skipdb_out_of_range_rejects_full_stream_and_malformed_anchors() {
    for (type_, start_ms, end_ms, offset_ms) in [
        ("outro", 1_420_000.0, 1_468_500.0, -1_438_500.0),
        ("outro", 1_420_000.0, 1_450_000.0, -1_420_000.0),
        ("outro", -1.0, 30_000.0, 0.0),
        ("preview", 30_000.0, 30_000.0, 0.0),
        ("intro", -1.0, 20_000.0, 0.0),
        ("recap", 0.0, 30_000.0, 0.0),
        ("intro", 0.0, 31_000.0, 0.0),
    ] {
        let entry = SkipDbSegmentEntry {
            start_ms,
            end_ms: Some(end_ms),
            match_: Some("out-of-range".into()),
            offset_ms: Some(offset_ms),
        };
        assert!(
            entry.into_segment(type_, Some(30.0)).is_none(),
            "{type_} {start_ms}"
        );
    }
}

#[test]
fn skipdb_intro_estimate_stays_before_eof_and_ignores_malformed_rows() {
    for (duration, expected) in [(26.0, None), (27.0, None), (28.0, Some(27.0))] {
        let response = serde_json::from_str(r#"{"intro_length_estimate_ms":30000}"#).unwrap();
        assert_eq!(
            collect_skip_db_segments(response, Some(duration)).intro_estimate_secs,
            expected
        );
    }
    for (start_ms, end_ms) in [(-1.0, 0.0), (100_000.0, 90_000.0)] {
        let response = serde_json::from_value(serde_json::json!({
            "intro_length_estimate_ms": 30000,
            "segments": {"intro": {"start_ms": start_ms, "end_ms": end_ms}}
        }))
        .unwrap();
        assert_eq!(
            collect_skip_db_segments(response, Some(100.0)).intro_estimate_secs,
            Some(27.0)
        );
    }
}

#[test]
fn normalize_skip_segments_clamps_to_stream_duration() {
    let segment = |type_, start_time, end_time| SkipSegment {
        type_,
        start_time,
        end_time,
        uncertain: false,
    };
    assert_eq!(
        normalize_skip_segments(
            vec![
                segment("outro", 2700.0, 2830.0),
                segment("preview", 2819.5, 2900.0),
                segment("intro", 60.0, 90.0),
            ],
            Some(2820.0),
        ),
        vec![
            segment("intro", 60.0, 90.0),
            segment("outro", 2700.0, 2820.0)
        ],
    );
}

#[test]
fn normalize_skip_segments_rejects_timestamp_rounding_overflow() {
    let valid = SkipSegment {
        type_: "intro",
        start_time: 10.0,
        end_time: 90.0,
        uncertain: false,
    };
    let mut segments = vec![valid.clone()];
    for (start_time, end_time) in [(0.0, f64::MAX), (f64::MAX, f64::MAX)] {
        segments.push(SkipSegment {
            type_: "outro",
            start_time,
            end_time,
            uncertain: false,
        });
    }
    assert_eq!(normalize_skip_segments(segments, None), [valid]);
}
