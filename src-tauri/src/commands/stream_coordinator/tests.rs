use super::{
    build_reference_title, canonicalize_language_prefs, is_neutral_title_extra,
    is_title_boundary_token, normalize_token_text, rank_stream_by_recommendation,
    recommendation_reasons_from_key, set_stream_match_badges, sort_streams_by_recommendation,
    stream_episode_relevance_priority, stream_language_preference_priority,
    stream_recommendation_key, tokenize_title_words, StreamMatchContext,
    StreamRecommendationInputs, StreamRecommendationKey, StreamSignalCache,
    DEFAULT_SOURCE_HEALTH_PRIORITY, DEFAULT_STREAM_FAMILY_PRIORITY,
};
use crate::commands::streaming_helpers::prepare_addon_streams;
use crate::providers::addons::{
    detect_stream_flags, AddonStream, SelectionPriority, StreamEpisodeMatchKind,
    StreamMatchBadgeKind, StreamMatchSummary, StreamMatchTier, StreamPackCoverage,
    StreamRecommendationReason, StreamResolution, StreamTitleMatch,
};
use crate::test_helpers::test_stream;
use std::collections::HashMap;

#[test]
fn selector_badges_preserve_order_tier_precedence_and_pack_suppression() {
    use StreamEpisodeMatchKind as Episode;
    use StreamMatchBadgeKind as Badge;
    use StreamMatchTier as Tier;

    let mut stream = test_stream();
    for (episode, seasons, badge, tier, pack_allowed) in [
        (None, None, None, None, true),
        (Some(Episode::None), None, None, None, false),
        (
            Some(Episode::Exact),
            None,
            Some(Badge::Episode),
            Some(Tier::Exact),
            true,
        ),
        (
            Some(Episode::EpisodeRange),
            None,
            Some(Badge::Range),
            Some(Tier::EpisodeRange),
            false,
        ),
        (
            Some(Episode::SeasonPack),
            None,
            Some(Badge::Season),
            Some(Tier::SeasonPack),
            false,
        ),
        (
            Some(Episode::SeasonPack),
            Some(vec![]),
            Some(Badge::Season),
            Some(Tier::SeasonPack),
            false,
        ),
        (
            Some(Episode::SeasonPack),
            Some(vec![1]),
            Some(Badge::Season),
            Some(Tier::SeasonPack),
            false,
        ),
        (
            Some(Episode::SeasonPack),
            Some(vec![1, 2]),
            Some(Badge::MultiSeason),
            Some(Tier::SeasonPack),
            false,
        ),
    ] {
        for (title, title_badge, title_tier) in [
            (None, None, None),
            (
                Some(StreamTitleMatch::Close),
                Some(Badge::Title),
                Some(Tier::Title),
            ),
            (
                Some(StreamTitleMatch::Partial),
                Some(Badge::TitlePartial),
                None,
            ),
        ] {
            for is_batch in [false, true] {
                stream.match_summary = Some(StreamMatchSummary {
                    episode,
                    title,
                    pack_coverage: seasons.as_ref().map(|seasons| StreamPackCoverage {
                        seasons: seasons.clone(),
                        episode_ranges: None,
                    }),
                });
                stream.presentation.is_batch = is_batch;
                set_stream_match_badges(&mut stream);
                assert_eq!(
                    stream.match_badge_kinds,
                    badge.into_iter().chain(title_badge).collect::<Vec<_>>()
                );
                assert_eq!(stream.match_tier, tier.or(title_tier));
                assert_eq!(stream.show_pack_badge, is_batch && pack_allowed);
            }
        }
    }
    for is_batch in [false, true] {
        stream.match_summary = None;
        stream.presentation.is_batch = is_batch;
        set_stream_match_badges(&mut stream);
        assert!(stream.match_badge_kinds.is_empty());
        assert_eq!(stream.match_tier, None);
        assert_eq!(stream.show_pack_badge, is_batch);
    }
}

#[test]
fn selector_badge_fields_are_backend_owned_and_serialize_with_the_ui_contract() {
    let mut stream: AddonStream = serde_json::from_value(serde_json::json!({
        "matchBadgeKinds": { "spoofed": true },
        "matchTier": 123,
        "showPackBadge": "true",
    }))
    .unwrap();
    assert!(stream.match_badge_kinds.is_empty());
    assert!(stream.match_tier.is_none());
    assert!(!stream.show_pack_badge);
    stream.match_badge_kinds = vec![
        StreamMatchBadgeKind::Episode,
        StreamMatchBadgeKind::Range,
        StreamMatchBadgeKind::Season,
        StreamMatchBadgeKind::MultiSeason,
        StreamMatchBadgeKind::Title,
        StreamMatchBadgeKind::TitlePartial,
    ];
    stream.match_tier = Some(StreamMatchTier::SeasonPack);
    stream.show_pack_badge = true;
    let dto = serde_json::to_value(&stream).unwrap();
    assert_eq!(
        dto["matchBadgeKinds"],
        serde_json::json!([
            "episode",
            "range",
            "season",
            "multi_season",
            "title",
            "title_partial"
        ])
    );
    assert_eq!(dto["matchTier"], "season_pack");
    assert_eq!(dto["showPackBadge"], true);
    stream.match_tier = None;
    assert_eq!(
        serde_json::to_value(&stream).unwrap()["matchTier"],
        serde_json::Value::Null
    );
    assert_eq!(
        serde_json::to_value([
            StreamMatchTier::Exact,
            StreamMatchTier::EpisodeRange,
            StreamMatchTier::SeasonPack,
            StreamMatchTier::Title,
        ])
        .unwrap(),
        serde_json::json!(["exact", "episode_range", "season_pack", "title"])
    );
}

fn recommendation_reasons(
    stream: &AddonStream,
    inputs: &StreamRecommendationInputs<'_>,
) -> Vec<StreamRecommendationReason> {
    // Single predicate pass shared with the sort key: the previous form
    // re-ran every relevance predicate once for the key and again here.
    let key = stream_recommendation_key(stream, inputs, &mut StreamSignalCache::default());
    let mut reasons = Vec::new();
    recommendation_reasons_from_key(&key, &mut reasons);
    reasons
}

fn build_stream(
    source_name: &str,
    cached: bool,
    url: Option<&str>,
    size_bytes: u64,
) -> AddonStream {
    AddonStream {
        stream_key: format!("s:{source_name}:{url:?}:{size_bytes}"),
        name: Some("1080p Release".to_string()),
        title: Some("2.0 GB".to_string()),
        content_hash: if url.is_none() {
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
        episode_targets: &[],
        canonical_season: None,
        is_final_season: false,
    }
}

fn episode_match_context<'a>(
    title: &'static str,
    episode_targets: &'a [(u32, u32)],
) -> StreamMatchContext<'a> {
    episode_match_context_final(title, episode_targets, false)
}

fn episode_match_context_final<'a>(
    title: &'static str,
    episode_targets: &'a [(u32, u32)],
    is_final_season: bool,
) -> StreamMatchContext<'a> {
    StreamMatchContext {
        media_type: "series",
        title: Some(title),
        episode_targets,
        canonical_season: episode_targets.first().map(|&(season, _)| season),
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

struct RecommendationFixture {
    addon_priorities: HashMap<String, u32>,
    source_health: HashMap<String, u8>,
    family_priorities: HashMap<String, u8>,
    title_affinity: Option<&'static str>,
    match_context: StreamMatchContext<'static>,
    audio_language: Option<&'static str>,
    subtitle_language: Option<&'static str>,
}

impl Default for RecommendationFixture {
    fn default() -> Self {
        let (addon_priorities, source_health, family_priorities) = tied_priorities();
        Self {
            addon_priorities,
            source_health,
            family_priorities,
            title_affinity: None,
            match_context: no_match_context(),
            audio_language: None,
            subtitle_language: None,
        }
    }
}

impl RecommendationFixture {
    fn inputs(&self) -> StreamRecommendationInputs<'_> {
        StreamRecommendationInputs {
            addon_source_priorities: &self.addon_priorities,
            source_health_priorities: &self.source_health,
            stream_family_priorities: &self.family_priorities,
            preferred_title_source_id: self.title_affinity,
            match_context: self.match_context,
            preferred_audio_language: self.audio_language,
            preferred_subtitle_language: self.subtitle_language,
        }
    }
}

// Each case lists (preferred, other); the assertion starts them in reverse order.
macro_rules! recommendation_sort_tests {
    ($($name:ident: |$fixture:ident| $cases:block;)*) => {
        $(
            #[test]
            fn $name() {
                let mut fixture = RecommendationFixture::default();
                let cases = (|$fixture: &mut RecommendationFixture| $cases)(&mut fixture);
                for (preferred, other) in cases {
                    assert_sorts_first_for_test_inputs(&preferred, &other, &fixture.inputs());
                }
            }
        )*
    };
}

recommendation_sort_tests! {
    sorts_prefers_healthier_source_with_same_viability: |fixture| {
        fixture.source_health.insert("beta".to_string(), 0);
        let alpha = sort_stream("alpha");
        let beta = build_stream("beta", true, Some("https://beta.example/video.m3u8"), 2_500);
        [(alpha, beta)]
    };
    sorts_prefers_recently_successful_stream_family_when_health_is_tied: |fixture| {
        fixture.family_priorities.insert("alpha|release:test".to_string(), 4);
        [(sort_stream("alpha"), sort_stream("beta"))]
    };
    sorts_prefers_recent_title_source_when_other_inputs_are_tied: |fixture| {
        fixture.title_affinity = Some("alpha");
        [(sort_stream("alpha"), sort_stream("beta"))]
    };
    sorts_prefers_exact_episode_over_batch_range: |fixture| {
        fixture.match_context = episode_match_context("One Piece", &[(1, 8)]);
        let mut exact = sort_stream("alpha");
        exact.name = Some("One Piece S01E08 1080p".to_string());
        let mut batch = sort_stream("beta");
        batch.name = Some("One Piece S01E01-E12 Batch 1080p".to_string());
        [(exact, batch)]
    };
    sorts_demotes_spinoff_title_even_with_matching_episode: |fixture| {
        fixture.match_context = episode_match_context("Attack on Titan", &[(1, 3)]);
        let mut mainline = sort_stream("alpha");
        mainline.name = Some("Attack on Titan S01E03 1080p".to_string());
        let mut spinoff = sort_stream("beta");
        spinoff.name = Some("Attack on Titan Junior High S01E03 1080p".to_string());
        [(mainline, spinoff)]
    };
    sorts_prefers_language_matching_stream_when_other_inputs_are_tied: |fixture| {
        fixture.audio_language = Some("ja");
        fixture.subtitle_language = Some("off");
        let mut japanese = sort_stream("alpha");
        japanese.name = Some("[JA] Dual Audio 1080p".to_string());
        let mut dubbed = sort_stream("beta");
        dubbed.name = Some("English Dub 1080p".to_string());
        [(japanese, dubbed)]
    };
    sorts_prefers_language_match_over_health_family_affinity_quality: |fixture| {
        fixture.source_health.insert("beta".to_string(), 3);
        fixture.family_priorities.insert("beta|release:test".to_string(), 4);
        fixture.title_affinity = Some("beta");
        fixture.match_context = episode_match_context("Show", &[(1, 5)]);
        fixture.audio_language = Some("en");
        fixture.subtitle_language = Some("en");
        let mut english = sort_stream("alpha");
        english.name = Some("Show S01E05 English 1080p".to_string());
        let mut german = sort_stream("beta");
        german.name = Some("Show S01E05 German 2160p".to_string());
        [(english, german)]
    };
    sorts_prefers_episode_match_over_english_wrong_episode: |fixture| {
        fixture.match_context = episode_match_context("Show", &[(1, 5)]);
        fixture.audio_language = Some("en");
        fixture.subtitle_language = Some("en");
        let mut correct = sort_stream("alpha");
        correct.name = Some("Show S01E05 1080p".to_string());
        let mut wrong = sort_stream("beta");
        wrong.name = Some("Show S01E07 English Dub 2160p".to_string());
        [(correct, wrong)]
    };
    sorts_untagged_release_above_other_audio_language_at_higher_quality: |fixture| {
        fixture.match_context = episode_match_context("Show", &[(1, 5)]);
        fixture.audio_language = Some("en");
        fixture.subtitle_language = Some("en");
        fixture.source_health.insert("beta".to_string(), 3);
        let mut untagged = sort_stream("alpha");
        untagged.name = Some("Show S01E05 1080p WEB-DL".to_string());
        let mut italian = sort_stream("beta");
        italian.name = Some("Show S01E05 2160p REMUX HDR \u{1F1EE}\u{1F1F9}".to_string());
        let mut german_audio = sort_stream("beta");
        german_audio.name = Some("Show S01E05 2160p German audio English subs".to_string());
        [(untagged.clone(), italian), (untagged, german_audio)]
    };
    sorts_original_audio_above_dub_for_japanese_audio_pref: |fixture| {
        fixture.audio_language = Some("ja");
        let mut original = sort_stream("alpha");
        original.name = Some("[Group] Show - 05 (720p)".to_string());
        let mut dub = sort_stream("beta");
        dub.name = Some("[Group] Show - 05 (1080p) English Dub".to_string());
        [(original, dub)]
    };
}

#[test]
fn language_priority_ignores_unspecified_dub_for_english_pref() {
    let prefs = canonicalize_language_prefs(Some("en"), None);
    let fit = |haystack: &str| {
        stream_language_preference_priority(haystack, prefs, detect_stream_flags(haystack), None)
    };
    let score = |haystack: &str| fit(haystack).0;

    assert_eq!(score("German Dub"), score("German"));
    assert_eq!(score("German"), 0);
    assert_eq!(score("Dub"), 0);
    assert!(score("English Dub") > 0);
    for (haystack, conflict) in [
        ("German", true),
        ("German Dub", true),
        ("German audio", true),
        ("de audio", true),
        ("Show S01E05 2160p 🇮🇹", true),
        ("Cidade.de.Deus.2002.1080p.BluRay.x264", false),
        ("La.Casa.de.Papel.S01E01.1080p", false),
        ("[ITA] 2160p", true),
        ("\u{1F1EE}\u{1F1F9}", true),
        ("japanese audio english subs", true),
        ("Dub", false),
        ("1080p", false),
        ("German subs", false),
        ("German English", false),
        ("German Dual Audio", false),
        ("Multi Audio \u{1F1EE}\u{1F1F9}", false),
        ("\u{1F1EC}\u{1F1E7} / \u{1F1EE}\u{1F1F9}", false),
    ] {
        assert_eq!(fit(haystack).1, conflict, "{haystack}");
    }
    let no_audio_pref = canonicalize_language_prefs(None, Some("en"));
    assert!(
        !stream_language_preference_priority(
            "German",
            no_audio_pref,
            detect_stream_flags("German"),
            None
        )
        .1
    );
}

#[test]
fn language_priority_tracks_independent_memberships_without_double_counting() {
    for (haystack, audio, subtitle, expected) in [
        ("eng eng english en", "en", "fr", 4),
        ("english japanese", "en", "ja", 6),
        ("jpn", "en", "ja", 3),
        ("german subtitle", "en", "ja", 1),
        ("dual audio", "en", "ja", 3),
        ("multi audio", "en", "ja", 3),
        ("multi sub", "en", "ja", 1),
        ("dubbed", "en", "off", 2),
        ("english", "en", " OFF ", 4),
        ("en dubbed", "en", "off", 6),
        ("german", "unknown", "unknown", 0),
        ("english", "en", "", 4),
        ("eng", " EN ", "English", 6),
        ("japanese audio english subs", "en", "", 0),
        ("japanese audio english subs", "ja", "en", 6),
        ("japanese audio english subs", "en", "ja", 1),
        ("english audio", "en", "en", 4),
        ("english dub", "en", "en", 4),
        ("english dubbed", "en", "en", 4),
        ("english sub", "en", "en", 3),
        ("english subs", "en", "en", 3),
        ("english subbed", "en", "en", 3),
        ("english subtitle", "en", "en", 3),
        ("english subtitles", "en", "en", 3),
        ("no time to die 1080p", "no", "", 0),
        ("hi score girl", "hi", "", 0),
        ("norwegian audio", "no", "", 4),
        ("hindi", "hi", "hi", 6),
        ("[NL] show s01e05 1080p", "nl", "", 4),
        ("(RU) show s01e05 1080p", "ru", "", 4),
        ("[PL] show s01e05 1080p", "pl", "", 4),
        ("[IT] show s01e05 1080p", "it", "", 4),
        ("[NO] show s01e05 1080p", "no", "", 4),
        ("[HDR] [DV] show s01e05 1080p", "nl", "", 0),
        ("nl show s01e05 1080p", "nl", "", 0),
        ("it follows 1080p", "it", "", 0),
        ("show s01e05 english 2160p", "nl", "", 0),
        ("japanese audio / subtitles: english", "en", "en", 3),
        ("japanese audio / subtitles: english", "ja", "en", 6),
        ("sub: english", "en", "en", 3),
        ("subs english", "en", "en", 3),
        ("subtitle english", "en", "en", 3),
        ("subbed: english", "en", "en", 3),
        ("audio: english", "en", "en", 4),
        ("dub english", "en", "en", 4),
        ("dubbed: english", "en", "en", 4),
        ("subtitles: english / audio: japanese", "en", "en", 3),
        ("subtitles | english", "en", "en", 6),
        ("subtitles unrelated text english", "en", "en", 6),
        ("subtitles: [NL]", "nl", "nl", 3),
        ("(RU) subs", "ru", "ru", 3),
        ("show s01e05 1080p \u{1F1EE}\u{1F1F9}", "it", "", 4),
        ("\u{1F1EC}\u{1F1E7} / \u{1F1EE}\u{1F1F9}", "en", "en", 6),
        ("\u{1F1EC}\u{1F1E7} subs", "en", "en", 3),
        ("subs: \u{1F1EC}\u{1F1E7}", "en", "en", 3),
        ("\u{1F1EF}\u{1F1F5} audio", "ja", "en", 4),
        ("\u{1F1E8}\u{1F1E6}", "en", "en", 0),
        ("\u{1F1EE}\u{1F1F9}", "en", "", 0),
    ] {
        assert_eq!(
            stream_language_preference_priority(
                haystack,
                canonicalize_language_prefs(Some(audio), Some(subtitle)),
                detect_stream_flags(haystack),
                None,
            )
            .0,
            expected,
            "{haystack}, audio={audio}, subtitle={subtitle}"
        );
    }
}

#[test]
fn ranking_language_evidence_excludes_reference_title_words() {
    for (title, language, marker) in [
        ("It Follows", "it", "italian audio"),
        ("La Casa de Papel", "de", "german audio"),
    ] {
        let mut plain = sort_stream("alpha");
        plain.name = Some(format!("{title} 1080p"));
        let fixture = RecommendationFixture {
            match_context: StreamMatchContext {
                title: Some(title),
                ..no_match_context()
            },
            audio_language: Some(language),
            subtitle_language: Some(language),
            ..RecommendationFixture::default()
        };
        let inputs = fixture.inputs();
        for (stream, expected) in [
            (plain.clone(), 0),
            (
                AddonStream {
                    name: Some(format!("{title} 1080p {marker}")),
                    ..plain
                },
                4,
            ),
        ] {
            let key =
                stream_recommendation_key(&stream, &inputs, &mut StreamSignalCache::default());
            assert_eq!(key.language, expected, "{title}, {:?}", stream.name);
        }
    }
}

#[test]
fn stream_audit_labelled_language_overrides_reference_title_suppression() {
    let reference = build_reference_title(Some("English Teacher")).unwrap();
    for (text, expected) in [
        ("english teacher 1080p", 0),
        ("english teacher 1080p english audio", 4),
        ("english teacher 1080p audio: english", 4),
        ("english teacher 1080p english dub", 4),
        ("english teacher 1080p english subtitles", 3),
        ("english teacher 1080p subtitles: english", 3),
        ("english teacher 1080p [en]", 6),
        ("english teacher 1080p [en] subtitles", 3),
    ] {
        assert_eq!(
            stream_language_preference_priority(
                text,
                canonicalize_language_prefs(Some("en"), Some("en")),
                detect_stream_flags(text),
                Some(&reference),
            )
            .0,
            expected,
            "{text}"
        );
    }
    let reference = build_reference_title(Some("English Dub")).unwrap();
    for (text, expected) in [
        ("english dub 1080p", 0),
        ("english.dub.1080p", 0),
        ("english dub 1080p english audio", 4),
        ("english dub 1080p subtitles: english", 3),
        ("english dub 1080p [en]", 6),
    ] {
        assert_eq!(
            stream_language_preference_priority(
                text,
                canonicalize_language_prefs(Some("en"), Some("en")),
                detect_stream_flags(text),
                Some(&reference),
            )
            .0,
            expected,
            "{text}"
        );
    }
}

#[test]
fn title_initialism_keeps_partial_relevance_without_overlap() {
    let reference = build_reference_title(Some("Full Metal Alchemist"));
    let mut stream = sort_stream("alpha");
    stream.name = Some("FMA 1080p".to_string());
    assert_eq!(
        super::stream_title_relevance_score(&stream, "series", reference.as_ref()),
        2
    );
}

#[test]
fn recommendation_reasons_include_title_source_and_language_context() {
    let fixture = RecommendationFixture {
        title_affinity: Some("alpha"),
        audio_language: Some("ja"),
        subtitle_language: Some("off"),
        ..RecommendationFixture::default()
    };
    let mut stream = sort_stream("alpha");
    stream.name = Some("[JA] Dual Audio 1080p".to_string());

    let reasons = recommendation_reasons(&stream, &fixture.inputs());

    assert!(reasons.contains(&StreamRecommendationReason::TitleAffinity));
    assert!(
        reasons.contains(&StreamRecommendationReason::LanguageMatch)
            || reasons.contains(&StreamRecommendationReason::LanguageFlexible)
    );
}

#[test]
fn recommendation_reasons_preserve_order_cap_and_fallback() {
    use StreamRecommendationReason as Reason;
    let baseline = StreamRecommendationKey {
        episode_match: StreamEpisodeMatchKind::None,
        season_claim_verified: false,
        title_match: 0,
        viability: 0,
        audio_language_conflict: std::cmp::Reverse(false),
        language: 0,
        health: 2,
        family: 2,
        title_source_affinity: 0,
        quality: 0,
        language_bonus: 0,
        source_priority: 0,
        oversize: std::cmp::Reverse(false),
        seeders: 0,
        size_bytes: 0,
    };
    let mut reasons = Vec::with_capacity(8);
    reasons.push(Reason::Fallback);
    let allocation = reasons.as_ptr();
    for ((health, family, affinity, language, quality, source_priority), expected) in [
        (
            (3, 4, 1, 4, 400, 1),
            vec![Reason::VerifiedSource, Reason::ProvenReleaseGroup],
        ),
        (
            (1, 1, 1, 4, 400, 1),
            vec![Reason::SourceIssues, Reason::ReleaseGroupIssues],
        ),
        (
            (0, 0, 1, 4, 400, 1),
            vec![Reason::SourceCooling, Reason::ReleaseGroupCooling],
        ),
        (
            (2, 2, 1, 4, 400, 1),
            vec![Reason::TitleAffinity, Reason::LanguageMatch],
        ),
        (
            (2, 2, 0, 2, 250, 1),
            vec![Reason::LanguageFlexible, Reason::GoodQuality],
        ),
        (
            (2, 2, 0, 0, 400, 1),
            vec![Reason::TopQuality, Reason::PreferredSource],
        ),
        (
            (2, 2, 0, 0, 250, 1),
            vec![Reason::GoodQuality, Reason::PreferredSource],
        ),
        ((2, 2, 0, 1, 249, 1), vec![Reason::PreferredSource]),
        ((2, 2, 0, 1, 249, 0), vec![Reason::Fallback]),
    ] {
        let key = StreamRecommendationKey {
            health,
            family,
            title_source_affinity: affinity,
            language,
            quality,
            source_priority,
            ..baseline
        };
        recommendation_reasons_from_key(&key, &mut reasons);
        assert_eq!(reasons, expected);
        assert_eq!(reasons.capacity(), 8);
        assert_eq!(reasons.as_ptr(), allocation);
    }
    for key in [
        StreamRecommendationKey {
            title_match: 2,
            ..baseline
        },
        StreamRecommendationKey {
            episode_match: StreamEpisodeMatchKind::Exact,
            ..baseline
        },
    ] {
        recommendation_reasons_from_key(&key, &mut reasons);
        assert!(reasons.is_empty());
        assert_eq!(reasons.as_ptr(), allocation);
    }
}

#[test]
/// Oversize demotion must actually rank an over-limit stream below an
/// otherwise identical smaller one in the same resolution tier.
fn sorts_at_limit_size_before_oversize_same_tier() {
    use StreamResolution::{P1080, P2160};
    const GIB: u64 = 1024 * 1024 * 1024;
    let fixture = RecommendationFixture {
        addon_priorities: HashMap::new(),
        source_health: HashMap::new(),
        family_priorities: HashMap::new(),
        ..RecommendationFixture::default()
    };
    let inputs = fixture.inputs();

    for (label, resolution, name, sizes, urls) in [
        (
            "1080p: 15 GiB limit",
            P1080,
            "1080p Release",
            [2, 16],
            [
                "https://alpha.example/small.m3u8",
                "https://alpha.example/large.m3u8",
            ],
        ),
        (
            "2160p: strict > 20 GiB boundary",
            P2160,
            "2160p Release",
            [20, 21],
            [
                "https://alpha.example/at-limit.m3u8",
                "https://alpha.example/over.m3u8",
            ],
        ),
    ] {
        let mut streams = Vec::from([0, 1].map(|index| {
            let mut stream = build_stream("alpha", true, Some(urls[index]), sizes[index] * GIB);
            stream.name = Some(name.to_string());
            stream.presentation.resolution = resolution;
            stream
        }));
        streams.reverse();
        sort_streams_by_recommendation(&mut streams, inputs, &mut StreamSignalCache::default());
        assert_eq!(
            streams
                .iter()
                .map(|stream| stream.size_bytes)
                .collect::<Vec<_>>(),
            sizes.map(|size| Some(size * GIB)),
            "{label}"
        );
    }
}

recommendation_sort_tests! {
    // The verified final-season claim beats the higher-quality bare-dash match.
    sorts_prefers_season_claimed_exact_match_over_assumed_higher_quality: |fixture| {
        fixture.match_context = episode_match_context_final("Shingeki no Kyojin", &[(4, 4)], true);
        let mut titled = sort_stream("alpha");
        titled.name = Some("Shingeki no Kyojin - The Final Season - 04 [1080p]".to_string());
        let mut bare = sort_stream("beta");
        bare.name = Some("Shingeki no Kyojin - 04 [2160p]".to_string());
        [(titled, bare)]
    };
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
        episode_targets: &[(3, 5)],
        canonical_season: Some(3),
        is_final_season: true,
    };
    let matched = stream_episode_relevance_priority(&stream, context);
    assert_eq!(matched.kind, StreamEpisodeMatchKind::Exact);
    assert!(matched.season_claim_verified);

    // Query (1,5) vs canonical (3,8): "final season" can only claim
    // season 3, so the query battery must see a conflicting season
    // claim — the canonical battery then finds no E08 either.
    let context = StreamMatchContext {
        episode_targets: &[(1, 5), (3, 8)],
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
    let mut fixture = RecommendationFixture {
        match_context: episode_match_context("One Piece", &[(1, 8)]),
        ..RecommendationFixture::default()
    };

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

    for (pass, expected_source) in ["alpha", "beta", "beta"].into_iter().enumerate() {
        if pass == 1 {
            // Only the growing family priority changes the tied order.
            fixture
                .family_priorities
                .insert("beta|release:test".to_string(), 4);
        } else if pass == 2 {
            streams[0].size_bytes = Some(1);
        }
        sort_streams_by_recommendation(&mut streams, fixture.inputs(), &mut signals);
        assert_eq!(streams[0].source_name.as_deref(), Some(expected_source));
        assert_eq!(streams.capacity(), capacity);
    }
}

#[test]
fn resort_reuses_fetch_context_and_owned_pack_coverage() {
    let fixture = RecommendationFixture {
        match_context: episode_match_context("Show", &[(1, 8)]),
        audio_language: Some("en"),
        subtitle_language: Some("en"),
        ..RecommendationFixture::default()
    };
    let inputs = fixture.inputs();
    let mut pack = sort_stream("alpha");
    pack.stream_key = "s:pack".to_string();
    pack.name = Some("Show S01E01-E12 English 1080p [Batch]".to_string());
    let original = pack.clone();
    let mut streams = vec![pack];
    let mut signals = StreamSignalCache::default();
    rank_stream_by_recommendation(&mut streams[0], inputs, &mut signals);
    let coverage_pointer = streams[0]
        .match_summary
        .as_ref()
        .and_then(|summary| summary.pack_coverage.as_ref())
        .expect("pack coverage")
        .seasons
        .as_ptr();
    assert_eq!(
        streams[0].match_badge_kinds,
        vec![StreamMatchBadgeKind::Range, StreamMatchBadgeKind::Title]
    );
    assert_eq!(streams[0].match_tier, Some(StreamMatchTier::EpisodeRange));
    assert!(!streams[0].show_pack_badge);
    let badge_pointer = streams[0].match_badge_kinds.as_ptr();

    // Even a new arrival uses the title/languages captured by this fetch's cache.
    let mut arrival = sort_stream("beta");
    arrival.stream_key = "s:arrival".to_string();
    arrival.name = Some("Show S01E08 English 1080p".to_string());
    streams.push(arrival);
    let changed_inputs = StreamRecommendationInputs {
        match_context: episode_match_context("Different Title", &[(1, 8)]),
        preferred_audio_language: Some("ja"),
        preferred_subtitle_language: None,
        ..inputs
    };
    sort_streams_by_recommendation(&mut streams, changed_inputs, &mut signals);
    let arrival = streams
        .iter()
        .find(|stream| stream.stream_key == "s:arrival")
        .expect("new arrival");
    let priority = arrival.selection_priority.expect("selection priority");
    assert_eq!(priority.title_match, 4);
    assert_eq!(priority.language, 6);
    let pack = streams
        .iter()
        .find(|stream| stream.stream_key == "s:pack")
        .expect("pack");
    assert_eq!(pack.match_badge_kinds.as_ptr(), badge_pointer);
    assert_eq!(
        pack.match_summary
            .as_ref()
            .and_then(|summary| summary.pack_coverage.as_ref())
            .expect("reused pack coverage")
            .seasons
            .as_ptr(),
        coverage_pointer
    );

    // Final merge reuses cached signals but starts with the unranked addon rows.
    let mut final_streams = vec![original];
    sort_streams_by_recommendation(&mut final_streams, inputs, &mut signals);
    assert_eq!(
        serde_json::to_value(&final_streams[0]).unwrap(),
        serde_json::to_value(pack).unwrap()
    );
    assert!(final_streams[0]
        .match_summary
        .as_ref()
        .and_then(|summary| summary.pack_coverage.as_ref())
        .is_some());
}

#[test]
fn borrowed_preview_ranking_keeps_final_declaration_ties_and_row_allocations() {
    let fixture = RecommendationFixture::default();
    let inputs = fixture.inputs();
    let mut streams = vec![sort_stream("alpha"), sort_stream("beta")];
    for stream in &mut streams {
        stream.stream_key = format!("s:{}", stream.source_id.as_deref().unwrap());
    }
    let pointers: Vec<_> = streams
        .iter()
        .map(|stream| {
            (
                stream.name.as_ref().unwrap().as_ptr(),
                stream.url.as_ref().unwrap().as_ptr(),
            )
        })
        .collect();
    let mut signals = StreamSignalCache::default();
    let mut preview = [1, 0].map(|index| {
        (
            rank_stream_by_recommendation(&mut streams[index], inputs, &mut signals),
            index,
        )
    });
    preview.sort_by_key(|(key, _)| std::cmp::Reverse(*key));
    assert_eq!(preview.map(|(_, index)| index), [1, 0]);

    sort_streams_by_recommendation(&mut streams, inputs, &mut signals);
    assert_eq!(
        streams
            .iter()
            .map(|stream| stream.source_id.as_deref())
            .collect::<Vec<_>>(),
        [Some("alpha"), Some("beta")]
    );
    for (stream, (name, url)) in streams.iter().zip(pointers) {
        assert_eq!(stream.name.as_ref().unwrap().as_ptr(), name);
        assert_eq!(stream.url.as_ref().unwrap().as_ptr(), url);
        assert!(stream.selection_priority.is_some());
    }
}

#[test]
fn sort_assigns_selection_priority_from_key() {
    let fixture = RecommendationFixture {
        match_context: episode_match_context("Show", &[(1, 5)]),
        audio_language: Some("en"),
        subtitle_language: Some("en"),
        ..RecommendationFixture::default()
    };
    let mut exact = sort_stream("alpha");
    exact.name = Some("Show S01E05 English 1080p".to_string());
    let mut other = sort_stream("beta");
    other.name = Some("Show S01E06 1080p".to_string());

    let mut streams = vec![other, exact];
    sort_streams_by_recommendation(
        &mut streams,
        fixture.inputs(),
        &mut StreamSignalCache::default(),
    );

    assert_eq!(
        streams[0].selection_priority,
        Some(SelectionPriority {
            episode_match: StreamEpisodeMatchKind::Exact,
            season_claim_verified: true,
            title_match: 4,
            viability: 1,
            language: 6,
        })
    );
    assert_eq!(
        streams[1].selection_priority,
        Some(SelectionPriority {
            episode_match: StreamEpisodeMatchKind::None,
            season_claim_verified: false,
            title_match: 4,
            viability: 1,
            language: 0,
        })
    );
}

#[test]
fn title_tokenization_preserves_ascii_rules_boundaries_and_word_limit() {
    for (input, stop_at_boundary, expected) in [
        ("A SHOW_É One / 2 | S01E05 bonus", true, "show one 2"),
        (
            "A SHOW_É One / 2 | S01E05 bonus",
            false,
            "show one 2 s01e05 bonus",
        ),
        ("ep A 1", true, ""),
        (
            "one two three four five six seven eight nine ten eleven twelve thirteen",
            false,
            "one two three four five six seven eight nine ten eleven twelve",
        ),
    ] {
        assert_eq!(
            tokenize_title_words(&normalize_token_text(input), stop_at_boundary)
                .collect::<Vec<_>>(),
            expected.split_whitespace().collect::<Vec<_>>(),
            "{input}, stop_at_boundary={stop_at_boundary}"
        );
    }
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
        "cam",
        "camrip",
        "hdcam",
        "hd-cam",
        "telesync",
        "hdts",
        "hd-ts",
        "telecine",
        "hdtc",
        "screener",
        "dvdscr",
    ];
    for spelling in FLAG_SPELLINGS {
        for word in tokenize_title_words(&normalize_token_text(spelling), false) {
            assert!(
                is_title_boundary_token(word) || is_neutral_title_extra(word, "series"),
                "flag spelling `{spelling}` tokenizes to `{word}`, which counts as a title extra"
            );
        }
    }
}

recommendation_sort_tests! {
    // An S01E04 request must not lose to a higher-quality final-season release.
    sorts_titled_final_season_release_below_the_requested_season: |fixture| {
        fixture.match_context = episode_match_context_final("Shingeki no Kyojin", &[(1, 4)], false);
        let mut season_one = sort_stream("alpha");
        season_one.name = Some("Shingeki no Kyojin - 04 [1080p]".to_string());
        let mut final_named = sort_stream("beta");
        final_named.name =
            Some("[SubsPlease] Shingeki no Kyojin - The Final Season - 04 (2160p)".to_string());
        [(season_one, final_named)]
    };
    stream_priority_prefers_user_source_order_when_quality_is_tied: |fixture| {
        fixture.addon_priorities =
            crate::commands::streaming_helpers::build_addon_source_priority_map(&[
                crate::test_helpers::test_addon("alpha", "Alpha"),
                crate::test_helpers::test_addon("beta", "Beta"),
            ]);
        let mut preferred = sort_stream("alpha");
        preferred.seeders = Some(10);
        let mut fallback = sort_stream("beta");
        fallback.seeders = Some(300);
        [(preferred, fallback)]
    };
    stream_priority_prefers_multi_audio_when_other_signals_match: |_fixture| {
        ["Dual Audio Release", "Multi Audio Release"].map(|title| {
            let [preferred, standard] = [("alpha", title), ("beta", "Standard Release")]
                .map(|(source, title)| {
                    let mut stream = sort_stream(source);
                    stream.title = Some(title.into());
                    prepare_addon_streams(vec![stream], source, source)
                        .pop()
                        .unwrap()
                });
            (preferred, standard)
        })
    };
}
