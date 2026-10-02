use super::config_store::get_trimmed_store_string;
use super::{
    language::{
        infer_track_preferred_language,
        normalize_language_token as normalize_backend_language_token,
        normalize_track_language_candidate,
        resolve_preferred_track_selection as resolve_track_language_selection,
        supported_language_options, SupportedLanguageOption, TrackLanguageCandidate,
        TrackLanguageSelectionResolution,
    },
    normalize_media_id, normalize_stream_media_type, now_unix_millis,
    playback_state::PlaybackStateService,
    DurableStore, PlaybackLanguagePreferences, SETTINGS_STORE_FILE,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{command, AppHandle, State};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PlaybackLanguagePreferenceKind {
    Audio,
    Sub,
}

// Settings-store keys for the two global language defaults — the stream
// fetcher snapshots the same keys, so the literal lives in one place.
pub(crate) const PREFERRED_AUDIO_LANGUAGE_STORE_KEY: &str = "preferred_audio_language";
pub(crate) const PREFERRED_SUBTITLE_LANGUAGE_STORE_KEY: &str = "preferred_subtitle_language";

pub(crate) fn sanitize_language_pref(value: Option<String>, allow_off: bool) -> Option<String> {
    normalize_backend_language_token(value.as_deref(), allow_off)
}

/// Save-boundary variant: `None` is an explicit clear, but a supplied value
/// that fails normalization is rejected rather than silently wiping the
/// stored preference.
fn sanitize_language_pref_for_save(
    value: Option<String>,
    allow_off: bool,
) -> Result<Option<String>, String> {
    match value {
        Some(raw) => sanitize_language_pref(Some(raw), allow_off)
            .map(Some)
            .ok_or_else(|| "Invalid language preference.".to_string()),
        None => Ok(None),
    }
}

pub(crate) fn read_playback_language_preferences_from_store(
    store: &DurableStore,
) -> PlaybackLanguagePreferences {
    PlaybackLanguagePreferences {
        preferred_audio_language: sanitize_language_pref(
            get_trimmed_store_string(store, PREFERRED_AUDIO_LANGUAGE_STORE_KEY),
            false,
        ),
        preferred_subtitle_language: sanitize_language_pref(
            get_trimmed_store_string(store, PREFERRED_SUBTITLE_LANGUAGE_STORE_KEY),
            true,
        ),
    }
}

/// Writes both keys without saving — backup restore batches this with the
/// other settings into one store commit.
pub(crate) fn write_playback_language_preferences(
    store: &DurableStore,
    preferences: &PlaybackLanguagePreferences,
) {
    if let Some(value) = preferences.preferred_audio_language.as_ref() {
        store.set(PREFERRED_AUDIO_LANGUAGE_STORE_KEY, json!(value));
    } else {
        store.delete(PREFERRED_AUDIO_LANGUAGE_STORE_KEY);
    }

    if let Some(value) = preferences.preferred_subtitle_language.as_ref() {
        store.set(PREFERRED_SUBTITLE_LANGUAGE_STORE_KEY, json!(value));
    } else {
        store.delete(PREFERRED_SUBTITLE_LANGUAGE_STORE_KEY);
    }
}

fn persist_playback_language_preferences(
    store: &DurableStore,
    preferences: &PlaybackLanguagePreferences,
) -> Result<(), String> {
    write_playback_language_preferences(store, preferences);
    store.save()
}

fn infer_track_preferred_language_candidate(
    track: Option<&TrackLanguageCandidate>,
) -> Option<String> {
    track.and_then(|candidate| {
        infer_track_preferred_language(candidate.lang.as_deref(), candidate.title.as_deref())
    })
}

fn infer_selected_playback_language_preference(
    preference_kind: PlaybackLanguagePreferenceKind,
    track: Option<&TrackLanguageCandidate>,
    subtitles_off: bool,
) -> Option<String> {
    match preference_kind {
        PlaybackLanguagePreferenceKind::Audio => infer_track_preferred_language_candidate(track),
        PlaybackLanguagePreferenceKind::Sub => {
            if subtitles_off {
                Some("off".to_string())
            } else {
                infer_track_preferred_language_candidate(track)
            }
        }
    }
}

/// Sets (or clears, with `None`) one global language default; the other
/// field keeps its stored value, so callers never compose a whole snapshot
/// from state that may be stale after a backup restore.
#[command]
pub async fn save_playback_language_preference(
    app: AppHandle,
    preference_kind: PlaybackLanguagePreferenceKind,
    language: Option<String>,
) -> Result<PlaybackLanguagePreferences, String> {
    let language = sanitize_language_pref_for_save(
        language,
        preference_kind == PlaybackLanguagePreferenceKind::Sub,
    )?;

    // Store file IO is blocking: run the read-modify-write off the async
    // worker, matching the library/history command pattern.
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, SETTINGS_STORE_FILE)?;
        let mut preferences = read_playback_language_preferences_from_store(&store);
        match preference_kind {
            PlaybackLanguagePreferenceKind::Audio => {
                preferences.preferred_audio_language = language
            }
            PlaybackLanguagePreferenceKind::Sub => {
                preferences.preferred_subtitle_language = language
            }
        }
        persist_playback_language_preferences(&store, &preferences)?;
        Ok(preferences)
    })
    .await
}

#[command]
pub async fn get_playback_language_preferences(
    app: AppHandle,
) -> Result<PlaybackLanguagePreferences, String> {
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, SETTINGS_STORE_FILE)?;
        Ok(read_playback_language_preferences_from_store(&store))
    })
    .await
}

#[command]
pub async fn get_effective_playback_language_preferences(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    media_id: Option<String>,
    media_type: Option<String>,
) -> Result<PlaybackLanguagePreferences, String> {
    let media_id = media_id.as_deref().and_then(normalize_media_id);
    let media_type = match media_type.as_deref() {
        Some(value) => Some(
            normalize_stream_media_type(value, media_id.as_deref())
                .ok_or_else(|| "Invalid media type for playback language preferences.".to_string())?
                .to_string(),
        ),
        None => None,
    };

    // One blocking round-trip for defaults plus the scoped merge — a
    // two-hop form could mix defaults from one instant with a snapshot
    // from another.
    let app = app.clone();
    let service = playback_state.inner().clone();
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, SETTINGS_STORE_FILE)?;
        let defaults = read_playback_language_preferences_from_store(&store);
        service.get_effective_playback_language_preferences(
            &app,
            media_id.as_deref(),
            media_type.as_deref(),
            defaults,
        )
    })
    .await
}

/// Bound on the candidate list: real files carry tens of tracks, so a larger
/// payload is hostile input, not data.
const MAX_TRACK_LANGUAGE_CANDIDATES: usize = 512;

#[command]
pub async fn resolve_preferred_track_selection(
    tracks: Vec<TrackLanguageCandidate>,
    preferred_language: Option<String>,
    selected_track_id: Option<i64>,
) -> Result<TrackLanguageSelectionResolution, String> {
    if tracks.len() > MAX_TRACK_LANGUAGE_CANDIDATES {
        return Err("Too many track language candidates.".to_string());
    }
    let tracks = tracks
        .into_iter()
        .map(normalize_track_language_candidate)
        .collect::<Vec<_>>();
    Ok(resolve_track_language_selection(
        &tracks,
        preferred_language.as_deref(),
        selected_track_id,
    ))
}

#[command]
pub async fn save_selected_playback_language_preference(
    app: AppHandle,
    preference_kind: PlaybackLanguagePreferenceKind,
    track: Option<TrackLanguageCandidate>,
    subtitles_off: Option<bool>,
) -> Result<PlaybackLanguagePreferences, String> {
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, SETTINGS_STORE_FILE)?;
        let mut preferences = read_playback_language_preferences_from_store(&store);

        let track = track.map(normalize_track_language_candidate);
        // A track with no inferable language is not malformed input — it
        // simply carries no preference to persist, so the save is a no-op.
        let Some(selected_language) = infer_selected_playback_language_preference(
            preference_kind,
            track.as_ref(),
            subtitles_off.unwrap_or(false),
        ) else {
            return Ok(preferences);
        };

        match preference_kind {
            PlaybackLanguagePreferenceKind::Audio => {
                preferences.preferred_audio_language = Some(selected_language);
            }
            PlaybackLanguagePreferenceKind::Sub => {
                preferences.preferred_subtitle_language = Some(selected_language);
            }
        }

        persist_playback_language_preferences(&store, &preferences)?;
        Ok(preferences)
    })
    .await
}

#[command]
pub async fn save_playback_language_preference_outcome_from_tracks(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    media_id: String,
    media_type: String,
    audio_track: Option<TrackLanguageCandidate>,
    subtitle_track: Option<TrackLanguageCandidate>,
    subtitles_off: Option<bool>,
) -> Result<(), String> {
    let media_id = normalize_media_id(&media_id)
        .ok_or_else(|| "Media ID is required for playback preference outcomes.".to_string())?;
    let media_type = normalize_stream_media_type(&media_type, Some(&media_id))
        .ok_or_else(|| "Invalid media type for playback preference outcomes.".to_string())?
        .to_string();
    let audio_track = audio_track.map(normalize_track_language_candidate);
    let subtitle_track = subtitle_track.map(normalize_track_language_candidate);

    let preferred_audio_language = infer_track_preferred_language_candidate(audio_track.as_ref());
    let preferred_subtitle_language = infer_selected_playback_language_preference(
        PlaybackLanguagePreferenceKind::Sub,
        subtitle_track.as_ref(),
        subtitles_off.unwrap_or(false),
    );

    // No early return on `None, None`: `record_playback_language_preference_outcome`
    // owns a delete branch for exactly that case — a title whose current tracks
    // carry no inferable languages drops its per-title override and falls back
    // to the global preferences.

    // The outcome write performs blocking store/file IO: route it through the
    // dedicated blocking pool instead of running it on the async command
    // worker, matching the other playback_state save paths.
    let app = app.clone();
    let service = playback_state.inner().clone();
    super::run_blocking_store_op(move || {
        service.record_playback_language_preference_outcome(
            &app,
            &media_id,
            &media_type,
            preferred_audio_language,
            preferred_subtitle_language,
            now_unix_millis(),
        )
    })
    .await
}

/// The closed language set, exposed once so the settings UI never carries a
/// second hardcoded table that can drift from the sanitizer.
#[command]
pub async fn get_supported_languages() -> Result<Vec<SupportedLanguageOption>, String> {
    Ok(supported_language_options())
}

#[cfg(test)]
mod tests;
