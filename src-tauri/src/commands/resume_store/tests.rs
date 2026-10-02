use super::ResumeStore;
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

fn read_entry(store: &mut ResumeStore, key: &str) -> WatchProgress {
    store.get_entry(key).expect("read ok").expect("row present")
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
    let item = crate::test_helpers::test_media_item("tt1234567", "series");
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
    let (writes, deletes) = prepare_episode_watch_changes(
        &item,
        &episodes,
        store.load_entries().expect("read rows"),
        true,
        2_000,
    );
    assert!(deletes.is_empty());
    assert_eq!(writes[0].0, key);
    assert_eq!(writes[0].1.season, Some(1));
    assert_eq!(writes[0].1.episode, Some(4));
    assert_eq!(writes[0].1.absolute_episode, Some(14));
    assert_eq!(writes[0].1.duration, 3600.0);
    assert_eq!(writes[0].1.position, 3600.0);
    assert_eq!(writes[1].1.duration, 1.0);
    assert!(writes[0].1.last_watched < writes[1].1.last_watched);
    store.merge_entries(writes).expect("mark watched");
    assert_eq!(store.count_entries().expect("count rows"), 2);
    assert!(store
        .get_entry("series:tt1234567:1:14")
        .expect("canonical key")
        .is_none());
    assert_eq!(store.total_watch_time_secs().expect("watch time"), 3601);

    let (writes, deletes) = prepare_episode_watch_changes(
        &item,
        &episodes[..1],
        store.load_entries().expect("read rows"),
        false,
        3_000,
    );
    assert!(writes.is_empty());
    assert_eq!(deletes, [key]);
    store.remove_keys(&deletes).expect("mark unwatched");
    assert!(store.get_entry(key).expect("read removed key").is_none());
    assert_eq!(store.count_entries().expect("only episode 15 remains"), 1);
}

#[test]
fn undo_restores_more_than_500_rows_for_one_title_in_one_merge() {
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
    store.merge_entries(rows.clone()).expect("seed title");
    store
        .remove_keys(&rows.iter().map(|(key, _)| key.clone()).collect::<Vec<_>>())
        .expect("remove title");
    assert_eq!(store.count_entries().expect("empty history"), 0);
    store.merge_entries(rows.clone()).expect("restore title");
    assert_eq!(store.count_entries().expect("restored history"), 501);
    let mut mixed = rows;
    mixed[0].1.id = "another-title".to_string();
    assert!(validate_history_batch(mixed.iter().map(|(_, row)| row)).is_err());
}

#[test]
fn open_initializes_v3_and_rejects_future_versions_without_clobbering() {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    fn file_hash(path: &std::path::Path) -> u64 {
        let bytes = std::fs::read(path).expect("read file");
        let mut hasher = DefaultHasher::new();
        bytes.hash(&mut hasher);
        hasher.finish()
    }
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
        let digest_before = file_hash(&path);
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
            file_hash(&path),
            digest_before,
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
    assert!(wrote, "newer row lands");
    let wrote = store
        .upsert_progress("movie:tt1234567", &sample_progress(1000, 100.0))
        .expect("stale write is a no-op, not an error");
    assert!(!wrote, "recency guard reports no row written");
    let kept = read_entry(&mut store, "movie:tt1234567");
    assert_eq!(kept.last_watched, 2000);
    assert_eq!(kept.position, 900.0);
}

#[test]
fn upsert_drops_url_shaped_stream_keys() {
    let path = TempDbPath::new("keyshape");
    let mut store = ResumeStore::open(&path).expect("fresh db opens");
    let mut progress = sample_progress(4000, 200.0);
    progress.last_stream_key = Some("u:https://cdn.example/legacy.mp4?sig=abc:0".to_string());
    store
        .upsert_progress("movie:tt1234567", &progress)
        .expect("write ok");
    let kept = read_entry(&mut store, "movie:tt1234567");
    assert_eq!(kept.last_stream_key, None);

    // Opaque hash identities (`h:`/`uh:`) and the prepared `s:` selector key
    // still persist — the `s:` form is what fresh rows carry.
    progress.last_stream_key = Some("uh:0123456789abcdef:0".to_string());
    progress.last_watched = 5000;
    store
        .upsert_progress("movie:tt1234567", &progress)
        .expect("write ok");
    let kept = read_entry(&mut store, "movie:tt1234567");
    assert_eq!(
        kept.last_stream_key.as_deref(),
        Some("uh:0123456789abcdef:0")
    );

    progress.last_stream_key = Some("s:0123456789abcdef0123456789abcdef".to_string());
    progress.last_watched = 6000;
    store
        .upsert_progress("movie:tt1234567", &progress)
        .expect("write ok");
    let kept = read_entry(&mut store, "movie:tt1234567");
    assert_eq!(
        kept.last_stream_key.as_deref(),
        Some("s:0123456789abcdef0123456789abcdef")
    );
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
    store
        .upsert_progress("movie:tt9999999", &newest)
        .expect("newest write triggers prune");
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
        store
            .upsert_progress(&format!("series:tt1234567:2:{episode}"), &partial)
            .expect("write partial");
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
    watched_full.duration = 1_380.0;
    store
        .upsert_progress("series:tt1:1:1", &watched_full)
        .expect("write watched_full");

    let mut overrun = sample_progress(1_000, 2_000.0);
    overrun.duration = 1_500.0;
    store
        .upsert_progress("series:tt2:1:1", &overrun)
        .expect("write overrun");

    let mut unknown_runtime = sample_progress(1_000, 120.0);
    unknown_runtime.duration = 0.0;
    store
        .upsert_progress("movie:tt3", &unknown_runtime)
        .expect("write unknown_runtime");

    let mut negative = sample_progress(1_000, -30.0);
    negative.duration = 0.0;
    store
        .upsert_progress("movie:tt4", &negative)
        .expect("write negative");

    assert_eq!(
        store.total_watch_time_secs().expect("sum ok"),
        1_380 + 1_500 + 120
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
