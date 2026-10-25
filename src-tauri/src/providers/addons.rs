mod stream_match;
mod transport;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::borrow::Cow;

// Re-exports keep the `providers::addons::X` surface unchanged.
pub(crate) use stream_match::{
    language_mention_is_audio, normalize_separators, stream_conflicts_with_episode_targets,
    stream_contains_batch_texts, stream_episode_match_texts, StreamEpisodeMatch,
    StreamEpisodeMatchKind, StreamFlags, StreamMatchSummary, StreamMatchText, StreamPackCoverage,
    StreamReleaseKind, StreamResolutionTier, StreamTitleMatch,
};
// Only test code calls this directly; production reads `StreamMatchText::flags`.
#[cfg(test)]
pub(crate) use stream_match::detect_stream_flags;
pub(crate) use transport::{remaining_stream_cache_ttl_ms, sanitize_addon_log, AddonTransport};

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum StreamResolution {
    #[serde(rename = "4k")]
    P2160,
    #[serde(rename = "1080p")]
    P1080,
    #[serde(rename = "720p")]
    P720,
    #[default]
    #[serde(rename = "sd")]
    Sd,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) enum StreamDeliveryKind {
    #[default]
    #[serde(rename = "p2p")]
    PeerToPeer,
    Cached,
    Http,
}

// Serialize-only: the coordinator owns presentation facts — the wire can never supply them.
#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StreamPresentation {
    /// Parsed from the stream's `name`/`title` — not the addon name (`AddonStream.source_name`).
    pub source_name: String,
    pub stream_title: String,
    pub resolution: StreamResolution,
    pub delivery_kind: StreamDeliveryKind,
    pub delivery_label: &'static str,
    pub is_instantly_playable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hdr_label: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_label: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codec_label: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multi_audio_label: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_label: Option<String>,
    pub is_batch: bool,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StreamRecommendationReason {
    VerifiedSource,
    SourceIssues,
    SourceCooling,
    ProvenReleaseGroup,
    ReleaseGroupIssues,
    ReleaseGroupCooling,
    TitleAffinity,
    LanguageMatch,
    LanguageFlexible,
    TopQuality,
    GoodQuality,
    PreferredSource,
    Fallback,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StreamMatchBadgeKind {
    Episode,
    Range,
    Season,
    MultiSeason,
    Title,
    TitlePartial,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StreamMatchTier {
    Exact,
    EpisodeRange,
    SeasonPack,
    Title,
}

/// Canonical Stremio stream object from any addon declaring `stream`.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[cfg_attr(test, derive(Default))]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddonStream {
    // Raw fields stay Rust-side (hints can carry proxy secrets); resolution runs by `stream_key`.
    #[serde(skip_serializing)]
    pub name: Option<String>,
    #[serde(alias = "description", skip_serializing)]
    pub title: Option<String>,
    #[serde(rename = "infoHash", alias = "info_hash", skip_serializing)]
    pub info_hash: Option<String>,
    #[serde(skip_serializing)]
    pub url: Option<String>,
    #[serde(rename = "fileIdx", alias = "file_idx", skip_serializing)]
    pub file_idx: Option<u32>,
    #[serde(rename = "behaviorHints", alias = "behavior_hints", skip_serializing)]
    pub behavior_hints: Option<BehaviorHints>,
    #[serde(default, deserialize_with = "deserialize_sources", skip_serializing)]
    pub sources: Vec<String>,

    // Stremio carries no `seeders`/`size`/`cached` keys — wire values could only spoof ranking.
    /// Hydration-derived availability hint; the wire exposes only `presentation.deliveryKind`.
    #[serde(skip)]
    pub cached: bool,
    #[serde(skip)]
    pub(crate) pool_fetched_at: Option<std::time::Instant>,
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub seeders: Option<u32>,
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    // Backend-derived fields are ignored on ingress, including malformed wire values.
    /// Producing addon/source, attached by `prepare_addon_streams`.
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
    /// Stable id of the producing addon config — the selector filters on this, not the name.
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    /// Backend-derived release-family identity reused across nearby episodes.
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub stream_family: Option<String>,
    /// Canonical backend-issued identity for selection, history, and recovery.
    #[serde(skip_deserializing)]
    pub stream_key: String,
    /// Backend-derived ranking reasons, ignored on ingress; the UI owns the labels.
    #[serde(skip_deserializing, skip_serializing_if = "Vec::is_empty")]
    pub recommendation_reasons: Vec<StreamRecommendationReason>,
    /// Structured episode/title match facts, set during coordinator ranking.
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub match_summary: Option<StreamMatchSummary>,
    #[serde(skip_deserializing)]
    pub match_badge_kinds: Vec<StreamMatchBadgeKind>,
    #[serde(skip_deserializing)]
    pub match_tier: Option<StreamMatchTier>,
    #[serde(skip_deserializing)]
    pub show_pack_badge: bool,
    #[serde(skip)]
    pub(crate) selection_priority: Option<SelectionPriority>,
    /// Backend-prepared presentation facts — the UI renders without reparsing raw text.
    #[serde(skip_deserializing)]
    pub presentation: StreamPresentation,
    /// Lazily computed lowered match text shared by every ranking layer; the
    /// matchable fields are fixed at decode. `skip` keeps the wire from
    /// smuggling rank text; `Arc` keeps cache clones to a refcount bump.
    #[serde(skip)]
    pub(crate) match_text: std::sync::OnceLock<std::sync::Arc<StreamMatchText>>,
}

fn deserialize_sources<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    let Value::Array(items) = value else {
        return Ok(Vec::new());
    };
    Ok(items
        .into_iter()
        .filter_map(|item| {
            let Value::String(source) = item else {
                return None;
            };
            let tracker = source.strip_prefix("tracker:")?;
            if source.chars().take(513).count() > 512
                || !["udp://", "http://", "https://", "wss://"]
                    .iter()
                    .any(|scheme| tracker.starts_with(scheme))
            {
                return None;
            }
            Some(source)
        })
        .take(24)
        .collect())
}

impl AddonStream {
    /// Lowered match text, computed once — `name`, `title`, and
    /// `behavior_hints.filename` must not mutate after the first probe.
    pub(crate) fn match_texts(&self) -> &StreamMatchText {
        self.match_text
            .get_or_init(|| std::sync::Arc::new(StreamMatchText::lower(self)))
            .as_ref()
    }

    /// Headers required to play this stream, from `proxyHeaders.request`.
    pub(crate) fn request_headers(&self) -> Vec<(String, String)> {
        self.behavior_hints
            .as_ref()
            .map(BehaviorHints::proxy_request_headers)
            .unwrap_or_default()
    }
}

/// Quality fingerprint for the preferred-position scan: "at least as good as
/// the pool's best" is elementwise dominance, not a tuple order.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct SelectionPriority {
    pub(crate) episode_match: StreamEpisodeMatchKind,
    pub(crate) season_claim_verified: bool,
    pub(crate) title_match: i8,
    pub(crate) viability: u8,
    pub(crate) language: u8,
}

impl SelectionPriority {
    /// Elementwise dominance — `>=` on a tuple would be lexicographic.
    pub(crate) fn covers(&self, best: &Self) -> bool {
        self.episode_match >= best.episode_match
            && self.season_claim_verified >= best.season_claim_verified
            && self.title_match >= best.title_match
            && self.viability >= best.viability
            && self.language >= best.language
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub(crate) struct BehaviorHints {
    #[serde(rename = "bingeGroup", alias = "binge_group")]
    pub binge_group: Option<String>,
    pub filename: Option<String>,
    #[serde(
        default,
        rename = "videoSize",
        alias = "video_size",
        deserialize_with = "deserialize_video_size",
        skip_serializing
    )]
    pub video_size: Option<u64>,
    #[serde(rename = "proxyHeaders", alias = "proxy_headers")]
    pub proxy_headers: Option<Value>,
}

fn deserialize_video_size<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    Ok(match value {
        Value::Number(number) => number.as_u64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
    .filter(|size| *size > 0))
}

/// `proxyHeaders.request` entries honored per stream; the cap blocks unbounded lists.
const MAX_PROXY_REQUEST_HEADERS: usize = 8;
const MAX_PROXY_HEADER_NAME_CHARS: usize = 128;
const MAX_PROXY_HEADER_VALUE_CHARS: usize = 4 * 1024;
pub(crate) const MAX_PROXY_HEADERS_BYTES: usize = 8 * 1024;

fn is_http_token(name: &str) -> bool {
    // RFC 7230 token: alphanumerics plus `!#$%&'*+-.^_`|~`.
    name.bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
}

/// Transport-owned headers an addon hint must not override — they'd collide
/// with framing (`Range`), misroute (`Host`), or leak proxy credentials.
/// Content headers (`Authorization`, `Cookie`, custom tokens) pass through.
fn is_transport_owned_header(name: &str) -> bool {
    // Case-insensitive without allocating: probe headers run per stream.
    [
        "host",
        "content-length",
        "transfer-encoding",
        "connection",
        "upgrade",
        "expect",
        "range",
        "proxy-authorization",
    ]
    .iter()
    .any(|owned| name.eq_ignore_ascii_case(owned))
}

fn proxy_request_header(name: &str, value: &Value) -> Option<(String, String)> {
    let name = name.trim();
    if name.is_empty()
        || name.chars().take(MAX_PROXY_HEADER_NAME_CHARS + 1).count() > MAX_PROXY_HEADER_NAME_CHARS
        || !is_http_token(name)
        || is_transport_owned_header(name)
    {
        return None;
    }
    let value = match value {
        Value::String(text) => Cow::Borrowed(text.trim()),
        Value::Number(number) => Cow::Owned(number.to_string()),
        Value::Bool(flag) => Cow::Owned(flag.to_string()),
        _ => return None,
    };
    if value.is_empty()
        || value.chars().take(MAX_PROXY_HEADER_VALUE_CHARS + 1).count()
            > MAX_PROXY_HEADER_VALUE_CHARS
        || value
            .bytes()
            .any(|byte| (byte < 0x20 && byte != b'\t') || byte == 0x7f)
    {
        return None;
    }
    Some((name.to_string(), value.into_owned()))
}

impl BehaviorHints {
    /// Bounded `proxyHeaders.request` headers for CDN playback; malformed
    /// entries degrade to headerless playback. Values are secrets — never log/persist.
    pub(crate) fn proxy_request_headers(&self) -> Vec<(String, String)> {
        let Some(request) = self
            .proxy_headers
            .as_ref()
            .and_then(|headers| headers.get("request"))
            .and_then(|request| request.as_object())
        else {
            return Vec::new();
        };
        request
            .iter()
            .filter_map(|(name, value)| proxy_request_header(name, value))
            .take(MAX_PROXY_REQUEST_HEADERS)
            .collect()
    }
}

#[cfg(test)]
mod tests;
