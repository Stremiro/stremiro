use super::AddonStream;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

// Release-tag flag vocabulary — the `StreamFlags` probes below. Kept beside
// the match battery so every regex over the lowered stream fields lives in
// one module.
static STREAM_DV_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bdv\b").expect("valid stream dv regex"));
static STREAM_AV1_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bav1\b").expect("valid stream av1 regex"));
static STREAM_DUAL_AUDIO_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)dual[.\-\s]?audio").expect("valid stream dual-audio regex"));
static STREAM_MULTI_AUDIO_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)multi[.\-\s]?audio").expect("valid stream multi-audio regex")
});
static STREAM_MULTI_LANG_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)multi[.\-\s]?lang").expect("valid stream multi-lang regex"));
static STREAM_MULTI_SUB_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)multi[.\-\s]?sub").expect("valid stream multi-sub regex"));
static STREAM_ENGLISH_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\beng(?:lish)?\b").expect("valid stream english regex"));
static STREAM_JAPANESE_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bjap(?:anese)?\b").expect("valid stream japanese regex"));
// `hdr\d*` keeps "HDR"/"HDR10" while rejecting "HDRip" (a capture-format
// tag, not HDR video) — a raw `contains("hdr")` misclassifies it.
static STREAM_HDR_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bhdr\d*\b").expect("valid stream hdr regex"));
// `\b4k\b` rejects non-resolution tokens like "4Kids" dubs that a raw
// `contains("4k")` misclassified as P2160.
static STREAM_4K_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b4k\b").expect("valid stream 4k regex"));
// Size text ("5.1 GB") is not a channel layout: strip `[57].1<size>` spans
// before probing, since `\b5\.1\b` alone cannot tell audio from bytes.
static STREAM_SURROUND_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b[57]\.1\b").expect("valid stream surround regex"));
static STREAM_SURROUND_SIZE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)[57]\.1\s*(?:k|m|g|t)i?b\b").expect("valid stream surround size regex")
});

/// Detects season packs, batch downloads, and multi-episode collections.
/// Intentionally conservative to avoid false positives on single-episode streams.
pub(super) static BATCH_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i)(?:",
        // Explicit batch/pack keywords. Word separators accept dots and
        // underscores too: release names are rarely space-separated
        // ("Show.Complete.Series.1080p").
        r"\bbatch\b",
        r"|\bcomplete[\s._-]+(?:series|season|pack|collection)\b",
        r"|\bseason[\s._-]*pack\b",
        r"|\bfull[\s._-]+(?:season|series)\b",
        // Season ranges: S01-S23, S01~S05
        r"|\bs\d{1,2}[\s._]*[-~][\s._]*s\d{1,2}\b",
        // Episode ranges requiring BOTH E/EP markers to avoid
        // false-matching titles like "S15E52 - 1080p"
        r"|\b(?:e|ep)\d{1,4}[\s._]*[-~][\s._]*(?:e|ep)\d{1,4}\b",
        // Keyword ranges: "Season 1-23", "Episode.1-24"
        r"|\bseason[\s._]*\d+[\s._]*[-~&][\s._]*(?:season[\s._]*)?\d+\b",
        r"|\bepisode[\s._]*\d+[\s._]*[-~][\s._]*(?:episode[\s._]*)?\d+\b",
        r")"
    ))
    .expect("valid batch regex")
});

static SEASON_EPISODE_RANGE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bs0*(\d{1,2})e0*(\d{1,4})\s*[-~]\s*e?0*(\d{1,4})\b")
        .expect("valid season episode range regex")
});
static X_SEASON_EPISODE_RANGE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b0*(\d{1,2})x0*(\d{1,4})\s*[-~]\s*(?:0*\d{1,2}x)?0*(\d{1,4})\b")
        .expect("valid x season episode range regex")
});
static EPISODE_RANGE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(?:e|ep|episode)[\s._]*0*(\d{1,4})[\s._]*[-~][\s._]*(?:e|ep|episode)?[\s._]*0*(\d{1,4})\b",
    )
    .expect("valid episode range regex")
});
static SEASON_RANGE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\bs(?:eason)?[\s._]*0*(\d{1,2})[\s._]*[-~&][\s._]*(?:s(?:eason)?[\s._]*)?0*(\d{1,2})\b",
    )
    .expect("valid season range regex")
});
static SEASON_TOKEN_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bseason[\s._]*0*(\d{1,2})\b").expect("valid season token regex")
});
// Bare `S01` without an `E` segment: how packs are usually named
// ("Show.S01.COMPLETE"). The trailing `\b` is a word boundary, so `S01E05`
// (no boundary before `e`) and `S0105` never produce a bare-season capture.
static BARE_SEASON_TOKEN_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bs0*(\d{1,2})\b").expect("valid bare season token regex"));
static SEASON_EPISODE_TOKEN_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bs0*(\d{1,2})e\d{1,4}\b").expect("valid season episode token regex")
});
static X_EPISODE_TOKEN_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b0*(\d{1,2})x\d{1,4}\b").expect("valid x episode token regex")
});
// Loose episode keyword forms: "episode 5", "Episode.05", "ep_5", "ep5".
// One regex covers every separator instead of a probe per spelling; the
// captured number is compared, so `ep5` never matches inside `ep52`.
static LOOSE_EPISODE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:episode|ep)[\s._-]*0*(\d{1,4})\b").expect("valid loose episode regex")
});
// Bare `E05` split from its season ("Show.S01.E05"). Gated on an explicit
// matching season marker so stray `e5`-shaped tokens (model numbers, codec
// fragments) can't produce a match where no season was declared.
static BARE_E_EPISODE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\be[\s._-]*0*(\d{1,4})\b").expect("valid bare-e episode regex")
});
// Pack vocabulary that only counts alongside a season marker: bare
// `complete`/`collection`/`pack` alone appear in movie titles
// ("Complete Unknown"), but "S01 Complete" is unambiguously a pack.
static PACK_KEYWORD_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:batch|complete|collection|pack)\b").expect("valid pack keyword regex")
});
static SEASON_MARKER_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bseason[\s._]*0*\d{1,2}\b|\bs0*\d{1,2}\b|\b0*\d{1,2}x\d{1,4}\b")
        .expect("valid season marker regex")
});
// Named season claims release groups use instead of numbers. Ordinal forms
// ("2nd Season") resolve to their number; "final season" claims the show's
// last season, which only the caller's final-season fact can verify. Titled
// final seasons ("… - The Final Season - 04") carry no numeric claim —
// without these the loose absolute dash form cross-matches every season
// with a same-numbered episode.
static FINAL_SEASON_MARKER_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bfinal[\s._-]*season\b").expect("valid final season marker regex")
});
static ORDINAL_SEASON_DIGIT_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(\d{1,2})(?:st|nd|rd|th)[\s._-]*season\b")
        .expect("valid ordinal season digit regex")
});
static ORDINAL_SEASON_WORD_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)[\s._-]*season\b",
    )
    .expect("valid ordinal season word regex")
});

// Match-tier *values* serialize snake_case (`season_pack`, `episode_range`)
// while the carrier fields stay camelCase (`matchSummary`) — the selector's
// badges, dot-field tier map, and aria strings all key on that contract.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StreamEpisodeMatchKind {
    None,
    SeasonPack,
    EpisodeRange,
    Exact,
}

/// Title-overlap tier derived from the coordinator's relevance score:
/// `Close` is a full reference-token overlap, `Partial` a strong one.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StreamTitleMatch {
    Partial,
    Close,
}

/// Structured match facts for the selector UI. The coordinator owns the
/// tiers; the frontend renders them as badges without parsing reason text.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StreamMatchSummary {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode: Option<StreamEpisodeMatchKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<StreamTitleMatch>,
}

fn range_contains(requested: u32, start: u32, end: u32) -> bool {
    let lower = start.min(end);
    let upper = start.max(end);
    requested >= lower && requested <= upper
}

fn parse_captured_u32(captures: &regex::Captures<'_>, index: usize) -> Option<u32> {
    captures.get(index)?.as_str().parse::<u32>().ok()
}

fn ordinal_season_word_number(word: &str) -> Option<u32> {
    match word.to_ascii_lowercase().as_str() {
        "first" => Some(1),
        "second" => Some(2),
        "third" => Some(3),
        "fourth" => Some(4),
        "fifth" => Some(5),
        "sixth" => Some(6),
        "seventh" => Some(7),
        "eighth" => Some(8),
        "ninth" => Some(9),
        _ => None,
    }
}

/// `None` = the text makes no season claim at all; `Some(true)` = an
/// explicit claim matches the requested season; `Some(false)` = the text
/// claims a different season. Numeric claims come from the marker regexes;
/// named claims join them: ordinals resolve to their number, and a
/// numberless "final season" claim matches only when `final_season` says
/// the request targets the show's last season — the only season that claim
/// can refer to. `Some(false)` is what keeps the loose absolute-number
/// episode forms from cross-matching a titled release of another season.
pub(super) fn text_matches_requested_season(
    text: &str,
    requested_season: u32,
    final_season: bool,
) -> Option<bool> {
    // Regexes are `(?i)`: no lowercase copy needed for season detection.
    let mut saw_explicit_season = false;
    let mut saw_matching_season = false;

    for captures in SEASON_RANGE_REGEX.captures_iter(text) {
        let Some(start) = parse_captured_u32(&captures, 1) else {
            continue;
        };
        let Some(end) = parse_captured_u32(&captures, 2) else {
            continue;
        };

        saw_explicit_season = true;
        if range_contains(requested_season, start, end) {
            saw_matching_season = true;
        }
    }

    for regex in [
        &*SEASON_EPISODE_RANGE_REGEX,
        &*X_SEASON_EPISODE_RANGE_REGEX,
        &*SEASON_EPISODE_TOKEN_REGEX,
        &*X_EPISODE_TOKEN_REGEX,
        &*SEASON_TOKEN_REGEX,
        &*BARE_SEASON_TOKEN_REGEX,
    ] {
        for captures in regex.captures_iter(text) {
            let Some(candidate_season) = parse_captured_u32(&captures, 1) else {
                continue;
            };

            saw_explicit_season = true;
            if candidate_season == requested_season {
                saw_matching_season = true;
            }
        }
    }

    for captures in ORDINAL_SEASON_DIGIT_REGEX.captures_iter(text) {
        if let Some(candidate_season) = parse_captured_u32(&captures, 1) {
            saw_explicit_season = true;
            if candidate_season == requested_season {
                saw_matching_season = true;
            }
        }
    }

    for captures in ORDINAL_SEASON_WORD_REGEX.captures_iter(text) {
        if let Some(candidate_season) = captures
            .get(1)
            .map(|capture| capture.as_str())
            .and_then(ordinal_season_word_number)
        {
            saw_explicit_season = true;
            if candidate_season == requested_season {
                saw_matching_season = true;
            }
        }
    }

    if FINAL_SEASON_MARKER_REGEX.is_match(text) {
        saw_explicit_season = true;
        if final_season {
            saw_matching_season = true;
        }
    }

    if !saw_explicit_season {
        None
    } else {
        Some(saw_matching_season)
    }
}

/// `season_context` is the caller's `text_matches_requested_season` result
/// for this field, so the season regex family runs once per (field, season)
/// instead of inside every probe.
fn episode_range_contains_text(
    text: &str,
    season: u32,
    episode: u32,
    season_context: Option<bool>,
) -> bool {
    for captures in SEASON_EPISODE_RANGE_REGEX.captures_iter(text) {
        let Some(candidate_season) = parse_captured_u32(&captures, 1) else {
            continue;
        };
        let Some(start_episode) = parse_captured_u32(&captures, 2) else {
            continue;
        };
        let Some(end_episode) = parse_captured_u32(&captures, 3) else {
            continue;
        };

        if candidate_season == season && range_contains(episode, start_episode, end_episode) {
            return true;
        }
    }

    for captures in X_SEASON_EPISODE_RANGE_REGEX.captures_iter(text) {
        let Some(candidate_season) = parse_captured_u32(&captures, 1) else {
            continue;
        };
        let Some(start_episode) = parse_captured_u32(&captures, 2) else {
            continue;
        };
        let Some(end_episode) = parse_captured_u32(&captures, 3) else {
            continue;
        };

        if candidate_season == season && range_contains(episode, start_episode, end_episode) {
            return true;
        }
    }

    if matches!(season_context, Some(false)) {
        return false;
    }

    for captures in EPISODE_RANGE_REGEX.captures_iter(text) {
        let Some(start_episode) = parse_captured_u32(&captures, 1) else {
            continue;
        };
        let Some(end_episode) = parse_captured_u32(&captures, 2) else {
            continue;
        };

        if range_contains(episode, start_episode, end_episode) {
            return true;
        }
    }

    false
}

/// `contains` plus digit boundaries. Every probe ends in the episode
/// number, so a trailing digit means a larger episode (`s1e1` inside
/// `s1e10`). Only the `NxNN` probes start with a digit, so only they need
/// the leading check (`1x01` inside `11x01`).
fn contains_episode_token(t: &str, needle: &str, leading_boundary: bool) -> bool {
    let bytes = t.as_bytes();
    let mut search_from = 0;
    while let Some(found) = t[search_from..].find(needle) {
        let start = search_from + found;
        let end = start + needle.len();
        if (!leading_boundary || start == 0 || !bytes[start - 1].is_ascii_digit())
            && (end == bytes.len() || !bytes[end].is_ascii_digit())
        {
            return true;
        }
        search_from = start + 1;
    }
    false
}

/// Check whether lowered stream text explicitly mentions the requested
/// episode. Handles long-running series (ep 1000+) and multiple naming
/// conventions. `season_context` is the caller's
/// `text_matches_requested_season` result for this field.
pub(super) fn episode_matches_lowered(
    t: &str,
    season: u32,
    episode: u32,
    season_context: Option<bool>,
) -> bool {
    use std::fmt::Write;

    let mut buf = String::with_capacity(20);

    // S15E52 (zero-padded) and mixed-padding forms (`S1E05`, `S01E5`) —
    // release groups pad season and episode independently.
    let _ = write!(buf, "s{:02}e{:02}", season, episode);
    if contains_episode_token(t, buf.as_str(), false) {
        return true;
    }

    buf.clear();
    let _ = write!(buf, "s{}e{}", season, episode);
    if contains_episode_token(t, buf.as_str(), false) {
        return true;
    }

    buf.clear();
    let _ = write!(buf, "s{}e{:02}", season, episode);
    if contains_episode_token(t, buf.as_str(), false) {
        return true;
    }

    buf.clear();
    let _ = write!(buf, "s{:02}e{}", season, episode);
    if contains_episode_token(t, buf.as_str(), false) {
        return true;
    }

    // 15x52 / 1x1000 — `{:02}` never truncates, so it also covers 3+ digit
    // episodes common in long-running anime. The second probe adds the
    // unpadded `1x5` form; only `NxNN` probes can sit inside a larger
    // season number, so they keep the leading digit boundary.
    buf.clear();
    let _ = write!(buf, "{}x{:02}", season, episode);
    if contains_episode_token(t, buf.as_str(), true) {
        return true;
    }

    buf.clear();
    let _ = write!(buf, "{}x{}", season, episode);
    if contains_episode_token(t, buf.as_str(), true) {
        return true;
    }

    if matches!(season_context, Some(false)) {
        return false;
    }

    // "Episode 52" / "Episode.1000" / "Ep 52" / "Ep.52" / "ep_5" / "ep52"
    for captures in LOOSE_EPISODE_REGEX.captures_iter(t) {
        if parse_captured_u32(&captures, 1) == Some(episode) {
            return true;
        }
    }

    // "S01.E05" — the `E` segment detached from its season token.
    if matches!(season_context, Some(true)) {
        for captures in BARE_E_EPISODE_REGEX.captures_iter(t) {
            if parse_captured_u32(&captures, 1) == Some(episode) {
                return true;
            }
        }
    }

    // " - 052" / " - 07" / " - 1000" — common absolute-numbered episode
    // form for anime release groups. `{:03}` already covers every episode
    // >= 100 unpadded; `{:02}` adds the two-digit form for episodes < 100.
    buf.clear();
    let _ = write!(buf, " - {:03}", episode);
    if contains_episode_token(t, buf.as_str(), false) {
        return true;
    }
    if episode < 100 {
        buf.clear();
        let _ = write!(buf, " - {:02}", episode);
        if contains_episode_token(t, buf.as_str(), false) {
            return true;
        }
    }

    // "#1000" — sometimes used in anime releases
    buf.clear();
    let _ = write!(buf, "#{}", episode);
    if contains_episode_token(t, buf.as_str(), false) {
        return true;
    }

    false
}

/// `_` is a word character, so it defeats `\b` in every match regex — but
/// release groups use it as a separator ("Show_S01_Complete"). Map it to a
/// space once so all probes and regexes see the same token boundaries.
pub(crate) fn normalize_separators(text: &str) -> std::borrow::Cow<'_, str> {
    if text.contains('_') {
        std::borrow::Cow::Owned(text.replace('_', " "))
    } else {
        std::borrow::Cow::Borrowed(text)
    }
}

/// One field counts as batch text when it trips the strict batch regex or
/// pairs a pack keyword with a season marker ("Show S01 Complete"). The
/// keyword alone is not enough — movie titles carry it too.
fn is_batch_text(text: &str) -> bool {
    BATCH_REGEX.is_match(text)
        || (PACK_KEYWORD_REGEX.is_match(text) && SEASON_MARKER_REGEX.is_match(text))
}

/// Batch check on pre-normalized text: the `(?i)` regexes behave identically
/// on the lowered fields, so the per-field memo filled in `lower` answers
/// without re-running the regex battery.
pub(crate) fn stream_contains_batch_texts(texts: &StreamMatchText) -> bool {
    texts.batch.name || texts.batch.title || texts.batch.filename
}

/// Resolution tier shared by the quality score and the presentation badge —
/// one classifier so the two cannot drift.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum StreamResolutionTier {
    P2160,
    P1080,
    P720,
    P480,
    #[default]
    Sd,
}

fn stream_resolution_tier(lower_text: &str) -> StreamResolutionTier {
    if lower_text.contains("2160p") || STREAM_4K_REGEX.is_match(lower_text) {
        StreamResolutionTier::P2160
    } else if lower_text.contains("1080p") {
        StreamResolutionTier::P1080
    } else if lower_text.contains("720p") {
        StreamResolutionTier::P720
    } else if lower_text.contains("480p") {
        StreamResolutionTier::P480
    } else {
        StreamResolutionTier::Sd
    }
}

/// Release-type tier for the quality score — the `else if` precedence of
/// the probe chain made data: the first matching kind wins.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum StreamReleaseKind {
    Remux,
    BluRay,
    WebDl,
    WebRip,
    Hdtv,
    #[default]
    Other,
}

/// Release-tag flags computed once over the lowered `name + " " + title`
/// haystack in `StreamMatchText::lower`. Single owner of the release-tag
/// vocabulary the presentation badge, the composite quality score, and the
/// language/marker probes all read — badge and ranker must never disagree.
/// Flags are raw probes; precedence lives in the consumers' else-if chains.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct StreamFlags {
    // Audio-language markers: ranking bonus, language score, DUAL/MULTI badge.
    pub dual_audio: bool,
    pub multi_audio: bool,
    pub multi_sub: bool,
    /// An explicit English+Japanese pair is badge-side dual-audio evidence.
    pub english_japanese_pair: bool,
    /// Resolution tier for the badge label, quality points, and oversize class.
    pub resolution: StreamResolutionTier,
    /// Release-type tier scored by the composite quality score.
    pub release: StreamReleaseKind,
    pub dolby_vision: bool,
    pub hdr10_plus: bool,
    pub hdr: bool,
    /// TrueHD folds into Atmos for both badge and score.
    pub atmos: bool,
    /// `dts-hd`/`dts-x`/`dtsx`; the plain `dts` flag stays raw — consumers
    /// gate it on `!dts_hd` where their precedence requires.
    pub dts_hd: bool,
    pub dts: bool,
    /// eac3/dd+/ddp/dd5.1 — union of the score and badge spellings.
    pub eac3: bool,
    pub aac: bool,
    /// 5.1/7.1 surround — quality-score signal only today.
    pub surround: bool,
    /// x265/hevc/h265/h.265 spellings.
    pub hevc: bool,
    pub av1: bool,
}

/// One probe pass over the lowered `name + " " + title` haystack — see
/// `StreamFlags`. Expects already-lowered, separator-normalized text
/// (`StreamMatchText` fields); callers with raw text must lower it first.
pub(crate) fn detect_stream_flags(haystack: &str) -> StreamFlags {
    let release = if haystack.contains("remux") {
        // `bdremux` is covered: it contains the `remux` substring.
        StreamReleaseKind::Remux
    } else if haystack.contains("bluray")
        || haystack.contains("blu-ray")
        || haystack.contains("bdrip")
    {
        StreamReleaseKind::BluRay
    } else if haystack.contains("web-dl") || haystack.contains("webdl") {
        StreamReleaseKind::WebDl
    } else if haystack.contains("webrip") {
        StreamReleaseKind::WebRip
    } else if haystack.contains("hdtv") {
        StreamReleaseKind::Hdtv
    } else {
        StreamReleaseKind::Other
    };

    StreamFlags {
        dual_audio: STREAM_DUAL_AUDIO_REGEX.is_match(haystack)
            || haystack.contains("dub + sub")
            || haystack.contains("sub + dub")
            || (haystack.contains("dubbed") && haystack.contains("sub")),
        multi_audio: STREAM_MULTI_AUDIO_REGEX.is_match(haystack)
            || STREAM_MULTI_LANG_REGEX.is_match(haystack),
        multi_sub: STREAM_MULTI_SUB_REGEX.is_match(haystack),
        english_japanese_pair: STREAM_ENGLISH_REGEX.is_match(haystack)
            && STREAM_JAPANESE_REGEX.is_match(haystack),
        resolution: stream_resolution_tier(haystack),
        release,
        dolby_vision: haystack.contains("dolby vision")
            || haystack.contains("dovi")
            || STREAM_DV_REGEX.is_match(haystack),
        hdr10_plus: haystack.contains("hdr10+"),
        hdr: STREAM_HDR_REGEX.is_match(haystack),
        atmos: haystack.contains("atmos") || haystack.contains("truehd"),
        dts_hd: haystack.contains("dts-hd")
            || haystack.contains("dts-x")
            || haystack.contains("dtsx"),
        dts: haystack.contains("dts"),
        eac3: haystack.contains("eac3")
            || haystack.contains("dd+")
            || haystack.contains("ddp")
            || haystack.contains("dd5.1"),
        aac: haystack.contains("aac"),
        surround: STREAM_SURROUND_REGEX
            .is_match(&STREAM_SURROUND_SIZE_REGEX.replace_all(haystack, " ")),
        hevc: haystack.contains("x265")
            || haystack.contains("hevc")
            || haystack.contains("h265")
            || haystack.contains("h.265"),
        av1: STREAM_AV1_REGEX.is_match(haystack),
    }
}

/// Lowercased, separator-normalized copies of the three matchable stream
/// fields. Every match probe — `contains` patterns and all `(?i)` regexes —
/// behaves identically on the lowered text, so one build serves every check
/// for every coordinate pair the caller evaluates.
#[derive(Debug, Clone)]
pub(crate) struct StreamMatchText {
    pub(crate) name: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) filename: Option<String>,
    /// `name + " " + title`, joined once alongside the lowered fields so
    /// the language/quality probes never re-allocate the haystack per pass.
    name_title: String,
    /// Per-field batch memo, filled once in `lower` — the SeasonPack tier
    /// re-asks per coordinate pair, so the decode-time answer is never
    /// re-scanned.
    batch: BatchTextFlags,
    /// Release-tag memo over `name_title`, filled once in `lower` — badge,
    /// quality score, and language probes share one scan.
    pub(crate) flags: StreamFlags,
}

/// Batch-text memo for `StreamMatchText`'s three fields — see `is_batch_text`
/// for what counts as batch text.
#[derive(Debug, Clone, Copy, Default)]
struct BatchTextFlags {
    name: bool,
    title: bool,
    filename: bool,
}

impl StreamMatchText {
    /// Lowercased, separator-normalized copies of the three matchable
    /// fields — see `normalize_separators` for why `_` becomes a space.
    pub(crate) fn lower(stream: &AddonStream) -> Self {
        let normalize = |text: &str| normalize_separators(text).to_lowercase();
        let name = stream.name.as_deref().map(normalize);
        let title = stream.title.as_deref().map(normalize);
        let filename = stream
            .behavior_hints
            .as_ref()
            .and_then(|hints| hints.filename.as_deref())
            .map(normalize);
        let name_title = format!(
            "{} {}",
            name.as_deref().unwrap_or(""),
            title.as_deref().unwrap_or("")
        );
        let batch = BatchTextFlags {
            name: name.as_deref().is_some_and(is_batch_text),
            title: title.as_deref().is_some_and(is_batch_text),
            filename: filename.as_deref().is_some_and(is_batch_text),
        };
        let flags = detect_stream_flags(&name_title);
        Self {
            name,
            title,
            filename,
            name_title,
            batch,
            flags,
        }
    }

    /// `name + " " + title` haystack for the language/quality probes,
    /// already lowered and separator-normalized.
    pub(crate) fn name_title_haystack(&self) -> &str {
        &self.name_title
    }

    /// (field text, season context, batch memo) pairs, computed once per
    /// call so the season regex family runs once per field, not per probe.
    /// The batch flag is the decode-time memo from `lower`, so the SeasonPack
    /// tier never re-runs the strict batch regexes.
    /// `final_season` is the caller's request fact (see
    /// `text_matches_requested_season`). Absent-field slots stay `None`.
    pub(super) fn fields_with_season_context(
        &self,
        season: u32,
        final_season: bool,
    ) -> [Option<(&String, Option<bool>, bool)>; 3] {
        [
            (self.name.as_ref(), self.batch.name),
            (self.title.as_ref(), self.batch.title),
            (self.filename.as_ref(), self.batch.filename),
        ]
        .map(|(text, is_batch)| {
            let text = text?;
            Some((
                text,
                text_matches_requested_season(text, season, final_season),
                is_batch,
            ))
        })
    }
}

/// Episode-match tier plus whether the winning tier rested on an explicit
/// season claim. Same-tier ties split on the claim: a release that names
/// its season ("S01E04", "The Final Season - 04" for a final-season
/// request) outranks an assumed absolute-number match ("… - 04"), so in a
/// mixed pool two same-numbered files of different seasons cannot swap
/// places on quality alone.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct StreamEpisodeMatch {
    pub kind: StreamEpisodeMatchKind,
    pub season_claim_verified: bool,
}

pub(crate) fn stream_episode_match_texts(
    texts: &StreamMatchText,
    season: u32,
    episode: u32,
    final_season: bool,
) -> StreamEpisodeMatch {
    let fields = texts.fields_with_season_context(season, final_season);

    // Exact/range scans read every matching field instead of stopping at
    // the first so the claim bit reflects the best evidence available.
    let mut matched_exact = false;
    let mut exact_claim_verified = false;
    for (text, season_context, _) in fields.iter().flatten() {
        if episode_matches_lowered(text, season, episode, *season_context) {
            matched_exact = true;
            exact_claim_verified |= matches!(*season_context, Some(true));
        }
    }
    if matched_exact {
        return StreamEpisodeMatch {
            kind: StreamEpisodeMatchKind::Exact,
            season_claim_verified: exact_claim_verified,
        };
    }

    let mut matched_range = false;
    let mut range_claim_verified = false;
    for (text, season_context, _) in fields.iter().flatten() {
        if episode_range_contains_text(text, season, episode, *season_context) {
            matched_range = true;
            range_claim_verified |= matches!(*season_context, Some(true));
        }
    }
    if matched_range {
        return StreamEpisodeMatch {
            kind: StreamEpisodeMatchKind::EpisodeRange,
            season_claim_verified: range_claim_verified,
        };
    }

    // SeasonPack: a batch field whose own season marker matches the target
    // ("S03 Complete" for S03E07), or a batch field with no season claim at
    // all ("Complete Series") provided no other field declares a different
    // season. A batch field that names a different season ("S02 Pack" for
    // S01E05) is evidence against, not for. The claim bit separates a pack
    // that names the requested season from one merely lacking a claim.
    let mut batch_with_matching_season = false;
    let mut batch_without_season = false;
    let mut conflicting_season = false;
    for (_, season_context, is_batch) in fields.iter().flatten() {
        if matches!(season_context, Some(false)) {
            conflicting_season = true;
        }
        if *is_batch {
            match season_context {
                Some(true) => batch_with_matching_season = true,
                Some(false) => {}
                None => batch_without_season = true,
            }
        }
    }
    if batch_with_matching_season {
        return StreamEpisodeMatch {
            kind: StreamEpisodeMatchKind::SeasonPack,
            season_claim_verified: true,
        };
    }
    if batch_without_season && !conflicting_season {
        return StreamEpisodeMatch {
            kind: StreamEpisodeMatchKind::SeasonPack,
            season_claim_verified: false,
        };
    }

    StreamEpisodeMatch {
        kind: StreamEpisodeMatchKind::None,
        season_claim_verified: false,
    }
}

/// Text-invariant claim probes for `numeric_episode_claim_matches` — the
/// ~13 regex scans depend only on the text, so a per-text profile is computed
/// once instead of once per (text, target) pair.
struct EpisodeClaimProfile {
    has_season: bool,
    has_episode: bool,
    has_range: bool,
}

fn episode_claim_profile(text: &str) -> Option<EpisodeClaimProfile> {
    let has_season = [
        &*SEASON_RANGE_REGEX,
        &*SEASON_EPISODE_TOKEN_REGEX,
        &*X_EPISODE_TOKEN_REGEX,
        &*SEASON_TOKEN_REGEX,
        &*BARE_SEASON_TOKEN_REGEX,
    ]
    .iter()
    .any(|regex| regex.is_match(text));
    let has_episode = [
        &*SEASON_EPISODE_TOKEN_REGEX,
        &*X_EPISODE_TOKEN_REGEX,
        &*LOOSE_EPISODE_REGEX,
        &*EPISODE_RANGE_REGEX,
    ]
    .iter()
    .any(|regex| regex.is_match(text))
        || (has_season && BARE_E_EPISODE_REGEX.is_match(text));
    if !has_season && !has_episode {
        return None;
    }
    let has_range = [
        &*SEASON_EPISODE_RANGE_REGEX,
        &*X_SEASON_EPISODE_RANGE_REGEX,
        &*EPISODE_RANGE_REGEX,
    ]
    .iter()
    .any(|regex| regex.is_match(text));
    Some(EpisodeClaimProfile {
        has_season,
        has_episode,
        has_range,
    })
}

fn numeric_episode_claim_matches(
    profile: &EpisodeClaimProfile,
    text: &str,
    season: u32,
    episode: u32,
    final_season: bool,
) -> bool {
    let season_context = text_matches_requested_season(text, season, final_season);
    if profile.has_season && season_context == Some(false) {
        return false;
    }
    if profile.has_range {
        return episode_range_contains_text(text, season, episode, season_context);
    }
    if profile.has_episode {
        episode_matches_lowered(text, season, episode, season_context)
    } else {
        season_context == Some(true)
    }
}

/// `final_season_season` is the target season the caller's `is_final_season`
/// fact was computed for; other target seasons keep the conservative `false`
/// so a numberless "final season" claim never cross-binds.
pub(crate) fn stream_conflicts_with_episode_targets(
    texts: &StreamMatchText,
    targets: &[(u32, u32)],
    final_season_season: Option<u32>,
) -> bool {
    for text in [
        texts.filename.as_deref(),
        texts.title.as_deref(),
        texts.name.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        // No season/episode markers at all: no target can claim this text.
        let Some(profile) = episode_claim_profile(text) else {
            continue;
        };
        let mut claimed = false;
        for &(season, episode) in targets {
            if numeric_episode_claim_matches(
                &profile,
                text,
                season,
                episode,
                final_season_season == Some(season),
            ) {
                return false;
            }
            claimed = true;
        }
        if claimed {
            return true;
        }
    }
    false
}
