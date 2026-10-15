//! Canonical media-type normalization, single owner.
//!
//! Two namespaces on purpose: history/title-scope folds `anime` onto `series`
//! (resume keys, title scopes, meta lookups), while the stream namespace keeps
//! `anime` distinct because anime catalogs index streams under it.

/// History/title-scope canonicalization: `anime` folds to `series`.
pub(crate) fn normalize_watch_progress_type(media_type: &str) -> Option<&'static str> {
    match media_type.trim().to_ascii_lowercase().as_str() {
        "movie" => Some("movie"),
        "series" | "anime" => Some("series"),
        _ => None,
    }
}

/// Stream-facing canonicalization: `anime` stays distinct and `kitsu:` series ids
/// promote to it (kitsu catalogs index streams under the anime type).
pub(crate) fn normalize_stream_media_type(
    media_type: &str,
    media_id: Option<&str>,
) -> Option<&'static str> {
    match media_type.trim().to_ascii_lowercase().as_str() {
        "movie" => Some("movie"),
        "anime" => Some("anime"),
        "series" => Some(
            if media_id
                .map(str::trim)
                .is_some_and(|value| value.to_ascii_lowercase().starts_with("kitsu:"))
            {
                "anime"
            } else {
                "series"
            },
        ),
        _ => None,
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
/// unknown persisted types fold to `series`, still honoring kitsu-id promotion.
pub(crate) fn normalize_history_row_media_type(media_type: &str, media_id: &str) -> &'static str {
    normalize_stream_media_type(media_type, Some(media_id)).unwrap_or_else(|| {
        if media_id.trim().to_ascii_lowercase().starts_with("kitsu:") {
            "anime"
        } else {
            "series"
        }
    })
}
