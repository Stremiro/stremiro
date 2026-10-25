use super::history_helpers::{
    WATCH_PROGRESS_FUTURE_SKEW_MS, WATCH_PROGRESS_MAX_RESUME_PROGRESS_RATIO,
};
use super::streaming_helpers::is_persistable_stream_key;
use crate::commands::WatchProgress;
use rusqlite::{
    params, Connection, ErrorCode, OpenFlags, OptionalExtension, Row, Statement, Transaction,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

const RESUME_DB_SCHEMA_VERSION: i32 = 3;
// Small LIMIT/OFFSET values: always fit in `i64` on every target.
/// Newest in-progress rows kept per title. Completed rows are the per-episode watched
/// marks, so this bound never evicts them — a watched season keeps every mark.
const MAX_RESUME_ROWS_PER_TITLE: i64 = 12;
/// Global bound so the resume table can't grow without limit; matches the backup
/// import's history cap so a full restore is never silently truncated.
pub(super) const MAX_RESUME_TOTAL_ENTRIES: i64 = 10_000;

/// Outcome of a guarded single-row save. `pruned` means cap pruning deleted
/// other rows in the same transaction, so cached snapshots may be stale.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProgressWrite {
    Skipped,
    Written { pruned: bool },
}

#[derive(Debug)]
pub(crate) enum HistoryMergeError {
    CapacityExceeded(String),
    Failed(String),
}

impl From<String> for HistoryMergeError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

impl From<HistoryMergeError> for String {
    fn from(error: HistoryMergeError) -> Self {
        match error {
            HistoryMergeError::CapacityExceeded(message) | HistoryMergeError::Failed(message) => {
                message
            }
        }
    }
}

pub(crate) struct ResumeStore {
    connection: Connection,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ResumeTitleIdentity {
    pub id: String,
    pub type_: String,
    pub last_watched: u64,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct ContinueWatchingDismissal {
    pub media_type: String,
    pub media_id: String,
    pub dismissed_through: i64,
}

impl ResumeStore {
    pub(crate) fn open(path: &Path) -> Result<Self, String> {
        Self::reject_unsupported_schema_file(path)?;

        let connection = Connection::open(path)
            .map_err(|error| format!("Failed to open playback resume database: {}", error))?;

        // One shared connection across concurrent commands — wait instead of failing fast with SQLITE_BUSY.
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|error| format!("Failed to open playback resume database: {}", error))?;

        // Re-check before any write: the PRAGMA setup below mutates the file header,
        // so a future-version file swapped in since the read-only probe must be rejected first.
        let version = Self::schema_version(&connection)?;

        connection
            .execute_batch(
                "
                PRAGMA journal_mode = WAL;
                PRAGMA synchronous = NORMAL;
                PRAGMA temp_store = MEMORY;
                PRAGMA foreign_keys = ON;
                ",
            )
            .map_err(|error| format!("Failed to initialize playback resume database: {}", error))?;

        // Only 0 (init below) or `RESUME_DB_SCHEMA_VERSION` reaches here.
        Self::initialize_schema(&connection, version)?;
        connection
            .execute_batch(CONTINUE_WATCHING_DISMISSALS_SQL)
            .map_err(|error| format!("Failed to initialize playback resume database: {error}"))?;

        Ok(Self { connection })
    }

    /// Opens the store, repairing index damage or quarantining header/page corruption.
    /// Unsupported schema versions still fail closed without touching the file.
    pub(crate) fn open_or_quarantine(path: &Path) -> Result<Self, String> {
        let existed = path.exists();
        match Self::open(path) {
            Ok(store) => {
                if !existed {
                    return Ok(store);
                }
                match store.quick_check() {
                    Ok(true) => return Ok(store),
                    Ok(false) => {}
                    Err(error) if Self::is_corruption(&error) => {}
                    Err(error) => {
                        return Err(format!("Failed to check playback resume database: {error}"));
                    }
                }
                match store
                    .connection
                    .execute_batch("REINDEX;")
                    .and_then(|()| store.quick_check())
                {
                    Ok(true) => {
                        crate::operational_log::log_warn("resume-store", "open", "repaired", &[]);
                        return Ok(store);
                    }
                    Ok(false) => {}
                    Err(error) if Self::is_corruption(&error) => {}
                    Err(error) => {
                        return Err(format!(
                            "Failed to repair playback resume database: {error}"
                        ));
                    }
                }
                drop(store);
            }
            Err(_) if Self::is_unreadable_database(path) => {}
            Err(error) => return Err(error),
        }
        Self::quarantine(path)?;
        Self::open(path)
    }

    fn quick_check(&self) -> rusqlite::Result<bool> {
        let mut statement = self.connection.prepare("PRAGMA quick_check")?;
        let mut rows = statement.query([])?;
        let mut count = 0;
        let mut passed = true;
        while let Some(row) = rows.next()? {
            count += 1;
            passed &= row.get_ref(0)? == rusqlite::types::ValueRef::Text(b"ok");
        }
        Ok(passed && count == 1)
    }

    fn is_corruption(error: &rusqlite::Error) -> bool {
        matches!(
            error.sqlite_error_code(),
            Some(ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt)
        )
    }

    /// True only when SQLite reports the file unreadable (not a database / corrupt
    /// header). Version mismatches and busy/permission errors must not be renamed aside.
    fn is_unreadable_database(path: &Path) -> bool {
        if !path.exists() {
            return false;
        }
        let probe = match Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
            Ok(connection) => connection,
            Err(error) => return Self::is_corruption(&error),
        };
        match probe.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0)) {
            Ok(_) => false,
            Err(error) => Self::is_corruption(&error),
        }
    }

    /// Renames the unreadable database aside (`<stem>.corrupt-<millis>`, same convention
    /// as `startup_validation`) and moves its WAL sidecar; SHM is disposable.
    /// A missing WAL is harmless; other WAL failures must prevent recreation.
    fn quarantine(path: &Path) -> Result<(), String> {
        let quarantined = path.with_extension(format!("corrupt-{}", super::now_unix_millis()));
        std::fs::rename(path, &quarantined).map_err(|error| {
            format!("Failed to quarantine unreadable playback resume database: {error}")
        })?;
        let mut wal = path.as_os_str().to_owned();
        wal.push("-wal");
        let mut wal_target = quarantined.as_os_str().to_owned();
        wal_target.push("-wal");
        if let Err(error) = std::fs::rename(&wal, &wal_target) {
            if error.kind() != std::io::ErrorKind::NotFound {
                if let Err(rollback_error) = std::fs::rename(&quarantined, path) {
                    return Err(format!(
                        "Failed to quarantine unreadable playback resume database WAL: {error}; failed to restore database from {}: {rollback_error}",
                        quarantined.display()
                    ));
                }
                return Err(format!(
                    "Failed to quarantine unreadable playback resume database WAL: {error}"
                ));
            }
        }
        crate::operational_log::log_warn("resume-store", "open", "quarantined", &[]);

        let mut shm = path.as_os_str().to_owned();
        shm.push("-shm");
        let _ = std::fs::remove_file(&shm);
        Ok(())
    }

    /// Read-only probe of an existing file's schema version, run before any write —
    /// `open`'s PRAGMA setup mutates the file header, so an unknown-future database
    /// must be rejected without mutation. Missing path = fresh database; skip the probe.
    fn reject_unsupported_schema_file(path: &Path) -> Result<(), String> {
        if path.exists() {
            let probe = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|error| format!("Failed to open playback resume database: {}", error))?;
            Self::schema_version(&probe)?;
        }
        Ok(())
    }

    /// Reads `PRAGMA user_version` and rejects anything that isn't the current schema.
    /// 0 means needs-init, not necessarily fresh — a crash between DDL and the version
    /// stamp leaves tables at version 0; init completes that idempotently.
    fn schema_version(connection: &Connection) -> Result<i32, String> {
        let version: i32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|error| format!("Failed to read playback resume schema version: {}", error))?;
        if version != 0 && version != RESUME_DB_SCHEMA_VERSION {
            return Err(format!(
                "Unsupported playback resume schema version {}.",
                version
            ));
        }
        Ok(version)
    }

    /// Fresh or torn-init database: `IF NOT EXISTS` DDL plus the version stamp in one
    /// transaction, so a crash between the two heals instead of bricking history.
    fn initialize_schema(connection: &Connection, version: i32) -> Result<(), String> {
        if version != 0 {
            return Ok(());
        }
        let init_sql = format!(
            "
            BEGIN IMMEDIATE;

            CREATE TABLE IF NOT EXISTS watch_progress (
                history_key TEXT PRIMARY KEY NOT NULL,
                media_id TEXT NOT NULL,
                media_type TEXT NOT NULL,
                season INTEGER,
                episode INTEGER,
                absolute_season INTEGER,
                absolute_episode INTEGER,
                stream_season INTEGER,
                stream_episode INTEGER,
                position REAL NOT NULL,
                duration REAL NOT NULL,
                last_watched INTEGER NOT NULL,
                title TEXT NOT NULL,
                poster TEXT,
                backdrop TEXT,
                last_stream_url TEXT,
                last_stream_format TEXT,
                last_stream_lookup_id TEXT,
                last_stream_key TEXT,
                source_name TEXT,
                stream_family TEXT,
                source_id TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_watch_progress_title_recency
                ON watch_progress(media_type, media_id, last_watched DESC, history_key DESC);

            CREATE INDEX IF NOT EXISTS idx_watch_progress_media_id_recency
                ON watch_progress(media_id, last_watched DESC, history_key DESC);

            PRAGMA user_version = {version};

            COMMIT;
            ",
            version = RESUME_DB_SCHEMA_VERSION
        );
        connection
            .execute_batch(&init_sql)
            .map_err(|error| format!("Failed to initialize playback resume database: {error}"))
    }

    /// The recency guard (`WHERE excluded.last_watched >= ...`) suppresses stale
    /// writes; callers must not mark their snapshot persisted on `Skipped`.
    pub(crate) fn upsert_progress(
        &mut self,
        key: &str,
        progress: &WatchProgress,
    ) -> Result<ProgressWrite, String> {
        let transaction = self
            .connection
            .transaction()
            .map_err(|error| format!("Failed to open playback resume transaction: {}", error))?;

        let wrote = upsert_progress_tx(&transaction, key, progress)?;
        // Steady-state saves almost never overflow: prune only when caps can be
        // exceeded so a normal tick pays one upsert, not prune scans. A
        // recency-guarded no-op wrote nothing, so nothing can have overflowed.
        let outcome = if wrote {
            let mut pruned = prune_title_history_tx(&transaction, &progress.type_, &progress.id)?;
            if count_history_tx(&transaction)? > MAX_RESUME_TOTAL_ENTRIES {
                pruned |= prune_total_history_tx(&transaction)?;
            }
            ProgressWrite::Written { pruned }
        } else {
            ProgressWrite::Skipped
        };

        transaction
            .commit()
            .map_err(|error| format!("Failed to commit playback resume save: {}", error))?;
        Ok(outcome)
    }

    pub(crate) fn load_entries(&mut self) -> Result<Vec<(String, WatchProgress)>, String> {
        query_progress_rows(
            &self.connection,
            "ORDER BY last_watched DESC, history_key DESC",
            [],
            "",
        )
    }

    pub(crate) fn load_continue_watching_dismissals(
        &mut self,
    ) -> Result<Vec<ContinueWatchingDismissal>, String> {
        self.connection
            .prepare(
                "SELECT media_type, media_id, dismissed_through FROM continue_watching_dismissals
                 ORDER BY media_type, media_id",
            )
            .and_then(|mut statement| {
                statement
                    .query_map([], |row| {
                        Ok(ContinueWatchingDismissal {
                            media_type: row.get(0)?,
                            media_id: row.get(1)?,
                            dismissed_through: row.get(2)?,
                        })
                    })?
                    .collect()
            })
            .map_err(|error| format!("Failed to read Continue Watching dismissals: {error}"))
    }

    /// `load_entries` minus titles dismissed from Continue Watching.
    pub(crate) fn load_continue_watching_entries(
        &mut self,
    ) -> Result<Vec<(String, WatchProgress)>, String> {
        query_progress_rows(
            &self.connection,
            &format!(
                "WHERE NOT EXISTS (
                    SELECT 1 FROM continue_watching_dismissals AS d
                    WHERE d.media_type = watch_progress.media_type
                      AND d.media_id = watch_progress.media_id
                      AND ({EFFECTIVE_DISMISSAL})
                 )
                 ORDER BY last_watched DESC, history_key DESC"
            ),
            [],
            "",
        )
    }

    /// Hides a title from Continue Watching and Up Next until it gains a row newer
    /// than its latest one now; history itself is untouched. No-op without history.
    pub(crate) fn dismiss_continue_watching(
        &mut self,
        media_type: &str,
        media_id: &str,
    ) -> Result<(), String> {
        let transaction = self.connection.transaction().map_err(|error| {
            format!("Failed to open Continue Watching dismissal transaction: {error}")
        })?;
        let inserted = transaction
            .execute(
                "INSERT INTO continue_watching_dismissals (media_type, media_id, dismissed_through)
                 SELECT media_type, media_id, MAX(last_watched) FROM watch_progress
                 WHERE media_type = ?1 AND media_id = ?2
                 GROUP BY media_type, media_id
                 ON CONFLICT(media_type, media_id)
                 DO UPDATE SET dismissed_through = excluded.dismissed_through",
                params![media_type, media_id],
            )
            .map_err(|error| format!("Failed to save Continue Watching dismissal: {error}"))?;
        if inserted > 0 {
            transaction
                .execute(
                    &format!(
                        "DELETE FROM continue_watching_dismissals AS d WHERE NOT ({EFFECTIVE_DISMISSAL})"
                    ),
                    [],
                )
                .and_then(|_| {
                    transaction.execute(
                        "DELETE FROM continue_watching_dismissals WHERE rowid NOT IN (
                            SELECT rowid FROM continue_watching_dismissals
                            ORDER BY (media_type = ?2 AND media_id = ?3) DESC, dismissed_through DESC
                            LIMIT ?1
                        )",
                        params![MAX_CONTINUE_WATCHING_DISMISSALS, media_type, media_id],
                    )
                })
                .map_err(|error| {
                    format!("Failed to prune Continue Watching dismissals: {error}")
                })?;
        }
        transaction
            .commit()
            .map_err(|error| format!("Failed to commit Continue Watching dismissal: {error}"))
    }

    pub(crate) fn restore_continue_watching(
        &mut self,
        media_type: &str,
        media_id: &str,
    ) -> Result<(), String> {
        self.connection
            .execute(
                "DELETE FROM continue_watching_dismissals WHERE media_type = ?1 AND media_id = ?2",
                params![media_type, media_id],
            )
            .map(|_| ())
            .map_err(|error| format!("Failed to restore Continue Watching title: {error}"))
    }

    pub(crate) fn load_latest_title_identities(
        &mut self,
        media_ids: &[&str],
    ) -> Result<Vec<ResumeTitleIdentity>, String> {
        let mut statement = self
            .connection
            .prepare_cached(
                "SELECT media_id, media_type, last_watched FROM watch_progress
                 WHERE media_id = ?1
                   AND typeof(media_type) = 'text'
                   AND typeof(last_watched) = 'integer'
                 ORDER BY last_watched DESC, history_key DESC LIMIT 1",
            )
            .map_err(|error| format!("Failed to prepare playback resume title read: {error}"))?;
        let mut titles = Vec::with_capacity(media_ids.len());
        for media_id in media_ids {
            let title = statement
                .query_row(params![media_id], |row| {
                    Ok(ResumeTitleIdentity {
                        id: row.get(0)?,
                        type_: row.get(1)?,
                        last_watched: from_sql_u64(row.get(2)?),
                    })
                })
                .optional()
                .map_err(|error| format!("Failed to read playback resume title: {error}"))?;
            if let Some(title) = title {
                titles.push(title);
            }
        }
        Ok(titles)
    }

    fn open_read_only(path: &Path) -> Result<Option<Connection>, String> {
        if !path
            .try_exists()
            .map_err(|error| format!("Failed to inspect playback resume database: {}", error))?
        {
            return Ok(None);
        }
        // A WAL reader needs neither the shared writer lock nor store initialization.
        let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| format!("Failed to open playback resume database: {}", error))?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|error| format!("Failed to open playback resume database: {}", error))?;
        Self::schema_version(&connection)?;
        Ok(Some(connection))
    }

    pub(crate) fn load_recent_titles(path: &Path) -> Result<Vec<(String, String)>, String> {
        let Some(connection) = Self::open_read_only(path)? else {
            return Ok(Vec::new());
        };
        let mut statement = connection
            .prepare(
                "SELECT media_type, media_id FROM watch_progress AS w
                 GROUP BY media_type, media_id
                 ORDER BY MAX(last_watched) DESC, (
                     SELECT history_key FROM watch_progress AS latest
                     WHERE latest.media_type = w.media_type AND latest.media_id = w.media_id
                     ORDER BY last_watched DESC, history_key DESC LIMIT 1
                 ) DESC LIMIT 3",
            )
            .map_err(|error| format!("Failed to read recent playback resume titles: {error}"))?;
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .and_then(|rows| rows.collect())
            .map_err(|error| format!("Failed to read recent playback resume titles: {error}"))
    }

    pub(crate) fn load_watched_title_ids(
        path: &Path,
        media_type: &str,
    ) -> Result<HashSet<String>, String> {
        let Some(connection) = Self::open_read_only(path)? else {
            return Ok(HashSet::new());
        };
        let mut statement = connection
            .prepare(
                "SELECT media_id FROM watch_progress WHERE media_type = ?1
                 GROUP BY media_id ORDER BY MAX(last_watched) DESC, media_id
                 LIMIT ?2",
            )
            .map_err(|error| format!("Failed to read watched playback resume titles: {error}"))?;
        statement
            .query_map(params![media_type, MAX_RESUME_TOTAL_ENTRIES], |row| {
                row.get(0)
            })
            .and_then(|rows| rows.collect())
            .map_err(|error| format!("Failed to read watched playback resume titles: {error}"))
    }

    pub(crate) fn count_entries(&mut self) -> Result<usize, String> {
        self.connection
            .query_row("SELECT COUNT(*) FROM watch_progress", [], |row| {
                row.get::<_, i64>(0)
            })
            .map(|count| usize::try_from(count.max(0)).unwrap_or(usize::MAX))
            .map_err(|error| format!("Failed to count playback resume rows: {}", error))
    }

    pub(crate) fn count_titles(&mut self) -> Result<usize, String> {
        self.connection
            .query_row(
                // History collapses by the exact (type, id) tuple, not just id.
                "SELECT COUNT(*) FROM (
                    SELECT DISTINCT media_type, media_id FROM watch_progress
                )",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|count| usize::try_from(count.max(0)).unwrap_or(usize::MAX))
            .map_err(|error| format!("Failed to count playback history titles: {}", error))
    }

    /// Sums saved progress once per canonical episode, choosing its newest storage
    /// alias. Known runtimes cap overruns; unknown keep position; negatives floor at zero.
    pub(crate) fn total_watch_time_secs(&mut self) -> Result<u64, String> {
        self.connection
            .query_row(
                "WITH ranked_progress AS (
                    SELECT position, duration,
                           ROW_NUMBER() OVER (
                               PARTITION BY media_type, media_id,
                                            COALESCE(absolute_season, season),
                                            COALESCE(absolute_episode, episode)
                               ORDER BY last_watched DESC, history_key DESC
                           ) AS episode_rank
                    FROM watch_progress
                )
                SELECT COALESCE(SUM(
                    CASE WHEN duration > 0.0 THEN MIN(MAX(position, 0.0), duration)
                         ELSE MAX(position, 0.0)
                    END
                ), 0.0) FROM ranked_progress WHERE episode_rank = 1",
                [],
                |row| row.get::<_, f64>(0),
            )
            .map(|secs| secs.round().max(0.0) as u64)
            .map_err(|error| format!("Failed to sum playback watch time: {}", error))
    }

    pub(crate) fn load_entries_for_media_id(
        &mut self,
        media_id: &str,
    ) -> Result<Vec<(String, WatchProgress)>, String> {
        query_progress_rows(
            &self.connection,
            "WHERE media_id = ?1 ORDER BY last_watched DESC, history_key DESC",
            params![media_id],
            " media-id",
        )
    }

    pub(crate) fn load_entries_for_title(
        &mut self,
        media_type: &str,
        media_id: &str,
    ) -> Result<Vec<(String, WatchProgress)>, String> {
        query_progress_rows(
            &self.connection,
            "WHERE media_type = ?1 AND media_id = ?2 ORDER BY last_watched DESC, history_key DESC",
            params![media_type, media_id],
            " title",
        )
    }

    /// Superset of canonical and raw-coordinate matches, including every possible donor.
    /// `choose_entry` still resolves conflicting aliases; retain its newest-first tie order.
    pub(crate) fn load_entries_for_episode(
        &mut self,
        media_type: &str,
        media_id: &str,
        season: u32,
        episode: u32,
    ) -> Result<Vec<(String, WatchProgress)>, String> {
        query_progress_rows(
            &self.connection,
            "WHERE media_type = ?1 AND media_id = ?2
               AND (season = ?3 OR absolute_season = ?3)
               AND (episode = ?4 OR absolute_episode = ?4)
             ORDER BY last_watched DESC, history_key DESC",
            params![media_type, media_id, season, episode],
            " episode",
        )
    }

    /// Returns the rows the recency guard admitted, plus whether cap pruning
    /// then deleted any rows (possibly some of those just admitted).
    /// Imports and restores reject growth rather than evicting durable history.
    pub(crate) fn merge_entries(
        &mut self,
        entries: Vec<(String, WatchProgress)>,
        is_backup_import: bool,
        dismissals: Vec<ContinueWatchingDismissal>,
    ) -> Result<(Vec<(String, WatchProgress)>, bool), HistoryMergeError> {
        if entries.is_empty() {
            return Ok((Vec::new(), false));
        }

        let transaction = self.connection.transaction().map_err(|error| {
            format!(
                "Failed to open playback resume merge transaction: {}",
                error
            )
        })?;
        {
            let mut statement = transaction
                .prepare("SELECT history_key FROM watch_progress")
                .map_err(|error| format!("Failed to read playback resume keys: {error}"))?;
            let existing: HashSet<String> = statement
                .query_map([], |row| row.get(0))
                .and_then(|rows| rows.collect())
                .map_err(|error| format!("Failed to read playback resume keys: {error}"))?;
            let new_keys: HashSet<&str> = entries
                .iter()
                .map(|(key, _)| key.as_str())
                .filter(|key| !existing.contains(*key))
                .collect();
            if !new_keys.is_empty()
                && existing.len().saturating_add(new_keys.len()) > MAX_RESUME_TOTAL_ENTRIES as usize
            {
                let action = if is_backup_import {
                    "This backup"
                } else {
                    "Restoring this history"
                };
                return Err(HistoryMergeError::CapacityExceeded(format!(
                    "{action} would exceed the {MAX_RESUME_TOTAL_ENTRIES}-entry watch history limit."
                )));
            }
        }
        // Decide against the destination before any history writes: even a locally
        // restored title must not be hidden again by an imported marker.
        let mut new_title_dismissals = Vec::new();
        if !dismissals.is_empty() {
            let mut statement = transaction
                .prepare(
                    "SELECT EXISTS(SELECT 1 FROM watch_progress
                     WHERE media_type = ?1 AND media_id = ?2)",
                )
                .map_err(|error| format!("Failed to read playback resume titles: {error}"))?;
            let latest_allowed =
                super::now_unix_millis().saturating_add(WATCH_PROGRESS_FUTURE_SKEW_MS);
            for mut dismissal in dismissals {
                let Some(media_type) = super::normalize_watch_progress_type(&dismissal.media_type)
                else {
                    continue;
                };
                let Some(media_id) = super::normalize_media_id(&dismissal.media_id) else {
                    continue;
                };
                if dismissal.dismissed_through < 0
                    || dismissal.dismissed_through as u64 > latest_allowed
                {
                    continue;
                }
                let exists: bool = statement
                    .query_row(params![media_type, media_id], |row| row.get(0))
                    .map_err(|error| format!("Failed to read playback resume titles: {error}"))?;
                if !exists {
                    dismissal.media_type = media_type.to_string();
                    dismissal.media_id = media_id;
                    new_title_dismissals.push(dismissal);
                }
            }
        }
        let mut imported = Vec::new();

        {
            // Prepare once — a bulk import must not re-compile the 22-column upsert per row.
            let mut upsert_statement =
                transaction.prepare(UPSERT_PROGRESS_SQL).map_err(|error| {
                    format!("Failed to prepare playback resume merge upsert: {}", error)
                })?;
            for (key, progress) in entries {
                // The upsert's recency guard is the source of truth — affected-row
                // count reports whether it landed, no separate SELECT.
                if upsert_progress_stmt(&mut upsert_statement, &key, &progress)? == 0 {
                    continue;
                }
                imported.push((key, progress));
            }
        }

        let pruned_titles: HashSet<(&str, &str)> = imported
            .iter()
            .map(|(_, progress)| (progress.type_.as_str(), progress.id.as_str()))
            .collect();
        // One prune per distinct title, not per row — a 10k import over few titles pays a few scans.
        let mut pruned = false;
        for (media_type, media_id) in &pruned_titles {
            pruned |= prune_title_history_tx(&transaction, media_type, media_id)?;
        }

        for dismissal in new_title_dismissals {
            // Keep the original cutoff, not MAX(merged history): newer imported
            // progress must remain visible. Existing local markers always win.
            transaction
                .execute(
                    "INSERT OR IGNORE INTO continue_watching_dismissals
                     (media_type, media_id, dismissed_through)
                     SELECT ?1, ?2, ?3
                     WHERE EXISTS(SELECT 1 FROM watch_progress
                         WHERE media_type = ?1 AND media_id = ?2)
                       AND (SELECT COUNT(*) FROM continue_watching_dismissals) < ?4",
                    params![
                        dismissal.media_type,
                        dismissal.media_id,
                        dismissal.dismissed_through,
                        MAX_CONTINUE_WATCHING_DISMISSALS
                    ],
                )
                .map_err(|error| {
                    format!("Failed to import Continue Watching dismissal: {error}")
                })?;
        }

        transaction
            .commit()
            .map_err(|error| format!("Failed to commit playback resume merge: {}", error))?;

        Ok((imported, pruned))
    }

    pub(crate) fn get_entry(&mut self, key: &str) -> Result<Option<WatchProgress>, String> {
        self.connection
            .prepare_cached(&format!("{WATCH_PROGRESS_SELECT} WHERE history_key = ?1"))
            .and_then(|mut statement| statement.query_row(params![key], read_watch_progress_row))
            .optional()
            .map(|entry| entry.map(|(_, progress)| progress))
            .map_err(|error| format!("Failed to read playback resume entry: {}", error))
    }

    pub(crate) fn remove_keys(&mut self, keys: &[String]) -> Result<(), String> {
        if keys.is_empty() {
            return Ok(());
        }

        let transaction = self.connection.transaction().map_err(|error| {
            format!(
                "Failed to open playback resume delete transaction: {}",
                error
            )
        })?;

        {
            let mut statement = transaction
                .prepare("DELETE FROM watch_progress WHERE history_key = ?1")
                .map_err(|error| format!("Failed to prepare playback resume delete: {}", error))?;

            for key in keys {
                statement.execute(params![key]).map_err(|error| {
                    format!("Failed to delete playback resume entry: {}", error)
                })?;
            }
        }

        transaction
            .commit()
            .map_err(|error| format!("Failed to commit playback resume delete: {}", error))
    }

    pub(crate) fn clear(&mut self) -> Result<(), String> {
        // No VACUUM: it rewrites the whole file (2x disk) while holding the shared
        // connection; freed pages get reused anyway.
        let transaction = self
            .connection
            .transaction()
            .map_err(|error| format!("Failed to clear playback resume database: {}", error))?;
        transaction
            .execute_batch(
                "DELETE FROM watch_progress;
                 DELETE FROM continue_watching_dismissals;",
            )
            .map_err(|error| format!("Failed to clear playback resume database: {}", error))?;
        transaction
            .commit()
            .map_err(|error| format!("Failed to clear playback resume database: {}", error))
    }
}

/// Added alongside schema 3 without a version bump: older builds ignore the table.
/// `dismissed_through` is the title's newest `last_watched` when dismissed.
const CONTINUE_WATCHING_DISMISSALS_SQL: &str = "
    CREATE TABLE IF NOT EXISTS continue_watching_dismissals (
        media_type TEXT NOT NULL,
        media_id TEXT NOT NULL,
        dismissed_through INTEGER NOT NULL,
        PRIMARY KEY (media_type, media_id)
    );";

/// A dismissal `d` holds while its title has history and nothing newer than it.
const EFFECTIVE_DISMISSAL: &str = "
    IFNULL((
        SELECT MAX(w.last_watched) FROM watch_progress AS w
        WHERE w.media_type = d.media_type AND w.media_id = d.media_id
    ), d.dismissed_through + 1) <= d.dismissed_through";

pub(super) const MAX_CONTINUE_WATCHING_DISMISSALS: i64 = 500;

const UPSERT_PROGRESS_SQL: &str = "
    INSERT INTO watch_progress (
        history_key,
        media_id,
        media_type,
        season,
        episode,
        absolute_season,
        absolute_episode,
        stream_season,
        stream_episode,
        position,
        duration,
        last_watched,
        title,
        poster,
        backdrop,
        last_stream_url,
        last_stream_format,
        last_stream_lookup_id,
        last_stream_key,
        source_name,
        stream_family,
        source_id
    ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22
    )
    ON CONFLICT(history_key) DO UPDATE SET
        media_id = excluded.media_id,
        media_type = excluded.media_type,
        season = excluded.season,
        episode = excluded.episode,
        absolute_season = excluded.absolute_season,
        absolute_episode = excluded.absolute_episode,
        stream_season = excluded.stream_season,
        stream_episode = excluded.stream_episode,
        position = excluded.position,
        duration = excluded.duration,
        last_watched = excluded.last_watched,
        title = excluded.title,
        poster = excluded.poster,
        backdrop = excluded.backdrop,
        last_stream_url = excluded.last_stream_url,
        last_stream_format = excluded.last_stream_format,
        last_stream_lookup_id = excluded.last_stream_lookup_id,
        last_stream_key = excluded.last_stream_key,
        source_name = excluded.source_name,
        stream_family = excluded.stream_family,
        source_id = excluded.source_id
    WHERE excluded.last_watched >= watch_progress.last_watched
       OR watch_progress.last_watched > ?23
";

/// One column list for every `watch_progress` read — `read_watch_progress_row`
/// decodes positionally, so all SELECTs keep this exact order.
const WATCH_PROGRESS_SELECT: &str = "\
    SELECT history_key, media_id, media_type, season, episode, \
    absolute_season, absolute_episode, stream_season, stream_episode, \
    position, duration, last_watched, title, poster, backdrop, \
    last_stream_format, last_stream_lookup_id, \
    last_stream_key, source_name, stream_family, source_id \
    FROM watch_progress";

fn upsert_progress_tx(
    transaction: &Transaction<'_>,
    key: &str,
    progress: &WatchProgress,
) -> Result<bool, String> {
    let mut statement = transaction
        .prepare_cached(UPSERT_PROGRESS_SQL)
        .map_err(|error| format!("Failed to prepare playback resume save: {}", error))?;
    // Recency guard reports via affected-row count: 0 means a newer row won.
    Ok(upsert_progress_stmt(&mut statement, key, progress)? > 0)
}

/// Shared prepare+collect for `WATCH_PROGRESS_SELECT` reads; `op` is spliced into error messages.
fn query_progress_rows(
    connection: &Connection,
    sql: &str,
    params: impl rusqlite::Params,
    op: &str,
) -> Result<Vec<(String, WatchProgress)>, String> {
    let mut statement = connection
        .prepare_cached(&format!("{WATCH_PROGRESS_SELECT} {sql}"))
        .map_err(|error| format!("Failed to prepare playback resume{op} read: {}", error))?;

    let mut rows = statement
        .query(params)
        .map_err(|error| format!("Failed to query playback resume{op} rows: {}", error))?;

    let mut entries = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|error| format!("Failed to query playback resume{op} rows: {}", error))?
    {
        match read_watch_progress_row(row) {
            Ok(entry) => entries.push(entry),
            Err(_error) => {
                #[cfg(debug_assertions)]
                eprintln!("[resume_store] dropping undecodable row: {_error}");
            }
        }
    }
    Ok(entries)
}

fn upsert_progress_stmt(
    statement: &mut Statement<'_>,
    key: &str,
    progress: &WatchProgress,
) -> Result<usize, String> {
    // Stream URLs are credential-bearing: the legacy `last_stream_url` column is always
    // NULL; resume re-resolves through opaque identities. The key column follows the same
    // rule — only `h:`/`uh:`/`s:` hash identities persist; legacy `u:` keys embed the raw URL.
    let no_persisted_url: Option<String> = None;
    let persisted_stream_key = progress
        .last_stream_key
        .as_deref()
        .filter(|key| is_persistable_stream_key(key));
    // Recency guard: an older `last_watched` payload must never overwrite a newer row.
    statement
        .execute(params![
            key,
            progress.id,
            progress.type_,
            to_sql_optional_u32(progress.season),
            to_sql_optional_u32(progress.episode),
            to_sql_optional_u32(progress.absolute_season),
            to_sql_optional_u32(progress.absolute_episode),
            to_sql_optional_u32(progress.stream_season),
            to_sql_optional_u32(progress.stream_episode),
            progress.position,
            progress.duration,
            to_sql_i64(progress.last_watched),
            progress.title,
            progress.poster,
            progress.backdrop,
            no_persisted_url,
            progress.last_stream_format,
            progress.last_stream_lookup_id,
            persisted_stream_key,
            progress.source_name,
            progress.stream_family,
            progress.source_id,
            to_sql_i64(super::now_unix_millis().saturating_add(WATCH_PROGRESS_FUTURE_SKEW_MS)),
        ])
        .map_err(|error| format!("Failed to save playback resume row: {}", error))
}

/// Rows of one title that aren't watched marks (completion ratio = the one `is_watched` uses).
const IN_PROGRESS_TITLE_ROWS: &str = "
    FROM watch_progress
    WHERE media_type = ?1 AND media_id = ?2
      AND NOT (duration > 0.0 AND position >= duration * ?3)";

/// Returns whether any row was deleted.
fn prune_title_history_tx(
    transaction: &Transaction<'_>,
    media_type: &str,
    media_id: &str,
) -> Result<bool, String> {
    // Cheap overflow gate: one title's count is an indexed range count — steady-state saves skip the ordered delete.
    let in_progress_count: i64 = transaction
        .prepare_cached(&format!("SELECT COUNT(*) {IN_PROGRESS_TITLE_ROWS}"))
        .and_then(|mut statement| {
            statement.query_row(
                params![
                    media_type,
                    media_id,
                    WATCH_PROGRESS_MAX_RESUME_PROGRESS_RATIO
                ],
                |row| row.get(0),
            )
        })
        .map_err(|error| format!("Failed to count playback resume title rows: {}", error))?;
    if in_progress_count <= MAX_RESUME_ROWS_PER_TITLE {
        return Ok(false);
    }
    let deleted = transaction
        .execute(
            &format!(
                "DELETE FROM watch_progress WHERE history_key IN (
                    SELECT history_key {IN_PROGRESS_TITLE_ROWS}
                    ORDER BY last_watched DESC, history_key DESC
                    LIMIT -1 OFFSET ?4
                )"
            ),
            params![
                media_type,
                media_id,
                WATCH_PROGRESS_MAX_RESUME_PROGRESS_RATIO,
                MAX_RESUME_ROWS_PER_TITLE
            ],
        )
        .map_err(|error| format!("Failed to prune playback resume title rows: {}", error))?;

    Ok(deleted > 0)
}

fn count_history_tx(transaction: &Transaction<'_>) -> Result<i64, String> {
    transaction
        .prepare_cached("SELECT COUNT(*) FROM watch_progress")
        .and_then(|mut statement| statement.query_row([], |row| row.get(0)))
        .map_err(|error| format!("Failed to count playback resume rows: {}", error))
}

/// Returns whether any row was deleted.
fn prune_total_history_tx(transaction: &Transaction<'_>) -> Result<bool, String> {
    let deleted = transaction
        .execute(
            "
            DELETE FROM watch_progress
            WHERE history_key NOT IN (
                SELECT history_key
                FROM watch_progress
                ORDER BY last_watched DESC, history_key DESC
                LIMIT ?1
            )
            ",
            params![MAX_RESUME_TOTAL_ENTRIES],
        )
        .map_err(|error| format!("Failed to prune total playback resume rows: {}", error))?;

    Ok(deleted > 0)
}

/// SQLite REAL can hold Inf/NaN — `serde_json` fails on non-finite `f64`, which would
/// poison the whole IPC payload and any write echoing the row.
fn from_sql_f64(value: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}

fn read_watch_progress_row(row: &Row<'_>) -> rusqlite::Result<(String, WatchProgress)> {
    let history_key = row.get::<_, String>(0)?;
    let progress = WatchProgress {
        id: row.get(1)?,
        type_: row.get(2)?,
        season: from_sql_optional_u32(row.get(3)?),
        episode: from_sql_optional_u32(row.get(4)?),
        absolute_season: from_sql_optional_u32(row.get(5)?),
        absolute_episode: from_sql_optional_u32(row.get(6)?),
        stream_season: from_sql_optional_u32(row.get(7)?),
        stream_episode: from_sql_optional_u32(row.get(8)?),
        position: row.get::<_, f64>(9).map(from_sql_f64)?,
        duration: row.get::<_, f64>(10).map(from_sql_f64)?,
        last_watched: from_sql_u64(row.get::<_, i64>(11)?),
        title: row.get(12)?,
        poster: row.get(13)?,
        backdrop: row.get(14)?,
        last_stream_format: row.get(15)?,
        last_stream_lookup_id: row.get(16)?,
        last_stream_key: row.get(17)?,
        source_name: row.get(18)?,
        stream_family: row.get(19)?,
        source_id: row.get(20)?,
        resume_start_time: None,
        is_watched: false,
        has_started_watching: false,
    };

    Ok((history_key, progress))
}

fn to_sql_optional_u32(value: Option<u32>) -> Option<i64> {
    value.map(i64::from)
}

fn from_sql_optional_u32(value: Option<i64>) -> Option<u32> {
    value.and_then(|value| u32::try_from(value).ok())
}

fn to_sql_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn from_sql_u64(value: i64) -> u64 {
    value.max(0) as u64
}

#[cfg(test)]
mod tests;
