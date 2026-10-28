//! mpv `track-list` reads batched behind one command — one IPC per burst instead of
//! ~150 invokes for a 20-track file. The staged wrapper's `track-list` node reads
//! still apply, so per-field stays.

use serde::{Deserialize, Serialize};
use std::collections::{hash_map::Entry, HashMap};
use tauri::{command, AppHandle, Window};
use tauri_plugin_libmpv::MpvExt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PlayerTrackType {
    // Audio/sub first so the pickers render in selection order; video last.
    Audio = 0,
    Sub = 1,
    Video = 2,
}

/// One `track-list` row, already normalized: `selected` comes from
/// `current-tracks/{type}/id` (authoritative — the per-track flag is never read).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlayerTrack {
    id: i64,
    r#type: PlayerTrackType,
    display_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    lang: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    selected: bool,
    default_track: bool,
    forced: bool,
    hearing_impaired: bool,
    external: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    external_filename: Option<String>,
}

/// Fresh `current-tracks/{type}/id` values the caller observed via property events —
/// passing them skips two property reads per refresh. All-or-nothing: a `None`
/// field means "no track of this type selected", NOT "not observed" — a caller with
/// only one side must omit the whole struct or the other type reports unselected.
#[derive(Debug, Clone, Copy, Deserialize)]
pub(crate) struct ObservedTrackIds {
    audio: Option<i64>,
    sub: Option<i64>,
}

fn mpv_property(
    app: &AppHandle,
    window_label: &str,
    name: String,
    format: &str,
) -> Option<serde_json::Value> {
    app.mpv()
        .get_property(name, format.to_string(), window_label)
        .ok()
}

fn property_i64(value: Option<serde_json::Value>) -> Option<i64> {
    value.and_then(|value| value.as_i64())
}

pub(crate) fn property_flag(value: Option<serde_json::Value>) -> bool {
    // mpv flag responses arrive as bool or 0/1 depending on the wrapper.
    match value {
        Some(serde_json::Value::Bool(flag)) => flag,
        Some(serde_json::Value::Number(number)) => number.as_i64() == Some(1),
        _ => false,
    }
}

fn property_non_blank(value: Option<serde_json::Value>) -> Option<String> {
    let serde_json::Value::String(value) = value? else {
        return None;
    };
    crate::providers::bound_optional(Some(value), usize::MAX)
}

/// Merge duplicate `type:id` rows: later strings win and flags OR together.
fn merge_track_variants(existing: &mut PlayerTrack, next: PlayerTrack) {
    existing.title = next.title.or(existing.title.take());
    existing.lang = next.lang.or(existing.lang.take());
    existing.selected |= next.selected;
    existing.default_track |= next.default_track;
    existing.forced |= next.forced;
    existing.hearing_impaired |= next.hearing_impaired;
    existing.external |= next.external;
    existing.external_filename = next.external_filename.or(existing.external_filename.take());
}

fn read_track_list(
    app: &AppHandle,
    window_label: &str,
    observed_ids: Option<ObservedTrackIds>,
) -> Result<Vec<PlayerTrack>, String> {
    let count = app
        .mpv()
        .get_property(
            "track-list/count".to_string(),
            "int64".to_string(),
            window_label,
        )
        .map_err(|error| format!("mpv track-count read failed: {error}"))?;
    let Some(count) = count.as_i64().filter(|count| *count > 0) else {
        return Ok(Vec::new());
    };

    let selected = observed_ids.unwrap_or_else(|| ObservedTrackIds {
        audio: property_i64(mpv_property(
            app,
            window_label,
            "current-tracks/audio/id".to_string(),
            "int64",
        )),
        sub: property_i64(mpv_property(
            app,
            window_label,
            "current-tracks/sub/id".to_string(),
            "int64",
        )),
    });

    let mut tracks: Vec<PlayerTrack> = Vec::new();
    let mut index_by_key: HashMap<(u8, i64), usize> = HashMap::new();

    for index in 0..count {
        let prefix = format!("track-list/{index}");
        let read = |name: &str, format: &str| {
            mpv_property(app, window_label, format!("{prefix}/{name}"), format)
        };
        let Some(id) = property_i64(read("id", "int64")) else {
            continue;
        };
        let track_type_value = read("type", "string");
        let track_type = match track_type_value
            .as_ref()
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
        {
            Some("audio") => PlayerTrackType::Audio,
            Some("sub") => PlayerTrackType::Sub,
            Some("video") => PlayerTrackType::Video,
            _ => continue,
        };
        let external = property_flag(read("external", "flag"));

        let mut track = PlayerTrack {
            id,
            r#type: track_type,
            display_label: String::new(),
            lang: None,
            title: None,
            selected: false,
            default_track: false,
            forced: false,
            hearing_impaired: false,
            external,
            external_filename: None,
        };
        if track_type != PlayerTrackType::Video {
            track.selected = match track_type {
                PlayerTrackType::Audio => selected.audio,
                PlayerTrackType::Sub => selected.sub,
                PlayerTrackType::Video => None,
            } == Some(id);
            track.lang = property_non_blank(read("lang", "string"));
            track.title = property_non_blank(read("title", "string"));
            track.default_track = property_flag(read("default", "flag"));
            track.forced = property_flag(read("forced", "flag"));
            track.hearing_impaired = property_flag(read("hearing-impaired", "flag"));
            if external {
                track.external_filename = property_non_blank(read("external-filename", "string"));
            }
        }

        match index_by_key.entry((track_type as u8, id)) {
            Entry::Occupied(existing) => merge_track_variants(&mut tracks[*existing.get()], track),
            Entry::Vacant(entry) => {
                entry.insert(tracks.len());
                tracks.push(track);
            }
        }
    }

    tracks.sort_unstable_by_key(|track| (track.r#type as u8, track.id));
    let mut label_counts = [HashMap::new(), HashMap::new(), HashMap::new()];
    for track in &mut tracks {
        let lang = track
            .lang
            .as_deref()
            .map(str::to_uppercase)
            .filter(|lang| !lang.is_empty());
        let title = track.title.as_deref().filter(|title| !title.is_empty());
        let mut label = match (title, lang.as_deref()) {
            (Some(title), Some(lang)) if !title.to_lowercase().contains(&lang.to_lowercase()) => {
                format!("{lang} · {title}")
            }
            (Some(title), _) => title.to_string(),
            (None, Some(lang)) => lang.to_string(),
            (None, None) => format!("Track {}", track.id),
        };
        if track.forced {
            label.push_str(" · Forced");
        }
        if track.hearing_impaired {
            label.push_str(" · SDH");
        }
        *label_counts[track.r#type as usize]
            .entry(label.clone())
            .or_insert(0) += 1;
        track.display_label = label;
    }
    for track in &mut tracks {
        if label_counts[track.r#type as usize][&track.display_label] > 1 {
            use std::fmt::Write as _;

            let _ = write!(track.display_label, " #{}", track.id);
        }
    }
    Ok(tracks)
}

#[command]
pub async fn read_player_track_list(
    app: AppHandle,
    window: Window,
    observed_ids: Option<ObservedTrackIds>,
) -> Result<Vec<PlayerTrack>, String> {
    let window_label = window.label().to_string();
    super::player_mpv_commands::run_mpv_op("track-list read", move || {
        read_track_list(&app, &window_label, observed_ids)
    })
    .await
}

#[cfg(test)]
mod tests;
