use super::{
    insert_sorted_unique, load_advisory_index, merge_sorted_unique, playback_title_scope_key,
    prune_index_to_cap, PlaybackStateService,
};
use crate::commands::playback_preferences_commands::sanitize_language_pref;
use crate::commands::{DurableStore, PlaybackLanguagePreferences};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use tauri::AppHandle;

pub(super) const PLAYBACK_LANGUAGE_PREFERENCES_INDEX_KEY: &str =
    "playback_language_preferences_index";
pub(super) const PLAYBACK_LANGUAGE_PREFERENCES_ITEM_PREFIX: &str =
    "playback_language_preferences_item:";
/// Hard bound for per-title language-preference overrides: one entry per
/// title ever played would otherwise grow the index without limit.
pub(super) const PLAYBACK_LANGUAGE_PREFERENCES_MAX_ENTRIES: usize = 2_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlaybackLanguagePreferencesSnapshot {
    pub preferred_audio_language: Option<String>,
    pub preferred_subtitle_language: Option<String>,
    pub updated_at: u64,
}

pub(super) fn playback_language_preferences_item_key(key: &str) -> String {
    format!("{}{}", PLAYBACK_LANGUAGE_PREFERENCES_ITEM_PREFIX, key)
}

pub(super) fn load_playback_language_preferences_snapshot(
    store: &DurableStore,
    key: &str,
) -> Option<PlaybackLanguagePreferencesSnapshot> {
    store.get_typed(playback_language_preferences_item_key(key))
}

fn prune_language_preferences_index(store: &DurableStore, index: &mut Vec<String>) {
    prune_index_to_cap(
        store,
        index,
        PLAYBACK_LANGUAGE_PREFERENCES_MAX_ENTRIES,
        |store, key| {
            load_playback_language_preferences_snapshot(store, key)
                .map(|snapshot| snapshot.updated_at)
                .unwrap_or(0)
        },
        playback_language_preferences_item_key,
    );
}

pub(super) fn merge_playback_language_preferences(
    defaults: PlaybackLanguagePreferences,
    scoped: Option<&PlaybackLanguagePreferencesSnapshot>,
) -> PlaybackLanguagePreferences {
    let PlaybackLanguagePreferences {
        preferred_audio_language,
        preferred_subtitle_language,
    } = defaults;

    // Explicit globals win; the scoped snapshot only fills fields the defaults
    // leave unset. Both sides can bypass the write-path sanitizer if the store
    // was hand-edited or corrupt — re-sanitize on merge so a raw token can never
    // surface as an effective preference.
    PlaybackLanguagePreferences {
        preferred_audio_language: sanitize_language_pref(preferred_audio_language, false).or_else(
            || {
                scoped.and_then(|snapshot| {
                    sanitize_language_pref(snapshot.preferred_audio_language.clone(), false)
                })
            },
        ),
        preferred_subtitle_language: sanitize_language_pref(preferred_subtitle_language, true)
            .or_else(|| {
                scoped.and_then(|snapshot| {
                    sanitize_language_pref(snapshot.preferred_subtitle_language.clone(), true)
                })
            }),
    }
}

impl PlaybackStateService {
    pub(crate) fn get_effective_playback_language_preferences(
        &self,
        app: &AppHandle,
        media_id: Option<&str>,
        media_type: Option<&str>,
        defaults: PlaybackLanguagePreferences,
    ) -> Result<PlaybackLanguagePreferences, String> {
        let defaults = merge_playback_language_preferences(defaults, None);
        if defaults.preferred_audio_language.is_some()
            && defaults.preferred_subtitle_language.is_some()
        {
            return Ok(defaults);
        }
        let Some(scope_key) = playback_title_scope_key(media_type, media_id) else {
            return Ok(defaults);
        };

        let store = self.open_state_store(app)?;
        let snapshot = load_playback_language_preferences_snapshot(&store, &scope_key);

        Ok(merge_playback_language_preferences(
            defaults,
            snapshot.as_ref(),
        ))
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn record_playback_language_preference_outcome(
        &self,
        app: &AppHandle,
        media_id: &str,
        media_type: &str,
        preferred_audio_language: Option<String>,
        preferred_subtitle_language: Option<String>,
        timestamp_ms: u64,
        expected_generation: u64,
    ) -> Result<(), String> {
        let Some(scope_key) = playback_title_scope_key(Some(media_type), Some(media_id)) else {
            return Ok(());
        };

        let store = self.open_state_store(app)?;
        // `off` is only a subtitle value; the audio sanitize must match the
        // global-preferences path or a stray "off" would persist as a pref.
        let preferred_audio_language = sanitize_language_pref(preferred_audio_language, false);
        let preferred_subtitle_language = sanitize_language_pref(preferred_subtitle_language, true);

        let _state_file_guard = self.lock_state_file_write();
        // Same resurrection hazard as `record_stream_outcome`: a history clear
        // racing this write, even before the worker starts, must not leave a stale preference.
        if self.history_generation() != expected_generation {
            return Ok(());
        }
        // The index load must live inside the critical section like every sibling
        // writer: a pre-lock load can be preempted by another outcome write, and the
        // write-back below would drop that sibling's entry — orphaning an item
        // `clear` only reaches via the index.
        let mut preferences_index =
            load_advisory_index(&store, PLAYBACK_LANGUAGE_PREFERENCES_INDEX_KEY);

        if preferred_audio_language.is_none() && preferred_subtitle_language.is_none() {
            // Nothing stored for this title: clearing is already a no-op, so
            // skip the whole-file save.
            if !preferences_index.iter().any(|entry| entry == &scope_key) {
                return Ok(());
            }
            store.delete(playback_language_preferences_item_key(&scope_key));
            preferences_index.retain(|entry| entry != &scope_key);
            store.set(
                PLAYBACK_LANGUAGE_PREFERENCES_INDEX_KEY,
                json!(preferences_index),
            );
            // Debounced like the sibling outcome writer — a track-cycling burst must not pay a whole-file save per selection.
            self.schedule_state_file_save(app);
            return Ok(());
        }

        insert_sorted_unique(&mut preferences_index, &scope_key);

        // Item written before pruning: a new key ranks `updated_at = 0`, so pruning
        // first would evict the pick being recorded and orphan its item.
        store.set(
            playback_language_preferences_item_key(&scope_key),
            json!(PlaybackLanguagePreferencesSnapshot {
                preferred_audio_language,
                preferred_subtitle_language,
                updated_at: timestamp_ms,
            }),
        );

        // `prune_index_to_cap` early-returns under the cap; the item write
        // above must still land first so the new pick can't evict itself.
        prune_language_preferences_index(&store, &mut preferences_index);

        store.set(
            PLAYBACK_LANGUAGE_PREFERENCES_INDEX_KEY,
            json!(preferences_index),
        );
        self.schedule_state_file_save(app);

        Ok(())
    }

    /// Learned per-title language picks keyed by title scope (`type:id`).
    pub(crate) fn export_title_language_preferences(
        &self,
        app: &AppHandle,
    ) -> Result<BTreeMap<String, PlaybackLanguagePreferencesSnapshot>, String> {
        let store = self.open_state_store(app)?;
        Ok(
            load_advisory_index(&store, PLAYBACK_LANGUAGE_PREFERENCES_INDEX_KEY)
                .into_iter()
                .filter_map(|key| {
                    let snapshot = load_playback_language_preferences_snapshot(&store, &key)?;
                    Some((key, snapshot))
                })
                .collect(),
        )
    }

    /// Backup restore: fills titles with no learned preference yet — a pick made on
    /// this device always wins. Keys and values re-derive through the live
    /// normalizers so a hostile backup can't plant what the write path rejects.
    pub(crate) fn import_title_language_preferences(
        &self,
        app: &AppHandle,
        entries: HashMap<String, Value>,
    ) -> Result<usize, String> {
        if entries.is_empty() {
            return Ok(0);
        }
        let store = self.open_state_store(app)?;
        let _state_file_guard = self.lock_state_file_write();
        let mut preferences_index =
            load_advisory_index(&store, PLAYBACK_LANGUAGE_PREFERENCES_INDEX_KEY);
        let now = crate::commands::now_unix_millis();
        // Accepted keys merge into the sorted index once at the end instead
        // of one shifting insert per row (imports can carry 10k entries).
        let mut accepted = HashSet::new();

        for (key, value) in entries {
            let Some(scope_key) = key.split_once(':').and_then(|(media_type, media_id)| {
                playback_title_scope_key(Some(media_type), Some(media_id))
            }) else {
                continue;
            };
            let Ok(snapshot) = serde_json::from_value::<PlaybackLanguagePreferencesSnapshot>(value)
            else {
                continue;
            };
            let preferred_audio_language =
                sanitize_language_pref(snapshot.preferred_audio_language, false);
            let preferred_subtitle_language =
                sanitize_language_pref(snapshot.preferred_subtitle_language, true);
            if preferred_audio_language.is_none() && preferred_subtitle_language.is_none() {
                continue;
            }
            if accepted.contains(&scope_key) || preferences_index.binary_search(&scope_key).is_ok()
            {
                continue;
            }
            store.set(
                playback_language_preferences_item_key(&scope_key),
                json!(PlaybackLanguagePreferencesSnapshot {
                    preferred_audio_language,
                    preferred_subtitle_language,
                    updated_at: snapshot.updated_at.min(now),
                }),
            );
            accepted.insert(scope_key);
        }

        let imported = accepted.len();
        if imported == 0 {
            return Ok(0);
        }
        merge_sorted_unique(&mut preferences_index, accepted.into_iter().collect());
        prune_language_preferences_index(&store, &mut preferences_index);
        store.set(
            PLAYBACK_LANGUAGE_PREFERENCES_INDEX_KEY,
            json!(preferences_index),
        );
        store.save()?;
        Ok(imported)
    }
}
