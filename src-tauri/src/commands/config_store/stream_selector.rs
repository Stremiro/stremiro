use super::{
    lenient_option, DurableStore, STREAM_SELECTOR_ADDON_MAX_CHARS, STREAM_SELECTOR_PREFERENCES_KEY,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
pub enum StreamSelectorQuality {
    #[default]
    #[serde(rename = "all")]
    All,
    #[serde(rename = "4k")]
    P2160,
    #[serde(rename = "1080p")]
    P1080,
    #[serde(rename = "720p")]
    P720,
    #[serde(rename = "sd")]
    Sd,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum StreamSelectorSource {
    #[default]
    All,
    Cached,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum StreamSelectorSort {
    #[default]
    Smart,
    Quality,
    Seeds,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum StreamSelectorBatch {
    #[default]
    All,
    Episodes,
    Packs,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamSelectorPreferences {
    pub quality: StreamSelectorQuality,
    pub source: StreamSelectorSource,
    pub addon: String,
    pub sort: StreamSelectorSort,
    pub batch: StreamSelectorBatch,
}

impl Default for StreamSelectorPreferences {
    fn default() -> Self {
        Self {
            quality: StreamSelectorQuality::All,
            source: StreamSelectorSource::All,
            addon: "all".to_string(),
            sort: StreamSelectorSort::Smart,
            batch: StreamSelectorBatch::All,
        }
    }
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StreamSelectorPreferencesPatch {
    pub episode_context: bool,
    pub quality: Option<StreamSelectorQuality>,
    pub source: Option<StreamSelectorSource>,
    pub addon: Option<String>,
    pub sort: Option<StreamSelectorSort>,
    pub batch: Option<StreamSelectorBatch>,
}

pub(crate) fn default_stream_selector_preferences(
    episode_context: bool,
) -> StreamSelectorPreferences {
    StreamSelectorPreferences {
        batch: if episode_context {
            StreamSelectorBatch::Episodes
        } else {
            StreamSelectorBatch::All
        },
        ..StreamSelectorPreferences::default()
    }
}

pub(crate) fn apply_stream_selector_preferences_patch(
    mut preferences: StreamSelectorPreferences,
    initialized: bool,
    patch: StreamSelectorPreferencesPatch,
) -> StreamSelectorPreferences {
    if !initialized {
        preferences = default_stream_selector_preferences(patch.episode_context);
    }
    if let Some(quality) = patch.quality {
        preferences.quality = quality;
    }
    if let Some(source) = patch.source {
        preferences.source = source;
    }
    if let Some(addon) = patch.addon {
        preferences.addon = addon;
    }
    if let Some(sort) = patch.sort {
        preferences.sort = sort;
    }
    if let Some(batch) = patch.batch {
        preferences.batch = batch;
    }
    sanitize_stream_selector_preferences(preferences)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredStreamSelectorPreferences {
    #[serde(default, deserialize_with = "lenient_option")]
    quality: Option<String>,
    #[serde(default, deserialize_with = "lenient_option")]
    source: Option<String>,
    #[serde(default, deserialize_with = "lenient_option")]
    addon: Option<String>,
    #[serde(default, deserialize_with = "lenient_option")]
    sort: Option<String>,
    #[serde(default, deserialize_with = "lenient_option")]
    batch: Option<String>,
}

pub(crate) fn parse_stream_selector_preferences(value: Value) -> Option<StreamSelectorPreferences> {
    serde_json::from_value::<StoredStreamSelectorPreferences>(value)
        .ok()
        .map(normalize_stored_stream_selector_preferences)
}

fn normalize_stream_selector_quality(value: Option<&str>) -> StreamSelectorQuality {
    match value.map(str::trim) {
        Some(value) if value.eq_ignore_ascii_case("4k") => StreamSelectorQuality::P2160,
        Some(value) if value.eq_ignore_ascii_case("1080p") => StreamSelectorQuality::P1080,
        Some(value) if value.eq_ignore_ascii_case("720p") => StreamSelectorQuality::P720,
        Some(value) if value.eq_ignore_ascii_case("sd") => StreamSelectorQuality::Sd,
        _ => StreamSelectorQuality::All,
    }
}

fn normalize_stream_selector_source(value: Option<&str>) -> StreamSelectorSource {
    match value.map(str::trim) {
        Some(value) if value.eq_ignore_ascii_case("cached") => StreamSelectorSource::Cached,
        _ => StreamSelectorSource::All,
    }
}

fn normalize_stream_selector_sort(value: Option<&str>) -> StreamSelectorSort {
    match value.map(str::trim) {
        Some(value) if value.eq_ignore_ascii_case("quality") => StreamSelectorSort::Quality,
        Some(value) if value.eq_ignore_ascii_case("seeds") => StreamSelectorSort::Seeds,
        _ => StreamSelectorSort::Smart,
    }
}

fn normalize_stream_selector_batch(value: Option<&str>) -> StreamSelectorBatch {
    match value.map(str::trim) {
        Some(value) if value.eq_ignore_ascii_case("episodes") => StreamSelectorBatch::Episodes,
        Some(value) if value.eq_ignore_ascii_case("packs") => StreamSelectorBatch::Packs,
        _ => StreamSelectorBatch::All,
    }
}

fn normalize_stream_selector_addon(value: Option<String>) -> String {
    match value.as_deref().map(str::trim) {
        Some(value)
            if !value.is_empty()
                && !value.eq_ignore_ascii_case("all")
                && value.chars().nth(STREAM_SELECTOR_ADDON_MAX_CHARS).is_none() =>
        {
            value.to_string()
        }
        _ => "all".to_string(),
    }
}

pub(crate) fn sanitize_stream_selector_preferences(
    preferences: StreamSelectorPreferences,
) -> StreamSelectorPreferences {
    StreamSelectorPreferences {
        quality: preferences.quality,
        source: preferences.source,
        addon: normalize_stream_selector_addon(Some(preferences.addon)),
        sort: preferences.sort,
        batch: preferences.batch,
    }
}

fn normalize_stored_stream_selector_preferences(
    preferences: StoredStreamSelectorPreferences,
) -> StreamSelectorPreferences {
    StreamSelectorPreferences {
        quality: normalize_stream_selector_quality(preferences.quality.as_deref()),
        source: normalize_stream_selector_source(preferences.source.as_deref()),
        addon: normalize_stream_selector_addon(preferences.addon),
        sort: normalize_stream_selector_sort(preferences.sort.as_deref()),
        batch: normalize_stream_selector_batch(preferences.batch.as_deref()),
    }
}

/// One store read for the `(preferences, initialized)` pair — both halves share the same key.
pub(crate) fn load_stream_selector_preferences_state(
    store: &DurableStore,
) -> (StreamSelectorPreferences, bool) {
    let stored = store.get(STREAM_SELECTOR_PREFERENCES_KEY);
    let initialized = stored.is_some();
    let preferences = stored
        .and_then(parse_stream_selector_preferences)
        .unwrap_or_default();
    (preferences, initialized)
}

pub(crate) fn save_stream_selector_preferences_to_store(
    store: &DurableStore,
    preferences: &StreamSelectorPreferences,
) {
    store.set(
        STREAM_SELECTOR_PREFERENCES_KEY,
        serde_json::json!(preferences),
    );
}
