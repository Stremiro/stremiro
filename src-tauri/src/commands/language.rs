use crate::providers::{bound_optional, push_unique};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ops::Range;
use std::sync::LazyLock;

static STREAM_LANGUAGE_TAG_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\[[a-z]{2,3}\]|\([a-z]{2,3}\)").expect("valid stream language tag regex")
});

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

/// Settings, exact language tags, safe metadata tokens and mpv options share one table.
struct SupportedLanguage {
    code: &'static str,
    label: &'static str,
    aliases: &'static [&'static str],
    exact_aliases: &'static [&'static str],
}

const SUPPORTED_LANGUAGES: &[SupportedLanguage] = &[
    SupportedLanguage {
        code: "en",
        label: "English",
        aliases: &["en", "eng", "english"],
        exact_aliases: &[],
    },
    SupportedLanguage {
        code: "ja",
        label: "Japanese",
        aliases: &["ja", "jpn", "japanese"],
        exact_aliases: &[],
    },
    SupportedLanguage {
        code: "es",
        label: "Spanish",
        aliases: &["es", "spa", "spanish"],
        exact_aliases: &[],
    },
    SupportedLanguage {
        code: "fr",
        label: "French",
        aliases: &["fr", "fra", "fre", "french"],
        exact_aliases: &[],
    },
    SupportedLanguage {
        code: "de",
        label: "German",
        aliases: &["de", "deu", "ger", "german"],
        exact_aliases: &[],
    },
    SupportedLanguage {
        code: "it",
        label: "Italian",
        aliases: &["ita", "italian"],
        exact_aliases: &["it"],
    },
    SupportedLanguage {
        code: "pt",
        label: "Portuguese",
        aliases: &["pt", "por", "portuguese", "pob"],
        exact_aliases: &["pt-br"],
    },
    SupportedLanguage {
        code: "ko",
        label: "Korean",
        aliases: &["ko", "kor", "korean"],
        exact_aliases: &[],
    },
    SupportedLanguage {
        code: "zh",
        label: "Chinese",
        aliases: &["zh", "zho", "chi", "chinese"],
        exact_aliases: &[],
    },
    SupportedLanguage {
        code: "ru",
        label: "Russian",
        aliases: &["rus", "russian"],
        exact_aliases: &["ru"],
    },
    SupportedLanguage {
        code: "ar",
        label: "Arabic",
        aliases: &["ara", "arabic"],
        exact_aliases: &["ar"],
    },
    SupportedLanguage {
        code: "hi",
        label: "Hindi",
        aliases: &["hin", "hindi"],
        exact_aliases: &["hi"],
    },
    SupportedLanguage {
        code: "nl",
        label: "Dutch",
        aliases: &["dut", "nld", "dutch"],
        exact_aliases: &["nl"],
    },
    SupportedLanguage {
        code: "pl",
        label: "Polish",
        aliases: &["pol", "polish"],
        exact_aliases: &["pl"],
    },
    SupportedLanguage {
        code: "tr",
        label: "Turkish",
        aliases: &["tur", "turkish"],
        exact_aliases: &["tr"],
    },
    SupportedLanguage {
        code: "sv",
        label: "Swedish",
        aliases: &["swe", "swedish"],
        exact_aliases: &["sv"],
    },
    SupportedLanguage {
        code: "no",
        label: "Norwegian",
        aliases: &["nor", "nob", "norwegian"],
        exact_aliases: &["no", "nb"],
    },
    SupportedLanguage {
        code: "da",
        label: "Danish",
        aliases: &["dan", "danish"],
        exact_aliases: &["da"],
    },
    SupportedLanguage {
        code: "fi",
        label: "Finnish",
        aliases: &["fin", "finnish"],
        exact_aliases: &["fi"],
    },
    SupportedLanguage {
        code: "cs",
        label: "Czech",
        aliases: &["cze", "ces", "czech"],
        exact_aliases: &["cs"],
    },
    SupportedLanguage {
        code: "hu",
        label: "Hungarian",
        aliases: &["hun", "hungarian"],
        exact_aliases: &["hu"],
    },
    SupportedLanguage {
        code: "el",
        label: "Greek",
        aliases: &["gre", "ell", "greek"],
        exact_aliases: &["el"],
    },
    SupportedLanguage {
        code: "he",
        label: "Hebrew",
        aliases: &["heb", "hebrew"],
        exact_aliases: &["he"],
    },
    SupportedLanguage {
        code: "th",
        label: "Thai",
        aliases: &["tha", "thai"],
        exact_aliases: &["th"],
    },
    SupportedLanguage {
        code: "vi",
        label: "Vietnamese",
        aliases: &["vie", "vietnamese"],
        exact_aliases: &["vi"],
    },
    SupportedLanguage {
        code: "id",
        label: "Indonesian",
        aliases: &["ind", "indonesian"],
        exact_aliases: &["id"],
    },
    SupportedLanguage {
        code: "uk",
        label: "Ukrainian",
        aliases: &["ukr", "ukrainian"],
        exact_aliases: &["uk"],
    },
    SupportedLanguage {
        code: "ro",
        label: "Romanian",
        aliases: &["rum", "ron", "romanian"],
        exact_aliases: &["ro"],
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
    let value = value.trim();
    SUPPORTED_LANGUAGES
        .iter()
        .find(|language| {
            language
                .aliases
                .iter()
                .any(|alias| alias.eq_ignore_ascii_case(value))
        })
        .map(|language| language.code)
}

fn language_aliases(canonical: &str) -> &'static [&'static str] {
    SUPPORTED_LANGUAGES
        .iter()
        .find(|language| language.code == canonical)
        .map(|language| language.aliases)
        .unwrap_or(&[])
}

pub(crate) fn canonicalize_language_value(value: &str) -> Option<&'static str> {
    let value = value.trim();
    canonicalize_language_token(value)
        .or_else(|| {
            SUPPORTED_LANGUAGES
                .iter()
                .find(|language| {
                    language
                        .exact_aliases
                        .iter()
                        .any(|alias| alias.eq_ignore_ascii_case(value))
                })
                .map(|language| language.code)
        })
        .or_else(|| {
            let (language, region) = value.split_once('-')?;
            (!region.is_empty())
                .then(|| canonicalize_language_value(language))
                .flatten()
        })
}

pub(crate) fn bracketed_language_tags(
    text: &str,
) -> impl Iterator<Item = (Range<usize>, &'static str)> + '_ {
    STREAM_LANGUAGE_TAG_REGEX
        .find_iter(text)
        .filter_map(|matched| {
            let tag = matched.as_str();
            canonicalize_language_value(&tag[1..tag.len() - 1])
                .map(|language| (matched.range(), language))
        })
}

/// Flag emoji addons print as language markers (`🇮🇹`): regional-indicator pairs by country.
pub(crate) fn flag_language_tags(
    text: &str,
) -> impl Iterator<Item = (Range<usize>, &'static str)> + '_ {
    let mut chars = text.char_indices().peekable();
    std::iter::from_fn(move || {
        while let Some((start, first)) = chars.next() {
            let Some(first) = regional_indicator_letter(first) else {
                continue;
            };
            let Some(second) = chars
                .peek()
                .and_then(|&(_, second)| regional_indicator_letter(second))
            else {
                continue;
            };
            let (second_start, second_char) = chars.next().expect("peeked flag half");
            if let Some(language) = flag_language([first, second]) {
                return Some((start..second_start + second_char.len_utf8(), language));
            }
        }
        None
    })
}

fn regional_indicator_letter(ch: char) -> Option<u8> {
    u32::from(ch)
        .checked_sub(0x1F1E6)
        .and_then(|offset| u8::try_from(offset).ok())
        .filter(|offset| *offset < 26)
        .map(|offset| b'a' + offset)
}

fn flag_language(country: [u8; 2]) -> Option<&'static str> {
    Some(match &country {
        b"gb" | b"us" | b"au" => "en",
        b"jp" => "ja",
        b"es" | b"mx" => "es",
        b"fr" => "fr",
        b"de" | b"at" => "de",
        b"it" => "it",
        b"pt" | b"br" => "pt",
        b"kr" => "ko",
        b"cn" | b"tw" | b"hk" => "zh",
        b"ru" => "ru",
        b"sa" | b"ae" | b"eg" => "ar",
        b"in" => "hi",
        b"nl" => "nl",
        b"pl" => "pl",
        b"tr" => "tr",
        b"se" => "sv",
        b"no" => "no",
        b"dk" => "da",
        b"fi" => "fi",
        b"cz" => "cs",
        b"hu" => "hu",
        b"gr" => "el",
        b"il" => "he",
        b"th" => "th",
        b"vn" => "vi",
        b"id" => "id",
        b"ua" => "uk",
        b"ro" => "ro",
        _ => return None,
    })
}

fn is_exact_only_language_alias(value: &str) -> bool {
    SUPPORTED_LANGUAGES
        .iter()
        .any(|language| language.exact_aliases.contains(&value))
}

fn normalize_lower(value: Option<&str>) -> Option<String> {
    let value = value?;
    if value.chars().nth(TRACK_LANG_MAX_CHARS).is_some() {
        return None;
    }
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

pub(crate) fn normalize_language_token(value: Option<&str>, allow_off: bool) -> Option<String> {
    let normalized = normalize_lower(value)?;

    if allow_off && normalized == "off" {
        return Some(normalized);
    }

    if let Some(canonical) = canonicalize_language_value(&normalized) {
        return Some(canonical.to_string());
    }

    let token_text = super::normalize_token_text(&normalized);
    token_text
        .split_whitespace()
        .find_map(|token| canonicalize_language_token(token).map(str::to_string))
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
/// `ger`/`fre`/`chi`), so a preference expands to every alias of the canonical code.
fn mpv_language_priority_list(preferred: Option<&str>) -> Option<String> {
    let normalized = normalize_language_token(preferred, false)?;
    let mut aliases = vec![normalized.as_str()];
    for alias in SUPPORTED_LANGUAGES
        .iter()
        .filter(|language| language.code == normalized)
        .flat_map(|language| language.aliases.iter().chain(language.exact_aliases))
    {
        if !aliases.contains(alias) {
            aliases.push(alias);
        }
    }
    Some(aliases.join(","))
}

/// Track auto-selection options for mpv init, built from the canonical table the
/// preference store sanitizes against. `off` is subtitle-only → `sid=no`.
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
    let Some(normalized) = normalize_lower(Some(preferred)) else {
        return Vec::new();
    };

    let canonical =
        normalize_language_token(Some(&normalized), false).unwrap_or_else(|| normalized.clone());
    let mut candidates = Vec::new();

    push_unique(&mut candidates, &canonical);
    push_unique(&mut candidates, &normalized);

    for alias in language_aliases(&canonical) {
        push_unique(&mut candidates, *alias);
    }

    let token_text = super::normalize_token_text(&normalized);
    for token in token_text.split_whitespace() {
        if let Some(token_canonical) = canonicalize_language_token(token) {
            push_unique(&mut candidates, token_canonical);

            for alias in language_aliases(token_canonical) {
                push_unique(&mut candidates, *alias);
            }
        }
    }

    candidates
}

fn contains_any_token(tokens: &[&str], needles: &[&str]) -> bool {
    needles.iter().any(|needle| tokens.contains(needle))
}

fn contains_phrase(tokens: &[&str], phrase: &[&str]) -> bool {
    if phrase.is_empty() || tokens.len() < phrase.len() {
        return false;
    }

    tokens.windows(phrase.len()).any(|window| window == phrase)
}

fn track_language_score(track: &TrackLanguageCandidate, candidates: &[String]) -> i32 {
    let tagged_language = normalize_language_token(track.lang.as_deref(), false);
    if tagged_language
        .as_ref()
        .is_some_and(|language| !candidates.contains(language))
    {
        return 0;
    }

    let lang = normalize_lower(track.lang.as_deref()).unwrap_or_default();
    let title_text = super::normalize_token_text(track.title.as_deref().unwrap_or_default());
    let title_tokens = title_text.split_whitespace().collect::<Vec<_>>();
    let mut score = if canonicalize_language_value(&lang).is_some() {
        if lang.contains('-') {
            100
        } else {
            120
        }
    } else {
        0
    };

    for candidate in candidates {
        if lang == *candidate {
            score = score.max(120);
        } else if lang
            .strip_prefix(candidate.as_str())
            .is_some_and(|rest| rest.starts_with('-'))
        {
            score = score.max(100);
        }

        if !is_exact_only_language_alias(candidate) && title_tokens.contains(&candidate.as_str()) {
            score = score.max(80);
        }
    }

    if score == 0 {
        return 0;
    }

    let lang_text = super::normalize_token_text(track.lang.as_deref().unwrap_or_default());
    let combined_tokens = lang_text
        .split_whitespace()
        .chain(title_tokens.iter().copied())
        .collect::<Vec<_>>();

    if track.default_track {
        score += 15;
    }

    if contains_any_token(&title_tokens, &["full", "dialogue", "dialog", "main"]) {
        score += 20;
    }

    if track.forced || combined_tokens.contains(&"forced") {
        score -= 45;
    }

    if contains_any_token(
        &title_tokens,
        &["sign", "signs", "song", "songs", "karaoke", "typesetting"],
    ) {
        score -= 35;
    }

    if combined_tokens.contains(&"commentary") {
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
    normalize_language_token(lang, false).or_else(|| {
        let title_text = super::normalize_token_text(title?);
        title_text
            .split_whitespace()
            .find_map(|token| canonicalize_language_token(token).map(str::to_string))
    })
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
    let title_text = title.map(super::normalize_token_text).unwrap_or_default();
    let title_tokens = title_text.split_whitespace().collect::<Vec<_>>();

    candidates.iter().any(|candidate| {
        lang == *candidate
            || lang
                .strip_prefix(candidate.as_str())
                .is_some_and(|rest| rest.starts_with('-'))
            || (!is_exact_only_language_alias(candidate)
                && title_tokens.contains(&candidate.as_str()))
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
