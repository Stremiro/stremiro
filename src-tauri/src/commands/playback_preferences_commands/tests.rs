use super::{
    infer_selected_playback_language_preference, sanitize_language_pref,
    PlaybackLanguagePreferenceKind,
};
use crate::commands::language::TrackLanguageCandidate;

#[test]
fn sanitize_language_pref_canonicalizes_known_aliases() {
    assert_eq!(
        sanitize_language_pref(Some("English".to_string()), false).as_deref(),
        Some("en")
    );
    assert_eq!(
        sanitize_language_pref(Some("jpn".to_string()), true).as_deref(),
        Some("ja")
    );
    assert_eq!(
        sanitize_language_pref(Some("pt-BR".to_string()), false).as_deref(),
        Some("pt")
    );
}

#[test]
fn sanitize_language_pref_preserves_subtitle_off() {
    assert_eq!(
        sanitize_language_pref(Some("off".to_string()), true).as_deref(),
        Some("off")
    );
    assert_eq!(sanitize_language_pref(Some("off".to_string()), false), None);
}

#[test]
fn sanitize_language_pref_drops_empty_or_unknown_values() {
    assert_eq!(sanitize_language_pref(Some("   ".to_string()), false), None);
    assert_eq!(
        sanitize_language_pref(Some("commentary".to_string()), true),
        None
    );
}

#[test]
fn infer_selected_playback_language_preference_keeps_subtitles_off() {
    assert_eq!(
        infer_selected_playback_language_preference(
            PlaybackLanguagePreferenceKind::Sub,
            None,
            true,
        )
        .as_deref(),
        Some("off")
    );
}

#[test]
fn infer_selected_playback_language_preference_reads_track_metadata() {
    let track = TrackLanguageCandidate {
        id: 1,
        lang: Some("eng".to_string()),
        title: Some("English Commentary".to_string()),
        default_track: false,
        forced: false,
        hearing_impaired: false,
    };

    assert_eq!(
        infer_selected_playback_language_preference(
            PlaybackLanguagePreferenceKind::Audio,
            Some(&track),
            false,
        )
        .as_deref(),
        Some("en")
    );
}
