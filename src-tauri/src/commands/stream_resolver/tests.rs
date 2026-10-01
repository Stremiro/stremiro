use super::{
    build_resolved_direct_stream, is_advisory_probe_status, proxy_header_map, sanitize_addon_log,
};

#[test]
fn resolved_headers_stay_on_first_hop_origin() {
    let headers = || vec![("Authorization".to_string(), "Bearer fixture".to_string())];
    for (final_url, keep_headers) in [
        ("https://cdn.test/next.mkv", true),
        ("https://other.test/next.mkv", false),
        ("http://cdn.test/next.mkv", false),
        ("https://cdn.test:444/next.mkv", false),
    ] {
        let resolved = build_resolved_direct_stream(
            "https://cdn.test/start",
            final_url.to_string(),
            headers(),
        )
        .expect("valid urls resolve");
        assert_eq!(resolved.url, final_url);
        assert_eq!(resolved.format, "video/x-matroska");
        if keep_headers {
            assert_eq!(
                resolved.request_headers,
                vec![("Authorization".to_string(), "Bearer fixture".to_string())]
            );
        } else {
            assert!(
                resolved.request_headers.is_empty(),
                "{final_url} must drop cross-origin headers"
            );
        }
    }
}

#[test]
fn advisory_probe_status_covers_auth_head_and_range_gaps() {
    for status in [401, 403, 407, 405, 501, 416] {
        assert!(
            is_advisory_probe_status(status),
            "{status} must pass through"
        );
    }
}

#[test]
fn dead_link_statuses_still_fail_over() {
    for status in [400, 404, 408, 429, 500, 502, 503] {
        assert!(!is_advisory_probe_status(status), "{status} must fail over");
    }
}

#[test]
fn proxy_header_map_keeps_valid_entries_and_skips_malformed_ones() {
    let map = proxy_header_map(&[
        ("Authorization".to_string(), "Bearer secret".to_string()),
        ("X-Custom".to_string(), "value".to_string()),
        ("Bad Name".to_string(), "dropped".to_string()),
        ("X-Inject".to_string(), "a\nb".to_string()),
    ]);
    assert_eq!(map.len(), 2);
    assert_eq!(
        map.get("authorization")
            .map(|value| value.to_str().unwrap()),
        Some("Bearer secret")
    );
    assert_eq!(
        map.get("x-custom").map(|value| value.to_str().unwrap()),
        Some("value")
    );
}

#[test]
fn probe_error_redaction_strips_signed_query_and_userinfo() {
    let redacted = sanitize_addon_log(
            "error sending request for url (https://cdn.example/video.m3u8?token=signed-secret): operation timed out",
        );
    assert!(!redacted.contains("signed-secret"), "{redacted}");
    assert!(redacted.contains("token=[redacted]"), "{redacted}");

    let redacted =
        sanitize_addon_log("error sending request for url (https://user:pass@cdn.example/v)");
    assert!(!redacted.contains("user:pass"), "{redacted}");
    assert!(redacted.contains("[redacted-userinfo]@"), "{redacted}");
}
