use super::language::canonicalize_language_token;
#[cfg(debug_assertions)]
use super::streaming_helpers::format_stream_size_label;
use super::streaming_helpers::{
    normalize_source_id, normalize_source_key, stream_language_haystack,
    stream_resolution_priority, stream_source_priority,
};
use crate::providers::addons::{
    stream_episode_match_texts, AddonStream, StreamEpisodeMatch, StreamEpisodeMatchKind,
    StreamFlags, StreamMatchSummary, StreamRecommendationReason, StreamTitleMatch,
};
use std::collections::{HashMap, HashSet};

/// Single owner for "no recorded outcome" source-health priority; shared by
/// the fetcher cooldown gate and the resume donor scan.
pub(crate) const DEFAULT_SOURCE_HEALTH_PRIORITY: u8 = 2;
pub(crate) const DEFAULT_STREAM_FAMILY_PRIORITY: u8 = 2;
const TITLE_STOP_WORDS: &[&str] = &["a", "an", "and", "of", "on", "the", "to"];
const TITLE_NEUTRAL_EXTRA_TOKENS: &[&str] = &[
    "arc",
    // Language/edition tags that must never read as significant title
    // extras — includes the release-tag spellings `StreamFlags` probes so a
    // tag-carrying release keeps its title overlap (`ray`/`blu`/`vision`
    // stay here rather than in `TITLE_BOUNDARY_TOKENS`: they are plausible
    // title words, so they relieve the extra penalty without stopping
    // tokenization).
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
/// Release-tag tokens that stop title tokenization. Must cover every
/// single-token spelling the `StreamFlags` probes use (or
/// `TITLE_NEUTRAL_EXTRA_TOKENS` for plausible title words) — a missing one
/// becomes a significant-extra penalty. `release_tag_spellings_never_count_as_title_extras` pins it.
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
    "eac3",
    "dualaudio",
    "flac",
    "h264",
    "h265",
    "hd",
    "hdcam",
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
    "truehd",
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
    /// The mapping-index fact for the requested season: true when it is the
    /// show's final season. It lets the episode battery resolve numberless
    /// "final season" naming claims (see `text_matches_requested_season`).
    pub is_final_season: bool,
}

#[derive(Clone, Copy)]
pub(crate) struct StreamRecommendationInputs<'a> {
    pub addon_source_priorities: &'a HashMap<String, u32>,
    pub source_health_priorities: &'a HashMap<String, u8>,
    pub stream_family_priorities: &'a HashMap<String, u8>,
    /// The single preferred addon instance for this title scope — the last
    /// source that succeeded recently, normalized.
    pub preferred_title_source_id: Option<&'a str>,
    pub match_context: StreamMatchContext<'a>,
    pub preferred_audio_language: Option<&'a str>,
    pub preferred_subtitle_language: Option<&'a str>,
}

/// Sort key computed once per stream so the comparator is a bare tuple
/// compare. Field order is rank order: episode, season claim, title,
/// viability, language, health, family, affinity, quality, bonus, addon
/// order, oversize demotion, swarm stats. Viability outranks reputation and
/// preference: a stream the player cannot load must never win.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct StreamRecommendationKey {
    pub episode_match: StreamEpisodeMatchKind,
    /// Same-tier split from `StreamEpisodeMatch`: a match resting on an
    /// explicit season claim outranks an assumed one, so a titled
    /// final-season release cannot lose an Exact tie to a same-numbered
    /// file of another season, nor win one for the wrong season.
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
    /// Oversize demotion, ordered before swarm stats so a bloated remux
    /// can't resurface on a tie; `Reverse` because the key sorts descending.
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
    let audio = audio.and_then(canonicalize_language_token);
    let subtitle = subtitle.and_then(|value| {
        let normalized = value.trim().to_ascii_lowercase();
        if normalized.is_empty() {
            None
        } else if normalized == "off" {
            Some(CanonicalSubtitlePref::Off)
        } else {
            canonicalize_language_token(&normalized).map(CanonicalSubtitlePref::Lang)
        }
    });
    CanonicalLanguagePrefs { audio, subtitle }
}

/// The fetch-constant half of `StreamRecommendationKey` — see
/// `StreamSignalCache`. Field-for-field identical to the key minus
/// `family`; `into_key` re-inserts it at its rank position.
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

/// Memoized per-stream entry — the rank fields plus the normalized family
/// key the per-pass family-priority lookup reads.
struct CachedStreamSignals {
    fixed: StreamFixedSignals,
    normalized_family: Option<String>,
}

/// Per-fetch memo of the fetch-constant half of the recommendation key: a
/// re-sort is a memo hit plus the still-growing family-map lookup and a
/// tuple compare. Sound only because the cache dies with the fetch that
/// captured its inputs.
#[derive(Default)]
pub(crate) struct StreamSignalCache {
    by_stream_key: HashMap<String, CachedStreamSignals>,
    /// Slot for key-less streams so `for_stream` always returns a borrow —
    /// unprepared rows (tests, fixtures) carry no dedup identity and a ""
    /// map key would collapse them all into one entry.
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
            self.uncached = Some(compute_cached_signals(
                stream,
                inputs,
                reference,
                language_prefs,
            ));
            return self.uncached.as_ref().expect("uncached slot just filled");
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
    // One normalization pass per stream: the haystack, instance id, and
    // family key feed language, bonus, source-priority, health, affinity,
    // and the per-pass family lookup.
    let haystack = stream_language_haystack(stream);
    let flags = stream.match_texts().flags;
    // Instance id is the identity for source ordering, health, and title
    // affinity — display names are shared between addon instances.
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
            language: stream_language_preference_priority(haystack, language_prefs, flags),
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
    // Family priority is the one ranking input still growing between
    // progressive passes — its lookup (not the memo) stays per-pass.
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
) -> u8 {
    let preferred_audio_language = language_prefs.audio;
    let preferred_subtitle_language = language_prefs.subtitle;

    if preferred_audio_language.is_none() && preferred_subtitle_language.is_none() {
        return 0;
    }

    // One tokenize pass: the canonical set answers the preference lookups
    // and the raw-token questions fold into single-pass booleans. The
    // haystack arrives already lowered and separator-normalized (the match
    // text memo), so borrowed tokens see the same boundaries as an
    // allocated `tokenize_language_meta` pass.
    let mut language_tokens: HashSet<&str> = HashSet::new();
    let mut has_dub = false;
    let mut has_subtitle_hint = false;
    for token in haystack
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
    {
        match token {
            "dub" | "dubbed" => has_dub = true,
            "sub" | "subbed" | "subtitle" | "subtitles" => has_subtitle_hint = true,
            _ => {}
        }
        if let Some(canonical) = canonicalize_language_token(token) {
            language_tokens.insert(canonical);
        } else {
            language_tokens.insert(token);
        }
    }
    // Flags come from the shared `StreamFlags` memo so ranking and the
    // presentation badge score the same vocabulary off the same haystack.
    let has_dual_audio = flags.dual_audio;
    let has_multi_audio = flags.multi_audio;
    let has_multi_sub = flags.multi_sub;
    let mut score = 0;

    if let Some(preferred_audio_language) = preferred_audio_language {
        if language_tokens.contains(preferred_audio_language) {
            score += 4;
        } else if has_dual_audio || has_multi_audio {
            score += 2;
        }
    }

    match preferred_subtitle_language {
        Some(CanonicalSubtitlePref::Off) if has_dub || has_dual_audio || has_multi_audio => {
            score += 2;
        }
        Some(CanonicalSubtitlePref::Lang(preferred_subtitle_language)) => {
            if language_tokens.contains(preferred_subtitle_language) {
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

/// Title affinity is binary: the stream's addon instance either is the
/// title's recently-succeeded preferred source (3) or it isn't (0).
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

fn tokenize_title_words(value: &str, stop_at_boundary: bool) -> Vec<String> {
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

    let mut words = Vec::new();
    for token in normalized.split_whitespace() {
        if stop_at_boundary && is_title_boundary_token(token) {
            break;
        }

        if token.len() == 1 && !token.chars().all(|ch| ch.is_ascii_digit()) {
            continue;
        }

        words.push(token.to_string());
        if words.len() >= 12 {
            break;
        }
    }

    words
}

fn build_title_token_set(words: &[String]) -> HashSet<String> {
    words
        .iter()
        .filter(|word| !is_title_stop_word(word))
        .cloned()
        .collect()
}

/// Borrowed variant for candidate sets that die inside the per-stream loop —
/// skips ~12 String clones per candidate per stream. The reference set stays
/// owned: it outlives the word Vec it was built from.
fn build_title_token_set_ref(words: &[String]) -> HashSet<&str> {
    words
        .iter()
        .map(String::as_str)
        .filter(|word| !is_title_stop_word(word))
        .collect()
}

fn build_title_initialism(words: &[String]) -> Option<String> {
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
    // when they are identical (the common no-remap case) the second battery
    // run is skipped.
    let query_pair = (context.query_season, context.query_episode);
    let canonical_pair = (context.canonical_season, context.canonical_episode);
    let pairs = [
        Some(query_pair),
        (canonical_pair != query_pair).then_some(canonical_pair),
    ];

    for pair in pairs.into_iter().flatten() {
        if let (Some(season), Some(episode)) = pair {
            // `is_final_season` was computed for the canonical (ranking)
            // season — a divergent query season must not inherit it or a
            // numberless "final season" claim verifies against a season it
            // cannot refer to (the conflict path scopes it the same way).
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
    let words = tokenize_title_words(title?.trim(), false);
    if words.is_empty() {
        return None;
    }
    let tokens = build_title_token_set(&words);
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

/// Leading release-group tag (`[SubsPlease] …`): near-universal on scene and
/// anime releases, and never part of the title — stripping it keeps the
/// group name out of the significant-extra penalty for legit matches.
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
        let candidate_words = tokenize_title_words(strip_leading_group_tag(candidate), true);
        let candidate_tokens = build_title_token_set_ref(&candidate_words);
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

        if initialism_match {
            score = score.max(2);
        }

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
    }

    best_score
}

/// Structured episode/title match tiers for the selector badges — the same
/// thresholds as the free-text reasons, carried as data so the UI never
/// parses strings.
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

/// The selector row renders at most this many reason chips; extra kinds
/// would only add IPC weight.
const MAX_RECOMMENDATION_REASONS: usize = 2;

fn recommendation_reasons_from_key(
    key: &StreamRecommendationKey,
) -> Vec<StreamRecommendationReason> {
    use StreamRecommendationReason as Reason;
    let mut reasons = Vec::with_capacity(6);

    // Episode/title match facts ship on `match_summary` — duplicating them
    // here would render the same fact twice in the selector row.

    match key.health {
        3 => reasons.push(Reason::VerifiedSource),
        1 => reasons.push(Reason::SourceIssues),
        0 => reasons.push(Reason::SourceCooling),
        _ => {}
    }

    match key.family {
        4 => reasons.push(Reason::ProvenReleaseGroup),
        1 => reasons.push(Reason::ReleaseGroupIssues),
        0 => reasons.push(Reason::ReleaseGroupCooling),
        _ => {}
    }

    if key.title_source_affinity > 0 {
        reasons.push(Reason::TitleAffinity);
    }

    if key.language >= 4 {
        reasons.push(Reason::LanguageMatch);
    } else if key.language >= 2 {
        reasons.push(Reason::LanguageFlexible);
    }

    // Delivery facts ("Cached"/"HTTP") are intentionally absent: the row's
    // icon tile and delivery label already carry them — repeating them as
    // reason chips renders the same fact twice.

    if key.quality >= 400 {
        reasons.push(Reason::TopQuality);
    } else if key.quality >= 250 {
        reasons.push(Reason::GoodQuality);
    }

    if key.source_priority > 0 {
        reasons.push(Reason::PreferredSource);
    }

    // "Fallback" only when the row has nothing else going for it — a lone
    // match badge is already meaningful on its own.
    if reasons.is_empty()
        && key.episode_match == StreamEpisodeMatchKind::None
        && key.title_match < 2
    {
        reasons.push(Reason::Fallback);
    }

    reasons.truncate(MAX_RECOMMENDATION_REASONS);
    reasons
}

/// Dev-inspector dump of the whole sort key, in rank order. Compiled out of
/// release builds entirely — `AddonStream.rank_debug` stays `None` there and
/// the field never reaches the wire.
#[cfg(debug_assertions)]
fn format_rank_debug(key: &StreamRecommendationKey) -> String {
    format!(
        "ep={:?}{} title={} via={} lang={} hp={} fam={} aff={} q={} +{} src={} ovr={} seeds={} size={}",
        key.episode_match,
        if key.season_claim_verified { "✓" } else { "" },
        key.title_match,
        key.viability,
        key.language,
        key.health,
        key.family,
        key.title_source_affinity,
        key.quality,
        key.language_bonus,
        key.source_priority,
        key.oversize.0,
        key.seeders,
        format_stream_size_label("", Some(key.size_bytes))
            .unwrap_or_else(|| "-".to_string()),
    )
}

pub(crate) fn sort_streams_by_recommendation(
    streams: &mut Vec<AddonStream>,
    inputs: StreamRecommendationInputs<'_>,
    signals: &mut StreamSignalCache,
) {
    // One memoized signals lookup per stream, then sort on the key alone;
    // Draining moves streams without cloning and preserves the output buffer
    // for repeated ranking passes as progressive addon results arrive.
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
        stream.selection_priority = Some((
            key.episode_match,
            key.season_claim_verified,
            key.title_match,
            key.viability,
            key.language,
        ));
        stream.recommendation_reasons = recommendation_reasons_from_key(&key);
        // Dev-only: ship the sort key so the selector's ranking inspector
        // can explain the order without re-running the match battery.
        #[cfg(debug_assertions)]
        {
            stream.rank_debug = Some(format_rank_debug(&key));
        }
        streams.push(stream);
    }
}

#[cfg(test)]
mod tests;
