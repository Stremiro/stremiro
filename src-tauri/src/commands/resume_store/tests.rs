use super::{ProgressWrite, ResumeStore};
use crate::commands::history_helpers::{
    should_skip_watch_progress_save, WATCH_PROGRESS_FUTURE_SKEW_MS,
};
use crate::commands::watch_history_commands::{
    prepare_episode_watch_changes, validate_history_batch, WatchedEpisode,
};
use crate::commands::WatchProgress;
use crate::test_helpers::test_progress;
use rusqlite::Connection;

fn sample_progress(last_watched: u64, position: f64) -> WatchProgress {
    WatchProgress {
        id: "tt1234567".to_string(),
        position,
        duration: 3600.0,
        last_watched,
        ..test_progress()
    }
}

fn temp_db_path(tag: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "stremiro-resume-version-{}-{}-{}.sqlite3",
        std::process::id(),
        tag,
        uuid::Uuid::new_v4()
    ))
}

/// Temp sqlite path that removes its file on drop, so a panicking test
/// can't leak state into a later run. `Deref`s to `Path` so `&path` call
/// sites keep working.
struct TempDbPath(std::path::PathBuf);

impl TempDbPath {
    fn new(tag: &str) -> Self {
        Self(temp_db_path(tag))
    }
}

impl std::ops::Deref for TempDbPath {
    type Target = std::path::Path;

    fn deref(&self) -> &std::path::Path {
        self.0.as_path()
    }
}

impl AsRef<std::path::Path> for TempDbPath {
    fn as_ref(&self) -> &std::path::Path {
        self.0.as_path()
    }
}

impl Drop for TempDbPath {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn user_version(path: &std::path::Path) -> i32 {
    Connection::open(path)
        .expect("reopen")
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("read version")
}

/// Temp-dir variant of `TempDbPath` for quarantine tests that need sibling
/// files: removes its whole tree on drop.
struct TempDbDir(std::path::PathBuf);

impl TempDbDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "stremiro-resume-quarantine-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        Self(dir)
    }
}

impl std::ops::Deref for TempDbDir {
    type Target = std::path::Path;

    fn deref(&self) -> &std::path::Path {
        self.0.as_path()
    }
}

impl Drop for TempDbDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn corrupt_siblings(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    std::fs::read_dir(dir)
        .expect("list temp dir")
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("playback_resume.corrupt-"))
        })
        .collect()
}

fn read_entry(store: &mut ResumeStore, key: &str) -> WatchProgress {
    store.get_entry(key).expect("read ok").expect("row present")
}

#[test]
fn episode_prefilter_preserves_canonical_claims_raw_fallback_and_all_donors() {
    use crate::commands::history_helpers::{choose_entry, resume_rows, HistoryEntryQuery};

    let path = TempDbPath::new("episode-candidates");
    let mut store = ResumeStore::open(&path).unwrap();
    store.connection.execute_batch(
        "INSERT INTO watch_progress
         (history_key, media_id, media_type, season, episode, absolute_season, absolute_episode,
          position, duration, last_watched, title, poster, backdrop)
         VALUES
         ('z-stub', 'tt1234567', 'series', 8, 102, 1, 2, 12, 2400, 600, 'stub', NULL, NULL),
         ('donor-a', 'tt1234567', 'series', 7, 202, 1, 2, 1020, 2400, 500, 'donor', 'poster', NULL),
         ('donor-b', 'tt1234567', 'series', 1, 302, NULL, 2, 1020, 2400, 500, 'donor', NULL, 'backdrop'),
         ('raw-conflict', 'tt1234567', 'series', 1, 2, 2, 12, 1800, 2400, 700, 'raw', 'wrong', 'wrong'),
         ('raw-fallback', 'tt1234567', 'series', 3, 4, 9, 14, 1000, 2400, 400, 'fallback', NULL, NULL),
         ('other', 'tt1234567', 'series', 1, 99, 1, 99, 1000, 2400, 800, 'other', NULL, NULL);",
    ).unwrap();
    for (season, episode) in [(1, 2), (2, 12), (3, 4), (9, 14), (1, 302), (0, 0)] {
        let choose = |entries| {
            choose_entry(
                resume_rows(entries),
                HistoryEntryQuery::Exact {
                    media_id: "tt1234567",
                    media_type: "series",
                    season: Some(season),
                    episode: Some(episode),
                },
                None,
            )
        };
        let full = choose(store.load_entries_for_title("series", "tt1234567").unwrap());
        let filtered = choose(
            store
                .load_entries_for_episode("series", "tt1234567", season, episode)
                .unwrap(),
        );
        assert_eq!(
            serde_json::to_value(&filtered).unwrap(),
            serde_json::to_value(&full).unwrap(),
            "episode {season}:{episode}"
        );
        if (season, episode) == (1, 2) {
            let chosen = filtered.unwrap();
            assert_eq!((chosen.season, chosen.episode), (Some(8), Some(102)));
            assert_eq!(chosen.position, 1020.0);
            assert_eq!(chosen.poster.as_deref(), Some("poster"));
            assert_eq!(chosen.backdrop.as_deref(), Some("backdrop"));
        }
    }
}

fn continue_watching_titles(store: &mut ResumeStore) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    store
        .load_continue_watching_entries()
        .unwrap()
        .into_iter()
        .map(|(_, row)| format!("{}:{}", row.type_, row.id))
        .filter(|title| seen.insert(title.clone()))
        .collect()
}

fn dismissal_rows(store: &ResumeStore) -> Vec<(String, String, i64)> {
    let mut statement = store
        .connection
        .prepare(
            "SELECT media_type, media_id, dismissed_through FROM continue_watching_dismissals
             ORDER BY media_type, media_id",
        )
        .unwrap();
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .and_then(|rows| rows.collect())
        .unwrap()
}

#[test]
fn continue_watching_dismissals_hide_titles_until_newer_progress_or_restore() {
    let path = TempDbPath::new("cw-dismissals");
    let mut store = ResumeStore::open(&path).unwrap();
    let save = |store: &mut ResumeStore, type_: &str, id: &str, last_watched: u64| {
        let (season, episode) = if type_ == "series" {
            (Some(1), Some((last_watched / 100) as u32))
        } else {
            (None, None)
        };
        let key = super::super::history_helpers::build_history_key(type_, id, season, episode);
        store
            .upsert_progress(
                &key,
                &WatchProgress {
                    id: id.into(),
                    type_: type_.into(),
                    season,
                    episode,
                    ..sample_progress(last_watched, 120.0)
                },
            )
            .unwrap();
        key
    };
    save(&mut store, "series", "tt1", 100);
    save(&mut store, "series", "tt1", 200);
    let movie_key = save(&mut store, "movie", "tt1", 150);
    save(&mut store, "movie", "tt2", 120);

    // (action, expected rail titles newest first, expected dismissal rows)
    type Step<'a> = (&'a str, &'a [&'a str], &'a [(&'a str, &'a str, i64)]);
    let steps: [Step; 7] = [
        (
            "dismiss series:tt1",
            &["movie:tt1", "movie:tt2"],
            &[("series", "tt1", 200)],
        ),
        (
            "dismiss movie:missing",
            &["movie:tt1", "movie:tt2"],
            &[("series", "tt1", 200)],
        ),
        (
            "reopen",
            &["movie:tt1", "movie:tt2"],
            &[("series", "tt1", 200)],
        ),
        (
            "save series:tt1 300",
            &["series:tt1", "movie:tt1", "movie:tt2"],
            &[("series", "tt1", 200)],
        ),
        (
            "dismiss movie:tt1",
            &["series:tt1", "movie:tt2"],
            &[("movie", "tt1", 150)],
        ),
        (
            "restore movie:tt1",
            &["series:tt1", "movie:tt1", "movie:tt2"],
            &[],
        ),
        (
            "dismiss then delete movie:tt1, dismiss movie:tt2",
            &["series:tt1"],
            &[("movie", "tt2", 120)],
        ),
    ];
    for (action, titles, dismissals) in steps {
        match action {
            "reopen" => {
                drop(store);
                store = ResumeStore::open(&path).unwrap();
            }
            "save series:tt1 300" => {
                save(&mut store, "series", "tt1", 300);
            }
            "dismiss then delete movie:tt1, dismiss movie:tt2" => {
                store.dismiss_continue_watching("movie", "tt1").unwrap();
                store.remove_keys(std::slice::from_ref(&movie_key)).unwrap();
                store.dismiss_continue_watching("movie", "tt2").unwrap();
            }
            _ => {
                let (verb, title) = action.split_once(' ').unwrap();
                let (type_, id) = title.split_once(':').unwrap();
                if verb == "dismiss" {
                    store.dismiss_continue_watching(type_, id).unwrap();
                } else {
                    store.restore_continue_watching(type_, id).unwrap();
                }
            }
        }
        assert_eq!(continue_watching_titles(&mut store), titles, "{action}");
        let expected: Vec<(String, String, i64)> = dismissals
            .iter()
            .map(|(type_, id, through)| (type_.to_string(), id.to_string(), *through))
            .collect();
        assert_eq!(dismissal_rows(&store), expected, "{action}");
    }
    // History itself never loses rows to a dismissal.
    assert_eq!(store.load_entries().unwrap().len(), 4);
    store.clear().unwrap();
    assert!(dismissal_rows(&store).is_empty());

    // A schema-3 database from before dismissals gains the table on open.
    save(&mut store, "movie", "tt2", 130);
    store
        .connection
        .execute_batch("DROP TABLE continue_watching_dismissals;")
        .unwrap();
    drop(store);
    let mut store = ResumeStore::open(&path).unwrap();
    store.dismiss_continue_watching("movie", "tt2").unwrap();
    assert!(continue_watching_titles(&mut store).is_empty());
    assert_eq!(user_version(&path), super::RESUME_DB_SCHEMA_VERSION);
}

#[test]
fn backup_continue_watching_roundtrip_keeps_cutoffs_types_and_local_visibility() {
    use super::super::history_helpers::build_history_key;
    let source_path = TempDbPath::new("backup-cw-source");
    let mut source = ResumeStore::open(&source_path).unwrap();
    for (type_, id) in [
        ("movie", "shared"),
        ("series", "shared"),
        ("movie", "resumed"),
        ("movie", "restored"),
        ("movie", "local-hidden"),
    ] {
        let row = WatchProgress {
            id: id.into(),
            type_: type_.into(),
            ..sample_progress(100, 120.0)
        };
        source
            .upsert_progress(&build_history_key(type_, id, None, None), &row)
            .unwrap();
        if (type_, id) != ("movie", "shared") {
            source.dismiss_continue_watching(type_, id).unwrap();
        }
    }
    source
        .upsert_progress(
            "movie:resumed",
            &WatchProgress {
                id: "resumed".into(),
                type_: "movie".into(),
                ..sample_progress(200, 120.0)
            },
        )
        .unwrap();
    let entries = source.load_entries().unwrap();
    let markers =
        serde_json::to_value(source.load_continue_watching_dismissals().unwrap()).unwrap();
    for fresh in [true, false] {
        let path = TempDbPath::new("backup-cw-destination");
        let mut destination = ResumeStore::open(&path).unwrap();
        if !fresh {
            for (id, last_watched) in [
                ("shared", 300),
                ("resumed", 300),
                ("restored", 50),
                ("local-hidden", 300),
            ] {
                destination
                    .upsert_progress(
                        &format!("movie:{id}"),
                        &WatchProgress {
                            id: id.into(),
                            type_: "movie".into(),
                            ..sample_progress(last_watched, 120.0)
                        },
                    )
                    .unwrap();
            }
            destination
                .dismiss_continue_watching("movie", "restored")
                .unwrap();
            destination
                .restore_continue_watching("movie", "restored")
                .unwrap();
            destination
                .dismiss_continue_watching("movie", "local-hidden")
                .unwrap();
        }
        destination
            .merge_entries(
                entries.clone(),
                true,
                serde_json::from_value(markers.clone()).unwrap(),
            )
            .unwrap();
        drop(destination);
        let mut destination = ResumeStore::open(&path).unwrap();
        let titles = continue_watching_titles(&mut destination);
        assert!(titles.contains(&"movie:shared".into()));
        assert!(titles.contains(&"movie:resumed".into()));
        assert!(!titles.contains(&"series:shared".into()));
        assert!(!titles.contains(&"movie:local-hidden".into()));
        assert_eq!(titles.contains(&"movie:restored".into()), !fresh);
        let expected = if fresh {
            vec![
                ("movie", "local-hidden", 100),
                ("movie", "restored", 100),
                ("movie", "resumed", 100),
                ("series", "shared", 100),
            ]
        } else {
            vec![("movie", "local-hidden", 300), ("series", "shared", 100)]
        };
        assert_eq!(
            dismissal_rows(&destination),
            expected
                .into_iter()
                .map(|(type_, id, through)| (type_.into(), id.into(), through))
                .collect::<Vec<_>>()
        );
    }
}

#[test]
fn backup_continue_watching_rejects_invalid_orphans_and_keeps_local_marker_capacity() {
    let path = TempDbPath::new("backup-cw-bound");
    let mut store = ResumeStore::open(&path).unwrap();
    store
        .connection
        .execute_batch(
            "WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n < 499)
         INSERT INTO watch_progress
             (history_key, media_id, media_type, position, duration, last_watched, title)
         SELECT 'movie:local' || n, 'local' || n, 'movie', 120, 3600, 10, 'Local' FROM ids;
         INSERT INTO continue_watching_dismissals
         SELECT media_type, media_id, last_watched FROM watch_progress;",
        )
        .unwrap();
    let local_markers = dismissal_rows(&store);
    let marker = |type_: &str, id: &str, through| super::ContinueWatchingDismissal {
        media_type: type_.into(),
        media_id: id.into(),
        dismissed_through: through,
    };
    let entries = ["new", "overflow"]
        .into_iter()
        .map(|id| {
            (
                format!("movie:{id}"),
                WatchProgress {
                    id: id.into(),
                    type_: "movie".into(),
                    ..sample_progress(100, 120.0)
                },
            )
        })
        .collect();
    store
        .merge_entries(
            entries,
            true,
            vec![
                marker("movie", "orphan", 100),
                marker("channel", "new", 100),
                marker("movie", " ", 100),
                marker("movie", "new", -1),
                marker("movie", "new", i64::MAX),
                marker("movie", "new", 100),
                marker("movie", "overflow", 100),
            ],
        )
        .unwrap();
    let rows = dismissal_rows(&store);
    assert_eq!(rows.len(), super::MAX_CONTINUE_WATCHING_DISMISSALS as usize);
    assert!(local_markers.iter().all(|row| rows.contains(row)));
    assert!(rows.contains(&("movie".into(), "new".into(), 100)));
    assert_eq!(continue_watching_titles(&mut store), ["movie:overflow"]);
}

#[test]
fn backup_continue_watching_marker_failure_rolls_back_history_and_dismissals() {
    let path = TempDbPath::new("backup-cw-rollback");
    let mut store = ResumeStore::open(&path).unwrap();
    store
        .connection
        .execute_batch(
            "CREATE TRIGGER fail_dismissal BEFORE INSERT ON continue_watching_dismissals
         BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;",
        )
        .unwrap();
    let row = sample_progress(100, 120.0);
    let marker = super::ContinueWatchingDismissal {
        media_type: row.type_.clone(),
        media_id: row.id.clone(),
        dismissed_through: 100,
    };
    assert!(store
        .merge_entries(vec![("movie:tt1234567".into(), row)], true, vec![marker])
        .is_err());
    assert!(store.load_entries().unwrap().is_empty());
    assert!(dismissal_rows(&store).is_empty());
}

#[test]
fn latest_title_identities_keep_recency_alias_ties_and_skip_unrequested_or_corrupt_rows() {
    let path = TempDbPath::new("title-identities");
    let mut store = ResumeStore::open(&path).unwrap();
    for (key, type_, id, last_watched) in [
        ("z-old", "series", "newer", 100),
        ("a-new", "anime", "newer", 200),
        ("a-tie", "series", "tie", 300),
        ("z-tie", "anime", "tie", 300),
        ("z-other", "movie", "other", 400),
        ("a-valid", "series", "corrupt", 100),
        ("zz-invalid", "anime", "corrupt", 300),
        ("a-supported", "series", "unsupported", 100),
        ("z-unsupported", "channel", "unsupported", 200),
        ("a-negative", "series", "negative", 100),
        ("z-negative", "anime", "negative", 200),
    ] {
        store
            .upsert_progress(
                key,
                &WatchProgress {
                    id: id.into(),
                    type_: type_.into(),
                    ..sample_progress(last_watched, 120.0)
                },
            )
            .unwrap();
    }
    store
        .connection
        .execute_batch(
            "UPDATE watch_progress SET last_watched = 'bogus' WHERE history_key = 'zz-invalid';
             UPDATE watch_progress SET last_watched = -2 WHERE history_key = 'a-negative';
             UPDATE watch_progress SET last_watched = -1 WHERE history_key = 'z-negative';",
        )
        .unwrap();
    let ids = [
        "tie",
        "newer",
        "missing",
        "corrupt",
        "unsupported",
        "negative",
    ];
    let mut expected = Vec::new();
    let entries = store.load_entries().unwrap();
    for id in ids {
        if let Some((_, progress)) = entries.iter().find(|(_, progress)| progress.id == id) {
            expected.push(super::ResumeTitleIdentity {
                id: progress.id.clone(),
                type_: progress.type_.clone(),
                last_watched: progress.last_watched,
            });
        }
    }
    let identities = store.load_latest_title_identities(&ids).unwrap();
    assert_eq!(identities, expected);
    assert_eq!(
        identities
            .iter()
            .map(|identity| (
                identity.id.as_str(),
                identity.type_.as_str(),
                identity.last_watched
            ))
            .collect::<Vec<_>>(),
        [
            ("tie", "anime", 300),
            ("newer", "anime", 200),
            ("corrupt", "series", 100),
            ("unsupported", "channel", 200),
            ("negative", "anime", 0),
        ]
    );
    assert!(store.load_latest_title_identities(&[]).unwrap().is_empty());
    assert_eq!(store.count_entries().unwrap(), 11);
}

#[test]
fn recent_titles_break_limit_ties_by_latest_rows_history_key() {
    let path = TempDbPath::new("recent-title-ties");
    let store = ResumeStore::open(&path).unwrap();
    store
        .connection
        .execute_batch(
            "INSERT INTO watch_progress
         (history_key, media_id, media_type, position, duration, last_watched, title)
         VALUES
         ('z-first', 'shared', 'series', 120, 3600, 300, 'Title'),
         ('y-second', 'shared', 'movie', 120, 3600, 300, 'Title'),
         ('a', 'included', 'movie', 120, 3600, 200, 'Title'),
         ('c', 'included', 'movie', 120, 3600, 200, 'Title'),
         ('b', 'excluded', 'movie', 120, 3600, 200, 'Title'),
         ('zz-old', 'excluded', 'movie', 120, 3600, 100, 'Title');",
        )
        .unwrap();
    assert_eq!(
        ResumeStore::load_recent_titles(&path).unwrap(),
        [
            ("series".to_string(), "shared".to_string()),
            ("movie".to_string(), "shared".to_string()),
            ("movie".to_string(), "included".to_string()),
        ]
    );
}

#[test]
fn recent_and_watched_titles_are_bounded_distinct_stable_and_read_only() {
    let path = TempDbPath::new("recent-titles");
    assert!(ResumeStore::load_recent_titles(&path).unwrap().is_empty());
    assert!(ResumeStore::load_watched_title_ids(&path, "movie")
        .unwrap()
        .is_empty());
    assert!(!path.exists());
    let mut store = ResumeStore::open(&path).unwrap();
    assert!(ResumeStore::load_recent_titles(&path).unwrap().is_empty());
    for (key, type_, id, last_watched) in [
        ("a", "movie", "newer", 200),
        ("b", "series", "tie", 200),
        ("c", "series", "tie", 199),
        ("zz", "movie", "newer", 100),
        ("z", "movie", "older", 100),
        ("x", "movie", "oldest", 50),
    ] {
        store
            .upsert_progress(
                key,
                &WatchProgress {
                    id: id.to_string(),
                    type_: type_.to_string(),
                    ..sample_progress(last_watched, 120.0)
                },
            )
            .unwrap();
    }
    assert_eq!(
        ResumeStore::load_recent_titles(&path).unwrap(),
        [
            ("series".to_string(), "tie".to_string()),
            ("movie".to_string(), "newer".to_string()),
            ("movie".to_string(), "older".to_string()),
        ]
    );
    assert_eq!(
        ResumeStore::load_watched_title_ids(&path, "movie").unwrap(),
        ["newer", "older", "oldest"]
            .map(str::to_string)
            .into_iter()
            .collect()
    );
    assert_eq!(
        ResumeStore::load_watched_title_ids(&path, "series").unwrap(),
        ["tie"].map(str::to_string).into_iter().collect()
    );
    assert!(ResumeStore::load_watched_title_ids(&path, "anime")
        .unwrap()
        .is_empty());
    let reader = ResumeStore::open_read_only(&path).unwrap().unwrap();
    assert!(reader.execute("DELETE FROM watch_progress", []).is_err());
    assert_eq!(store.count_entries().unwrap(), 6);
    drop(reader);
    store
        .connection
        .execute_batch("PRAGMA user_version = 999")
        .unwrap();
    assert!(ResumeStore::load_recent_titles(&path).is_err());
    assert!(ResumeStore::load_watched_title_ids(&path, "movie").is_err());
    assert_eq!(user_version(&path), 999);
}

#[test]
fn watched_title_query_bounds_oversized_history_to_newest_titles() {
    let path = TempDbPath::new("watched-limit");
    let mut store = ResumeStore::open(&path).unwrap();
    let transaction = store.connection.transaction().unwrap();
    for index in 0..=super::MAX_RESUME_TOTAL_ENTRIES {
        transaction
            .execute(
                "INSERT INTO watch_progress (
                    history_key, media_id, media_type, position, duration, last_watched, title
                 ) VALUES (?1, ?1, 'movie', 120, 3600, ?2, 'Title')",
                rusqlite::params![index.to_string(), index],
            )
            .unwrap();
    }
    transaction.commit().unwrap();
    let watched = ResumeStore::load_watched_title_ids(&path, "movie").unwrap();
    assert_eq!(watched.len(), super::MAX_RESUME_TOTAL_ENTRIES as usize);
    assert!(!watched.contains("0"));
    assert!(watched.contains(&super::MAX_RESUME_TOTAL_ENTRIES.to_string()));
}

#[test]
fn history_title_count_collapses_episodes_but_keeps_media_types_distinct() {
    let path = TempDbPath::new("title-count");
    let mut store = ResumeStore::open(&path).expect("open db");
    assert_eq!(store.count_titles().expect("empty count"), 0);
    for (key, type_, episode) in [
        ("series:tt1234567:1:1", "series", Some(1)),
        ("series:tt1234567:1:2", "series", Some(2)),
        ("movie:tt1234567", "movie", None),
    ] {
        let row = WatchProgress {
            type_: type_.to_string(),
            season: episode.map(|_| 1),
            episode,
            ..sample_progress(1_000, 120.0)
        };
        store.upsert_progress(key, &row).expect("seed history");
    }
    assert_eq!(store.count_entries().expect("raw row count"), 3);
    assert_eq!(store.count_titles().expect("collapsed title count"), 2);
}

#[test]
fn watched_marks_do_not_overwrite_another_canonical_episode_at_a_raw_key() {
    for requested in [vec![4], vec![4, 15], vec![14, 4], vec![4, 14]] {
        let path = TempDbPath::new("remapped-key-collision");
        let mut store = ResumeStore::open(&path).expect("open db");
        let prior = WatchProgress {
            type_: "series".to_string(),
            season: Some(1),
            episode: Some(4),
            absolute_season: Some(1),
            absolute_episode: Some(14),
            ..sample_progress(1_000, 120.0)
        };
        let key = crate::commands::history_helpers::build_history_key(
            &prior.type_,
            &prior.id,
            prior.season,
            prior.episode,
        );
        assert_eq!(key, "series:tt1234567:1:4");
        store
            .upsert_progress(&key, &prior)
            .expect("seed remapped episode");
        let item = crate::test_helpers::test_media_item("tt1234567", "series");
        let episodes: Vec<_> = requested
            .iter()
            .map(|&episode| WatchedEpisode { season: 1, episode })
            .collect();
        let error = prepare_episode_watch_changes(
            &item,
            &episodes,
            store.load_entries().expect("read rows"),
            true,
            2_000,
        )
        .expect_err("conflicting episode mapping");
        assert_eq!(
            error,
            "Some episodes couldn't be marked because of a conflicting saved episode."
        );
        let retained = read_entry(&mut store, &key);
        assert_eq!(retained.absolute_episode, Some(14));
        assert_eq!(retained.episode, Some(4));
        assert_eq!(retained.duration, prior.duration);
        assert_eq!(retained.position, prior.position);
        assert_eq!(store.count_entries().unwrap(), 1);
    }
}

#[test]
fn watched_marks_preserve_remapped_storage_identity_and_unwatched_deletes_it() {
    let path = TempDbPath::new("remapped-watched");
    let mut store = ResumeStore::open(&path).expect("open db");
    let mut prior = sample_progress(1_000, 120.0);
    prior.type_ = "series".to_string();
    prior.season = Some(1);
    prior.episode = Some(4);
    prior.absolute_season = Some(1);
    prior.absolute_episode = Some(14);
    let key = "series:tt1234567:1:4";
    store
        .upsert_progress(key, &prior)
        .expect("seed remapped episode");
    let mut item = crate::test_helpers::test_media_item("tt1234567", "series");
    item.title = "Updated title".into();
    item.poster = Some("https://img.example/poster.jpg".into());
    item.backdrop = Some("https://img.example/backdrop.jpg".into());
    let episodes = [
        WatchedEpisode {
            season: 1,
            episode: 14,
        },
        WatchedEpisode {
            season: 1,
            episode: 15,
        },
    ];
    let (writes, deletes, _) = prepare_episode_watch_changes(
        &item,
        &episodes,
        store.load_entries().expect("read rows"),
        true,
        2_000,
    )
    .expect("prepare watched episodes");
    assert!(deletes.is_empty());
    assert_eq!(writes[0].0, key);
    assert_eq!(writes[0].1.season, Some(1));
    assert_eq!(writes[0].1.episode, Some(4));
    assert_eq!(writes[0].1.absolute_episode, Some(14));
    assert_eq!(writes[0].1.duration, 3600.0);
    assert_eq!(writes[0].1.position, 3600.0);
    assert_eq!(writes[1].1.duration, 1.0);
    for (_, row) in &writes {
        assert_eq!(row.title, item.title);
        assert_eq!(row.poster, item.poster);
        assert_eq!(row.backdrop, item.backdrop);
    }
    assert!(writes[0].1.last_watched < writes[1].1.last_watched);
    store
        .merge_entries(writes, false, Vec::new())
        .expect("mark watched");
    assert_eq!(store.count_entries().expect("count rows"), 2);
    assert!(store
        .get_entry("series:tt1234567:1:14")
        .expect("canonical key")
        .is_none());
    assert_eq!(store.total_watch_time_secs().expect("watch time"), 3601);

    let (writes, deletes, _) = prepare_episode_watch_changes(
        &item,
        &episodes[..1],
        store.load_entries().expect("read rows"),
        false,
        3_000,
    )
    .expect("prepare unwatched episodes");
    assert!(writes.is_empty());
    assert_eq!(deletes, [key]);
    store.remove_keys(&deletes).expect("mark unwatched");
    assert!(store.get_entry(key).expect("read removed key").is_none());
    assert_eq!(store.count_entries().expect("only episode 15 remains"), 1);
}

#[test]
fn season_watch_undo_restores_every_raw_episode_donor() {
    for watched in [false, true] {
        let path = TempDbPath::new("season-donor-undo");
        let mut store = ResumeStore::open(&path).expect("open db");
        let item = crate::test_helpers::test_media_item("tt1234567", "series");
        let episodes = [WatchedEpisode {
            season: 1,
            episode: 14,
        }];
        for episode in [4, 14, 15] {
            let row = WatchProgress {
                type_: "series".into(),
                season: Some(1),
                episode: Some(episode),
                absolute_season: Some(1),
                absolute_episode: Some(if episode == 4 { 14 } else { episode }),
                last_stream_key: Some(format!("stream-{episode}")),
                resume_start_time: Some(f64::from(episode)),
                ..sample_progress(1_000 + u64::from(episode), f64::from(episode) * 10.0)
            };
            store
                .upsert_progress(&format!("series:tt1234567:1:{episode}"), &row)
                .expect("seed episode");
        }
        let before = store.load_entries().expect("read raw rows");
        let progress =
            crate::commands::watch_history_commands::build_title_watch_progress_with_priorities(
                before.iter().map(|(_, row)| row.clone()).collect(),
                None,
            );
        assert_eq!(progress.episode_progress.len(), 2);
        let expected: Vec<_> = before
            .iter()
            .filter(|(_, row)| row.absolute_episode == Some(14))
            .map(|(_, row)| row.clone())
            .collect();
        let (writes, deletes, previous_rows) =
            prepare_episode_watch_changes(&item, &episodes, before.clone(), watched, 2_000)
                .expect("prepare season change");
        assert_eq!(previous_rows.len(), 2);
        assert_eq!(
            serde_json::to_value(&previous_rows).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
        if watched {
            store
                .merge_entries(writes, false, Vec::new())
                .expect("mark watched");
            let (_, deletes, _) = prepare_episode_watch_changes(
                &item,
                &episodes,
                store.load_entries().unwrap(),
                false,
                3_000,
            )
            .unwrap();
            store.remove_keys(&deletes).expect("undo watched mark");
        } else {
            assert!(writes.is_empty());
            assert_eq!(deletes.len(), 2);
            store.remove_keys(&deletes).expect("mark unwatched");
        }
        validate_history_batch(previous_rows.iter()).expect("restore within row cap");
        let restored = previous_rows
            .into_iter()
            .map(|row| {
                let row = crate::commands::history_helpers::sanitize_watch_progress(row).unwrap();
                let key = crate::commands::history_helpers::build_history_key(
                    &row.type_,
                    &row.id,
                    row.season,
                    row.episode,
                );
                (key, row)
            })
            .collect();
        store
            .merge_entries(restored, false, Vec::new())
            .expect("undo restore");
        assert_eq!(
            serde_json::to_value(store.load_entries().unwrap()).unwrap(),
            serde_json::to_value(before).unwrap()
        );
    }
}

#[test]
fn undo_restores_more_than_500_rows_in_one_merge() {
    let path = TempDbPath::new("large-undo");
    let mut store = ResumeStore::open(&path).expect("open db");
    let rows: Vec<_> = (1..=501)
        .map(|episode| {
            let mut row = sample_progress(1_000 + u64::from(episode), 3600.0);
            row.type_ = "series".to_string();
            row.season = Some(1);
            row.episode = Some(episode);
            (format!("series:tt1234567:1:{episode}"), row)
        })
        .collect();
    validate_history_batch(rows.iter().map(|(_, row)| row)).expect("single-title restore accepted");
    store
        .merge_entries(rows.clone(), false, Vec::new())
        .expect("seed title");
    store
        .remove_keys(&rows.iter().map(|(key, _)| key.clone()).collect::<Vec<_>>())
        .expect("remove title");
    assert_eq!(store.count_entries().expect("empty history"), 0);
    store
        .merge_entries(rows.clone(), false, Vec::new())
        .expect("restore title");
    assert_eq!(store.count_entries().expect("restored history"), 501);
    // Bulk History Undo restores several titles in one batch.
    let mut mixed = rows;
    mixed[0].1.id = "another-title".to_string();
    validate_history_batch(mixed.iter().map(|(_, row)| row)).expect("multi-title restore accepted");
    let oversized = vec![mixed[0].1.clone(); super::MAX_RESUME_TOTAL_ENTRIES as usize + 1];
    assert!(validate_history_batch(oversized.iter()).is_err());
}

#[test]
fn open_initializes_v3_and_rejects_future_versions_without_clobbering() {
    let path = TempDbPath::new("future");
    ResumeStore::open(&path).expect("fresh db opens as v3");
    let version = user_version(&path);
    assert_eq!(version, 3);
    // Second open on the same v3 file must succeed.
    drop(ResumeStore::open(&path).expect("v3 reopen ok"));

    for version in [1, 2, 4] {
        Connection::open(&path)
            .expect("open for bump")
            .execute_batch(&format!("PRAGMA user_version = {version};"))
            .expect("stamp unsupported version");
        let bytes_before = std::fs::read(&path).expect("read file");
        let error = match ResumeStore::open(&path) {
            Ok(_) => panic!("v{version} must be rejected"),
            Err(error) => error,
        };
        assert!(
            error.contains(&format!(
                "Unsupported playback resume schema version {version}"
            )),
            "unexpected error: {error}"
        );
        // The rejected open must not have restamped the version and must
        // not have mutated the file at all (read-only probe only).
        let still = user_version(&path);
        assert_eq!(still, version);
        assert_eq!(
            std::fs::read(&path).expect("read file"),
            bytes_before,
            "rejected open must leave the file byte-identical"
        );
        // The read-only probe must not leave WAL/SHM/journal sidecars behind.
        for suffix in ["-wal", "-shm", "-journal"] {
            let mut sidecar = path.as_os_str().to_owned();
            sidecar.push(suffix);
            assert!(
                !std::path::Path::new(&sidecar).exists(),
                "no {suffix} sidecar may remain"
            );
        }
    }
}

#[test]
fn torn_init_without_version_stamp_heals_instead_of_bricking() {
    let path = TempDbPath::new("torninit");
    {
        let mut store = ResumeStore::open(&path).expect("fresh db opens");
        store
            .upsert_progress("movie:tt1234567", &sample_progress(5000, 300.0))
            .expect("seed ok");
    }
    // Simulate a crash between schema DDL and the version stamp: tables
    // and rows exist but `user_version` is still 0.
    Connection::open(&path)
        .expect("raw open")
        .execute_batch("PRAGMA user_version = 0;")
        .expect("simulate torn stamp");
    let mut store = ResumeStore::open(&path).expect("torn v0 heals to v3");
    let version = user_version(&path);
    assert_eq!(version, 3);
    let kept = store
        .get_entry("movie:tt1234567")
        .expect("read ok")
        .expect("seeded row survives the heal");
    assert_eq!(kept.last_watched, 5000);
}

#[test]
fn stale_progress_write_does_not_regress_resume() {
    let path = TempDbPath::new("recency");
    let mut store = ResumeStore::open(&path).expect("fresh db opens");
    let wrote = store
        .upsert_progress("movie:tt1234567", &sample_progress(2000, 900.0))
        .expect("newer write ok");
    assert_eq!(
        wrote,
        ProgressWrite::Written { pruned: false },
        "newer row lands"
    );
    let wrote = store
        .upsert_progress("movie:tt1234567", &sample_progress(1000, 100.0))
        .expect("stale write is a no-op, not an error");
    assert_eq!(
        wrote,
        ProgressWrite::Skipped,
        "recency guard reports no row written"
    );
    let kept = read_entry(&mut store, "movie:tt1234567");
    assert_eq!(kept.last_watched, 2000);
    assert_eq!(kept.position, 900.0);

    let now = crate::commands::now_unix_millis();
    let incoming = sample_progress(now, 900.0);
    for (skew, skipped) in [
        (60_000, true),
        (WATCH_PROGRESS_FUTURE_SKEW_MS + 60_000, false),
    ] {
        let existing = sample_progress(now + skew, 900.0);
        store
            .upsert_progress("movie:tt1234567", &existing)
            .expect("future row lands");
        assert_eq!(
            should_skip_watch_progress_save(&existing, &incoming),
            skipped
        );
        assert_eq!(
            store
                .upsert_progress("movie:tt1234567", &incoming)
                .expect("clock-corrected write succeeds"),
            if skipped {
                ProgressWrite::Skipped
            } else {
                ProgressWrite::Written { pruned: false }
            }
        );
        assert_eq!(
            read_entry(&mut store, "movie:tt1234567").last_watched,
            if skipped { existing.last_watched } else { now }
        );
    }
}

#[test]
fn explicit_live_completion_survives_reopening_without_a_schema_change() {
    use crate::commands::history_helpers::{
        prepare_live_watch_progress, with_progress_annotations,
    };
    let path = TempDbPath::new("live-completion");
    let key = "movie:tt1234567";
    let mut store = ResumeStore::open(&path).unwrap();
    store
        .upsert_progress(key, &sample_progress(1000, 900.0))
        .unwrap();
    assert!(
        prepare_live_watch_progress(sample_progress(2000, 0.0), false)
            .unwrap()
            .is_none()
    );
    assert_eq!(read_entry(&mut store, key).position, 900.0);

    let completed = prepare_live_watch_progress(
        WatchProgress {
            duration: 0.0,
            ..sample_progress(3000, 120.0)
        },
        true,
    )
    .unwrap()
    .unwrap();
    store.upsert_progress(key, &completed).unwrap();
    drop(store);
    let mut store = ResumeStore::open(&path).unwrap();
    let ended = with_progress_annotations(read_entry(&mut store, key));
    assert!(ended.is_watched);
    assert_eq!(ended.duration, ended.position);
    assert_eq!(ended.resume_start_time, None);
    assert_eq!(
        store
            .upsert_progress(key, &sample_progress(1500, 800.0))
            .unwrap(),
        ProgressWrite::Skipped
    );
    assert_eq!(user_version(&path), 3);
}

#[test]
fn upsert_drops_url_shaped_stream_keys() {
    let path = TempDbPath::new("keyshape");
    let mut store = ResumeStore::open(&path).expect("fresh db opens");
    for (key, expected) in [
        ("u:https://cdn.example/legacy.mp4?sig=abc:0", None),
        ("uh:0123456789abcdef:0", Some("uh:0123456789abcdef:0")),
        (
            "s:0123456789abcdef0123456789abcdef",
            Some("s:0123456789abcdef0123456789abcdef"),
        ),
    ] {
        let mut progress = sample_progress(4000, 200.0);
        progress.last_stream_key = Some(key.to_string());
        store
            .upsert_progress("movie:tt1234567", &progress)
            .expect("write ok");
        assert_eq!(
            read_entry(&mut store, "movie:tt1234567")
                .last_stream_key
                .as_deref(),
            expected
        );
    }
}

#[test]
fn history_merge_rejects_capacity_growth_before_writing_any_rows() {
    let path = TempDbPath::new("mergecap");
    let mut store = ResumeStore::open(&path).unwrap();
    let rows = (0..super::MAX_RESUME_TOTAL_ENTRIES - 1)
        .map(|index| {
            (
                format!("movie:tt{index}"),
                WatchProgress {
                    id: format!("tt{index}"),
                    type_: "movie".to_string(),
                    ..sample_progress(1, 10.0)
                },
            )
        })
        .collect();
    store.merge_entries(rows, true, Vec::new()).unwrap();
    let added = WatchProgress {
        id: "added".to_string(),
        type_: "movie".to_string(),
        ..sample_progress(2, 20.0)
    };
    store
        .merge_entries(
            vec![
                ("movie:added".to_string(), added.clone()),
                ("movie:added".to_string(), added),
            ],
            true,
            Vec::new(),
        )
        .expect("duplicate incoming keys count once");
    let update = WatchProgress {
        id: "tt0".to_string(),
        type_: "movie".to_string(),
        ..sample_progress(3, 30.0)
    };
    store
        .merge_entries(
            vec![("movie:tt0".to_string(), update.clone())],
            true,
            Vec::new(),
        )
        .expect("existing keys fit at capacity");
    let (mut writes, _, _) = prepare_episode_watch_changes(
        &crate::test_helpers::test_media_item("tt1234567", "series"),
        &[WatchedEpisode {
            season: 1,
            episode: 1,
        }],
        Vec::new(),
        true,
        4,
    )
    .unwrap();
    writes.push((
        "movie:tt0".to_string(),
        WatchProgress {
            last_watched: 4,
            ..update
        },
    ));
    let error = store
        .merge_entries(writes, true, Vec::new())
        .expect_err("growth must not evict local history");
    assert!(String::from(error).contains("10000"));
    assert_eq!(
        store.count_entries().unwrap(),
        super::MAX_RESUME_TOTAL_ENTRIES as usize
    );
    assert_eq!(read_entry(&mut store, "movie:tt0").last_watched, 3);
    assert!(store.get_entry("series:tt1234567:1:1").unwrap().is_none());
}

#[test]
fn history_undo_rejects_growth_after_other_titles_fill_the_store() {
    let path = TempDbPath::new("undocap");
    let mut store = ResumeStore::open(&path).unwrap();
    let removed = (
        "movie:removed".to_string(),
        WatchProgress {
            id: "removed".into(),
            type_: "movie".into(),
            ..sample_progress(1, 10.0)
        },
    );
    store
        .merge_entries(vec![removed.clone()], false, Vec::new())
        .unwrap();
    store.remove_keys(std::slice::from_ref(&removed.0)).unwrap();
    let rows = (0..super::MAX_RESUME_TOTAL_ENTRIES)
        .map(|index| {
            (
                format!("movie:tt{index}"),
                WatchProgress {
                    id: format!("tt{index}"),
                    type_: "movie".into(),
                    ..sample_progress(2, 20.0)
                },
            )
        })
        .collect();
    store.merge_entries(rows, false, Vec::new()).unwrap();
    let before = store.load_entries().unwrap();
    let error = store
        .merge_entries(vec![removed], false, Vec::new())
        .unwrap_err();
    assert!(matches!(
        error,
        super::HistoryMergeError::CapacityExceeded(_)
    ));
    assert_eq!(
        String::from(error),
        "Restoring this history would exceed the 10000-entry watch history limit."
    );
    assert_eq!(
        serde_json::to_value(store.load_entries().unwrap()).unwrap(),
        serde_json::to_value(before).unwrap()
    );
    assert!(store.get_entry("movie:removed").unwrap().is_none());
}

#[test]
fn total_history_is_bounded_to_newest_entries() {
    let path = TempDbPath::new("totalcap");
    {
        let mut store = ResumeStore::open(&path).expect("fresh db opens");
        store
            .upsert_progress("movie:tt0000000", &sample_progress(1, 10.0))
            .expect("seed ok");
    }
    {
        let raw = Connection::open(&path).expect("raw open");
        raw.execute_batch("PRAGMA journal_mode = WAL;")
            .expect("wal");
        let tx = raw.unchecked_transaction().expect("raw tx");
        {
            let mut stmt = tx
                .prepare(
                    "INSERT OR REPLACE INTO watch_progress (
                            history_key, media_id, media_type, position, duration,
                            last_watched, title
                        ) VALUES (?1, ?2, 'movie', 10.0, 3600.0, ?3, 'Bulk')",
                )
                .expect("prepare bulk");
            for index in 1..=super::MAX_RESUME_TOTAL_ENTRIES + 500 {
                stmt.execute(rusqlite::params![
                    format!("movie:tt{:07}", index),
                    format!("tt{:07}", index),
                    index,
                ])
                .expect("bulk insert");
            }
        }
        tx.commit().expect("commit bulk");
    }
    let mut store = ResumeStore::open(&path).expect("reopen ok");
    let mut newest = sample_progress(9_999_999, 10.0);
    newest.id = "tt9999999".to_string();
    assert_eq!(
        store
            .upsert_progress("movie:tt9999999", &newest)
            .expect("newest write triggers prune"),
        ProgressWrite::Written { pruned: true }
    );
    let count = store.count_entries().expect("count ok");
    assert_eq!(count as i64, super::MAX_RESUME_TOTAL_ENTRIES);
    assert!(store.get_entry("movie:tt9999999").expect("read").is_some());
    assert!(store.get_entry("movie:tt0000000").expect("read").is_none());
}

#[test]
fn title_prune_keeps_every_watched_mark() {
    // A fully watched 24-episode season plus 14 partial rows: every watched
    // mark survives and only the in-progress overflow is evicted.
    let path = TempDbPath::new("titlecap");
    let mut store = ResumeStore::open(&path).expect("open db");
    for episode in 1..=24u32 {
        let mut watched = sample_progress(u64::from(episode), 3_600.0);
        watched.type_ = "series".to_string();
        watched.season = Some(1);
        watched.episode = Some(episode);
        store
            .upsert_progress(&format!("series:tt1234567:1:{episode}"), &watched)
            .expect("write watched");
    }
    for episode in 1..=14u32 {
        let mut partial = sample_progress(100 + u64::from(episode), 600.0);
        partial.type_ = "series".to_string();
        partial.season = Some(2);
        partial.episode = Some(episode);
        let outcome = store
            .upsert_progress(&format!("series:tt1234567:2:{episode}"), &partial)
            .expect("write partial");
        let pruned = i64::from(episode) > super::MAX_RESUME_ROWS_PER_TITLE;
        assert_eq!(
            outcome,
            ProgressWrite::Written { pruned },
            "episode={episode}"
        );
    }

    let rows = store
        .load_entries_for_title("series", "tt1234567")
        .expect("title rows");
    let watched = rows.iter().filter(|(_, row)| row.season == Some(1)).count();
    let partial: Vec<u32> = rows
        .iter()
        .filter(|(_, row)| row.season == Some(2))
        .filter_map(|(_, row)| row.episode)
        .collect();
    assert_eq!(watched, 24);
    assert_eq!(partial.len() as i64, super::MAX_RESUME_ROWS_PER_TITLE);
    assert!(!partial.contains(&1) && !partial.contains(&2));
}

#[test]
fn total_watch_time_secs_caps_at_duration_and_keeps_unknown_runtime_rows() {
    // A row past its runtime is corrupt — count the runtime, not the
    // overrun; a row with no known runtime keeps its raw position; a
    // negative position floors at zero.
    let path = TempDbPath::new("watchtime");
    let mut store = ResumeStore::open(&path).expect("open db");
    assert_eq!(store.total_watch_time_secs().expect("empty sum"), 0);

    let mut watched_full = sample_progress(1_000, 1_380.0);
    watched_full.id = "tt1".to_string();
    watched_full.type_ = "series".to_string();
    watched_full.season = Some(1);
    watched_full.episode = Some(4);
    watched_full.absolute_season = Some(1);
    watched_full.absolute_episode = Some(14);
    watched_full.duration = 1_380.0;
    store
        .upsert_progress("series:tt1:1:4", &watched_full)
        .expect("write watched_full");

    let mut overrun = sample_progress(1_000, 2_000.0);
    overrun.id = "tt2".to_string();
    overrun.type_ = "series".to_string();
    overrun.season = Some(1);
    overrun.episode = Some(1);
    overrun.duration = 1_500.0;
    store
        .upsert_progress("series:tt2:1:1", &overrun)
        .expect("write overrun");

    let mut unknown_runtime = sample_progress(1_000, 120.0);
    unknown_runtime.id = "tt3".to_string();
    unknown_runtime.type_ = "movie".to_string();
    unknown_runtime.duration = 0.0;
    store
        .upsert_progress("movie:tt3", &unknown_runtime)
        .expect("write unknown_runtime");

    let mut negative = sample_progress(1_000, -30.0);
    negative.id = "tt4".to_string();
    negative.type_ = "movie".to_string();
    negative.duration = 0.0;
    store
        .upsert_progress("movie:tt4", &negative)
        .expect("write negative");

    assert_eq!(
        store.total_watch_time_secs().expect("sum ok"),
        1_380 + 1_500 + 120
    );

    let mut canonical_alias = watched_full.clone();
    canonical_alias.episode = Some(14);
    canonical_alias.position = 600.0;
    canonical_alias.last_watched = 2_000;
    store
        .upsert_progress("series:tt1:1:14", &canonical_alias)
        .expect("write newer canonical alias");
    assert_eq!(
        store.total_watch_time_secs().expect("deduplicated sum"),
        600 + 1_500 + 120
    );

    let mut sibling = canonical_alias.clone();
    sibling.episode = Some(15);
    sibling.absolute_episode = Some(15);
    sibling.position = 200.0;
    store
        .upsert_progress("series:tt1:1:15", &sibling)
        .expect("write distinct episode");
    assert_eq!(
        store.total_watch_time_secs().expect("distinct episode sum"),
        600 + 200 + 1_500 + 120
    );

    canonical_alias.episode = Some(5);
    canonical_alias.position = 900.0;
    store
        .upsert_progress("series:tt1:1:5", &canonical_alias)
        .expect("write recency tie");
    assert_eq!(
        store.total_watch_time_secs().expect("stable recency tie"),
        900 + 200 + 1_500 + 120
    );
}

#[test]
fn corrupt_row_drops_only_itself_and_non_finite_position_clamps() {
    let path = TempDbPath::new("corruptrow");
    let mut store = ResumeStore::open(&path).expect("open db");
    store
        .upsert_progress("movie:tt1234567", &sample_progress(1_000, 300.0))
        .expect("write good row");
    store
        .upsert_progress("series:tt1234567:1:2", &sample_progress(2_000, 600.0))
        .expect("write doomed row");

    // SQLite is dynamically typed: a TEXT storage class in an INTEGER-read
    // column is the corrupt-row case (legacy writes, manual edits).
    store
        .connection
        .execute(
            "UPDATE watch_progress SET last_watched = 'bogus' \
             WHERE history_key = 'series:tt1234567:1:2'",
            [],
        )
        .expect("corrupt the row");
    // A non-finite REAL must clamp to a serializable value instead of
    // failing the read or serializing as `null` over IPC.
    store
        .connection
        .execute(
            "UPDATE watch_progress SET position = 9e999 \
             WHERE history_key = 'movie:tt1234567'",
            [],
        )
        .expect("set non-finite position");

    let entries = store
        .load_entries()
        .expect("list read survives corrupt row");
    let keys: Vec<&str> = entries.iter().map(|(key, _)| key.as_str()).collect();
    assert_eq!(keys, ["movie:tt1234567"]);

    let scoped = store
        .load_entries_for_media_id("tt1234567")
        .expect("scoped read survives corrupt row");
    assert_eq!(scoped.len(), 1);

    let clamped = read_entry(&mut store, "movie:tt1234567");
    assert_eq!(clamped.position, 0.0);
}

#[test]
fn query_step_error_fails_history_read() {
    let path = TempDbPath::new("steperror");
    let mut store = ResumeStore::open(&path).expect("open db");
    store
        .upsert_progress("movie:tt1234567", &sample_progress(1_000, 300.0))
        .expect("write good row");

    let error = super::query_progress_rows(
        &store.connection,
        "ORDER BY abs(-9223372036854775808)",
        [],
        "",
    )
    .expect_err("SQLite step errors must fail the read");
    assert!(
        error.contains("Failed to query playback resume rows: integer overflow"),
        "unexpected error: {error}"
    );
}

#[test]
fn unreadable_database_file_is_quarantined_and_recreated() {
    let dir = TempDbDir::new();
    let path = dir.join("playback_resume.sqlite3");
    let garbage = vec![0xABu8; 4096];
    std::fs::write(&path, &garbage).expect("write garbage db");

    let store = ResumeStore::open_or_quarantine(&path).expect("unreadable db heals");
    drop(store);
    assert_eq!(user_version(&path), 3);

    let quarantined = corrupt_siblings(&dir);
    assert_eq!(quarantined.len(), 1, "exactly one quarantined sibling");
    assert_eq!(
        std::fs::read(&quarantined[0]).expect("read quarantined file"),
        garbage,
        "quarantined file keeps the original bytes"
    );
}

#[test]
fn corrupt_table_page_with_intact_header_is_quarantined_and_recreated() {
    use std::io::{Seek, SeekFrom, Write};

    let dir = TempDbDir::new();
    let path = dir.join("playback_resume.sqlite3");
    let mut store = ResumeStore::open(&path).expect("open db");
    for index in 0..400 {
        let progress = WatchProgress {
            id: format!("tt{index}"),
            type_: "movie".to_string(),
            ..sample_progress(1_000, 300.0)
        };
        store
            .upsert_progress(&format!("movie:{}", progress.id), &progress)
            .expect("seed table pages");
    }
    assert_eq!(store.count_entries().expect("count seeded rows"), 400);
    drop(store);

    let connection = Connection::open(&path).expect("open for checkpoint");
    connection
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .expect("checkpoint table pages");
    let page_size: u32 = connection
        .query_row("PRAGMA page_size", [], |row| row.get(0))
        .expect("read page size");
    let root_page: u32 = connection
        .query_row(
            "SELECT rootpage FROM sqlite_master WHERE name = 'watch_progress'",
            [],
            |row| row.get(0),
        )
        .expect("find table root page");
    assert!(root_page > 1, "table root is not the database header");
    drop(connection);

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .expect("open table page for corruption");
    file.seek(SeekFrom::Start(
        u64::from(root_page - 1) * u64::from(page_size),
    ))
    .expect("seek to table root");
    file.write_all(&[0xAB; 12])
        .expect("corrupt table b-tree header");
    drop(file);
    assert_eq!(user_version(&path), 3, "database header stays readable");

    let mut store = ResumeStore::open_or_quarantine(&path).expect("table corruption heals");
    assert_eq!(
        corrupt_siblings(&dir).len(),
        1,
        "table damage is quarantined"
    );
    assert_eq!(store.count_entries().expect("count fresh rows"), 0);
    store
        .upsert_progress("movie:tt1234567", &sample_progress(2_000, 600.0))
        .expect("fresh store accepts progress");
    assert_eq!(store.count_entries().expect("count new row"), 1);
}

#[test]
fn unsupported_schema_version_fails_without_quarantine() {
    let dir = TempDbDir::new();
    let path = dir.join("playback_resume.sqlite3");
    ResumeStore::open(&path).expect("fresh db opens as v3");
    Connection::open(&path)
        .expect("open for bump")
        .execute_batch("PRAGMA user_version = 99;")
        .expect("stamp unsupported version");
    let bytes_before = std::fs::read(&path).expect("read file");

    let error = match ResumeStore::open_or_quarantine(&path) {
        Ok(_) => panic!("v99 must be rejected"),
        Err(error) => error,
    };
    assert!(
        error.contains("Unsupported playback resume schema version 99"),
        "unexpected error: {error}"
    );
    assert!(path.exists(), "rejected file stays in place");
    assert_eq!(
        std::fs::read(&path).expect("read file"),
        bytes_before,
        "rejected open leaves the file byte-identical"
    );
    assert!(corrupt_siblings(&dir).is_empty(), "no quarantined sibling");
}
