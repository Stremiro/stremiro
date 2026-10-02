use super::{
    build_reference_title, canonicalize_language_prefs, is_neutral_title_extra,
    is_title_boundary_token, recommendation_reasons_from_key, sort_streams_by_recommendation,
    stream_episode_relevance_priority, stream_language_preference_priority,
    stream_recommendation_key, tokenize_title_words, StreamMatchContext,
    StreamRecommendationInputs, StreamSignalCache, DEFAULT_SOURCE_HEALTH_PRIORITY,
    DEFAULT_STREAM_FAMILY_PRIORITY,
};
use crate::providers::addons::{
    detect_stream_flags, AddonStream, StreamEpisodeMatchKind, StreamRecommendationReason,
    StreamResolution,
};
use crate::test_helpers::test_stream;
use std::collections::HashMap;

fn recommendation_reasons(
    stream: &AddonStream,
    inputs: &StreamRecommendationInputs<'_>,
) -> Vec<StreamRecommendationReason> {
    // Single predicate pass shared with the sort key: the previous form
    // re-ran every relevance predicate once for the key and again here.
    let reference = build_reference_title(inputs.match_context.title);
    let language_prefs = canonicalize_language_prefs(
        inputs.preferred_audio_language,
        inputs.preferred_subtitle_language,
    );
    let key = stream_recommendation_key(
        stream,
        inputs,
        reference.as_ref(),
        language_prefs,
        &mut StreamSignalCache::default(),
    );
    recommendation_reasons_from_key(&key)
}

fn build_stream(
    source_name: &str,
    cached: bool,
    url: Option<&str>,
    size_bytes: u64,
) -> AddonStream {
    AddonStream {
        name: Some("1080p Release".to_string()),
        title: Some("2.0 GB".to_string()),
        info_hash: if url.is_none() {
            Some("abc123".to_string())
        } else {
            None
        },
        url: url.map(|value| value.to_string()),
        cached,
        seeders: Some(100),
        size_bytes: Some(size_bytes),
        source_name: Some(source_name.to_string()),
        source_id: Some(source_name.to_string()),
        stream_family: Some(format!("{}|release:test", source_name.to_ascii_lowercase())),
        ..test_stream()
    }
}

/// Canonical sort-fixture stream: cached, 2_000 bytes, served from the
/// `https://{source}.example/video.m3u8` URL most sort tests share.
fn sort_stream(source: &str) -> AddonStream {
    build_stream(
        source,
        true,
        Some(&format!("https://{source}.example/video.m3u8")),
        2_000,
    )
}

fn no_match_context() -> StreamMatchContext<'static> {
    StreamMatchContext {
        media_type: "series",
        title: None,
        query_season: None,
        query_episode: None,
        canonical_season: None,
        canonical_episode: None,
        is_final_season: false,
    }
}

fn episode_match_context(
    title: &'static str,
    season: u32,
    episode: u32,
) -> StreamMatchContext<'static> {
    episode_match_context_final(title, season, episode, false)
}

fn episode_match_context_final(
    title: &'static str,
    season: u32,
    episode: u32,
    is_final_season: bool,
) -> StreamMatchContext<'static> {
    StreamMatchContext {
        media_type: "series",
        title: Some(title),
        query_season: Some(season),
        query_episode: Some(episode),
        canonical_season: Some(season),
        canonical_episode: Some(episode),
        is_final_season,
    }
}

/// Sort-order gate: the key-ordered sort must rank the preferred stream
/// first. Compares by source identity so the gate fails if key ordering
/// ever inverts a documented preference.
fn assert_sorts_first_for_test_inputs(
    preferred: &AddonStream,
    other: &AddonStream,
    inputs: &StreamRecommendationInputs<'_>,
) {
    let mut streams = vec![other.clone(), preferred.clone()];
    sort_streams_by_recommendation(&mut streams, *inputs, &mut StreamSignalCache::default());
    assert_eq!(
        streams
            .iter()
            .map(|stream| stream.source_name.clone())
            .collect::<Vec<_>>(),
        vec![preferred.source_name.clone(), other.source_name.clone()]
    );
}

/// Baseline tied inputs: identical addon order, health, and family
/// priorities for alpha and beta, so each test varies exactly one signal.
fn tied_priorities() -> (
    HashMap<String, u32>,
    HashMap<String, u8>,
    HashMap<String, u8>,
) {
    (
        HashMap::from([("alpha".to_string(), 1), ("beta".to_string(), 1)]),
        HashMap::from([
            ("alpha".to_string(), DEFAULT_SOURCE_HEALTH_PRIORITY),
            ("beta".to_string(), DEFAULT_SOURCE_HEALTH_PRIORITY),
        ]),
        HashMap::from([
            (
                "alpha|release:test".to_string(),
                DEFAULT_STREAM_FAMILY_PRIORITY,
            ),
            (
                "beta|release:test".to_string(),
                DEFAULT_STREAM_FAMILY_PRIORITY,
            ),
        ]),
    )
}

fn recommendation_inputs<'a>(
    addon_priorities: &'a HashMap<String, u32>,
    source_health: &'a HashMap<String, u8>,
    stream_family_priorities: &'a HashMap<String, u8>,
    preferred_title_source_id: Option<&'a str>,
    match_context: StreamMatchContext<'a>,
    preferred_audio_language: Option<&'a str>,
    preferred_subtitle_language: Option<&'a str>,
) -> StreamRecommendationInputs<'a> {
    StreamRecommendationInputs {
        addon_source_priorities: addon_priorities,
        source_health_priorities: source_health,
        stream_family_priorities,
        preferred_title_source_id,
        match_context,
        preferred_audio_language,
        preferred_subtitle_language,
    }
}

#[test]
/// sorts healthier source first: key-ordered sort ranks the preferred stream first.
fn sorts_prefers_healthier_source_with_same_viability() {
    let (addon_priorities, mut source_health, stream_family_priorities) = tied_priorities();
    source_health.insert("beta".to_string(), 0);
    let alpha = sort_stream("alpha");
    let beta = build_stream("beta", true, Some("https://beta.example/video.m3u8"), 2_500);

    assert_sorts_first_for_test_inputs(
        &alpha,
        &beta,
        &recommendation_inputs(
            &addon_priorities,
            &source_health,
            &stream_family_priorities,
            None,
            no_match_context(),
            None,
            None,
        ),
    );
}

#[test]
/// sorts proven release family first: key-ordered sort ranks the preferred stream first.
fn sorts_prefers_recently_successful_stream_family_when_health_is_tied() {
    let (addon_priorities, source_health, mut family_health) = tied_priorities();
    family_health.insert("alpha|release:test".to_string(), 4);
    let alpha = sort_stream("alpha");
    let beta = sort_stream("beta");

    assert_sorts_first_for_test_inputs(
        &alpha,
        &beta,
        &recommendation_inputs(
            &addon_priorities,
            &source_health,
            &family_health,
            None,
            no_match_context(),
            None,
            None,
        ),
    );
}

#[test]
/// sorts previously working source first: key-ordered sort ranks the preferred stream first.
fn sorts_prefers_recent_title_source_when_other_inputs_are_tied() {
    let (addon_priorities, source_health, stream_family_priorities) = tied_priorities();
    let title_affinity = Some("alpha");
    let alpha = sort_stream("alpha");
    let beta = sort_stream("beta");

    assert_sorts_first_for_test_inputs(
        &alpha,
        &beta,
        &recommendation_inputs(
            &addon_priorities,
            &source_health,
            &stream_family_priorities,
            title_affinity,
            no_match_context(),
            None,
            None,
        ),
    );
}

#[test]
/// sorts exact episode over batch range: key-ordered sort ranks the preferred stream first.
fn sorts_prefers_exact_episode_over_batch_range() {
    let (addon_priorities, source_health, stream_family_priorities) = tied_priorities();
    let mut exact = sort_stream("alpha");
    exact.name = Some("One Piece S01E08 1080p".to_string());

    let mut batch = sort_stream("beta");
    batch.name = Some("One Piece S01E01-E12 Batch 1080p".to_string());

    assert_sorts_first_for_test_inputs(
        &exact,
        &batch,
        &recommendation_inputs(
            &addon_priorities,
            &source_health,
            &stream_family_priorities,
            None,
            episode_match_context("One Piece", 1, 8),
            None,
            None,
        ),
    );
}

#[test]
/// demotes spinoff title: key-ordered sort ranks the preferred stream first.
fn sorts_demotes_spinoff_title_even_with_matching_episode() {
    let (addon_priorities, source_health, stream_family_priorities) = tied_priorities();
    let mut mainline = sort_stream("alpha");
    mainline.name = Some("Attack on Titan S01E03 1080p".to_string());

    let mut spinoff = sort_stream("beta");
    spinoff.name = Some("Attack on Titan Junior High S01E03 1080p".to_string());

    assert_sorts_first_for_test_inputs(
        &mainline,
        &spinoff,
        &recommendation_inputs(
            &addon_priorities,
            &source_health,
            &stream_family_priorities,
            None,
            episode_match_context("Attack on Titan", 1, 3),
            None,
            None,
        ),
    );
}

#[test]
/// sorts language-matching stream first: key-ordered sort ranks the preferred stream first.
fn sorts_prefers_language_matching_stream_when_other_inputs_are_tied() {
    let (addon_priorities, source_health, stream_family_priorities) = tied_priorities();
    let mut japanese = sort_stream("alpha");
    japanese.name = Some("[JA] Dual Audio 1080p".to_string());

    let mut dubbed = sort_stream("beta");
    dubbed.name = Some("English Dub 1080p".to_string());

    assert_sorts_first_for_test_inputs(
        &japanese,
        &dubbed,
        &recommendation_inputs(
            &addon_priorities,
            &source_health,
            &stream_family_priorities,
            None,
            no_match_context(),
            Some("ja"),
            Some("off"),
        ),
    );
}

#[test]
fn sorts_prefers_language_match_over_health_family_affinity_quality() {
    let addon_priorities = HashMap::from([("alpha".to_string(), 1), ("beta".to_string(), 1)]);
    let source_health = HashMap::from([("alpha".to_string(), 2), ("beta".to_string(), 3)]);
    let stream_family_priorities = HashMap::from([
        ("alpha|release:test".to_string(), 2),
        ("beta|release:test".to_string(), 4),
    ]);
    let title_affinity = Some("beta");

    let mut english = sort_stream("alpha");
    english.name = Some("Show S01E05 English 1080p".to_string());
    let mut german = sort_stream("beta");
    german.name = Some("Show S01E05 German 2160p".to_string());

    assert_sorts_first_for_test_inputs(
        &english,
        &german,
        &recommendation_inputs(
            &addon_priorities,
            &source_health,
            &stream_family_priorities,
            title_affinity,
            episode_match_context("Show", 1, 5),
            Some("en"),
            Some("en"),
        ),
    );
}

#[test]
fn sorts_prefers_episode_match_over_english_wrong_episode() {
    let (addon_priorities, source_health, stream_family_priorities) = tied_priorities();
    let mut correct = sort_stream("alpha");
    correct.name = Some("Show S01E05 1080p".to_string());
    let mut wrong = sort_stream("beta");
    wrong.name = Some("Show S01E07 English Dub 2160p".to_string());

    assert_sorts_first_for_test_inputs(
        &correct,
        &wrong,
        &recommendation_inputs(
            &addon_priorities,
            &source_health,
            &stream_family_priorities,
            None,
            episode_match_context("Show", 1, 5),
            Some("en"),
            Some("en"),
        ),
    );
}

#[test]
fn language_priority_ignores_unspecified_dub_for_english_pref() {
    let prefs = canonicalize_language_prefs(Some("en"), None);
    let score = |haystack: &str| {
        stream_language_preference_priority(haystack, prefs, detect_stream_flags(haystack))
    };

    assert_eq!(score("German Dub"), score("German"));
    assert_eq!(score("German"), 0);
    assert_eq!(score("Dub"), 0);
    assert!(score("English Dub") > 0);
}

#[test]
fn recommendation_reasons_include_title_source_and_language_context() {
    let addon_priorities = HashMap::from([("alpha".to_string(), 1)]);
    let source_health = HashMap::from([("alpha".to_string(), DEFAULT_SOURCE_HEALTH_PRIORITY)]);
    let stream_family_priorities = HashMap::from([(
        "alpha|release:test".to_string(),
        DEFAULT_STREAM_FAMILY_PRIORITY,
    )]);
    let title_affinity = Some("alpha");
    let mut stream = sort_stream("alpha");
    stream.name = Some("[JA] Dual Audio 1080p".to_string());

    let reasons = recommendation_reasons(
        &stream,
        &recommendation_inputs(
            &addon_priorities,
            &source_health,
            &stream_family_priorities,
            title_affinity,
            no_match_context(),
            Some("ja"),
            Some("off"),
        ),
    );

    assert!(reasons.contains(&StreamRecommendationReason::TitleAffinity));
    assert!(
        reasons.contains(&StreamRecommendationReason::LanguageMatch)
            || reasons.contains(&StreamRecommendationReason::LanguageFlexible)
    );
}

#[test]
/// Oversize demotion must actually rank an over-limit stream below an
/// otherwise identical smaller one in the same resolution tier.
fn sorts_at_limit_size_before_oversize_same_tier() {
    const GIB: u64 = 1024 * 1024 * 1024;
    let empty_priorities = HashMap::new();
    let empty_health = HashMap::new();
    let empty_families = HashMap::new();
    let inputs = recommendation_inputs(
        &empty_priorities,
        &empty_health,
        &empty_families,
        None,
        no_match_context(),
        None,
        None,
    );

    // 1080p tier (15 GiB limit): identical metadata except size.
    let mut small = build_stream(
        "alpha",
        true,
        Some("https://alpha.example/small.m3u8"),
        2 * GIB,
    );
    small.presentation.resolution = StreamResolution::P1080;
    let mut large = build_stream(
        "alpha",
        true,
        Some("https://alpha.example/large.m3u8"),
        16 * GIB,
    );
    large.presentation.resolution = StreamResolution::P1080;

    let mut streams = vec![large, small];
    sort_streams_by_recommendation(&mut streams, inputs, &mut StreamSignalCache::default());
    assert_eq!(
        streams
            .iter()
            .map(|stream| stream.size_bytes)
            .collect::<Vec<_>>(),
        vec![Some(2 * GIB), Some(16 * GIB)]
    );

    // 4K tier (20 GiB limit, strict `>`): the at-limit stream must rank
    // ahead of the over-limit one even though it is smaller — without the
    // demotion the larger `size_bytes` tiebreak would invert them.
    let mut at_limit = build_stream(
        "alpha",
        true,
        Some("https://alpha.example/at-limit.m3u8"),
        20 * GIB,
    );
    at_limit.name = Some("2160p Release".to_string());
    at_limit.presentation.resolution = StreamResolution::P2160;
    let mut over = build_stream(
        "alpha",
        true,
        Some("https://alpha.example/over.m3u8"),
        21 * GIB,
    );
    over.name = Some("2160p Release".to_string());
    over.presentation.resolution = StreamResolution::P2160;

    let mut streams = vec![over, at_limit];
    sort_streams_by_recommendation(&mut streams, inputs, &mut StreamSignalCache::default());
    assert_eq!(
        streams
            .iter()
            .map(|stream| stream.size_bytes)
            .collect::<Vec<_>>(),
        vec![Some(20 * GIB), Some(21 * GIB)]
    );
}

#[test]
/// sorts season-claimed match first: key-ordered sort ranks the preferred stream first.
fn sorts_prefers_season_claimed_exact_match_over_assumed_higher_quality() {
    // Attack on Titan Final Season request in a mixed pool: both files
    // Exact-match the dash form; the titled release carries the verified
    // season claim and must outrank the 2160p bare-dash file even at 1080p.
    let (addon_priorities, source_health, stream_family_priorities) = tied_priorities();
    let mut titled = sort_stream("alpha");
    titled.name = Some("Shingeki no Kyojin - The Final Season - 04 [1080p]".to_string());

    let mut bare = sort_stream("beta");
    bare.name = Some("Shingeki no Kyojin - 04 [2160p]".to_string());

    assert_sorts_first_for_test_inputs(
        &titled,
        &bare,
        &recommendation_inputs(
            &addon_priorities,
            &source_health,
            &stream_family_priorities,
            None,
            episode_match_context_final("Shingeki no Kyojin", 4, 4, true),
            None,
            None,
        ),
    );
}

#[test]
/// `is_final_season` is computed for the canonical (ranking) season — a
/// divergent query season must not verify a numberless "final season"
/// claim, or a different season's episode earns `season_claim_verified`
/// it can't support (the conflict path scopes the fact the same way).
fn final_season_claim_scopes_to_the_canonical_season() {
    let mut stream = sort_stream("alpha");
    stream.name = Some("Show The Final Season - 05".to_string());
    stream.title = None;

    // Canonical pair IS the final season: the numberless claim verifies.
    let context = StreamMatchContext {
        media_type: "series",
        title: Some("Show"),
        query_season: Some(3),
        query_episode: Some(5),
        canonical_season: Some(3),
        canonical_episode: Some(5),
        is_final_season: true,
    };
    let matched = stream_episode_relevance_priority(&stream, context);
    assert_eq!(matched.kind, StreamEpisodeMatchKind::Exact);
    assert!(matched.season_claim_verified);

    // Query (1,5) vs canonical (3,8): "final season" can only claim
    // season 3, so the query battery must see a conflicting season
    // claim — the canonical battery then finds no E08 either.
    let context = StreamMatchContext {
        query_season: Some(1),
        canonical_episode: Some(8),
        ..context
    };
    let matched = stream_episode_relevance_priority(&stream, context);
    assert_eq!(matched.kind, StreamEpisodeMatchKind::None);
}

#[test]
/// Progressive re-sorts reuse memoized fixed signals — the ~30-probe
/// episode battery and title score run once per fetch — while the
/// still-growing family map is re-read on every pass.
fn resort_memoizes_fixed_signals_but_rereads_family_priority() {
    let (addon_priorities, source_health, mut family_priorities) = tied_priorities();

    // Identical match text: every fixed signal ties — only the family
    // lookup can split the order.
    let mut alpha = sort_stream("alpha");
    alpha.name = Some("One Piece S01E08 1080p".to_string());
    alpha.stream_key = "s:alpha".to_string();
    let mut beta = sort_stream("beta");
    beta.name = alpha.name.clone();
    beta.stream_key = "s:beta".to_string();

    let mut signals = StreamSignalCache::default();
    let mut streams = vec![alpha, beta];
    // Progressive fetches reserve room for more addon results. Re-ranking
    // must preserve that buffer instead of discarding its spare capacity.
    streams.reserve(126);
    let capacity = streams.capacity();

    // Pass 1 (tied family): the stable sort keeps declaration order.
    sort_streams_by_recommendation(
        &mut streams,
        recommendation_inputs(
            &addon_priorities,
            &source_health,
            &family_priorities,
            None,
            episode_match_context("One Piece", 1, 8),
            None,
            None,
        ),
        &mut signals,
    );
    assert_eq!(streams[0].source_name.as_deref(), Some("alpha"));

    // Pass 2 (beta's family turned proven mid-fetch): the re-read family
    // signal is the only key field that can move — beta takes first place.
    family_priorities.insert("beta|release:test".to_string(), 4);
    sort_streams_by_recommendation(
        &mut streams,
        recommendation_inputs(
            &addon_priorities,
            &source_health,
            &family_priorities,
            None,
            episode_match_context("One Piece", 1, 8),
            None,
            None,
        ),
        &mut signals,
    );
    assert_eq!(streams[0].source_name.as_deref(), Some("beta"));

    // Pass 3: stripping beta's family and size must NOT re-run the battery —
    // a recompute would lose its family edge and its size tiebreak, handing
    // first place back to alpha. The memo holds because the cache is scoped
    // to this fetch's fixed inputs.
    streams[0].stream_family = None;
    streams[0].size_bytes = Some(1);
    sort_streams_by_recommendation(
        &mut streams,
        recommendation_inputs(
            &addon_priorities,
            &source_health,
            &family_priorities,
            None,
            episode_match_context("One Piece", 1, 8),
            None,
            None,
        ),
        &mut signals,
    );
    assert_eq!(streams[0].source_name.as_deref(), Some("beta"));
    assert_eq!(streams.capacity(), capacity);
}

#[test]
fn sort_assigns_selection_priority_from_key() {
    let (addon_priorities, source_health, stream_family_priorities) = tied_priorities();
    let mut exact = sort_stream("alpha");
    exact.name = Some("Show S01E05 English 1080p".to_string());
    let mut other = sort_stream("beta");
    other.name = Some("Show S01E06 1080p".to_string());

    let mut streams = vec![other, exact];
    sort_streams_by_recommendation(
        &mut streams,
        recommendation_inputs(
            &addon_priorities,
            &source_health,
            &stream_family_priorities,
            None,
            episode_match_context("Show", 1, 5),
            Some("en"),
            Some("en"),
        ),
        &mut StreamSignalCache::default(),
    );

    assert_eq!(
        streams[0].selection_priority,
        Some((StreamEpisodeMatchKind::Exact, true, 4, 1, 6))
    );
    assert_eq!(
        streams[1].selection_priority,
        Some((StreamEpisodeMatchKind::None, false, 4, 1, 0))
    );
}

#[test]
/// Every token a `StreamFlags` spelling can produce must be a title
/// boundary or a neutral extra — a release tag left readable as a title
/// word becomes a significant-extra penalty, the exact drift the shared
/// flag vocabulary exists to kill.
fn release_tag_spellings_never_count_as_title_extras() {
    const FLAG_SPELLINGS: &[&str] = &[
        "remux",
        "bdremux",
        "bluray",
        "blu-ray",
        "bdrip",
        "web-dl",
        "webdl",
        "webrip",
        "hdtv",
        "dolby vision",
        "dovi",
        "dv",
        "hdr10+",
        "hdr",
        "atmos",
        "truehd",
        "dts-hd",
        "dts-x",
        "dtsx",
        "dts",
        "eac3",
        "dd+",
        "ddp",
        "dd5.1",
        "aac",
        "x265",
        "hevc",
        "h265",
        "h.265",
        "av1",
        "5.1",
        "7.1",
        "dual audio",
        "dual.audio",
        "dualaudio",
        "dub + sub",
        "sub + dub",
        "dubbed",
        "multi audio",
        "multi.audio",
        "multiaudio",
        "multi lang",
        "multi-lang",
        "multilang",
        "multi sub",
        "multi-sub",
        "multisub",
        "multi subtitle",
        "english",
        "eng",
        "japanese",
        "jap",
    ];
    for spelling in FLAG_SPELLINGS {
        for word in tokenize_title_words(spelling, false) {
            assert!(
                is_title_boundary_token(&word) || is_neutral_title_extra(&word, "series"),
                "flag spelling `{spelling}` tokenizes to `{word}`, which counts as a title extra"
            );
        }
    }
}

#[test]
/// sorts the right season first: key-ordered sort ranks the preferred stream first.
fn sorts_titled_final_season_release_below_the_requested_season() {
    // The reported case: an S01E04 request must not lose to a cached 2160p
    // final-season release that loose-matched the same episode number —
    // the S1 file's Exact match beats the titled release's None.
    let (addon_priorities, source_health, stream_family_priorities) = tied_priorities();
    let mut season_one = sort_stream("alpha");
    season_one.name = Some("Shingeki no Kyojin - 04 [1080p]".to_string());

    let mut final_named = sort_stream("beta");
    final_named.name =
        Some("[SubsPlease] Shingeki no Kyojin - The Final Season - 04 (2160p)".to_string());

    assert_sorts_first_for_test_inputs(
        &season_one,
        &final_named,
        &recommendation_inputs(
            &addon_priorities,
            &source_health,
            &stream_family_priorities,
            None,
            episode_match_context_final("Shingeki no Kyojin", 1, 4, false),
            None,
            None,
        ),
    );
}

#[test]
/// Dev ranking inspector: the sort stamps each stream with its full key
/// dump in debug builds; the field is `skip_serializing_if`-gated so a
/// release payload can never carry it.
fn sort_attaches_rank_debug_in_debug_builds() {
    let (addon_priorities, source_health, stream_family_priorities) = tied_priorities();
    let mut streams = vec![sort_stream("alpha")];

    sort_streams_by_recommendation(
        &mut streams,
        recommendation_inputs(
            &addon_priorities,
            &source_health,
            &stream_family_priorities,
            None,
            episode_match_context("Shingeki no Kyojin", 1, 4),
            None,
            None,
        ),
        &mut StreamSignalCache::default(),
    );

    if cfg!(debug_assertions) {
        let dump = streams[0].rank_debug.as_deref().expect("debug rank dump");
        assert!(dump.contains("ep=") && dump.contains("q=") && dump.contains("size="));
    } else {
        assert!(streams[0].rank_debug.is_none());
    }
}
