//! Canonical media-type normalization, single owner.
//!
//! Two namespaces on purpose: history/title-scope folds `anime` onto `series`
//! (resume keys, title scopes, meta lookups), while the stream namespace keeps
//! `anime` distinct because anime catalogs index streams under it.

use crate::providers::addon_manifest::MAX_TYPE_CHARS;

/// Any non-empty, char-bounded type is valid: passthrough so addon-declared
/// catalog types route without code changes.
fn normalize_media_type(media_type: &str) -> Option<String> {
    let trimmed = media_type.trim();
    if trimmed.is_empty() || trimmed.chars().nth(MAX_TYPE_CHARS).is_some() {
        return None;
    }
    Some(trimmed.to_ascii_lowercase())
}

/// History/title-scope canonicalization: `anime` folds to `series`.
pub(crate) fn normalize_watch_progress_type(media_type: &str) -> Option<String> {
    normalize_media_type(media_type).map(|normalized| match normalized.as_str() {
        "movie" => "movie".to_string(),
        "series" | "anime" => "series".to_string(),
        _ => normalized,
    })
}

/// Stream-facing canonicalization: `anime` stays distinct and `kitsu:` series ids
/// promote to it (kitsu catalogs index streams under the anime type).
pub(crate) fn normalize_stream_media_type(
    media_type: &str,
    media_id: Option<&str>,
) -> Option<String> {
    normalize_media_type(media_type).map(|normalized| match normalized.as_str() {
        "movie" => "movie".to_string(),
        "anime" => "anime".to_string(),
        "series" => series_stream_type(media_id).to_string(),
        _ => normalized,
    })
}

fn series_stream_type(media_id: Option<&str>) -> &'static str {
    let is_kitsu = media_id
        .map(str::trim)
        .and_then(|value| value.get(..6))
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("kitsu:"));
    if is_kitsu {
        "anime"
    } else {
        "series"
    }
}

/// Addon episode endpoints index seasons under `series`: `anime` is a
/// catalog-facing type that folds at the stream/subtitle request boundary.
pub(crate) fn addon_episode_lookup_type(media_type: &str) -> &str {
    if media_type == "anime" {
        "series"
    } else {
        media_type
    }
}

/// History-row canonicalization: the stream namespace with an infallible fallback —
/// invalid persisted types fold to `series`, still honoring kitsu-id promotion.
pub(crate) fn normalize_history_row_media_type(media_type: &str, media_id: &str) -> String {
    normalize_stream_media_type(media_type, Some(media_id))
        .unwrap_or_else(|| series_stream_type(Some(media_id)).to_string())
}
