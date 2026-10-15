use super::{normalize_recovery_url, stream_link, validated_info_hash, StreamLinkKind};
use crate::providers::addons::BehaviorHints;
use crate::test_helpers::test_stream;

#[test]
fn stream_link_validates_hash_formats() {
    let hex = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
    assert_eq!(validated_info_hash(hex), Some(hex.to_ascii_lowercase()));
    let base32 = "abcdefghijklmnopqrstuvwxyz234567";
    assert_eq!(
        validated_info_hash(base32),
        Some(base32.to_ascii_uppercase())
    );
    for invalid in [
        "",
        "abc123",
        "ABCDEF0123456789ABCDEF0123456789ABCDEF0Z",
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ234568",
        " ABCDEF0123456789ABCDEF0123456789ABCDEF01",
    ] {
        assert!(validated_info_hash(invalid).is_none());
    }
}

#[test]
fn stream_link_builds_encoded_magnet_with_filename_and_trackers() {
    let mut stream = test_stream();
    stream.info_hash = Some("ABCDEF0123456789ABCDEF0123456789ABCDEF01".to_string());
    stream.title = Some("Release & name\n1080p".to_string());
    stream.sources = vec![
        "tracker:udp://tracker.example:80/announce".to_string(),
        "tracker:https://tracker.example/announce?x=1&y=2".to_string(),
    ];
    let link = stream_link(&stream).expect("magnet");
    assert!(matches!(link.kind, StreamLinkKind::Magnet));
    assert_eq!(
        link.url,
        "magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01&dn=Release%20%26%20name&tr=udp%3A%2F%2Ftracker.example%3A80%2Fannounce&tr=https%3A%2F%2Ftracker.example%2Fannounce%3Fx%3D1%26y%3D2"
    );
    stream.behavior_hints = Some(BehaviorHints {
        filename: Some("chosen file.mkv".to_string()),
        ..BehaviorHints::default()
    });
    assert!(stream_link(&stream)
        .expect("filename")
        .url
        .contains("&dn=chosen%20file.mkv&tr="));
    stream.info_hash = Some("bad-hash".to_string());
    assert!(stream_link(&stream).is_err());
}

#[test]
fn stream_link_preserves_admitted_urls_without_resolution() {
    let mut stream = test_stream();
    for url in [
        "https://cdn.example/video.mkv?sig=a%2FB&token=x",
        "magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01&dn=Raw%20Name",
    ] {
        stream.url = Some(url.to_string());
        assert_eq!(stream_link(&stream).expect("original link").url, url);
    }
    stream.url = Some("file:///private".to_string());
    assert!(stream_link(&stream).is_err());
}

#[test]
fn recovery_url_uses_the_shared_fetchable_gate() {
    assert!(normalize_recovery_url(Some("https://cdn.example/video.m3u8".to_string())).is_some());
    // Non-HTTP schemes, embedded credentials, and non-routable targets
    // (dotted or numeric) never reach the player, matching the probe gate.
    for blocked in [
        "file:///etc/passwd",
        "https://user:pass@cdn.example/video.m3u8",
        "http://127.0.0.1:11470/video.mp4",
        "http://169.254.169.254/latest/meta-data",
        "http://2130706433/video.mp4",
        "http://0x7f.0.0.1/video.mp4",
    ] {
        assert!(
            normalize_recovery_url(Some(blocked.to_string())).is_none(),
            "{blocked} must be rejected"
        );
    }
}
