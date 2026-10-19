use super::{
    build_mpv_language_selection_options, canonicalize_language_token, canonicalize_language_value,
    infer_track_preferred_language, normalize_language_token, resolve_preferred_track_selection,
    supported_language_options, track_matches_preferred_language, TrackLanguageCandidate,
    SUPPORTED_LANGUAGES,
};

#[test]
fn preferred_language_inputs_are_bounded_before_normalization() {
    let at_limit = format!("{}en", " ".repeat(super::TRACK_LANG_MAX_CHARS - 2));
    assert_eq!(
        normalize_language_token(Some(&at_limit), false).as_deref(),
        Some("en")
    );
    let oversized = format!(" {at_limit}");
    assert_eq!(normalize_language_token(Some(&oversized), false), None);
    assert!(super::language_candidates(&oversized).is_empty());
    assert_eq!(
        normalize_language_token(Some(&"界".repeat(65)), false),
        None
    );
}

#[test]
fn normalize_language_token_handles_whole_values_fallback_and_off() {
    for (value, allow_off, expected) in [
        (Some("eng"), false, Some("en")),
        (Some("pt-BR"), false, Some("pt")),
        (Some("English Commentary"), false, Some("en")),
        (Some("Japanese English"), false, Some("ja")),
        (Some(" OFF "), true, Some("off")),
        (Some("off"), false, None),
        (Some("commentary"), true, None),
        (Some(" "), false, None),
        (None, false, None),
    ] {
        assert_eq!(
            normalize_language_token(value, allow_off).as_deref(),
            expected
        );
    }
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
        Some("pt,por,portuguese,pob,pt-br")
    );
    assert_eq!(options.get("subs-fallback").map(String::as_str), Some("no"));

    assert!(build_mpv_language_selection_options(None, None).is_empty());
    assert!(build_mpv_language_selection_options(Some("commentary"), Some("x")).is_empty());
}

#[test]
fn common_languages_accept_exact_tags_and_safe_aliases_without_title_collisions() {
    let options = supported_language_options();
    assert_eq!(options.len(), 28);
    for language in &SUPPORTED_LANGUAGES[9..] {
        assert!(options
            .iter()
            .any(|option| option.code == language.code && option.label == language.label));
        for alias in language.exact_aliases {
            assert_eq!(canonicalize_language_value(alias), Some(language.code));
            assert_eq!(canonicalize_language_token(alias), None);
            assert_eq!(
                normalize_language_token(Some(&format!("{alias} dialogue")), false),
                None
            );
            assert_eq!(infer_track_preferred_language(None, Some(alias)), None);
            assert!(!track_matches_preferred_language(
                None,
                Some(&format!("{alias} dialogue")),
                language.code
            ));
            let track = TrackLanguageCandidate {
                id: 1,
                lang: Some(alias.to_string()),
                title: None,
                default_track: false,
                forced: false,
                hearing_impaired: false,
            };
            let resolution = resolve_preferred_track_selection(&[track], Some(language.code), None);
            assert_eq!(resolution.matched_track_id, Some(1));
            let title_only = TrackLanguageCandidate {
                id: 2,
                lang: None,
                title: Some(format!("{alias} dialogue")),
                default_track: false,
                forced: false,
                hearing_impaired: false,
            };
            assert_eq!(
                resolve_preferred_track_selection(&[title_only], Some(language.code), None)
                    .matched_track_id,
                None
            );
        }
        for alias in language.aliases {
            assert_eq!(canonicalize_language_token(alias), Some(language.code));
            assert!(track_matches_preferred_language(
                None,
                Some(&format!("{alias} dialogue")),
                language.code
            ));
        }
    }
}

#[test]
fn expanded_mpv_languages_include_container_tags_and_brazilian_portuguese() {
    for (preference, expected) in [
        ("ru", "ru,rus,russian"),
        ("nb-NO", "no,nor,nob,norwegian,nb"),
        ("nl", "nl,dut,nld,dutch"),
        ("cs", "cs,cze,ces,czech"),
        ("pob", "pt,por,portuguese,pob,pt-br"),
    ] {
        let options = build_mpv_language_selection_options(Some(preference), Some(preference));
        assert_eq!(options.get("alang").map(String::as_str), Some(expected));
        assert_eq!(options.get("slang").map(String::as_str), Some(expected));
    }
    for token in ["pob", "pt-BR", "POR"] {
        assert_eq!(canonicalize_language_value(token), Some("pt"));
    }
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
