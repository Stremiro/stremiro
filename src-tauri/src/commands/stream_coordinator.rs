use super::language::{canonicalize_language_token, canonicalize_language_value};
use super::normalize_token_text;
use super::streaming_helpers::{
    normalize_source_id, normalize_source_key, stream_language_haystack,
    stream_resolution_priority, stream_source_priority,
};
use crate::providers::addons::{
    language_mention_is_audio, stream_episode_match_texts, AddonStream, SelectionPriority,
    StreamEpisodeMatch, StreamEpisodeMatchKind, StreamFlags, StreamMatchSummary,
    StreamRecommendationReason, StreamTitleMatch,
};
use std::collections::{HashMap, HashSet};

/// "No recorded outcome" health priority; shared by the fetcher cooldown gate and the resume donor scan.
pub(crate) const DEFAULT_SOURCE_HEALTH_PRIORITY: u8 = 2;
pub(crate) const DEFAULT_STREAM_FAMILY_PRIORITY: u8 = 2;
const TITLE_STOP_WORDS: &[&str] = &["a", "an", "and", "of", "on", "the", "to"];
const TITLE_NEUTRAL_EXTRA_TOKENS: &[&str] = &[
    "arc",
    // Language/edition tags that must never count as significant title extras.
    // `ray`/`blu`/`vision` stay here rather than in `TITLE_BOUNDARY_TOKENS`:
    // plausible title words that relieve the extra penalty without stopping tokenization.
    "audio",
    "batch",
    "blu",
    "chapter",
    "collection",
    "complete",
    "cour",
    "cut",
    "directors",
    "dub",
    "dubbed",
    "dual",
    "eng",
    "english",
    "extended",
    "final",
    "jap",
    "japanese",
    "lang",
    "multi",
    "pack",
    "part",
    "ray",
    "season",
    "sub",
    "subbed",
    "subtitle",
    "subtitles",
    "uncut",
    "vision",
    "volume",
    "vol",
];
const TITLE_SPINOFF_TOKENS: &[&str] = &[
    "anthology",
    "chibi",
    "junior",
    "musical",
    "ona",
    "ova",
    "parody",
    "picture",
    "recap",
    "short",
    "shorts",
    "special",
    "specials",
    "spinoff",
];
/// Release-tag tokens that stop title tokenization. Must cover every single-token
/// spelling the `StreamFlags` probes use — a missing one becomes a significant-extra
/// penalty. Pinned by `release_tag_spellings_never_count_as_title_extras`.
const TITLE_BOUNDARY_TOKENS: &[&str] = &[
    "10bit",
    "aac",
    "ac3",
    "amzn",
    "atmos",
    "av1",
    "avc",
    "bdremux",
    "bdrip",
    "bluray",
    "brrip",
    "cam",
    "camrip",
    "dd",
    "dd5",
    "ddp",
    "dl",
    "dolby",
    "dovi",
    "dsnp",
    "dts",
    "dtsx",
    "dv",
    "dvdrip",
    "dvdscr",
    "eac3",
    "dualaudio",
    "flac",
    "h264",
    "h265",
    "hd",
    "hdcam",
    "hdtc",
    "hdts",
    "hdtv",
    "hdr",
    "hdr10",
    "hevc",
    "hulu",
    "hybrid",
    "imax",
    "mkv",
    "mp3",
    "mp4",
    "multiaudio",
    "multilang",
    "multisub",
    "nf",
    "opus",
    "proper",
    "r5",
    "repack",
    "remux",
    "sdr",
    "screener",
    "telecine",
    "telesync",
    "truehd",
    "ts",
    "uhd",
    "webrip",
    "web",
    "webdl",
    "x264",
    "x265",
];

#[derive(Clone, Copy)]
pub(crate) struct StreamMatchContext<'a> {
    pub media_type: &'a str,
    pub title: Option<&'a str>,
    pub query_season: Option<u32>,
    pub query_episode: Option<u32>,
    pub canonical_season: Option<u32>,
    pub canonical_episode: Option<u32>,
    /// True when the requested season is the show's final season — lets the episode
    /// battery resolve numberless "final season" naming claims (`text_matches_requested_season`).
    pub is_final_season: bool,
}

#[derive(Clone, Copy)]
pub(crate) struct StreamRecommendationInputs<'a> {
    pub addon_source_priorities: &'a HashMap<String, u32>,
    pub source_health_priorities: &'a HashMap<String, u8>,
    pub stream_family_priorities: &'a HashMap<String, u8>,
    /// The preferred addon instance for this title scope — last source that succeeded recently, normalized.
    pub preferred_title_source_id: Option<&'a str>,
    pub match_context: StreamMatchContext<'a>,
    pub preferred_audio_language: Option<&'a str>,
    pub preferred_subtitle_language: Option<&'a str>,
}

/// Sort key computed once per stream so the comparator is a bare tuple compare.
/// Field order is rank order. Viability outranks reputation and preference:
/// a stream the player cannot load must never win.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct StreamRecommendationKey {
    pub episode_match: StreamEpisodeMatchKind,
    /// Same-tier split from `StreamEpisodeMatch`: an explicit season claim outranks
    /// an assumed one — a titled final-season release can't lose/win an Exact tie
    /// against a same-numbered file of the wrong season.
    pub season_claim_verified: bool,
    pub title_match: i8,
    pub viability: u8,
    pub language: u8,
    pub health: u8,
    pub family: u8,
    pub title_source_affinity: u8,
    pub quality: i32,
    pub language_bonus: u8,
    pub source_priority: u32,
    /// Oversize demotion before swarm stats so a bloated remux can't resurface on a tie; `Reverse` = descending sort.
    pub oversize: std::cmp::Reverse<bool>,
    pub seeders: u32,
    pub size_bytes: u64,
}

#[derive(Clone, Copy)]
enum CanonicalSubtitlePref {
    Off,
    Lang(&'static str),
}

#[derive(Clone, Copy)]
struct CanonicalLanguagePrefs {
    audio: Option<&'static str>,
    subtitle: Option<CanonicalSubtitlePref>,
}

fn canonicalize_language_prefs(
    audio: Option<&str>,
    subtitle: Option<&str>,
) -> CanonicalLanguagePrefs {
    let audio = audio.and_then(canonicalize_language_value);
    let subtitle = subtitle.and_then(|value| {
        if value.trim().eq_ignore_ascii_case("off") {
            Some(CanonicalSubtitlePref::Off)
        } else {
            canonicalize_language_value(value).map(CanonicalSubtitlePref::Lang)
        }
    });
    CanonicalLanguagePrefs { audio, subtitle }
}

/// The fetch-constant half of `StreamRecommendationKey` — identical minus `family`,
/// which `into_key` re-inserts at its rank position.
#[derive(Clone, Copy)]
struct StreamFixedSignals {
    episode_match: StreamEpisodeMatch,
    title_match: i8,
    viability: u8,
    language: u8,
    health: u8,
    title_source_affinity: u8,
    quality: i32,
    language_bonus: u8,
    source_priority: u32,
    oversize: bool,
    seeders: u32,
    size_bytes: u64,
}

impl StreamFixedSignals {
    fn into_key(self, family: u8) -> StreamRecommendationKey {
        StreamRecommendationKey {
            episode_match: self.episode_match.kind,
            season_claim_verified: self.episode_match.season_claim_verified,
            title_match: self.title_match,
            viability: self.viability,
            language: self.language,
            health: self.health,
            family,
            title_source_affinity: self.title_source_affinity,
            quality: self.quality,
            language_bonus: self.language_bonus,
            source_priority: self.source_priority,
            oversize: std::cmp::Reverse(self.oversize),
            seeders: self.seeders,
            size_bytes: self.size_bytes,
        }
    }
}

/// Memoized per-stream entry: rank fields plus the normalized family key.
struct CachedStreamSignals {
    fixed: StreamFixedSignals,
    normalized_family: Option<String>,
}

/// Per-fetch memo of the recommendation key's fetch-constant half: a re-sort is a
/// memo hit + the still-growing family-map lookup + tuple compare. Sound only
/// because the cache dies with the fetch that captured its inputs.
#[derive(Default)]
pub(crate) struct StreamSignalCache {
    by_stream_key: HashMap<String, CachedStreamSignals>,
    /// Slot for key-less streams so `for_stream` always returns a borrow —
    /// unprepared rows (tests) carry no identity and a "" key would collapse them.
    uncached: Option<CachedStreamSignals>,
}

impl StreamSignalCache {
    fn for_stream(
        &mut self,
        stream: &AddonStream,
        inputs: &StreamRecommendationInputs<'_>,
        reference: Option<&ReferenceTitle>,
        language_prefs: CanonicalLanguagePrefs,
    ) -> &CachedStreamSignals {
        if stream.stream_key.is_empty() {
            return self.uncached.insert(compute_cached_signals(
                stream,
                inputs,
                reference,
                language_prefs,
            ));
        }
        // get-then-insert avoids cloning the key on hits.
        if !self.by_stream_key.contains_key(&stream.stream_key) {
            let computed = compute_cached_signals(stream, inputs, reference, language_prefs);
            self.by_stream_key
                .insert(stream.stream_key.clone(), computed);
        }
        self.by_stream_key
            .get(&stream.stream_key)
            .expect("signal cache entry just filled")
    }
}

fn compute_cached_signals(
    stream: &AddonStream,
    inputs: &StreamRecommendationInputs<'_>,
    reference: Option<&ReferenceTitle>,
    language_prefs: CanonicalLanguagePrefs,
) -> CachedStreamSignals {
    // One normalization pass per stream: haystack, instance id, and family key
    // feed language, bonus, source-priority, health, affinity, and family lookup.
    let haystack = stream_language_haystack(stream);
    let flags = stream.match_texts().flags;
    // Instance id is the identity for source ordering/health/affinity — display names are shared between instances.
    let source_id = stream.source_id.as_deref().and_then(normalize_source_id);
    let resolution = stream_resolution_priority(stream, flags);

    CachedStreamSignals {
        normalized_family: stream
            .stream_family
            .as_deref()
            .and_then(normalize_source_key),
        fixed: StreamFixedSignals {
            episode_match: stream_episode_relevance_priority(stream, inputs.match_context),
            title_match: stream_title_relevance_score(
                stream,
                inputs.match_context.media_type,
                reference,
            ),
            viability: resolution.viability,
            language: stream_language_preference_priority(
                haystack,
                language_prefs,
                flags,
                reference,
            ),
            health: source_id
                .as_deref()
                .and_then(|id| inputs.source_health_priorities.get(id).copied())
                .unwrap_or(DEFAULT_SOURCE_HEALTH_PRIORITY),
            title_source_affinity: stream_title_source_affinity_priority(
                source_id.as_deref(),
                inputs.preferred_title_source_id,
            ),
            quality: resolution.quality,
            language_bonus: resolution.language_bonus,
            source_priority: stream_source_priority(
                source_id.as_deref(),
                inputs.addon_source_priorities,
            ),
            oversize: resolution.oversize,
            seeders: resolution.seeders,
            size_bytes: resolution.size_bytes,
        },
    }
}

fn stream_recommendation_key(
    stream: &AddonStream,
    inputs: &StreamRecommendationInputs<'_>,
    reference: Option<&ReferenceTitle>,
    language_prefs: CanonicalLanguagePrefs,
    signals: &mut StreamSignalCache,
) -> StreamRecommendationKey {
    let cached = signals.for_stream(stream, inputs, reference, language_prefs);
    // Family priority is the one ranking input still growing between progressive passes — stays per-pass.
    let family = stream_family_priority(
        cached.normalized_family.as_deref(),
        inputs.stream_family_priorities,
    );
    cached.fixed.into_key(family)
}

fn stream_language_preference_priority(
    haystack: &str,
    language_prefs: CanonicalLanguagePrefs,
    flags: StreamFlags,
    reference: Option<&ReferenceTitle>,
) -> u8 {
    let preferred_audio_language = language_prefs.audio;
    let preferred_subtitle_language = language_prefs.subtitle;

    if preferred_audio_language.is_none() && preferred_subtitle_language.is_none() {
        return 0;
    }

    // Track the two language memberships while tokenizing instead of allocating a set per stream.
    let mut audio_matches = false;
    let mut subtitle_matches = false;
    let mut has_dub = false;
    let mut has_subtitle_hint = false;
    let mut tokens = haystack
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .peekable();
    while let Some(token) = tokens.next() {
        match token {
            "dub" | "dubbed" => has_dub = true,
            "sub" | "subs" | "subbed" | "subtitle" | "subtitles" => has_subtitle_hint = true,
            _ => {}
        }
        if reference.is_some_and(|reference| reference.tokens.contains(token)) {
            continue;
        }
        // Token scans skip exact-only codes (`no`, `hi`, …) that double as ordinary words.
        let Some(canonical) = canonicalize_language_token(token) else {
            continue;
        };
        let next = tokens.peek().copied();
        let audio_only = matches!(next, Some("audio" | "dub" | "dubbed"));
        audio_matches |= language_mention_is_audio(next.unwrap_or(""))
            && preferred_audio_language == Some(canonical);
        subtitle_matches |= !audio_only
            && matches!(
                preferred_subtitle_language,
                Some(CanonicalSubtitlePref::Lang(preferred)) if preferred == canonical
            );
    }
    // Flags come from the shared `StreamFlags` memo so ranking and the badge score the same vocabulary.
    let has_dual_audio = flags.dual_audio;
    let has_multi_audio = flags.multi_audio;
    let has_multi_sub = flags.multi_sub;
    let mut score = 0;

    if preferred_audio_language.is_some() {
        if audio_matches {
            score += 4;
        } else if has_dual_audio || has_multi_audio {
            score += 2;
        }
    }

    match preferred_subtitle_language {
        Some(CanonicalSubtitlePref::Off) if has_dub || has_dual_audio || has_multi_audio => {
            score += 2;
        }
        Some(CanonicalSubtitlePref::Lang(_)) => {
            if subtitle_matches {
                score += 3;
            } else if has_multi_sub || has_dual_audio || has_multi_audio || has_subtitle_hint {
                score += 1;
            }
        }
        _ => {}
    }

    score.min(6)
}

fn stream_family_priority(
    normalized_family: Option<&str>,
    stream_family_priorities: &HashMap<String, u8>,
) -> u8 {
    normalized_family
        .and_then(|stream_family| stream_family_priorities.get(stream_family).copied())
        .unwrap_or(DEFAULT_STREAM_FAMILY_PRIORITY)
}

/// Title affinity is binary: the stream's instance is the title's preferred source (3) or not (0).
fn stream_title_source_affinity_priority(
    normalized_source_id: Option<&str>,
    preferred_title_source_id: Option<&str>,
) -> u8 {
    u8::from(
        preferred_title_source_id.is_some() && normalized_source_id == preferred_title_source_id,
    ) * 3
}

fn is_title_stop_word(token: &str) -> bool {
    TITLE_STOP_WORDS.contains(&token)
}

fn is_resolution_token(token: &str) -> bool {
    token
        .strip_suffix('p')
        .and_then(|value| value.parse::<u16>().ok())
        .is_some_and(|value| matches!(value, 480 | 576 | 720 | 1080 | 1440 | 2160))
}

fn is_episode_token(token: &str) -> bool {
    token.split_once('x').is_some_and(|(season, episode)| {
        !season.is_empty()
            && !episode.is_empty()
            && season.chars().all(|ch| ch.is_ascii_digit())
            && episode.chars().all(|ch| ch.is_ascii_digit())
    }) || (token.starts_with('s')
        && token.contains('e')
        && token.chars().skip(1).any(|ch| ch.is_ascii_digit()))
}

fn is_title_boundary_token(token: &str) -> bool {
    TITLE_BOUNDARY_TOKENS.contains(&token)
        || is_resolution_token(token)
        || is_episode_token(token)
        || matches!(token, "ep" | "episode")
}

/// Borrow words from the normalized buffer instead of allocating each token.
fn tokenize_title_words(normalized: &str, stop_at_boundary: bool) -> impl Iterator<Item = &str> {
    normalized
        .split_whitespace()
        .take_while(move |token| !stop_at_boundary || !is_title_boundary_token(token))
        .filter(|token| token.len() != 1 || token.chars().all(|ch| ch.is_ascii_digit()))
        .take(12)
}

fn build_title_initialism(words: &[&str]) -> Option<String> {
    let initialism: String = words
        .iter()
        .filter(|word| !is_title_stop_word(word))
        .filter(|word| word.chars().all(|ch| ch.is_ascii_alphabetic()))
        .filter_map(|word| word.chars().next())
        .collect();

    (3..=6).contains(&initialism.len()).then_some(initialism)
}

fn is_neutral_title_extra(token: &str, media_type: &str) -> bool {
    is_title_stop_word(token)
        || TITLE_NEUTRAL_EXTRA_TOKENS.contains(&token)
        || token.chars().all(|ch| ch.is_ascii_digit())
        || (media_type == "movie" && matches!(token, "movie" | "film"))
}

fn is_spin_off_title_extra(token: &str, media_type: &str) -> bool {
    TITLE_SPINOFF_TOKENS.contains(&token)
        || (media_type != "movie" && matches!(token, "movie" | "film"))
}

fn stream_episode_relevance_priority(
    stream: &AddonStream,
    context: StreamMatchContext<'_>,
) -> StreamEpisodeMatch {
    let mut best_match = StreamEpisodeMatch {
        kind: StreamEpisodeMatchKind::None,
        season_claim_verified: false,
    };
    // One lowered match-text set serves both coordinate pairs.
    let texts = stream.match_texts();
    // Remapped titles carry a canonical pair distinct from the query pair;
    // when identical (common case) the second battery run is skipped.
    let query_pair = (context.query_season, context.query_episode);
    let canonical_pair = (context.canonical_season, context.canonical_episode);
    let pairs = [
        Some(query_pair),
        (canonical_pair != query_pair).then_some(canonical_pair),
    ];

    for pair in pairs.into_iter().flatten() {
        if let (Some(season), Some(episode)) = pair {
            // `is_final_season` was computed for the canonical season — a divergent
            // query season must not inherit it, or a numberless "final season" claim
            // verifies against a season it cannot refer to.
            let final_season = context.is_final_season && Some(season) == context.canonical_season;
            best_match = best_match.max(stream_episode_match_texts(
                texts,
                season,
                episode,
                final_season,
            ));
        }
    }

    best_match
}

/// Reference title tokens computed once per ranking pass.
struct ReferenceTitle {
    tokens: HashSet<String>,
    initialism: Option<String>,
    len: usize,
}

fn build_reference_title(title: Option<&str>) -> Option<ReferenceTitle> {
    let normalized = normalize_token_text(title?.trim());
    let words: Vec<_> = tokenize_title_words(&normalized, false).collect();
    let tokens: HashSet<String> = words
        .iter()
        .filter(|word| !is_title_stop_word(word))
        .map(|word| word.to_string())
        .collect();
    if tokens.is_empty() {
        return None;
    }
    let initialism = build_title_initialism(&words);
    let len = tokens.len();
    Some(ReferenceTitle {
        tokens,
        initialism,
        len,
    })
}

/// Leading release-group tag (`[SubsPlease] …`): near-universal on releases and never
/// part of the title — strip it so the group name escapes the significant-extra penalty.
fn strip_leading_group_tag(candidate: &str) -> &str {
    let trimmed = candidate.trim_start();
    let Some(rest) = trimmed.strip_prefix('[') else {
        return trimmed;
    };
    let Some(end) = rest.find(']') else {
        return trimmed;
    };
    if end == 0 || end > 48 {
        return trimmed;
    }
    rest[end + 1..].trim_start()
}

fn stream_title_relevance_score(
    stream: &AddonStream,
    media_type: &str,
    reference: Option<&ReferenceTitle>,
) -> i8 {
    let Some(reference) = reference else {
        return 0;
    };
    let reference_tokens = &reference.tokens;
    let reference_initialism = &reference.initialism;
    let mut best_score = 0;

    for candidate in [
        stream.name.as_deref(),
        stream.title.as_deref(),
        stream
            .behavior_hints
            .as_ref()
            .and_then(|hints| hints.filename.as_deref()),
    ]
    .into_iter()
    .flatten()
    {
        let normalized = normalize_token_text(strip_leading_group_tag(candidate));
        let candidate_tokens: HashSet<&str> = tokenize_title_words(&normalized, true)
            .filter(|word| !is_title_stop_word(word))
            .collect();
        if candidate_tokens.is_empty() {
            continue;
        }

        let overlap_count = candidate_tokens
            .iter()
            .copied()
            .filter(|token| reference_tokens.contains(*token))
            .count();
        let initialism_match = reference_initialism
            .as_deref()
            .is_some_and(|initialism| candidate_tokens.contains(initialism));

        if overlap_count == 0 && !initialism_match {
            continue;
        }

        let mut score = if overlap_count >= reference.len {
            4
        } else if overlap_count * 3 >= reference.len * 2 {
            3
        } else {
            2
        };

        let has_spin_off_marker = candidate_tokens.iter().copied().any(|token| {
            !reference_tokens.contains(token) && is_spin_off_title_extra(token, media_type)
        });
        let significant_extra_count = candidate_tokens
            .iter()
            .copied()
            .filter(|token| !reference_tokens.contains(*token))
            .filter(|token| reference_initialism.as_deref() != Some(*token))
            .filter(|token| !is_neutral_title_extra(token, media_type))
            .count();

        if has_spin_off_marker {
            score -= 5;
        } else if significant_extra_count > 0 && reference.len <= 2 {
            score -= 2;
        } else if significant_extra_count > 1 {
            score -= 1;
        }

        best_score = best_score.max(score);
        if best_score == 4 {
            break;
        }
    }

    best_score
}

/// Structured episode/title match tiers for the selector badges — same thresholds
/// as the free-text reasons, carried as data so the UI never parses strings.
fn stream_match_summary(key: &StreamRecommendationKey) -> Option<StreamMatchSummary> {
    let episode = (key.episode_match != StreamEpisodeMatchKind::None).then_some(key.episode_match);
    let title = if key.title_match >= 4 {
        Some(StreamTitleMatch::Close)
    } else if key.title_match >= 2 {
        Some(StreamTitleMatch::Partial)
    } else {
        None
    };

    (episode.is_some() || title.is_some()).then_some(StreamMatchSummary { episode, title })
}

/// The selector row renders at most this many reason chips.
const MAX_RECOMMENDATION_REASONS: usize = 2;

fn recommendation_reasons_from_key(
    key: &StreamRecommendationKey,
    reasons: &mut Vec<StreamRecommendationReason>,
) {
    use StreamRecommendationReason as Reason;
    reasons.clear();
    reasons.reserve_exact(MAX_RECOMMENDATION_REASONS);

    // Match and delivery facts already have dedicated row badges.
    reasons.extend(
        [
            match key.health {
                3 => Some(Reason::VerifiedSource),
                1 => Some(Reason::SourceIssues),
                0 => Some(Reason::SourceCooling),
                _ => None,
            },
            match key.family {
                4 => Some(Reason::ProvenReleaseGroup),
                1 => Some(Reason::ReleaseGroupIssues),
                0 => Some(Reason::ReleaseGroupCooling),
                _ => None,
            },
            (key.title_source_affinity > 0).then_some(Reason::TitleAffinity),
            if key.language >= 4 {
                Some(Reason::LanguageMatch)
            } else if key.language >= 2 {
                Some(Reason::LanguageFlexible)
            } else {
                None
            },
            if key.quality >= 400 {
                Some(Reason::TopQuality)
            } else if key.quality >= 250 {
                Some(Reason::GoodQuality)
            } else {
                None
            },
            (key.source_priority > 0).then_some(Reason::PreferredSource),
        ]
        .into_iter()
        .flatten()
        .take(MAX_RECOMMENDATION_REASONS),
    );

    // "Fallback" only when the row has nothing else going for it.
    if reasons.is_empty()
        && key.episode_match == StreamEpisodeMatchKind::None
        && key.title_match < 2
    {
        reasons.push(Reason::Fallback);
    }
}

pub(crate) fn sort_streams_by_recommendation(
    streams: &mut Vec<AddonStream>,
    inputs: StreamRecommendationInputs<'_>,
    signals: &mut StreamSignalCache,
) {
    // Draining moves streams without cloning and keeps the output buffer for the
    // repeated ranking passes of progressive fetches.
    let reference = build_reference_title(inputs.match_context.title);
    // Canonicalize the preference strings once per ranking pass.
    let language_prefs = canonicalize_language_prefs(
        inputs.preferred_audio_language,
        inputs.preferred_subtitle_language,
    );
    let mut keyed: Vec<(StreamRecommendationKey, AddonStream)> = streams
        .drain(..)
        .map(|stream| {
            let key = stream_recommendation_key(
                &stream,
                &inputs,
                reference.as_ref(),
                language_prefs,
                signals,
            );
            (key, stream)
        })
        .collect();
    // Stable sort keeps input order for tied keys.
    keyed.sort_by_key(|entry| std::cmp::Reverse(entry.0));

    for (key, mut stream) in keyed {
        stream.match_summary = stream_match_summary(&key);
        stream.selection_priority = Some(SelectionPriority {
            episode_match: key.episode_match,
            season_claim_verified: key.season_claim_verified,
            title_match: key.title_match,
            viability: key.viability,
            language: key.language,
        });
        recommendation_reasons_from_key(&key, &mut stream.recommendation_reasons);
        streams.push(stream);
    }
}

#[cfg(test)]
mod tests;
