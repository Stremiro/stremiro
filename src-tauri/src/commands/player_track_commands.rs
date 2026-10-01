//! mpv `track-list` reads batched behind one command — one IPC per burst
//! instead of one per property per track (~150 invokes for a 20-track
//! file). The staged wrapper's `track-list` node reads still apply, so
//! per-field stays.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{command, AppHandle, Window};
use tauri_plugin_libmpv::MpvExt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PlayerTrackType {
    Audio,
    Sub,
    Video,
}

impl PlayerTrackType {
    // Audio/sub first so the pickers render in selection order; video last.
    fn sort_order(self) -> u8 {
        match self {
            Self::Audio => 0,
            Self::Sub => 1,
            Self::Video => 2,
        }
    }
}

/// One `track-list` row, already normalized: `selected` comes from
/// `current-tracks/{type}/id` (the authoritative selection source — the
/// per-track `selected` flag is never read), and blank strings are `None`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlayerTrack {
    id: i64,
    r#type: PlayerTrackType,
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

/// Fresh `current-tracks/{type}/id` values the caller already observed via
/// property events — fresher than a re-read, so passing them skips two
/// property reads per refresh. All-or-nothing contract: a `None` field means
/// "no track of this type selected", NOT "not observed" — a caller that has
/// only one side must omit the whole struct or the other type's tracks all
/// report unselected.
#[derive(Debug, Clone, Copy, Deserialize)]
pub(crate) struct ObservedTrackIds {
    audio: Option<i64>,
    sub: Option<i64>,
}

fn mpv_property(
    app: &AppHandle,
    window_label: &str,
    name: &str,
    format: &str,
) -> Option<serde_json::Value> {
    app.mpv()
        .get_property(name.to_string(), format.to_string(), window_label)
        .ok()
}

fn property_i64(value: Option<serde_json::Value>) -> Option<i64> {
    value.and_then(|value| value.as_i64())
}

fn property_flag(value: Option<serde_json::Value>) -> bool {
    // mpv flag responses arrive as bool or 0/1 depending on the wrapper.
    match value {
        Some(serde_json::Value::Bool(flag)) => flag,
        Some(serde_json::Value::Number(number)) => number.as_i64() == Some(1),
        _ => false,
    }
}

fn property_non_blank(value: Option<serde_json::Value>) -> Option<String> {
    value
        .as_ref()
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|trimmed| !trimmed.is_empty())
        .map(str::to_string)
}

/// Duplicate `type:id` rows merge — later non-empty strings win, flags OR
/// together (mirrors the retired frontend `mergeTrackVariants`).
fn merge_track_variants(existing: &mut PlayerTrack, next: PlayerTrack) {
    if next.title.is_some() {
        existing.title = next.title;
    }
    if next.lang.is_some() {
        existing.lang = next.lang;
    }
    existing.selected |= next.selected;
    existing.default_track |= next.default_track;
    existing.forced |= next.forced;
    existing.hearing_impaired |= next.hearing_impaired;
    existing.external |= next.external;
    if next.external_filename.is_some() {
        existing.external_filename = next.external_filename;
    }
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
            "current-tracks/audio/id",
            "int64",
        )),
        sub: property_i64(mpv_property(
            app,
            window_label,
            "current-tracks/sub/id",
            "int64",
        )),
    });

    let mut tracks: Vec<PlayerTrack> = Vec::new();
    let mut index_by_key: HashMap<(u8, i64), usize> = HashMap::new();

    for index in 0..count {
        let prefix = format!("track-list/{index}");
        let Some(id) = property_i64(mpv_property(
            app,
            window_label,
            &format!("{prefix}/id"),
            "int64",
        )) else {
            continue;
        };
        let track_type = match property_non_blank(mpv_property(
            app,
            window_label,
            &format!("{prefix}/type"),
            "string",
        ))
        .as_deref()
        {
            Some("audio") => PlayerTrackType::Audio,
            Some("sub") => PlayerTrackType::Sub,
            Some("video") => PlayerTrackType::Video,
            _ => continue,
        };
        let external = property_flag(mpv_property(
            app,
            window_label,
            &format!("{prefix}/external"),
            "flag",
        ));

        let track = if track_type == PlayerTrackType::Video {
            // Video rows only carry identity — every consumer filters to
            // audio/sub, so their detail reads are skipped outright.
            PlayerTrack {
                id,
                r#type: track_type,
                lang: None,
                title: None,
                selected: false,
                default_track: false,
                forced: false,
                hearing_impaired: false,
                external,
                external_filename: None,
            }
        } else {
            let selected_id = match track_type {
                PlayerTrackType::Audio => selected.audio,
                PlayerTrackType::Sub => selected.sub,
                // Video returned in the branch above.
                PlayerTrackType::Video => None,
            };
            PlayerTrack {
                id,
                r#type: track_type,
                lang: property_non_blank(mpv_property(
                    app,
                    window_label,
                    &format!("{prefix}/lang"),
                    "string",
                )),
                title: property_non_blank(mpv_property(
                    app,
                    window_label,
                    &format!("{prefix}/title"),
                    "string",
                )),
                selected: selected_id == Some(id),
                default_track: property_flag(mpv_property(
                    app,
                    window_label,
                    &format!("{prefix}/default"),
                    "flag",
                )),
                forced: property_flag(mpv_property(
                    app,
                    window_label,
                    &format!("{prefix}/forced"),
                    "flag",
                )),
                hearing_impaired: property_flag(mpv_property(
                    app,
                    window_label,
                    &format!("{prefix}/hearing-impaired"),
                    "flag",
                )),
                external,
                // `external-filename` only exists on external
                // (`sub-add`-loaded) rows.
                external_filename: if external {
                    property_non_blank(mpv_property(
                        app,
                        window_label,
                        &format!("{prefix}/external-filename"),
                        "string",
                    ))
                } else {
                    None
                },
            }
        };

        match index_by_key.get(&(track_type.sort_order(), id)) {
            Some(&existing_index) => merge_track_variants(&mut tracks[existing_index], track),
            None => {
                index_by_key.insert((track_type.sort_order(), id), tracks.len());
                tracks.push(track);
            }
        }
    }

    tracks.sort_by(|left, right| {
        (left.r#type.sort_order(), left.id).cmp(&(right.r#type.sort_order(), right.id))
    });
    Ok(tracks)
}

#[command]
pub async fn read_player_track_list(
    app: AppHandle,
    window: Window,
    observed_ids: Option<ObservedTrackIds>,
) -> Result<Vec<PlayerTrack>, String> {
    let window_label = window.label().to_string();
    tokio::time::timeout(
        super::BLOCKING_OP_TIMEOUT,
        tauri::async_runtime::spawn_blocking(move || {
            read_track_list(&app, &window_label, observed_ids)
        }),
    )
    .await
    .map_err(|_| "mpv track-list read timed out.".to_string())?
    .map_err(|error| format!("mpv track-list read failed: {error}"))?
}

#[cfg(test)]
mod tests;
