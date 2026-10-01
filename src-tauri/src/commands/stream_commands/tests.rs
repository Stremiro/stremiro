use super::normalize_recovery_url;

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
