use super::*;
use crate::providers::addons::BehaviorHints;

fn year_match(
    release: &str,
    accepted: &[u16],
    title: &str,
    targets: &[(u32, u32)],
) -> StreamYearMatch {
    let stream = AddonStream {
        title: Some(release.to_string()),
        ..Default::default()
    };
    stream_year_match(stream.match_texts(), accepted, Some(title), targets)
}

#[test]
fn avatar_adaptations_require_compatible_work_years_not_just_episode_numbers() {
    use StreamYearMatch::*;
    for accepted in [&[2005][..], &[2005, 2006][..]] {
        for (release, expected) in [
            (
                "Avatar.The.Last.Airbender.2024.S01E05.2160p.NF.WEB-DL.DV.HDR",
                Conflicting,
            ),
            (
                "Avatar.The.Last.Airbender.S01E05.2024.2160p.NF.WEB-DL.DUAL.DDP5.1.Atmos.DV.HDR.H.265-HHWEB.mkv",
                Conflicting,
            ),
            (
                "Avatar.The.Last.Airbender.2026.S02E01.2160p.NF.WEB-DL",
                Conflicting,
            ),
            (
                "Avatar.The.Last.Airbender.S02E01.2026.2160p.NF.WEB-DL",
                Conflicting,
            ),
            ("Avatar.The.Last.Airbender.S01E05.1080p.BluRay", None),
            ("Avatar.The.Last.Airbender.(2005).S01E05.1080p", Verified),
            ("Avatar (2005-2008) Complete 1080p", Verified),
            ("Avatar (2005–2008) Complete 1080p", Verified),
            (
                "Avatar The Last Airbender Season 1 (2024) 2160p",
                Conflicting,
            ),
            ("Avatar S01E05 1080p (2005)", Verified),
            ("Avatar S01E05 1080p [2024]", None),
            ("Avatar [2005] S01E05 1080p", Verified),
            ("[Group 2024] Avatar 2005 S01E05 1080p", Verified),
            ("(Group 2024) Avatar 2005 S01E05 1080p", Verified),
            ("Avatar (2008-2005) 1080p", None),
            ("Avatar (1950-2005) 1080p", None),
        ] {
            assert_eq!(
                year_match(release, accepted, "Avatar The Last Airbender", &[(1, 5)]),
                expected,
                "{release}"
            );
        }
    }
    assert_eq!(
        year_match("Avatar 2024 S01E05", &[], "Avatar", &[(1, 5)]),
        None
    );
}

#[test]
fn work_years_exclude_episode_subtitles_dimensions_units_and_numeric_title_words() {
    use StreamYearMatch::*;
    for (release, title, accepted, targets, expected) in [
        (
            "Show.S03E04.Summer.1984.1080p.mkv",
            "Show",
            &[2005][..],
            &[(3, 4)][..],
            None,
        ),
        (
            "Show.S03E04.2024.Olympics.1080p.mkv",
            "Show",
            &[2005][..],
            &[(3, 4)][..],
            None,
        ),
        ("Show 1920x1080", "Show", &[2005][..], &[][..], None),
        ("Show 1920×1080", "Show", &[2005][..], &[][..], None),
        ("Show 2048x1080", "Show", &[2005][..], &[][..], None),
        ("Show 3840x2160", "Show", &[2005][..], &[][..], None),
        ("Show 1984abcd", "Show", &[2005][..], &[][..], None),
        ("Show 1950 MB", "Show", &[2005][..], &[][..], None),
        ("Show Part 1950", "Show", &[2005][..], &[][..], None),
        ("Show #1950", "Show", &[2005][..], &[][..], None),
        (
            "Anime - 1950 1080p",
            "Anime",
            &[1999][..],
            &[(1, 1950)][..],
            None,
        ),
        (
            "Blade.Runner.2049.2017.2160p",
            "Blade Runner 2049",
            &[2017][..],
            &[][..],
            Verified,
        ),
        (
            "Blade.Runner.1982.2160p",
            "Blade Runner 2049",
            &[2017][..],
            &[][..],
            Conflicting,
        ),
        ("1917.1080p", "1917", &[2019][..], &[][..], None),
        (
            "Wonder.Woman.1984.1080p",
            "Wonder Woman 1984",
            &[2020][..],
            &[][..],
            None,
        ),
        (
            "Reply.1988.S01E01.1080p",
            "Reply 1988",
            &[2015][..],
            &[(1, 1)][..],
            None,
        ),
        (
            "Blade Runner 2049 2049 1080p",
            "Blade Runner 2049",
            &[2017][..],
            &[][..],
            Conflicting,
        ),
        (
            "Blade Runner 2049\nBlade Runner 2049",
            "Blade Runner 2049",
            &[2017][..],
            &[][..],
            None,
        ),
    ] {
        assert_eq!(
            year_match(release, accepted, title, targets),
            expected,
            "{release}"
        );
    }
    for marker in [
        "S01E05", "S01", "Season 1", "1x05", "E05", "EP05", "1080p", "WEB-DL", "NF", "complete",
    ] {
        assert_eq!(
            year_match(&format!("Show {marker} 2024"), &[2005], "Show", &[(1, 5)]),
            None,
            "{marker}"
        );
    }
    for unit in [
        "b", "kb", "kib", "mb", "mib", "gb", "gib", "tb", "tib", "kbps", "mbps", "hz", "khz",
        "fps", "bit",
    ] {
        assert_eq!(
            year_match(&format!("Show 1950 {unit}"), &[2005], "Show", &[]),
            None,
            "{unit}"
        );
    }
}

#[test]
fn work_year_field_authority_and_any_overlap_are_deterministic() {
    let stream = AddonStream {
        name: Some("Avatar 2005 S01E05".into()),
        title: Some("Avatar 2024 S01E05".into()),
        behavior_hints: Some(BehaviorHints {
            filename: Some("Avatar 2005 S01E05.mkv".into()),
            ..Default::default()
        }),
        ..Default::default()
    };
    assert_eq!(
        stream_year_match(stream.match_texts(), &[2005], Some("Avatar"), &[(1, 5)]),
        StreamYearMatch::Verified
    );
    let stream = AddonStream {
        behavior_hints: None,
        match_text: Default::default(),
        ..stream
    };
    assert!(stream_conflicts_with_work_years(
        stream.match_texts(),
        &[2005],
        Some("Avatar"),
        &[(1, 5)]
    ));
    assert_eq!(
        year_match("Avatar 2024 2005 S01E05", &[2005], "Avatar", &[(1, 5)]),
        StreamYearMatch::Verified
    );
}
