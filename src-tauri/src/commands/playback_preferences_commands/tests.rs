use super::{
    infer_selected_playback_language_preference, sanitize_language_pref,
    PlaybackLanguagePreferenceKind, SavedPlaybackLanguagePreference,
};
use crate::commands::language::TrackLanguageCandidate;
use crate::commands::PlaybackLanguagePreferences;

#[test]
fn saved_playback_language_preference_omits_scopeless_effective() {
    let value = serde_json::to_value(&SavedPlaybackLanguagePreference {
        preferences: PlaybackLanguagePreferences {
            preferred_audio_language: Some("en".to_string()),
            preferred_subtitle_language: Some("off".to_string()),
        },
        effective: None,
    })
    .unwrap();

    // The scopeless save must not emit an `effective` key — the frontend
    // only writes the effective cache when the field is present.
    assert_eq!(value["preferences"]["preferredAudioLanguage"], "en");
    assert_eq!(value["preferences"]["preferredSubtitleLanguage"], "off");
    assert!(value.get("effective").is_none());
}

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
