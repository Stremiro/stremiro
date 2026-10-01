use super::{compare_continue_watching, sanitize_watch_progress};
use crate::commands::now_unix_millis;
use crate::commands::WatchProgress;
use crate::test_helpers::test_progress;

fn progress_with_url(url: &str) -> WatchProgress {
    WatchProgress {
        position: 60.0,
        duration: 600.0,
        last_watched: 1,
        title: "Title".to_string(),
        last_stream_url: Some(url.to_string()),
        last_stream_lookup_id: Some("tt123".to_string()),
        ..test_progress()
    }
}

#[test]
fn stream_urls_never_persist_but_lookup_identity_survives() {
    for url in [
        "https://cdn.example/video.mp4?expires=123&sig=abc",
        "https://cdn.example/video.mp4",
        "https://cdn.example/v.mp4#notes?token=abc",
    ] {
        let sanitized = sanitize_watch_progress(progress_with_url(url)).expect("valid progress");
        assert_eq!(sanitized.last_stream_url, None);
        assert_eq!(sanitized.last_stream_lookup_id.as_deref(), Some("tt123"));
    }
}

#[test]
fn sanitize_drops_empty_media_id_and_defaults_empty_title() {
    let mut progress = progress_with_url("https://cdn.example/v.mp4");
    progress.id = "   ".to_string();
    assert!(sanitize_watch_progress(progress).is_none());

    let mut progress = progress_with_url("https://cdn.example/v.mp4");
    progress.title = "  ".to_string();
    let sanitized = sanitize_watch_progress(progress).expect("valid progress");
    assert_eq!(sanitized.title, "Untitled");
}

#[test]
fn sanitize_drops_out_of_range_episode_coordinates() {
    let mut progress = progress_with_url("https://cdn.example/v.mp4");
    progress.type_ = "series".to_string();
    progress.season = Some(2);
    progress.episode = Some(u32::MAX);
    progress.absolute_episode = Some(u32::MAX);
    progress.stream_episode = Some(12);

    let sanitized = sanitize_watch_progress(progress).expect("valid progress");
    assert_eq!(sanitized.season, Some(2));
    assert_eq!(sanitized.episode, None);
    assert_eq!(sanitized.absolute_episode, None);
    assert_eq!(sanitized.stream_episode, Some(12));
}

#[test]
fn sanitize_clamps_far_future_timestamps_but_keeps_small_skew() {
    let before = now_unix_millis();
    let mut progress = progress_with_url("https://cdn.example/v.mp4");
    progress.last_watched = before.saturating_add(365 * 24 * 60 * 60 * 1000);
    let sanitized = sanitize_watch_progress(progress).expect("valid progress");
    assert!(sanitized.last_watched >= before);
    assert!(sanitized.last_watched <= now_unix_millis());

    let mut progress = progress_with_url("https://cdn.example/v.mp4");
    let near_future = now_unix_millis().saturating_add(60_000);
    progress.last_watched = near_future;
    let sanitized = sanitize_watch_progress(progress).expect("valid progress");
    assert_eq!(sanitized.last_watched, near_future);
}

#[test]
fn compare_continue_watching_sorts_recent_meaningful_before_older_deeper() {
    let mut recent = test_progress();
    recent.position = 600.0;
    recent.duration = 2_400.0;
    recent.last_watched = 500;

    let mut older_deeper = test_progress();
    older_deeper.position = 2_000.0;
    older_deeper.duration = 2_400.0;
    older_deeper.last_watched = 100;

    assert_eq!(
        compare_continue_watching(&recent, &older_deeper),
        std::cmp::Ordering::Less
    );
}

#[test]
fn compare_continue_watching_demotes_low_confidence_resume_positions() {
    let mut low_confidence = test_progress();
    low_confidence.position = 30.0;
    low_confidence.duration = 600.0;
    low_confidence.last_watched = 500;

    let mut meaningful = test_progress();
    meaningful.position = 300.0;
    meaningful.duration = 600.0;
    meaningful.last_watched = 100;

    assert_eq!(
        compare_continue_watching(&low_confidence, &meaningful),
        std::cmp::Ordering::Greater
    );
}
