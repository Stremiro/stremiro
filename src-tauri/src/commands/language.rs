use crate::providers::{bound_optional, push_unique};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrackLanguageCandidate {
    pub id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default)]
    pub default_track: bool,
    #[serde(default)]
    pub forced: bool,
    #[serde(default)]
    pub hearing_impaired: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrackLanguageSelectionResolution {
    pub selected_matches: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matched_track_id: Option<i64>,
}

/// The closed language set is a single table: `code` is canonical, `label`
/// feeds the settings UI, and `aliases` (code first) drives canonicalization
/// and mpv `alang`/`slang` expansion. Every consumer reads this table so a
/// new language lands in one place.
struct SupportedLanguage {
    code: &'static str,
    label: &'static str,
    aliases: &'static [&'static str],
}

const SUPPORTED_LANGUAGES: &[SupportedLanguage] = &[
    SupportedLanguage {
        code: "en",
        label: "English",
        aliases: &["en", "eng", "english"],
    },
    SupportedLanguage {
        code: "ja",
        label: "Japanese",
        aliases: &["ja", "jpn", "japanese"],
    },
    SupportedLanguage {
        code: "es",
        label: "Spanish",
        aliases: &["es", "spa", "spanish"],
    },
    SupportedLanguage {
        code: "fr",
        label: "French",
        aliases: &["fr", "fra", "fre", "french"],
    },
    SupportedLanguage {
        code: "de",
        label: "German",
        aliases: &["de", "deu", "ger", "german"],
    },
    SupportedLanguage {
        code: "it",
        label: "Italian",
        aliases: &["it", "ita", "italian"],
    },
    SupportedLanguage {
        code: "pt",
        label: "Portuguese",
        aliases: &["pt", "por", "portuguese"],
    },
    SupportedLanguage {
        code: "ko",
        label: "Korean",
        aliases: &["ko", "kor", "korean"],
    },
    SupportedLanguage {
        code: "zh",
        label: "Chinese",
        aliases: &["zh", "zho", "chi", "chinese"],
    },
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportedLanguageOption {
    pub code: &'static str,
    pub label: &'static str,
}

pub(crate) fn supported_language_options() -> Vec<SupportedLanguageOption> {
    SUPPORTED_LANGUAGES
        .iter()
        .map(|language| SupportedLanguageOption {
            code: language.code,
            label: language.label,
        })
        .collect()
}

pub(crate) fn canonicalize_language_token(value: &str) -> Option<&'static str> {
    // Skip the lowercase copy when the token is already lowered — the
    // coordinator's per-stream path feeds it normalized match text.
    let trimmed = value.trim();
    let owned;
    let normalized = if trimmed.bytes().any(|byte| byte.is_ascii_uppercase()) {
        owned = trimmed.to_ascii_lowercase();
        owned.as_str()
    } else {
        trimmed
    };
    SUPPORTED_LANGUAGES
        .iter()
        .find(|language| language.aliases.contains(&normalized))
        .map(|language| language.code)
}

fn language_aliases(canonical: &str) -> &'static [&'static str] {
    SUPPORTED_LANGUAGES
        .iter()
        .find(|language| language.code == canonical)
        .map(|language| language.aliases)
        .unwrap_or(&[])
}

fn normalize_lower(value: Option<&str>) -> Option<String> {
    let normalized = value?.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

pub(crate) fn tokenize_language_meta(value: &str) -> Vec<String> {
    let normalized: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect();

    normalized.split_whitespace().map(str::to_string).collect()
}

/// How a token reached a canonical code: `Exact` means the whole value
/// canonicalized directly (including the subtitle `off` sentinel);
/// `Inferred` means a per-token scan of a longer string produced the match —
/// advisory for consumers that persist or auto-apply on the result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LanguageMatchConfidence {
    Exact,
    Inferred,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageTokenNormalization {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub normalized: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<LanguageMatchConfidence>,
}

pub(crate) fn classify_language_token(
    value: Option<&str>,
    allow_off: bool,
) -> LanguageTokenNormalization {
    let Some(normalized) = normalize_lower(value) else {
        return LanguageTokenNormalization {
            normalized: None,
            confidence: None,
        };
    };

    if allow_off && normalized == "off" {
        return LanguageTokenNormalization {
            normalized: Some(normalized),
            confidence: Some(LanguageMatchConfidence::Exact),
        };
    }

    if let Some(canonical) = canonicalize_language_token(&normalized) {
        return LanguageTokenNormalization {
            normalized: Some(canonical.to_string()),
            confidence: Some(LanguageMatchConfidence::Exact),
        };
    }

    let inferred = tokenize_language_meta(&normalized)
        .into_iter()
        .find_map(|token| canonicalize_language_token(&token).map(str::to_string));
    let confidence = inferred
        .is_some()
        .then_some(LanguageMatchConfidence::Inferred);

    LanguageTokenNormalization {
        normalized: inferred,
        confidence,
    }
}

pub(crate) fn normalize_language_token(value: Option<&str>, allow_off: bool) -> Option<String> {
    classify_language_token(value, allow_off).normalized
}

/// Track metadata is untrusted IPC input feeding a per-char tokenizer: bound
/// the strings so a hostile payload can't burn CPU or dominate the match.
const TRACK_LANG_MAX_CHARS: usize = 64;
const TRACK_TITLE_MAX_CHARS: usize = 256;

pub(crate) fn normalize_track_language_candidate(
    mut track: TrackLanguageCandidate,
) -> TrackLanguageCandidate {
    track.lang = bound_optional(track.lang, TRACK_LANG_MAX_CHARS);
    track.title = bound_optional(track.title, TRACK_TITLE_MAX_CHARS);
    track
}

/// mpv matches `alang`/`slang` against container tags (often 639-2/B like
/// `ger`/`fre`/`chi`), so a preference expands to every alias of the
/// canonical code, not just the stored token.
fn mpv_language_priority_list(preferred: Option<&str>) -> Option<String> {
    let normalized = normalize_language_token(preferred, false)?;
    // `normalized` is always a canonical table code, and every table entry
    // carries its own code first — the alias list is never empty here.
    Some(language_aliases(&normalized).join(","))
}

/// Track auto-selection options for mpv init, built from the same canonical
/// table the preference store sanitizes against — one language source of
/// truth. `off` is a subtitle-only signal and maps to `sid=no`.
pub(crate) fn build_mpv_language_selection_options(
    preferred_audio_language: Option<&str>,
    preferred_subtitle_language: Option<&str>,
) -> HashMap<String, String> {
    let mut options = HashMap::new();

    if let Some(list) = mpv_language_priority_list(preferred_audio_language) {
        options.insert("track-auto-selection".to_string(), "yes".to_string());
        options.insert("aid".to_string(), "auto".to_string());
        options.insert("alang".to_string(), list);
    }

    if normalize_language_token(preferred_subtitle_language, true).as_deref() == Some("off") {
        options.insert("track-auto-selection".to_string(), "yes".to_string());
        options.insert("sid".to_string(), "no".to_string());
    } else if let Some(list) = mpv_language_priority_list(preferred_subtitle_language) {
        options.insert("track-auto-selection".to_string(), "yes".to_string());
        options.insert("sid".to_string(), "auto".to_string());
        options.insert("slang".to_string(), list);
        options.insert("subs-fallback".to_string(), "no".to_string());
    }

    options
}

pub(crate) fn language_candidates(preferred: &str) -> Vec<String> {
    let normalized = preferred.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return Vec::new();
    }

    let canonical =
        normalize_language_token(Some(&normalized), false).unwrap_or_else(|| normalized.clone());
    let mut candidates = Vec::new();

    push_unique(&mut candidates, &canonical);
    push_unique(&mut candidates, &normalized);

    for alias in language_aliases(&canonical) {
        push_unique(&mut candidates, alias);
    }

    for token in tokenize_language_meta(&normalized) {
        if let Some(token_canonical) = canonicalize_language_token(&token) {
            push_unique(&mut candidates, token_canonical);

            for alias in language_aliases(token_canonical) {
                push_unique(&mut candidates, alias);
            }
        }
    }

    candidates
}

fn contains_token(tokens: &[String], needle: &str) -> bool {
    tokens.iter().any(|token| token == needle)
}

fn contains_any_token(tokens: &[String], needles: &[&str]) -> bool {
    needles.iter().any(|needle| contains_token(tokens, needle))
}

fn contains_phrase(tokens: &[String], phrase: &[&str]) -> bool {
    if phrase.is_empty() || tokens.len() < phrase.len() {
        return false;
    }

    tokens
        .windows(phrase.len())
        .any(|window| window.iter().map(String::as_str).eq(phrase.iter().copied()))
}

fn track_language_score(track: &TrackLanguageCandidate, candidates: &[String]) -> i32 {
    let lang = normalize_lower(track.lang.as_deref()).unwrap_or_default();
    let lang_tokens = track
        .lang
        .as_deref()
        .map(tokenize_language_meta)
        .unwrap_or_default();
    let title_tokens = track
        .title
        .as_deref()
        .map(tokenize_language_meta)
        .unwrap_or_default();
    let combined_tokens = lang_tokens
        .iter()
        .chain(title_tokens.iter())
        .cloned()
        .collect::<Vec<_>>();

    if normalize_language_token(track.lang.as_deref(), false)
        .is_some_and(|language| !candidates.contains(&language))
    {
        return 0;
    }

    let mut score = 0;

    for candidate in candidates {
        if lang == *candidate {
            score = score.max(120);
        } else if lang.starts_with(&format!("{}-", candidate)) {
            score = score.max(100);
        }

        if title_tokens.iter().any(|token| token == candidate) {
            score = score.max(80);
        }
    }

    if score == 0 {
        return 0;
    }

    if track.default_track {
        score += 15;
    }

    if contains_any_token(&title_tokens, &["full", "dialogue", "dialog", "main"]) {
        score += 20;
    }

    if track.forced || contains_token(&combined_tokens, "forced") {
        score -= 45;
    }

    if contains_any_token(
        &title_tokens,
        &["sign", "signs", "song", "songs", "karaoke", "typesetting"],
    ) {
        score -= 35;
    }

    if contains_token(&combined_tokens, "commentary") {
        score -= 60;
    }

    if track.hearing_impaired
        || contains_any_token(&combined_tokens, &["sdh", "cc"])
        || contains_phrase(&combined_tokens, &["closed", "caption"])
        || contains_phrase(&combined_tokens, &["closed", "captions"])
        || contains_phrase(&combined_tokens, &["hearing", "impaired"])
    {
        score -= 12;
    }

    score
}

pub(crate) fn infer_track_preferred_language(
    lang: Option<&str>,
    title: Option<&str>,
) -> Option<String> {
    if let Some(normalized_lang) = normalize_lower(lang) {
        if let Some(canonical) = canonicalize_language_token(&normalized_lang) {
            return Some(canonical.to_string());
        }

        for token in tokenize_language_meta(&normalized_lang) {
            if let Some(canonical) = canonicalize_language_token(&token) {
                return Some(canonical.to_string());
            }
        }
    }

    for token in title.map(tokenize_language_meta).unwrap_or_default() {
        if let Some(canonical) = canonicalize_language_token(&token) {
            return Some(canonical.to_string());
        }
    }

    None
}

pub(crate) fn track_matches_preferred_language(
    lang: Option<&str>,
    title: Option<&str>,
    preferred_language: &str,
) -> bool {
    let candidates = language_candidates(preferred_language);
    if candidates.is_empty() {
        return false;
    }

    if let Some(language) = normalize_language_token(lang, false) {
        return candidates.contains(&language);
    }

    let lang = normalize_lower(lang).unwrap_or_default();
    let title_tokens = title.map(tokenize_language_meta).unwrap_or_default();

    candidates.iter().any(|candidate| {
        lang == *candidate
            || lang.starts_with(&format!("{}-", candidate))
            || title_tokens.iter().any(|token| token == candidate)
    })
}

fn find_track_by_language(
    tracks: &[TrackLanguageCandidate],
    preferred_language: &str,
    selected_track_id: Option<i64>,
) -> Option<i64> {
    let candidates = language_candidates(preferred_language);
    if candidates.is_empty() {
        return None;
    }

    let mut best_track_id = None;
    let mut best_score = -1;

    for track in tracks {
        let score = track_language_score(track, &candidates);

        if score > 0
            && (score > best_score || (score == best_score && Some(track.id) == selected_track_id))
        {
            best_score = score;
            best_track_id = Some(track.id);
        }
    }

    best_track_id
}

pub(crate) fn resolve_preferred_track_selection(
    tracks: &[TrackLanguageCandidate],
    preferred_language: Option<&str>,
    selected_track_id: Option<i64>,
) -> TrackLanguageSelectionResolution {
    let normalized_preferred_language = normalize_language_token(preferred_language, false);
    let Some(preferred_language) = normalized_preferred_language.as_deref() else {
        return TrackLanguageSelectionResolution::default();
    };

    let matched_track_id = find_track_by_language(tracks, preferred_language, selected_track_id);

    let selected_matches = match (selected_track_id, matched_track_id) {
        (Some(selected_track_id), Some(best_track_id)) => selected_track_id == best_track_id,
        (Some(track_id), None) => tracks
            .iter()
            .find(|track| track.id == track_id)
            .is_some_and(|track| {
                track_matches_preferred_language(
                    track.lang.as_deref(),
                    track.title.as_deref(),
                    preferred_language,
                )
            }),
        _ => false,
    };

    let matched_track_id = if selected_matches {
        None
    } else {
        matched_track_id
    };

    TrackLanguageSelectionResolution {
        selected_matches,
        matched_track_id,
    }
}

#[cfg(test)]
mod tests;
