use super::{
    build_mpv_language_selection_options, classify_language_token, infer_track_preferred_language,
    normalize_language_token, resolve_preferred_track_selection, LanguageMatchConfidence,
    TrackLanguageCandidate,
};

#[test]
fn classify_language_token_marks_exact_vs_inferred() {
    let exact = classify_language_token(Some("eng"), false);
    assert_eq!(exact.normalized.as_deref(), Some("en"));
    assert_eq!(exact.confidence, Some(LanguageMatchConfidence::Exact));

    let inferred = classify_language_token(Some("English Commentary"), false);
    assert_eq!(inferred.normalized.as_deref(), Some("en"));
    assert_eq!(inferred.confidence, Some(LanguageMatchConfidence::Inferred));

    let off = classify_language_token(Some("off"), true);
    assert_eq!(off.confidence, Some(LanguageMatchConfidence::Exact));

    let unknown = classify_language_token(Some("commentary"), true);
    assert_eq!(unknown.normalized, None);
    assert_eq!(unknown.confidence, None);
}

#[test]
fn mpv_language_selection_options_expand_aliases_and_handle_off() {
    let options = build_mpv_language_selection_options(Some("eng"), Some("off"));
    assert_eq!(
        options.get("alang").map(String::as_str),
        Some("en,eng,english")
    );
    assert_eq!(options.get("sid").map(String::as_str), Some("no"));
    assert!(!options.contains_key("slang"));

    let options = build_mpv_language_selection_options(None, Some("pt-BR"));
    assert_eq!(
        options.get("slang").map(String::as_str),
        Some("pt,por,portuguese")
    );
    assert_eq!(options.get("subs-fallback").map(String::as_str), Some("no"));

    assert!(build_mpv_language_selection_options(None, None).is_empty());
    assert!(build_mpv_language_selection_options(Some("commentary"), Some("x")).is_empty());
}

#[test]
fn normalize_language_token_canonicalizes_aliases() {
    assert_eq!(
        normalize_language_token(Some("English"), false).as_deref(),
        Some("en")
    );
    assert_eq!(
        normalize_language_token(Some("pt-BR"), false).as_deref(),
        Some("pt")
    );
    assert_eq!(normalize_language_token(Some("commentary"), false), None);
}

#[test]
fn infer_track_preferred_language_checks_lang_then_title() {
    assert_eq!(
        infer_track_preferred_language(Some("English Commentary"), None).as_deref(),
        Some("en")
    );
    assert_eq!(
        infer_track_preferred_language(None, Some("[JPN] Main Subtitle")).as_deref(),
        Some("ja")
    );
}

#[test]
fn resolve_preferred_track_selection_returns_match_state_and_best_track() {
    let tracks = vec![
        TrackLanguageCandidate {
            id: 1,
            lang: Some("eng".to_string()),
            title: Some("English".to_string()),
            default_track: false,
            forced: false,
            hearing_impaired: false,
        },
        TrackLanguageCandidate {
            id: 2,
            lang: Some("jpn".to_string()),
            title: Some("Japanese".to_string()),
            default_track: false,
            forced: false,
            hearing_impaired: false,
        },
    ];

    let resolution = resolve_preferred_track_selection(&tracks, Some("Japanese"), Some(1));
    assert!(!resolution.selected_matches);
    assert_eq!(resolution.matched_track_id, Some(2));

    let already_matching = resolve_preferred_track_selection(&tracks, Some("eng"), Some(1));
    assert!(already_matching.selected_matches);
    assert_eq!(already_matching.matched_track_id, None);
}

#[test]
fn resolve_preferred_track_selection_prefers_full_subtitles_over_signs_track() {
    let tracks = vec![
        TrackLanguageCandidate {
            id: 1,
            lang: Some("eng".to_string()),
            title: Some("English Signs & Songs".to_string()),
            default_track: true,
            forced: false,
            hearing_impaired: false,
        },
        TrackLanguageCandidate {
            id: 2,
            lang: Some("eng".to_string()),
            title: Some("English Full".to_string()),
            default_track: false,
            forced: false,
            hearing_impaired: false,
        },
    ];

    let resolution = resolve_preferred_track_selection(&tracks, Some("English"), Some(1));
    assert!(!resolution.selected_matches);
    assert_eq!(resolution.matched_track_id, Some(2));
}

#[test]
fn resolve_preferred_track_selection_prefers_main_audio_over_commentary() {
    let tracks = vec![
        TrackLanguageCandidate {
            id: 1,
            lang: Some("eng".to_string()),
            title: Some("English Commentary".to_string()),
            default_track: true,
            forced: false,
            hearing_impaired: false,
        },
        TrackLanguageCandidate {
            id: 2,
            lang: Some("eng".to_string()),
            title: Some("English".to_string()),
            default_track: false,
            forced: false,
            hearing_impaired: false,
        },
    ];

    let resolution = resolve_preferred_track_selection(&tracks, Some("English"), Some(1));
    assert!(!resolution.selected_matches);
    assert_eq!(resolution.matched_track_id, Some(2));
}

#[test]
fn resolve_preferred_track_selection_skips_conflicting_lang_tag_despite_title() {
    let tracks = vec![
        TrackLanguageCandidate {
            id: 1,
            lang: Some("jpn".to_string()),
            title: Some("English Main".to_string()),
            default_track: true,
            forced: false,
            hearing_impaired: false,
        },
        TrackLanguageCandidate {
            id: 2,
            lang: Some("eng".to_string()),
            title: Some("English".to_string()),
            default_track: false,
            forced: false,
            hearing_impaired: false,
        },
    ];

    let resolution = resolve_preferred_track_selection(&tracks, Some("en"), Some(1));
    assert!(!resolution.selected_matches);
    assert_eq!(resolution.matched_track_id, Some(2));
}

#[test]
fn resolve_preferred_track_selection_conflicting_tag_alone_yields_no_match() {
    let tracks = vec![TrackLanguageCandidate {
        id: 1,
        lang: Some("jpn".to_string()),
        title: Some("English Main".to_string()),
        default_track: true,
        forced: false,
        hearing_impaired: false,
    }];

    let resolution = resolve_preferred_track_selection(&tracks, Some("en"), Some(1));
    assert!(!resolution.selected_matches);
    assert_eq!(resolution.matched_track_id, None);
}

#[test]
fn resolve_preferred_track_selection_keeps_regional_lang_tag() {
    let tracks = vec![TrackLanguageCandidate {
        id: 1,
        lang: Some("en-US".to_string()),
        title: None,
        default_track: false,
        forced: false,
        hearing_impaired: false,
    }];

    let resolution = resolve_preferred_track_selection(&tracks, Some("en"), Some(1));
    assert!(resolution.selected_matches);
    assert_eq!(resolution.matched_track_id, None);
}

#[test]
fn resolve_preferred_track_selection_und_tag_falls_back_to_title() {
    let tracks = vec![TrackLanguageCandidate {
        id: 1,
        lang: Some("und".to_string()),
        title: Some("English".to_string()),
        default_track: false,
        forced: false,
        hearing_impaired: false,
    }];

    let resolution = resolve_preferred_track_selection(&tracks, Some("en"), Some(1));
    assert!(resolution.selected_matches);
    assert_eq!(resolution.matched_track_id, None);
}
