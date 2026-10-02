use super::{compare_continue_watching, sanitize_watch_progress, with_progress_annotations};
use crate::commands::now_unix_millis;
use crate::commands::WatchProgress;
use crate::test_helpers::test_progress;

fn sample_progress() -> WatchProgress {
    WatchProgress {
        position: 60.0,
        duration: 600.0,
        last_watched: 1,
        title: "Title".to_string(),
        last_stream_lookup_id: Some("tt123".to_string()),
        ..test_progress()
    }
}

#[test]
fn sanitize_drops_empty_media_id_and_defaults_empty_title() {
    let mut progress = sample_progress();
    progress.id = "   ".to_string();
    assert!(sanitize_watch_progress(progress).is_none());

    let mut progress = sample_progress();
    progress.title = "  ".to_string();
    let sanitized = sanitize_watch_progress(progress).expect("valid progress");
    assert_eq!(sanitized.title, "Untitled");
}

#[test]
fn sanitize_drops_out_of_range_episode_coordinates() {
    let mut progress = sample_progress();
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
    let mut progress = sample_progress();
    progress.last_watched = before.saturating_add(365 * 24 * 60 * 60 * 1000);
    let sanitized = sanitize_watch_progress(progress).expect("valid progress");
    assert!(sanitized.last_watched >= before);
    assert!(sanitized.last_watched <= now_unix_millis());

    let mut progress = sample_progress();
    let near_future = now_unix_millis().saturating_add(60_000);
    progress.last_watched = near_future;
    let sanitized = sanitize_watch_progress(progress).expect("valid progress");
    assert_eq!(sanitized.last_watched, near_future);
}

#[test]
fn progress_annotations_share_the_backend_thresholds_and_never_persist() {
    let annotate = |position: f64, duration: f64| {
        with_progress_annotations(WatchProgress {
            position,
            duration,
            ..sample_progress()
        })
    };

    let fresh = annotate(20.0, 600.0);
    assert!(!fresh.has_started_watching && !fresh.is_watched);
    assert_eq!(fresh.resume_start_time, Some(20.0));

    let started = annotate(60.0, 600.0);
    assert!(started.has_started_watching && !started.is_watched);

    let watched = annotate(570.0, 600.0);
    assert!(watched.has_started_watching && watched.is_watched);
    assert_eq!(watched.resume_start_time, None);

    let unknown_runtime = annotate(60.0, 0.0);
    assert!(!unknown_runtime.has_started_watching && !unknown_runtime.is_watched);

    let sanitized = sanitize_watch_progress(watched).expect("valid progress");
    assert!(!sanitized.is_watched && !sanitized.has_started_watching);
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
