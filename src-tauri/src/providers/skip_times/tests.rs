use super::{
    collect_skip_db_segments, normalize_skip_segments, skip_times_body_failure,
    skip_times_fetch_failure, skip_times_http_failure, FetchFailure, SkipDbSegmentEntry,
    SkipDbSegmentsResponse, SkipSegment, TRANSIENT_ERROR,
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
fn skipdb_send_failures_only_retry_transient_errors() {
    assert_eq!(
        skip_times_fetch_failure(FetchFailure::Retryable(TRANSIENT_ERROR.to_string())).unwrap_err(),
        TRANSIENT_ERROR
    );
    assert!(
        skip_times_fetch_failure(FetchFailure::Fatal(TRANSIENT_ERROR.to_string()))
            .unwrap()
            .segments
            .is_empty()
    );

    crate::providers::ensure_rustls_crypto_provider();
    let error = reqwest::Client::new().get("not a URL").build().unwrap_err();
    assert!(error.is_builder());
    assert!(skip_times_fetch_failure(FetchFailure::from_send_error(
        &error,
        TRANSIENT_ERROR.to_string()
    ))
    .unwrap()
    .segments
    .is_empty());
}

#[test]
fn skipdb_body_failures_distinguish_transient_reads_from_oversize_payloads() {
    assert_eq!(
        skip_times_body_failure(crate::providers::BoundedBodyError::Read(
            "disconnect".to_string()
        ))
        .unwrap_err(),
        TRANSIENT_ERROR
    );
    assert!(
        skip_times_body_failure(crate::providers::BoundedBodyError::TooLarge(
            "oversize".to_string()
        ))
        .unwrap()
        .segments
        .is_empty()
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
            start_time: -4.0004,
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
        .into_segment("intro", None)
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

    let segments = collect_skip_db_segments(response.segments, None);
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
    assert!(entry.into_segment("preview", Some(2820.0)).is_none());
}

#[test]
fn skipdb_end_less_outro_runs_to_requested_duration_only() {
    let end_less = || SkipDbSegmentEntry {
        start_ms: 2700000.0,
        end_ms: None,
        match_: None,
    };
    assert_eq!(
        end_less().into_segment("outro", Some(2820.0)),
        Some(SkipSegment {
            type_: "outro".to_string(),
            start_time: 2700.0,
            end_time: 2820.0,
        }),
    );
    // Without a stream duration there is no usable cut, and only outros run to the end.
    assert!(end_less().into_segment("outro", None).is_none());
    assert!(end_less().into_segment("preview", Some(2820.0)).is_none());
}
