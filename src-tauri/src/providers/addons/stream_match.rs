use super::AddonStream;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::sync::LazyLock;

// Release-tag flag vocabulary — every regex over the lowered stream fields lives in this module.
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
static STREAM_CAPTURE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i)\b(?:cam|camrip|hdcam|hd-cam|telesync|hdts|hd-ts|telecine|hdtc|screener|dvdscr)\b",
        r"|(?:^|[. _\-\[\]()])(?:ts|tc|r5)\b",
    ))
    .expect("valid stream capture regex")
});
// `hdr\d*` rejects "HDRip" (capture format, not HDR) — `contains("hdr")` misclassifies it.
static STREAM_HDR_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bhdr\d*\b").expect("valid stream hdr regex"));
// `\b4k\b` rejects "4Kids" dubs that `contains("4k")` misclassified as P2160.
static STREAM_4K_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b4k\b").expect("valid stream 4k regex"));
// Strip `[57].1<size>` spans before probing — size text isn't a channel layout.
static STREAM_SURROUND_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b[57]\.1\b").expect("valid stream surround regex"));
static STREAM_SURROUND_SIZE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)[57]\.1\s*(?:k|m|g|t)i?b\b").expect("valid stream surround size regex")
});

/// Detects season packs/batches/multi-episode collections — intentionally
/// conservative against single-episode false positives.
pub(super) static BATCH_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i)(?:",
        // Batch/pack keywords; separators accept dots/underscores ("Show.Complete.Series").
        r"\bbatch\b",
        r"|\bcomplete[\s._-]+(?:series|season|pack|collection)\b",
        r"|\bseason[\s._-]*pack\b",
        r"|\bfull[\s._-]+(?:season|series)\b",
        // Season ranges: S01-S23, S01~S05
        r"|\bs\d{1,2}[\s._]*[-~][\s._]*s\d{1,2}\b",
        // Episode ranges require BOTH E/EP markers ("S15E52 - 1080p" must not match)
        r"|\b(?:e|ep)\d{1,4}[\s._]*[-~][\s._]*(?:e|ep)\d{1,4}\b",
        // Keyword ranges: "Season 1-23", "Episode.1-24"
        r"|\bseason[\s._]*\d+[\s._]*[-~&][\s._]*(?:season[\s._]*)?\d+\b",
        r"|\bepisode[\s._]*\d+[\s._]*[-~][\s._]*(?:episode[\s._]*)?\d+\b",
        r")"
    ))
    .expect("valid batch regex")
});

// Also covers dashless scene multi-episode files (`S01E05E06`).
static SEASON_EPISODE_RANGE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bs0*(\d{1,2})e0*(\d{1,4})(?:\s*[-~]\s*e?|e)0*(\d{1,4})\b")
        .expect("valid season episode range regex")
});
static X_SEASON_EPISODE_RANGE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b0*(\d{1,2})x0*(\d{1,4})\s*[-~]\s*(?:0*(\d{1,2})x)?0*(\d{1,4})\b")
        .expect("valid x season episode range regex")
});
static BARE_EPISODE_RANGE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r" - (\d{1,4})\s*[-~]\s*(\d{1,4})\b").expect("valid bare episode range regex")
});
static BARE_EPISODE_METADATA_SUFFIX_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:p\b|(?:[.,]\d+)?\s*[KMGT]i?B\b)")
        .expect("valid bare episode metadata suffix regex")
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
// Bare `S01` without an `E` segment — pack naming ("Show.S01.COMPLETE"); the
// trailing `\b` keeps `S01E05`/`S0105` from capturing a bare season.
static BARE_SEASON_TOKEN_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bs0*(\d{1,2})\b").expect("valid bare season token regex"));
static SEASON_EPISODE_TOKEN_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bs0*(\d{1,2})e(\d{1,4})\b").expect("valid season episode token regex")
});
static X_EPISODE_TOKEN_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b0*(\d{1,2})x(\d{1,4})\b").expect("valid x episode token regex")
});
// Loose episode forms ("episode 5", "ep_5", "ep5") — the captured number is
// compared, so `ep5` never matches inside `ep52`.
static LOOSE_EPISODE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:episode|ep)[\s._-]*0*(\d{1,4})\b").expect("valid loose episode regex")
});
// Bare `E05` split from its season ("Show.S01.E05"); gated on a season marker
// so stray `e5`-shaped tokens can't match with no season declared.
static BARE_E_EPISODE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\be[\s._-]*0*(\d{1,4})\b").expect("valid bare-e episode regex")
});
// Pack words count only alongside a season marker: bare `complete`/`pack`
// appear in movie titles ("Complete Unknown"), "S01 Complete" is a pack.
static PACK_KEYWORD_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:batch|complete|collection|pack)\b").expect("valid pack keyword regex")
});
static SEASON_MARKER_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bseason[\s._]*0*\d{1,2}\b|\bs0*\d{1,2}\b|\b0*\d{1,2}x\d{1,4}\b")
        .expect("valid season marker regex")
});
// Named season claims release groups use instead of numbers: ordinals resolve
// to their number; a numberless "final season" claim needs the caller's
// final-season fact — it must not cross-bind to every season.
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum StreamEpisodeMatchKind {
    None,
    SeasonPack,
    EpisodeRange,
    Exact,
}

/// Title-overlap tier derived from the coordinator's relevance score:
/// `Close` is a full reference-token overlap, `Partial` a strong one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StreamTitleMatch {
    Partial,
    Close,
}

/// Structured match facts for the selector UI. The coordinator owns the
/// tiers; the frontend renders them as badges without parsing reason text.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StreamMatchSummary {
    #[serde(skip_serializing)]
    pub episode: Option<StreamEpisodeMatchKind>,
    #[serde(skip_serializing)]
    pub title: Option<StreamTitleMatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pack_coverage: Option<StreamPackCoverage>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StreamPackCoverage {
    pub seasons: Vec<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub episode_ranges: Option<Vec<StreamPackEpisodeRange>>,
}

impl StreamPackCoverage {
    pub(crate) fn covers(&self, season: Option<u32>, episode: Option<u32>) -> bool {
        (self.seasons.is_empty() || season.is_some_and(|season| self.seasons.contains(&season)))
            && self.episode_ranges.as_ref().is_none_or(|ranges| {
                ranges.iter().any(|range| {
                    (range.season.is_none() || range.season == season)
                        && episode
                            .is_some_and(|episode| episode >= range.start && episode <= range.end)
                })
            })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct StreamPackEpisodeRange {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub season: Option<u32>,
    pub start: u32,
    pub end: u32,
}

fn range_contains(requested: u32, start: u32, end: u32) -> bool {
    let lower = start.min(end);
    let upper = start.max(end);
    requested >= lower && requested <= upper
}

fn parse_captured_u32(captures: &regex::Captures<'_>, index: usize) -> Option<u32> {
    captures.get(index)?.as_str().parse::<u32>().ok()
}

fn bare_episode_suffix_is_metadata(suffix: &str) -> bool {
    BARE_EPISODE_METADATA_SUFFIX_REGEX.is_match(suffix)
}

fn bare_episode_ranges(text: &str) -> impl Iterator<Item = regex::Captures<'_>> {
    BARE_EPISODE_RANGE_REGEX
        .captures_iter(text)
        .filter(|captures| {
            let start = parse_captured_u32(captures, 1).unwrap_or_default();
            let end = parse_captured_u32(captures, 2).unwrap_or_default();
            let suffix = &text[captures.get(0).expect("range match").end()..];
            // Year spans and decimal/unit-bearing size spans are not episode claims.
            !((1900..=2099).contains(&start) && (1900..=2099).contains(&end))
                && !bare_episode_suffix_is_metadata(suffix)
        })
}

fn has_episode_range(text: &str) -> bool {
    episode_range_claims(text).next().is_some()
}

fn ordinal_season_word_number(word: &str) -> Option<u32> {
    const ORDINALS: [&str; 9] = [
        "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth",
    ];
    ORDINALS
        .iter()
        .position(|ordinal| ordinal.eq_ignore_ascii_case(word))
        .map(|index| index as u32 + 1)
}

fn explicit_season_ranges(text: &str) -> impl Iterator<Item = (u32, u32)> + '_ {
    let ranges = SEASON_RANGE_REGEX
        .captures_iter(text)
        .filter_map(|captures| {
            Some((
                parse_captured_u32(&captures, 1)?,
                parse_captured_u32(&captures, 2)?,
            ))
        });
    let x_ranges = X_SEASON_EPISODE_RANGE_REGEX
        .captures_iter(text)
        .filter(|captures| {
            !bare_episode_suffix_is_metadata(&text[captures.get(0).expect("range match").end()..])
        })
        .filter_map(|captures| {
            let start = parse_captured_u32(&captures, 1)?;
            let end = captures
                .get(3)
                .map_or(Some(start), |capture| capture.as_str().parse::<u32>().ok())?;
            Some((start, end))
        });
    let singles = [
        &*SEASON_EPISODE_RANGE_REGEX,
        &*SEASON_EPISODE_TOKEN_REGEX,
        &*X_EPISODE_TOKEN_REGEX,
        &*SEASON_TOKEN_REGEX,
        &*BARE_SEASON_TOKEN_REGEX,
        &*ORDINAL_SEASON_DIGIT_REGEX,
    ]
    .into_iter()
    .flat_map(move |regex| regex.captures_iter(text))
    .filter_map(|captures| parse_captured_u32(&captures, 1).map(|season| (season, season)));
    let ordinals = ORDINAL_SEASON_WORD_REGEX
        .captures_iter(text)
        .filter_map(|captures| {
            captures
                .get(1)
                .map(|capture| capture.as_str())
                .and_then(ordinal_season_word_number)
                .map(|season| (season, season))
        });
    ranges.chain(x_ranges).chain(singles).chain(ordinals)
}

/// `None` = no season claim; `Some(false)` = a different season claimed.
/// A numberless "final season" claim needs the caller's final-season fact.
pub(super) fn text_matches_requested_season(
    text: &str,
    requested_season: u32,
    final_season: bool,
) -> Option<bool> {
    let mut saw_explicit_season = false;
    for (start, end) in explicit_season_ranges(text) {
        saw_explicit_season = true;
        if range_contains(requested_season, start, end) {
            return Some(true);
        }
    }

    if FINAL_SEASON_MARKER_REGEX.is_match(text) {
        return Some(final_season);
    }

    saw_explicit_season.then_some(false)
}

/// Blanks every episode-range claim so only standalone episode tokens remain.
fn strip_episode_ranges(text: &str) -> Cow<'_, str> {
    let mut stripped = Cow::Borrowed(text);
    for regex in [
        &*SEASON_EPISODE_RANGE_REGEX,
        &*X_SEASON_EPISODE_RANGE_REGEX,
        &*EPISODE_RANGE_REGEX,
    ] {
        if let Cow::Owned(replaced) =
            regex.replace_all(&stripped, |captures: &regex::Captures<'_>| {
                let matched = captures.get(0).expect("range match");
                if bare_episode_suffix_is_metadata(&stripped[matched.end()..]) {
                    &stripped[matched.start()..matched.end()]
                } else {
                    " "
                }
            })
        {
            stripped = Cow::Owned(replaced);
        }
    }
    let mut bare_stripped = None;
    let mut last_end = 0;
    for captures in bare_episode_ranges(&stripped) {
        let matched = captures.get(0).expect("range match");
        let result = bare_stripped.get_or_insert_with(|| String::with_capacity(stripped.len()));
        result.push_str(&stripped[last_end..matched.start()]);
        result.push(' ');
        last_end = matched.end();
    }
    if let Some(mut result) = bare_stripped {
        result.push_str(&stripped[last_end..]);
        Cow::Owned(result)
    } else {
        stripped
    }
}

fn episode_range_claims(text: &str) -> impl Iterator<Item = (Option<(u32, u32)>, u32, u32)> + '_ {
    let seasons = SEASON_EPISODE_RANGE_REGEX
        .captures_iter(text)
        .filter(|captures| {
            !bare_episode_suffix_is_metadata(&text[captures.get(0).expect("range match").end()..])
        })
        .filter_map(|captures| {
            let season = parse_captured_u32(&captures, 1)?;
            Some((
                Some((season, season)),
                parse_captured_u32(&captures, 2)?,
                parse_captured_u32(&captures, 3)?,
            ))
        });
    let x_seasons = X_SEASON_EPISODE_RANGE_REGEX
        .captures_iter(text)
        .filter(|captures| {
            !bare_episode_suffix_is_metadata(&text[captures.get(0).expect("range match").end()..])
        })
        .filter_map(|captures| {
            let start = parse_captured_u32(&captures, 1)?;
            let end = captures
                .get(3)
                .map_or(Some(start), |capture| capture.as_str().parse::<u32>().ok())?;
            Some((
                Some((start, end)),
                parse_captured_u32(&captures, 2)?,
                parse_captured_u32(&captures, 4)?,
            ))
        });
    let loose = EPISODE_RANGE_REGEX
        .captures_iter(text)
        .filter(|captures| {
            !bare_episode_suffix_is_metadata(&text[captures.get(0).expect("range match").end()..])
        })
        .chain(bare_episode_ranges(text))
        .filter_map(|captures| {
            Some((
                None,
                parse_captured_u32(&captures, 1)?,
                parse_captured_u32(&captures, 2)?,
            ))
        });
    seasons.chain(x_seasons).chain(loose)
}

/// `season_context` is the caller's `text_matches_requested_season` result.
fn episode_range_contains_text(
    text: &str,
    season: u32,
    episode: u32,
    season_context: Option<bool>,
) -> bool {
    episode_range_claims(text).any(|(seasons, start, end)| {
        if let Some((start_season, end_season)) = seasons {
            let start = (start_season, start);
            let end = (end_season, end);
            (start.min(end)..=start.max(end)).contains(&(season, episode))
        } else {
            season_context != Some(false) && range_contains(episode, start, end)
        }
    })
}

/// `contains` plus digit boundaries: a trailing digit means a larger episode
/// (`s1e1` in `s1e10`); only `NxNN` probes need the leading check (`1x01` in `11x01`).
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

fn absolute_episode_claims(text: &str) -> impl Iterator<Item = u32> + '_ {
    [('-', true), ('#', false)]
        .into_iter()
        .flat_map(move |(marker, padded)| {
            text.match_indices(marker).filter_map(move |(start, _)| {
                let offset = if padded {
                    if start == 0
                        || text.as_bytes()[start - 1] != b' '
                        || text.as_bytes().get(start + 1) != Some(&b' ')
                    {
                        return None;
                    }
                    2
                } else {
                    1
                };
                let number = &text[start + offset..];
                let digits = number.bytes().take_while(u8::is_ascii_digit).count();
                let episode = number[..digits].parse::<u32>().ok()?;
                if !padded {
                    return (digits == 1 || !number.starts_with('0')).then_some(episode);
                }
                if !(digits == 3
                    || (digits == 2 && episode < 100)
                    || (episode >= 1000 && !number.starts_with('0')))
                {
                    return None;
                }
                let suffix = &number[digits..];
                let trimmed = suffix.trim_start();
                let range_end = trimmed
                    .strip_prefix('-')
                    .or_else(|| trimmed.strip_prefix('~'));
                let is_range_start = range_end.is_some_and(|end| {
                    let end = end.trim_start();
                    let digits = end.bytes().take_while(u8::is_ascii_digit).count();
                    let rest = &end.as_bytes()[digits..];
                    let is_resolution = rest.first() == Some(&b'p')
                        && !rest.get(1).is_some_and(u8::is_ascii_alphanumeric);
                    digits > 0 && !is_resolution
                });
                (!bare_episode_suffix_is_metadata(suffix) && !is_range_start).then_some(episode)
            })
        })
}

/// True when lowered stream text names the requested episode (handles ep 1000+
/// forms). `season_context` is the caller's `text_matches_requested_season` result.
pub(super) fn episode_matches_lowered(
    t: &str,
    season: u32,
    episode: u32,
    season_context: Option<bool>,
) -> bool {
    episode_matches_lowered_with_scratch(t, season, episode, season_context, &mut String::new())
}

fn episode_matches_lowered_with_scratch(
    t: &str,
    season: u32,
    episode: u32,
    season_context: Option<bool>,
    buf: &mut String,
) -> bool {
    use std::fmt::Write;

    buf.clear();
    buf.reserve(20);
    let variants = if season < 10 && episode < 10 {
        4
    } else if season < 10 || episode < 10 {
        2
    } else {
        1
    };
    for &(season_width, episode_width) in &[(2, 2), (0, 0), (0, 2), (2, 0)][..variants] {
        buf.clear();
        let _ = write!(buf, "s{season:0season_width$}e{episode:0episode_width$}");
        if contains_episode_token(t, buf.as_str(), false) {
            return true;
        }
    }
    for &width in if episode < 10 { &[2, 0][..] } else { &[2][..] } {
        buf.clear();
        let _ = write!(buf, "{season}x{episode:0width$}");
        if contains_episode_token(t, buf.as_str(), true) {
            return true;
        }
    }

    for regex in [&*SEASON_EPISODE_TOKEN_REGEX, &*X_EPISODE_TOKEN_REGEX] {
        if regex.captures_iter(t).any(|captures| {
            parse_captured_u32(&captures, 1) == Some(season)
                && parse_captured_u32(&captures, 2) == Some(episode)
        }) {
            return true;
        }
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

    absolute_episode_claims(t).any(|candidate| candidate == episode)
}

/// `_` defeats `\b` (it's a word char) but groups use it as a separator —
/// map to a space once so every probe sees the same token boundaries.
pub(crate) fn normalize_separators(text: &str) -> std::borrow::Cow<'_, str> {
    if text.contains('_') {
        std::borrow::Cow::Owned(text.replace('_', " "))
    } else {
        std::borrow::Cow::Borrowed(text)
    }
}

/// Batch text = strict batch regex, or a pack keyword beside a season marker
/// ("Show S01 Complete") — the keyword alone appears in movie titles too.
fn is_batch_text(text: &str, has_episode_range: bool) -> bool {
    BATCH_REGEX.is_match(text)
        || has_episode_range
        || (PACK_KEYWORD_REGEX.is_match(text) && SEASON_MARKER_REGEX.is_match(text))
}

/// Batch check over the per-field memo filled in `lower` — no regex re-run.
pub(crate) fn stream_contains_batch_texts(texts: &StreamMatchText) -> bool {
    texts.batch.name || texts.batch.title || texts.batch.filename
}

/// Resolution tier shared by quality score and presentation badge — one classifier.
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

/// Release-type tier for the quality score; first matching kind wins.
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
/// haystack — raw probes; precedence lives in the consumers' else-if chains.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct StreamFlags {
    explicit_groups: u8,
    // Audio-language markers: ranking bonus, language score, DUAL/MULTI badge.
    pub dual_audio: bool,
    pub multi_audio: bool,
    pub multi_sub: bool,
    /// An explicit English+Japanese pair is dual-audio evidence.
    pub english_japanese_pair: bool,
    /// Resolution tier for the badge label, quality points, and oversize class.
    pub resolution: StreamResolutionTier,
    /// Release-type tier scored by the composite quality score.
    pub release: StreamReleaseKind,
    pub capture_release: bool,
    pub dolby_vision: bool,
    pub hdr10_plus: bool,
    pub hdr10: bool,
    pub hdr: bool,
    /// TrueHD folds into Atmos for both badge and score.
    pub atmos: bool,
    /// `dts-hd`/`dts-x`/`dtsx`; `dts` stays raw — consumers gate it on `!dts_hd`.
    pub dts_hd: bool,
    pub dts: bool,
    /// eac3/dd+/ddp — plain `dd5.1` is AC3 and counts as surround only.
    pub eac3: bool,
    pub aac: bool,
    /// 5.1/7.1 surround — quality-score signal only today.
    pub surround: bool,
    /// x265/hevc/h265/h.265 spellings.
    pub hevc: bool,
    pub av1: bool,
}

impl StreamFlags {
    const RESOLUTION: u8 = 1;
    const RELEASE: u8 = 2;
    const HDR: u8 = 4;
    const AUDIO: u8 = 8;
    const CHANNELS: u8 = 16;
    const CODEC: u8 = 32;

    fn with_filename_fallback(mut self, fallback: Self) -> Self {
        macro_rules! fill {
            ($group:ident, $($field:ident),+) => {
                if self.explicit_groups & Self::$group == 0 {
                    $(self.$field = fallback.$field;)+
                }
            };
        }
        fill!(RESOLUTION, resolution);
        fill!(RELEASE, release, capture_release);
        fill!(HDR, dolby_vision, hdr10_plus, hdr10, hdr);
        fill!(AUDIO, atmos, dts_hd, dts, eac3, aac);
        fill!(CHANNELS, surround);
        fill!(CODEC, hevc, av1);
        self
    }
}

pub(crate) fn language_mention_is_audio(suffix: &str) -> bool {
    let next = suffix
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .find(|token| !token.is_empty());
    !next.is_some_and(|token| {
        ["sub", "subs", "subbed", "subtitle", "subtitles"]
            .iter()
            .any(|label| token.eq_ignore_ascii_case(label))
    })
}

/// One probe pass over the lowered haystack — expects `StreamMatchText` field
/// text (already lowered and separator-normalized).
pub(crate) fn detect_stream_flags(haystack: &str) -> StreamFlags {
    let release = if haystack.contains("remux") {
        // `bdremux` is covered via the `remux` substring.
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

    let mut flags = StreamFlags {
        explicit_groups: 0,
        dual_audio: STREAM_DUAL_AUDIO_REGEX.is_match(haystack)
            || haystack.contains("dub + sub")
            || haystack.contains("sub + dub")
            || (haystack.contains("dubbed") && haystack.contains("sub")),
        multi_audio: STREAM_MULTI_AUDIO_REGEX.is_match(haystack)
            || STREAM_MULTI_LANG_REGEX.is_match(haystack),
        multi_sub: STREAM_MULTI_SUB_REGEX.is_match(haystack),
        english_japanese_pair: STREAM_ENGLISH_REGEX
            .find_iter(haystack)
            .any(|matched| language_mention_is_audio(&haystack[matched.end()..]))
            && STREAM_JAPANESE_REGEX
                .find_iter(haystack)
                .any(|matched| language_mention_is_audio(&haystack[matched.end()..])),
        resolution: stream_resolution_tier(haystack),
        release,
        capture_release: STREAM_CAPTURE_REGEX.find_iter(haystack).any(|matched| {
            let tag = matched
                .as_str()
                .trim_start_matches(['.', ' ', '-', '_', '[', ']', '(', ')']);
            if !["ts", "tc", "r5"]
                .iter()
                .any(|marker| tag.eq_ignore_ascii_case(marker))
            {
                return true;
            }
            let suffix = &haystack[matched.end()..];
            if !suffix.is_empty() && !suffix.starts_with(['.', ' ', '-', '_', '[', ']', '(', ')']) {
                return false;
            }
            if !tag.eq_ignore_ascii_case("ts") {
                return true;
            }
            let prefix = &haystack[..matched.end() - tag.len()];
            if !prefix.ends_with('.') || !(suffix.is_empty() || suffix.starts_with(' ')) {
                return true;
            }
            // A terminal `.ts` is an extension unless it directly follows a resolution tag.
            !prefix
                .split_whitespace()
                .next_back()
                .is_some_and(|token| token.contains(['/', '\\']))
                && prefix[..prefix.len() - 1]
                    .rsplit(['.', ' ', '-', '_', '[', ']', '(', ')'])
                    .next()
                    .is_some_and(|token| stream_resolution_tier(token) != StreamResolutionTier::Sd)
        }),
        dolby_vision: haystack.contains("dolby vision")
            || haystack.contains("dovi")
            || STREAM_DV_REGEX.is_match(haystack),
        hdr10_plus: haystack.contains("hdr10+"),
        hdr10: false,
        hdr: false,
        atmos: haystack.contains("atmos") || haystack.contains("truehd"),
        dts_hd: haystack.contains("dts-hd")
            || haystack.contains("dts-x")
            || haystack.contains("dtsx"),
        dts: haystack.contains("dts"),
        eac3: haystack.contains("eac3") || haystack.contains("dd+") || haystack.contains("ddp"),
        aac: haystack.contains("aac"),
        surround: haystack.contains("dd5.1")
            || STREAM_SURROUND_REGEX
                .is_match(&STREAM_SURROUND_SIZE_REGEX.replace_all(haystack, " ")),
        hevc: haystack.contains("x265")
            || haystack.contains("hevc")
            || haystack.contains("h265")
            || haystack.contains("h.265"),
        av1: STREAM_AV1_REGEX.is_match(haystack),
    };
    for tag in STREAM_HDR_REGEX.find_iter(haystack) {
        flags.hdr = true;
        flags.hdr10 |= tag.as_str().eq_ignore_ascii_case("hdr10");
    }
    for (present, group) in [
        (
            flags.resolution != StreamResolutionTier::Sd,
            StreamFlags::RESOLUTION,
        ),
        (
            flags.release != StreamReleaseKind::Other || flags.capture_release,
            StreamFlags::RELEASE,
        ),
        (
            flags.dolby_vision || flags.hdr10_plus || flags.hdr,
            StreamFlags::HDR,
        ),
        (
            flags.atmos || flags.dts_hd || flags.dts || flags.eac3 || flags.aac,
            StreamFlags::AUDIO,
        ),
        (flags.surround, StreamFlags::CHANNELS),
        (
            flags.hevc || flags.av1 || haystack.contains("h.264"),
            StreamFlags::CODEC,
        ),
    ] {
        if present {
            flags.explicit_groups |= group;
        }
    }
    for token in haystack.split(|ch: char| !ch.is_ascii_alphanumeric()) {
        flags.explicit_groups |= match token {
            "sd" | "240p" | "360p" | "576p" => StreamFlags::RESOLUTION,
            "sdr" => StreamFlags::HDR,
            "ac3" | "dd5" | "mp3" | "flac" | "opus" | "pcm" => StreamFlags::AUDIO,
            "stereo" | "mono" => StreamFlags::CHANNELS,
            "h264" | "x264" | "avc" | "mpeg2" | "xvid" | "divx" | "vp9" => StreamFlags::CODEC,
            _ => 0,
        };
    }
    flags
}

/// Lowered, separator-normalized copies of the three matchable stream fields —
/// one build serves every probe (`contains`/`(?i)` behave identically on lowered text).
#[derive(Debug, Clone)]
pub(crate) struct StreamMatchText {
    pub(crate) name: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) filename: Option<String>,
    /// Joined once so probes never re-allocate the haystack per pass.
    name_title: String,
    /// Per-field batch memo filled in `lower` — SeasonPack re-asks per coordinate without re-running regexes.
    batch: BatchTextFlags,
    episode_range: BatchTextFlags,
    claims: [Option<EpisodeClaimProfile>; 3],
    pub(crate) pack_coverage: Option<StreamPackCoverage>,
    /// Display-field flags with filename-only technical evidence as a fallback.
    pub(crate) flags: StreamFlags,
}

/// Batch-text memo for `StreamMatchText`'s three fields — see `is_batch_text`.
#[derive(Debug, Clone, Copy, Default)]
struct BatchTextFlags {
    name: bool,
    title: bool,
    filename: bool,
}

impl StreamMatchText {
    /// See `normalize_separators` for why `_` becomes a space.
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
        let episode_range = BatchTextFlags {
            name: name.as_deref().is_some_and(has_episode_range),
            title: title.as_deref().is_some_and(has_episode_range),
            filename: filename.as_deref().is_some_and(has_episode_range),
        };
        let batch = BatchTextFlags {
            name: name
                .as_deref()
                .is_some_and(|text| is_batch_text(text, episode_range.name)),
            title: title
                .as_deref()
                .is_some_and(|text| is_batch_text(text, episode_range.title)),
            filename: filename
                .as_deref()
                .is_some_and(|text| is_batch_text(text, episode_range.filename)),
        };
        let mut flags = detect_stream_flags(&name_title);
        let fallback_groups = StreamFlags::RESOLUTION
            | StreamFlags::RELEASE
            | StreamFlags::HDR
            | StreamFlags::AUDIO
            | StreamFlags::CHANNELS
            | StreamFlags::CODEC;
        if let Some(filename) = filename
            .as_deref()
            .filter(|_| flags.explicit_groups & fallback_groups != fallback_groups)
        {
            flags = flags.with_filename_fallback(detect_stream_flags(
                filename.strip_suffix(".ts").unwrap_or(filename),
            ));
        }
        let claims = [
            (filename.as_deref(), episode_range.filename),
            (title.as_deref(), episode_range.title),
            (name.as_deref(), episode_range.name),
        ]
        .map(|(text, has_range)| text.and_then(|text| episode_claim_profile(text, has_range)));
        let mut texts = Self {
            name,
            title,
            filename,
            name_title,
            batch,
            episode_range,
            claims,
            pack_coverage: None,
            flags,
        };
        if stream_contains_batch_texts(&texts) {
            texts.pack_coverage = texts.build_pack_coverage();
        }
        texts
    }

    fn build_pack_coverage(&self) -> Option<StreamPackCoverage> {
        let fields = [
            (
                self.filename.as_deref(),
                self.batch.filename,
                self.episode_range.filename,
            ),
            (
                self.title.as_deref(),
                self.batch.title,
                self.episode_range.title,
            ),
            (
                self.name.as_deref(),
                self.batch.name,
                self.episode_range.name,
            ),
        ];
        // A pack's per-episode filename must not narrow its season-wide title.
        let (text, _, has_range) = fields
            .iter()
            .copied()
            .find(|(text, batch, range)| {
                *batch
                    && text
                        .is_some_and(|text| *range || explicit_season_ranges(text).next().is_some())
            })
            .or_else(|| {
                fields.into_iter().find(|(text, _, _)| {
                    text.is_some_and(|text| explicit_season_ranges(text).next().is_some())
                })
            })?;
        let text = text?;
        let mut seasons = Vec::new();
        let season_text = if explicit_season_ranges(text).next().is_some() {
            text
        } else {
            fields
                .into_iter()
                .filter_map(|(text, _, _)| text)
                .find(|text| explicit_season_ranges(text).next().is_some())
                .unwrap_or(text)
        };
        for (start, end) in explicit_season_ranges(season_text) {
            seasons.extend(start.min(end)..=start.max(end));
        }
        seasons.sort_unstable();
        seasons.dedup();
        let mut episode_ranges = Vec::new();
        if has_range {
            for (claim_seasons, start, end) in episode_range_claims(text) {
                if let Some((start_season, end_season)) = claim_seasons {
                    let first = (start_season, start).min((end_season, end));
                    let last = (start_season, start).max((end_season, end));
                    for season in first.0..=last.0 {
                        episode_ranges.push(StreamPackEpisodeRange {
                            season: Some(season),
                            start: if season == first.0 { first.1 } else { 0 },
                            end: if season == last.0 { last.1 } else { u32::MAX },
                        });
                    }
                } else {
                    episode_ranges.push(StreamPackEpisodeRange {
                        season: None,
                        start: start.min(end),
                        end: start.max(end),
                    });
                }
            }
            let standalone = strip_episode_ranges(text);
            for regex in [&*SEASON_EPISODE_TOKEN_REGEX, &*X_EPISODE_TOKEN_REGEX] {
                for captures in regex.captures_iter(&standalone) {
                    if let (Some(season), Some(episode)) = (
                        parse_captured_u32(&captures, 1),
                        parse_captured_u32(&captures, 2),
                    ) {
                        episode_ranges.push(StreamPackEpisodeRange {
                            season: Some(season),
                            start: episode,
                            end: episode,
                        });
                    }
                }
            }
            for (regex, enabled) in [
                (&*LOOSE_EPISODE_REGEX, true),
                (&*BARE_E_EPISODE_REGEX, !seasons.is_empty()),
            ] {
                if !enabled {
                    continue;
                }
                for captures in regex.captures_iter(&standalone) {
                    if let Some(episode) = parse_captured_u32(&captures, 1) {
                        episode_ranges.push(StreamPackEpisodeRange {
                            season: None,
                            start: episode,
                            end: episode,
                        });
                    }
                }
            }
            episode_ranges.extend(absolute_episode_claims(&standalone).map(|episode| {
                StreamPackEpisodeRange {
                    season: None,
                    start: episode,
                    end: episode,
                }
            }));
        }
        (!seasons.is_empty() || !episode_ranges.is_empty()).then_some(StreamPackCoverage {
            seasons,
            episode_ranges: (!episode_ranges.is_empty()).then_some(episode_ranges),
        })
    }

    /// The joined `name + " " + title` haystack, already lowered and normalized.
    pub(crate) fn name_title_haystack(&self) -> &str {
        &self.name_title
    }

    /// (field text, season context, batch-without-range memo) per field — the season regexes
    /// run once per field, not per probe. Absent fields stay `None`.
    pub(super) fn fields_with_season_context(
        &self,
        season: u32,
        final_season: bool,
    ) -> [Option<(&String, Option<bool>, bool)>; 3] {
        [
            (
                self.name.as_ref(),
                self.batch.name && !self.episode_range.name,
            ),
            (
                self.title.as_ref(),
                self.batch.title && !self.episode_range.title,
            ),
            (
                self.filename.as_ref(),
                self.batch.filename && !self.episode_range.filename,
            ),
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

/// Episode-match tier plus whether it rested on an explicit season claim —
/// same-tier ties favor the named season ("S01E04") over an assumed
/// absolute-number match ("… - 04").
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
    // Same conflict rule as `stream_conflicts_with_episode_targets`, reusing the season context.
    let claimed = texts
        .claims
        .iter()
        .zip(fields.iter().rev())
        .find_map(|(profile, field)| Some((profile.as_ref()?, (*field)?)));
    if claimed.is_some_and(|(profile, (text, season_context, _))| {
        !numeric_episode_claim_matches(profile, text, season, episode, season_context)
    }) {
        return StreamEpisodeMatch {
            kind: StreamEpisodeMatchKind::None,
            season_claim_verified: false,
        };
    }

    // Keep scanning matching fields until one carries a verified season claim.
    let mut matched_exact = false;
    let mut episode_token = String::new();
    let has_ranges = [
        texts.episode_range.name,
        texts.episode_range.title,
        texts.episode_range.filename,
    ];
    for (field, has_range) in fields.iter().zip(has_ranges) {
        let Some((text, season_context, _)) = field else {
            continue;
        };
        // Probe raw text first: stripping can join loose tokens ("ep S01E01-E02 5").
        if !episode_matches_lowered_with_scratch(
            text,
            season,
            episode,
            *season_context,
            &mut episode_token,
        ) {
            continue;
        }
        let standalone = if has_range {
            strip_episode_ranges(text)
        } else {
            Cow::Borrowed(text.as_str())
        };
        if matches!(standalone, Cow::Borrowed(_))
            || episode_matches_lowered_with_scratch(
                &standalone,
                season,
                episode,
                *season_context,
                &mut episode_token,
            )
        {
            if matches!(*season_context, Some(true)) {
                return StreamEpisodeMatch {
                    kind: StreamEpisodeMatchKind::Exact,
                    season_claim_verified: true,
                };
            }
            matched_exact = true;
        }
    }
    if matched_exact {
        return StreamEpisodeMatch {
            kind: StreamEpisodeMatchKind::Exact,
            season_claim_verified: false,
        };
    }

    let mut matched_range = false;
    let mut range_claim_verified = false;
    for (field, has_range) in fields.iter().zip(has_ranges) {
        let Some((text, season_context, _)) = field.filter(|_| has_range) else {
            continue;
        };
        if episode_range_contains_text(text, season, episode, season_context) {
            matched_range = true;
            range_claim_verified |= matches!(season_context, Some(true));
        }
    }
    if matched_range {
        return StreamEpisodeMatch {
            kind: StreamEpisodeMatchKind::EpisodeRange,
            season_claim_verified: range_claim_verified,
        };
    }

    // SeasonPack = a batch field whose own season marker matches the target
    // ("S03 Complete" for S03E07), or a season-less batch field when no field
    // declares a different season.
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

/// Text-invariant claim probes — computed once per text, not per (text, target).
#[derive(Debug, Clone, Copy)]
struct EpisodeClaimProfile {
    has_season: bool,
    has_episode: bool,
    has_range: bool,
}

fn episode_claim_profile(text: &str, has_range: bool) -> Option<EpisodeClaimProfile> {
    // A range claims both season and episode; dashless `S01E05E06` trips no `\b` token below.
    let has_season_episode_range =
        has_range && episode_range_claims(text).any(|(seasons, _, _)| seasons.is_some());
    let has_season = has_season_episode_range
        || [
            &*SEASON_RANGE_REGEX,
            &*SEASON_EPISODE_TOKEN_REGEX,
            &*X_EPISODE_TOKEN_REGEX,
            &*SEASON_TOKEN_REGEX,
            &*BARE_SEASON_TOKEN_REGEX,
            &*ORDINAL_SEASON_DIGIT_REGEX,
            &*ORDINAL_SEASON_WORD_REGEX,
        ]
        .iter()
        .any(|regex| regex.is_match(text));
    let has_episode = has_range
        || [
            &*SEASON_EPISODE_TOKEN_REGEX,
            &*X_EPISODE_TOKEN_REGEX,
            &*LOOSE_EPISODE_REGEX,
        ]
        .iter()
        .any(|regex| regex.is_match(text))
        || (has_season && BARE_E_EPISODE_REGEX.is_match(text))
        || absolute_episode_claims(text).next().is_some();
    if !has_season && !has_episode {
        return None;
    }
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
    season_context: Option<bool>,
) -> bool {
    if profile.has_season && season_context == Some(false) {
        return false;
    }
    if profile.has_range {
        // A standalone token beside a range still claims its episode.
        return episode_range_contains_text(text, season, episode, season_context)
            || episode_matches_lowered(
                &strip_episode_ranges(text),
                season,
                episode,
                season_context,
            );
    }
    if profile.has_episode {
        episode_matches_lowered(text, season, episode, season_context)
    } else {
        season_context == Some(true)
    }
}

/// `final_season_season` scopes the caller's final-season fact to its target
/// season; other targets keep `false` so a numberless claim can't cross-bind.
pub(crate) fn stream_conflicts_with_episode_targets(
    texts: &StreamMatchText,
    targets: &[(u32, u32)],
    final_season_season: Option<u32>,
) -> bool {
    if targets.is_empty() {
        return false;
    }

    for (text, profile) in [
        texts.filename.as_deref(),
        texts.title.as_deref(),
        texts.name.as_deref(),
    ]
    .into_iter()
    .zip(&texts.claims)
    {
        // No season/episode markers at all: no target can claim this text.
        let (Some(text), Some(profile)) = (text, profile) else {
            continue;
        };
        return targets.iter().all(|&(season, episode)| {
            !numeric_episode_claim_matches(
                profile,
                text,
                season,
                episode,
                text_matches_requested_season(text, season, final_season_season == Some(season)),
            )
        });
    }
    false
}
