//! Shared `#[cfg(test)]` fixtures. One canonical literal per wire/persisted
//! struct: schema drift (new fields) is edited here once instead of across
//! per-file copies. Tests override only the fields they assert on via struct
//! update syntax (`AddonStream { url: ..., ..test_stream() }`).

use crate::commands::config_store::AddonConfig;
use crate::commands::WatchProgress;
use crate::providers::addon_manifest::{parse_addon_manifest, AddonManifest};
use crate::providers::addons::{AddonStream, StreamPresentation};
use crate::providers::MediaItem;

/// Canonical Cinemeta endpoint — the pinned default browsing addon.
pub(crate) const CINEMETA_URL: &str = "https://v3-cinemeta.strem.io";

pub(crate) fn test_stream() -> AddonStream {
    AddonStream {
        name: None,
        title: None,
        info_hash: None,
        url: None,
        file_idx: None,
        behavior_hints: None,
        cached: false,
        seeders: None,
        size_bytes: None,
        source_name: None,
        source_id: None,
        stream_family: None,
        stream_key: String::new(),
        recommendation_reasons: Vec::new(),
        match_summary: None,
        rank_debug: None,
        selection_priority: None,
        presentation: StreamPresentation::default(),
        match_text: std::sync::OnceLock::new(),
    }
}

pub(crate) fn test_progress() -> WatchProgress {
    WatchProgress {
        id: "tt123".to_string(),
        type_: "movie".to_string(),
        season: None,
        episode: None,
        absolute_season: None,
        absolute_episode: None,
        stream_season: None,
        stream_episode: None,
        position: 0.0,
        duration: 0.0,
        last_watched: 0,
        title: "Test".to_string(),
        poster: None,
        backdrop: None,
        last_stream_format: None,
        last_stream_lookup_id: None,
        last_stream_key: None,
        source_name: None,
        source_id: None,
        stream_family: None,
        resume_start_time: None,
        is_watched: false,
        has_started_watching: false,
    }
}

/// Generic addon config: `url` follows the `{id}/manifest.json` convention
/// stream-fetch tests rely on. Tests needing a specific URL override it via
/// struct update.
pub(crate) fn test_addon(id: &str, name: &str) -> AddonConfig {
    AddonConfig {
        id: id.to_string(),
        url: format!("{id}/manifest.json"),
        name: name.to_string(),
        enabled: true,
        capabilities: None,
    }
}

pub(crate) fn test_media_item(id: &str, type_: &str) -> MediaItem {
    MediaItem {
        id: id.to_string(),
        title: id.to_string(),
        poster: None,
        backdrop: None,
        logo: None,
        description: None,
        year: None,
        primary_year: None,
        display_year: None,
        genres: None,
        type_: type_.to_string(),
    }
}

/// Canonical Cinemeta-shaped manifest: `catalog` + `meta` resources with the
/// `top` (search/genre/skip extras) and `imdbRating` movie catalogs. Single
/// source so parse, URL-build, and registry tests cannot drift apart. The
/// deliberately-maximal manifest-parse edge cases stay inline in
/// `addon_manifest/tests.rs`.
pub(crate) fn cinemeta_manifest_json() -> &'static str {
    r#"{
        "name": "Cinemeta",
        "resources": ["catalog", "meta"],
        "types": ["movie", "series"],
        "idPrefixes": ["tt"],
        "catalogs": [
            {
                "type": "movie",
                "id": "top",
                "name": "Popular",
                "extra": [
                    {"name": "genre", "options": ["Action", "Animation"]},
                    {"name": "search"},
                    {"name": "skip"}
                ]
            },
            {
                "type": "movie",
                "id": "imdbRating",
                "name": "Featured",
                "extra": [
                    {"name": "genre"},
                    {"name": "skip"}
                ]
            }
        ]
    }"#
}

pub(crate) fn cinemeta_manifest() -> AddonManifest {
    parse_addon_manifest(cinemeta_manifest_json().as_bytes()).expect("valid Cinemeta fixture")
}

/// Stored Cinemeta config before capability classification.
pub(crate) fn cinemeta_addon() -> AddonConfig {
    AddonConfig {
        id: CINEMETA_URL.to_string(),
        url: CINEMETA_URL.to_string(),
        name: "Cinemeta".to_string(),
        enabled: true,
        capabilities: None,
    }
}

/// Cinemeta config carrying the canonical manifest capability snapshot.
pub(crate) fn classified_cinemeta_addon() -> AddonConfig {
    AddonConfig {
        capabilities: Some(cinemeta_manifest()),
        ..cinemeta_addon()
    }
}
