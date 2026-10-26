use super::{
    build_resolved_direct_stream, format_mpv_http_header_fields, is_advisory_probe_status,
    proxy_header_map, resolve_redirect_url, validate_probe_content_type,
};
use crate::commands::streaming_helpers::PLAYBACK_URL_MAX_BYTES;
use crate::providers::addons::sanitize_addon_log;

#[test]
fn relative_redirects_inherit_playback_fragments() {
    let initial = reqwest::Url::parse("https://cdn.test/start#filename.mkv").unwrap();
    for (location, expected) in [
        ("/video", "https://cdn.test/video#filename.mkv"),
        ("next", "https://cdn.test/next#filename.mkv"),
        (
            "/video%23part",
            "https://cdn.test/video%23part#filename.mkv",
        ),
    ] {
        let target = resolve_redirect_url(&initial, location).unwrap();
        let resolved = build_resolved_direct_stream(&initial, target.to_string(), &[]).unwrap();
        assert_eq!(resolved.url, expected);
    }
}

#[test]
fn absolute_redirects_inherit_playback_fragments() {
    let initial = reqwest::Url::parse("https://cdn.test/start#file=Episode%201.mkv").unwrap();
    let target = resolve_redirect_url(&initial, "https://other.test/video").unwrap();
    assert_eq!(
        target.as_str(),
        "https://other.test/video#file=Episode%201.mkv"
    );
}

#[test]
fn explicit_redirect_fragments_replace_playback_fragments() {
    let initial = reqwest::Url::parse("https://cdn.test/start#filename.mkv").unwrap();
    for location in [
        "/video#replacement.mkv",
        "https://cdn.test/video#replacement.mkv",
    ] {
        let target = resolve_redirect_url(&initial, location).unwrap();
        assert_eq!(target.as_str(), "https://cdn.test/video#replacement.mkv");
    }
}

#[test]
fn explicit_empty_redirect_fragments_clear_playback_fragments() {
    let initial = reqwest::Url::parse("https://cdn.test/start#filename.mkv").unwrap();
    for location in ["/video#", "https://cdn.test/video#"] {
        let target = resolve_redirect_url(&initial, location).unwrap();
        assert_eq!(target.fragment(), Some(""));
        assert_eq!(target.as_str(), "https://cdn.test/video#");
    }
}

#[test]
fn redirect_chains_inherit_the_previous_hops_fragment() {
    let initial = reqwest::Url::parse("https://cdn.test/start#filename.mkv").unwrap();
    let mut target = initial.clone();
    for (location, expected_fragment) in [
        ("/hop", "filename.mkv"),
        ("https://other.test/video", "filename.mkv"),
        ("/replacement#other.mkv", "other.mkv"),
        ("/next", "other.mkv"),
        ("/empty#", ""),
        ("/final", ""),
    ] {
        target = resolve_redirect_url(&target, location).unwrap();
        assert_eq!(target.fragment(), Some(expected_fragment));
    }
    let resolved = build_resolved_direct_stream(&initial, target.to_string(), &[]).unwrap();
    assert_eq!(resolved.url, "https://other.test/final#");
}

#[test]
fn probe_content_types_allow_media() {
    for (label, content_type, allowed) in [
        ("missing", None, true),
        ("hls", Some("application/vnd.apple.mpegurl"), true),
        (
            "hls case",
            Some("Application/X-MpegURL; charset=utf-8"),
            true,
        ),
        ("dash", Some("application/dash+xml"), true),
        ("binary", Some("application/octet-stream"), true),
        ("mp4", Some("video/mp4"), true),
    ] {
        let mut headers = reqwest::header::HeaderMap::new();
        if let Some(content_type) = content_type {
            headers.insert(
                reqwest::header::CONTENT_TYPE,
                reqwest::header::HeaderValue::from_str(content_type).unwrap(),
            );
        }
        let result = validate_probe_content_type(&headers);
        assert_eq!(result.is_ok(), allowed, "{label}");
    }
}

#[test]
fn resolved_headers_stay_on_first_hop_origin() {
    let initial = reqwest::Url::parse("https://cdn.test/start").unwrap();
    let headers = || vec![("Authorization".to_string(), "Bearer fixture".to_string())];
    for (final_url, keep_headers) in [
        ("https://cdn.test/next.mkv", true),
        ("https://other.test/next.mkv", false),
        ("http://cdn.test/next.mkv", false),
        ("https://cdn.test:444/next.mkv", false),
    ] {
        let resolved = build_resolved_direct_stream(&initial, final_url.to_string(), &headers())
            .expect("valid urls resolve");
        assert_eq!(resolved.url, final_url);
        if keep_headers {
            assert_eq!(
                resolved.mpv_http_header_fields,
                "Authorization: Bearer fixture"
            );
        } else {
            assert!(
                resolved.mpv_http_header_fields.is_empty(),
                "{final_url} must drop cross-origin headers"
            );
        }
    }
}

#[test]
fn resolved_playback_urls_preserve_unicode_encoding_and_opaque_fragments() {
    let prefix = "https://cdn.test/";
    let initial = reqwest::Url::parse(prefix).unwrap();
    let fragment = "#file=Episode%201.mkv&hint=%2f%2F+opaque";
    for character in ["漢", "\u{10000}"] {
        let raw = format!(
            "{prefix}{}{fragment}",
            character.repeat(2_048 - prefix.len() - fragment.len())
        );
        assert_eq!(raw.chars().count(), 2_048);
        let canonical = reqwest::Url::parse(&raw).unwrap().to_string();
        assert!(canonical.len() > 4_096);
        assert!(canonical.len() <= PLAYBACK_URL_MAX_BYTES);
        for final_url in [raw, canonical] {
            let resolved = build_resolved_direct_stream(&initial, final_url.clone(), &[]).unwrap();
            assert_eq!(resolved.url, final_url);
            assert!(resolved.url.ends_with(fragment));
        }
    }
}

#[test]
fn resolved_playback_urls_enforce_native_bounds_and_schemes() {
    let prefix = "https://cdn.test/";
    let initial = reqwest::Url::parse(prefix).unwrap();
    let at_limit = format!(
        "{prefix}{}",
        "x".repeat(PLAYBACK_URL_MAX_BYTES - prefix.len())
    );
    let resolved = build_resolved_direct_stream(&initial, at_limit.clone(), &[]).unwrap();
    assert_eq!(resolved.url, at_limit);
    assert!(build_resolved_direct_stream(&initial, format!("{at_limit}x"), &[]).is_err());

    let raw = format!(
        "{prefix}{}",
        "\u{10000}".repeat(PLAYBACK_URL_MAX_BYTES / 12 + 1)
    );
    assert!(raw.len() <= PLAYBACK_URL_MAX_BYTES);
    let canonical = reqwest::Url::parse(&raw).unwrap().to_string();
    assert!(canonical.len() > PLAYBACK_URL_MAX_BYTES);
    for final_url in [raw, canonical] {
        assert!(build_resolved_direct_stream(&initial, final_url, &[]).is_err());
    }

    for final_url in [
        "file:///C:/video.mkv",
        "ftp://cdn.test/video.mkv",
        "magnet:?xt=urn:btih:x",
        "https://",
        "http://?video",
    ] {
        assert!(build_resolved_direct_stream(&initial, final_url.to_string(), &[]).is_err());
    }
    for final_url in [
        "http://127.0.0.1:11470/video",
        "http://localhost:11470/video",
        "http://[::1]:11470/video",
    ] {
        let resolved = build_resolved_direct_stream(&initial, final_url.to_string(), &[]).unwrap();
        assert_eq!(resolved.url, final_url);
    }
}

#[test]
fn mpv_http_header_fields_escape_commas_and_backslashes() {
    assert_eq!(format_mpv_http_header_fields(&[]), "");
    let resolved = build_resolved_direct_stream(
        &reqwest::Url::parse("https://cdn.test/start").unwrap(),
        "https://cdn.test/video.mkv".to_string(),
        &[
            ("X-Custom".to_string(), r"one,two\three\,four".to_string()),
            ("Authorization".to_string(), "Bearer fixture".to_string()),
        ],
    )
    .unwrap();
    assert_eq!(
        resolved.mpv_http_header_fields,
        r"X-Custom: one\,two\\three\\\,four,Authorization: Bearer fixture"
    );
    let payload = serde_json::to_value(resolved).unwrap();
    assert!(payload.get("format").is_none());
    assert!(payload.get("mpvHttpHeaderFields").is_some());
    assert!(payload.get("requestHeaders").is_none());
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
