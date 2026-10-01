use super::history_helpers::WATCH_PROGRESS_MAX_RESUME_PROGRESS_RATIO;
use super::streaming_helpers::is_persistable_stream_key;
use crate::commands::WatchProgress;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Row, Statement, Transaction};
use std::path::Path;
use std::time::Duration;

const RESUME_DB_SCHEMA_VERSION: i32 = 3;
// Small LIMIT/OFFSET values: always fit in `i64` on every target.
/// Newest in-progress rows kept per title. Completed rows are the per-episode
/// watched marks, so this bound never evicts them — a fully watched season
/// must keep every mark, not just the newest dozen.
const MAX_RESUME_ROWS_PER_TITLE: i64 = 12;
/// Global bound so the resume table cannot grow without limit. Matches the
/// backup import's history cap so a full restore is never silently truncated.
const MAX_RESUME_TOTAL_ENTRIES: i64 = 10_000;

pub(crate) struct ResumeStore {
    connection: Connection,
}

impl ResumeStore {
    pub(crate) fn open(path: &Path) -> Result<Self, String> {
        Self::reject_unsupported_schema_file(path)?;

        let connection = Connection::open(path)
            .map_err(|error| format!("Failed to open playback resume database: {}", error))?;

        // The resume store is shared across concurrent Tauri commands on one
        // connection. Wait instead of failing fast with SQLITE_BUSY.
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|error| format!("Failed to open playback resume database: {}", error))?;

        // Re-check before any write: the PRAGMA setup below mutates the file
        // header, so a future-version file swapped in between the read-only
        // probe and this open must be rejected before it runs.
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

        // Any version reaching here is 0 (initialized below) or
        // `RESUME_DB_SCHEMA_VERSION`: nothing else survives either version
        // check, keeping the no-mutation guarantee.
        Self::initialize_schema(&connection, version)?;

        Ok(Self { connection })
    }

    /// Read-only probe of an existing file's schema version, run before any
    /// write: the PRAGMA/journal-mode setup in `open` mutates the file
    /// header, so an unknown-future database must be rejected without
    /// mutation. A missing path means a fresh database — a read-only probe
    /// would report version 0 identically, so skip it and let the writer
    /// create the file. Read-only also keeps hot-journal/WAL recovery from
    /// mutating a foreign file before the version check runs.
    fn reject_unsupported_schema_file(path: &Path) -> Result<(), String> {
        if path.exists() {
            let probe = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|error| format!("Failed to open playback resume database: {}", error))?;
            Self::schema_version(&probe)?;
        }
        Ok(())
    }

    /// Read `PRAGMA user_version` and reject anything that is not the
    /// current schema: 0 means needs-init, not necessarily fresh — a crash
    /// between schema DDL and the version stamp leaves tables present with
    /// `user_version` still 0, and the init below completes that
    /// idempotently. Older and future versions alike are rejected before
    /// any write so an unrecognized file is never partially rewritten.
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

    /// Fresh or torn-init database: `IF NOT EXISTS` DDL plus the version
    /// stamp in one transaction, so a retry after a crash between the two
    /// heals instead of bricking history as an unsupported version. The
    /// stamp comes from the constant so a bump can't leave a stale version.
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

    /// Returns whether the upsert actually wrote the row: the recency guard
    /// (`WHERE excluded.last_watched >= ...`) suppresses stale writes, and
    /// callers must not mark their in-memory snapshot persisted on a no-op.
    pub(crate) fn upsert_progress(
        &mut self,
        key: &str,
        progress: &WatchProgress,
    ) -> Result<bool, String> {
        let transaction = self
            .connection
            .transaction()
            .map_err(|error| format!("Failed to open playback resume transaction: {}", error))?;

        let wrote = upsert_progress_tx(&transaction, key, progress)?;
        // Steady-state saves (one key, ~15s cadence) almost never overflow:
        // prune only titles/counts that can actually exceed their caps so a
        // normal tick pays one upsert, not two prune scans plus deletes.
        prune_title_history_tx(&transaction, &progress.type_, &progress.id)?;
        if count_history_tx(&transaction)? > MAX_RESUME_TOTAL_ENTRIES {
            prune_total_history_tx(&transaction)?;
        }

        transaction
            .commit()
            .map_err(|error| format!("Failed to commit playback resume save: {}", error))?;
        Ok(wrote)
    }

    pub(crate) fn load_entries(&mut self) -> Result<Vec<(String, WatchProgress)>, String> {
        let mut statement = self
            .connection
            .prepare(&format!(
                "{WATCH_PROGRESS_SELECT} ORDER BY last_watched DESC, history_key DESC"
            ))
            .map_err(|error| format!("Failed to prepare playback resume read: {}", error))?;

        let rows = statement
            .query_map([], read_watch_progress_row)
            .map_err(|error| format!("Failed to query playback resume rows: {}", error))?;

        Ok(collect_progress_rows(rows))
    }

    pub(crate) fn count_entries(&mut self) -> Result<usize, String> {
        self.connection
            .query_row("SELECT COUNT(*) FROM watch_progress", [], |row| {
                row.get::<_, i64>(0)
            })
            .map(|count| usize::try_from(count.max(0)).unwrap_or(usize::MAX))
            .map_err(|error| format!("Failed to count playback resume rows: {}", error))
    }

    /// "Hours watched" sums the raw per-episode rows in SQL — decoding every
    /// row to add positions would pay a full-table scan for one number. The
    /// CASE mirrors the row-level contract: corrupt overruns count the
    /// runtime, rows with no known runtime keep their raw position, and
    /// negative positions floor at zero.
    pub(crate) fn total_watch_time_secs(&mut self) -> Result<u64, String> {
        self.connection
            .query_row(
                "SELECT COALESCE(SUM(
                    CASE WHEN duration > 0.0 THEN MIN(MAX(position, 0.0), duration)
                         ELSE MAX(position, 0.0)
                    END
                ), 0.0) FROM watch_progress",
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
        let mut statement = self
            .connection
            .prepare(&format!(
                "{WATCH_PROGRESS_SELECT} WHERE media_id = ?1 ORDER BY last_watched DESC, history_key DESC"
            ))
            .map_err(|error| {
                format!("Failed to prepare playback resume media-id read: {}", error)
            })?;

        let rows = statement
            .query_map(params![media_id], read_watch_progress_row)
            .map_err(|error| format!("Failed to query playback resume media-id rows: {}", error))?;

        Ok(collect_progress_rows(rows))
    }

    pub(crate) fn load_entries_for_title(
        &mut self,
        media_type: &str,
        media_id: &str,
    ) -> Result<Vec<(String, WatchProgress)>, String> {
        let mut statement = self
            .connection
            .prepare(&format!(
                "{WATCH_PROGRESS_SELECT} WHERE media_type = ?1 AND media_id = ?2 ORDER BY last_watched DESC, history_key DESC"
            ))
            .map_err(|error| format!("Failed to prepare playback resume title read: {}", error))?;

        let rows = statement
            .query_map(params![media_type, media_id], read_watch_progress_row)
            .map_err(|error| format!("Failed to query playback resume title rows: {}", error))?;

        Ok(collect_progress_rows(rows))
    }

    pub(crate) fn merge_entries(
        &mut self,
        entries: Vec<(String, WatchProgress)>,
    ) -> Result<Vec<(String, WatchProgress)>, String> {
        if entries.is_empty() {
            return Ok(Vec::new());
        }

        let transaction = self.connection.transaction().map_err(|error| {
            format!(
                "Failed to open playback resume merge transaction: {}",
                error
            )
        })?;
        let mut imported = Vec::new();
        let mut pruned_titles = std::collections::HashSet::new();

        {
            // Prepare once: a bulk import would otherwise re-compile the 22-
            // column upsert per row.
            let mut upsert_statement =
                transaction.prepare(UPSERT_PROGRESS_SQL).map_err(|error| {
                    format!("Failed to prepare playback resume merge upsert: {}", error)
                })?;
            for (key, progress) in entries {
                // The upsert's recency guard is the source of truth: `changes()`
                // reports whether it landed, so no separate SELECT round-trip.
                upsert_progress_stmt(&mut upsert_statement, &key, &progress)?;
                if transaction.changes() == 0 {
                    continue;
                }
                pruned_titles.insert((progress.type_.clone(), progress.id.clone()));
                imported.push((key, progress));
            }
        }

        // One prune per distinct title instead of one per row: a 10k import
        // over few titles pays a handful of bounded scans, not 10k.
        for (media_type, media_id) in &pruned_titles {
            prune_title_history_tx(&transaction, media_type, media_id)?;
        }

        if count_history_tx(&transaction)? > MAX_RESUME_TOTAL_ENTRIES {
            prune_total_history_tx(&transaction)?;
        }

        transaction
            .commit()
            .map_err(|error| format!("Failed to commit playback resume merge: {}", error))?;

        Ok(imported)
    }

    pub(crate) fn get_entry(&mut self, key: &str) -> Result<Option<WatchProgress>, String> {
        self.connection
            .query_row(
                &format!("{WATCH_PROGRESS_SELECT} WHERE history_key = ?1"),
                params![key],
                read_watch_progress_row,
            )
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
        // A single DELETE is atomic under auto-commit. No VACUUM here: it
        // rewrites the whole file (2x disk, fails when full) while holding
        // the single shared connection, and SQLite reuses freed pages.
        self.connection
            .execute("DELETE FROM watch_progress", [])
            .map_err(|error| format!("Failed to clear playback resume database: {}", error))?;

        Ok(())
    }
}

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
";

/// One column list for every `watch_progress` read: `read_watch_progress_row`
/// decodes positionally, so all SELECTs must keep this exact order.
const WATCH_PROGRESS_SELECT: &str = "\
    SELECT history_key, media_id, media_type, season, episode, \
    absolute_season, absolute_episode, stream_season, stream_episode, \
    position, duration, last_watched, title, poster, backdrop, \
    last_stream_url, last_stream_format, last_stream_lookup_id, \
    last_stream_key, source_name, stream_family, source_id \
    FROM watch_progress";

fn upsert_progress_tx(
    transaction: &Transaction<'_>,
    key: &str,
    progress: &WatchProgress,
) -> Result<bool, String> {
    let mut statement = transaction
        .prepare(UPSERT_PROGRESS_SQL)
        .map_err(|error| format!("Failed to prepare playback resume save: {}", error))?;
    upsert_progress_stmt(&mut statement, key, progress)?;
    // `changes()` reflects the upsert's recency guard: 0 means an existing
    // newer row won and nothing was written.
    Ok(transaction.changes() > 0)
}

fn upsert_progress_stmt(
    statement: &mut Statement<'_>,
    key: &str,
    progress: &WatchProgress,
) -> Result<(), String> {
    // Store-enforced invariant: stream URLs are credential-bearing and
    // short-lived, so the resume table never persists them even if a caller
    // bypasses `sanitize_watch_progress`. Resume re-resolves through opaque
    // lookup/key/source identities. The key column gets the same treatment:
    // only opaque hash identities persist — the `h:`/`uh:` content keys and
    // the `s:` prepared selector key (SHA-256 over content key + source +
    // transport, no credential material). Legacy `u:` keys embed the
    // normalized URL verbatim and stay excluded.
    let no_persisted_url: Option<String> = None;
    let persisted_stream_key = progress
        .last_stream_key
        .as_deref()
        .filter(|key| is_persistable_stream_key(key));
    // Recency guard: concurrent saves race across read/write round-trips, so
    // an older `last_watched` payload must never overwrite a newer row.
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
        ])
        .map_err(|error| format!("Failed to save playback resume row: {}", error))?;

    Ok(())
}

/// Rows of one title that aren't watched marks — the completion ratio is the
/// one `playable_resume_start_time` and the frontend's `isWatchedProgress` use.
const IN_PROGRESS_TITLE_ROWS: &str = "
    FROM watch_progress
    WHERE media_type = ?1 AND media_id = ?2
      AND NOT (duration > 0.0 AND position >= duration * ?3)";

fn prune_title_history_tx(
    transaction: &Transaction<'_>,
    media_type: &str,
    media_id: &str,
) -> Result<(), String> {
    // Cheap overflow gate: counting one title's rows is an indexed range
    // count, so steady-state saves skip the ordered delete below.
    let in_progress_count: i64 = transaction
        .query_row(
            &format!("SELECT COUNT(*) {IN_PROGRESS_TITLE_ROWS}"),
            params![
                media_type,
                media_id,
                WATCH_PROGRESS_MAX_RESUME_PROGRESS_RATIO
            ],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to count playback resume title rows: {}", error))?;
    if in_progress_count <= MAX_RESUME_ROWS_PER_TITLE {
        return Ok(());
    }
    transaction
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

    Ok(())
}

fn count_history_tx(transaction: &Transaction<'_>) -> Result<i64, String> {
    transaction
        .query_row("SELECT COUNT(*) FROM watch_progress", [], |row| row.get(0))
        .map_err(|error| format!("Failed to count playback resume rows: {}", error))
}

fn prune_total_history_tx(transaction: &Transaction<'_>) -> Result<(), String> {
    transaction
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

    Ok(())
}

/// Per-row decode isolation for list reads: one corrupt row (unexpected
/// storage class, bad enum text) drops only itself instead of blanking the
/// whole history/resume surface. Statement/query errors still propagate.
fn collect_progress_rows<T>(
    rows: rusqlite::MappedRows<'_, impl FnMut(&Row<'_>) -> rusqlite::Result<T>>,
) -> Vec<T> {
    rows.filter_map(|row| match row {
        Ok(entry) => Some(entry),
        Err(_error) => {
            #[cfg(debug_assertions)]
            eprintln!("[resume_store] dropping undecodable row: {_error}");
            None
        }
    })
    .collect()
}

/// SQLite REAL columns can hold Inf/NaN; a non-finite value must clamp to a
/// serializable number — `serde_json` fails on non-finite `f64`, which would
/// poison the whole IPC payload and any write that echoes the row back.
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
        last_stream_url: row.get(15)?,
        last_stream_format: row.get(16)?,
        last_stream_lookup_id: row.get(17)?,
        last_stream_key: row.get(18)?,
        source_name: row.get(19)?,
        stream_family: row.get(20)?,
        source_id: row.get(21)?,
        resume_start_time: None,
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
    u64::try_from(value.max(0)).unwrap_or_default()
}

#[cfg(test)]
mod tests;
