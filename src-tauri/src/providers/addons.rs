mod stream_match;
mod transport;

use serde::{Deserialize, Serialize};
use serde_json::Value;

// Re-exports keep the `providers::addons::X` surface unchanged: the match
// battery lives in `stream_match`, fetch/decode/cache in `transport`.
pub(crate) use stream_match::{
    normalize_separators, stream_conflicts_with_episode_targets, stream_contains_batch_texts,
    stream_episode_match_texts, StreamEpisodeMatch, StreamEpisodeMatchKind, StreamFlags,
    StreamMatchSummary, StreamMatchText, StreamReleaseKind, StreamResolutionTier, StreamTitleMatch,
};
// Only test code calls this directly; production reads `StreamMatchText::flags`.
#[cfg(test)]
pub(crate) use stream_match::detect_stream_flags;
pub(crate) use transport::{sanitize_addon_log, AddonTransport};

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

// Serialize-only: `AddonStream.presentation` is `skip_deserializing` — the
// coordinator owns presentation facts and the wire can never supply them.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StreamPresentation {
    /// Display label parsed from the stream's own `name`/`title` text —
    /// NOT the producing addon's name (that lives on `AddonStream.source_name`).
    pub source_name: String,
    pub stream_title: String,
    pub resolution: StreamResolution,
    pub delivery_kind: StreamDeliveryKind,
    pub delivery_label: String,
    pub is_instantly_playable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hdr_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codec_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multi_audio_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_label: Option<String>,
    pub is_batch: bool,
}

impl Default for StreamPresentation {
    fn default() -> Self {
        Self {
            source_name: "Unknown".to_string(),
            stream_title: "Unknown".to_string(),
            resolution: StreamResolution::Sd,
            delivery_kind: StreamDeliveryKind::PeerToPeer,
            delivery_label: "P2P".to_string(),
            is_instantly_playable: false,
            hdr_label: None,
            audio_label: None,
            codec_label: None,
            multi_audio_label: None,
            size_label: None,
            is_batch: false,
        }
    }
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

/// Canonical Stremio stream object returned by any addon declaring the
/// `stream` resource.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddonStream {
    // Raw addon fields stay Rust-side (hints can carry proxy-header secrets);
    // resolution runs by `stream_key`, so they never cross into the payload.
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

    // Computed fields: Stremio streams carry no `seeders`/`size`/`cached`
    // keys, so wire values could only spoof ranking — hydration is the sole
    // writer, decode ignores them outright.
    /// Hydration-derived availability hint for delivery classification; the
    /// wire exposes only the `presentation.deliveryKind` verdict.
    #[serde(skip)]
    pub cached: bool,
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub seeders: Option<u32>,
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    /// Producing addon/source (set by commands.rs, not the addon payload).
    #[serde(
        default,
        alias = "source_name",
        skip_serializing_if = "Option::is_none"
    )]
    pub source_name: Option<String>,
    /// Stable instance id of the producing addon config — the selector
    /// filters on this rather than the display name.
    #[serde(default, alias = "source_id", skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    /// Backend-derived release-family identity reused across nearby episodes.
    #[serde(
        default,
        alias = "stream_family",
        skip_serializing_if = "Option::is_none"
    )]
    pub stream_family: Option<String>,
    /// Canonical backend-issued identity for selection, history, and recovery.
    #[serde(rename = "streamKey", alias = "stream_key", default)]
    pub stream_key: String,
    /// Structured reasons the coordinator ranked this stream here; the UI
    /// owns the labels. Coordinator outputs never decode from the wire —
    /// a malformed injected value would otherwise fail the stream's decode.
    #[serde(skip_deserializing, skip_serializing_if = "Vec::is_empty")]
    pub recommendation_reasons: Vec<StreamRecommendationReason>,
    /// Structured episode/title match facts, set during coordinator ranking.
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub match_summary: Option<StreamMatchSummary>,
    /// Debug-build dump of the full sort key — absent from release payloads;
    /// `skip_deserializing` keeps the wire from forging it.
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub rank_debug: Option<String>,
    #[serde(skip)]
    pub(crate) selection_priority: Option<SelectionPriority>,
    /// Backend-prepared presentation facts so the UI renders without reparsing raw text.
    #[serde(skip_deserializing)]
    pub presentation: StreamPresentation,
    /// Lazily computed lowered match text shared by every ranking layer. The
    /// matchable fields are fixed at decode time, so the first probe fills
    /// this once. `skip` keeps the wire from smuggling precomputed rank text.
    /// `Arc` keeps TTL-cache clones to a refcount bump instead of re-cloning
    /// the four normalized strings on every cache-hit `to_vec`.
    #[serde(skip)]
    pub(crate) match_text: std::sync::OnceLock<std::sync::Arc<StreamMatchText>>,
}

impl AddonStream {
    /// Lowered, separator-normalized match text, computed once per stream.
    /// `name`, `title`, and `behavior_hints.filename` are decode-time fields
    /// — callers must not mutate them after the first match probe.
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

/// Coordinator-assigned quality fingerprint used by the preferred-position
/// scan: "at least as good as the pool's best" is an elementwise dominance
/// check, not a tuple order — named fields keep the construction site in
/// `stream_coordinator` and the comparison in `probe_pool` honest.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct SelectionPriority {
    pub(crate) episode_match: StreamEpisodeMatchKind,
    pub(crate) season_claim_verified: bool,
    pub(crate) title_match: i8,
    pub(crate) viability: u8,
    pub(crate) language: u8,
}

impl SelectionPriority {
    /// True when `self` trails `best` on no field. `>=` on the tuple shape
    /// would be lexicographic — dominance must compare every field.
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
    #[serde(rename = "proxyHeaders", alias = "proxy_headers")]
    pub proxy_headers: Option<Value>,
}

/// `proxyHeaders.request` entries honored per stream — real hints carry a
/// handful of CDN auth headers; the cap blocks unbounded lists.
const MAX_PROXY_REQUEST_HEADERS: usize = 8;
const MAX_PROXY_HEADER_NAME_CHARS: usize = 128;
const MAX_PROXY_HEADER_VALUE_CHARS: usize = 4 * 1024;
pub(crate) const MAX_PROXY_HEADERS_BYTES: usize = 8 * 1024;

fn is_http_token(name: &str) -> bool {
    // RFC 7230 token: alphanumerics plus `!#$%&'*+-.^_`|~`.
    name.bytes().all(|byte| {
        byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'!' | b'#'
                    | b'$'
                    | b'%'
                    | b'&'
                    | b'\''
                    | b'*'
                    | b'+'
                    | b'-'
                    | b'.'
                    | b'^'
                    | b'_'
                    | b'`'
                    | b'|'
                    | b'~'
            )
    })
}

/// Transport-owned headers: an addon hint carrying one would collide with
/// the client's framing (a second `Range` next to the probe's `bytes=0-0`),
/// misroute (`Host`), or leak proxy credentials — never forwarded. Content
/// headers (`Authorization`, `Cookie`, custom tokens) pass through.
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
        || name.chars().count() > MAX_PROXY_HEADER_NAME_CHARS
        || !is_http_token(name)
        || is_transport_owned_header(name)
    {
        return None;
    }
    let value = match value {
        // Trim straight off the borrowed text: no clone-then-retrim pass.
        Value::String(text) => text.trim().to_string(),
        Value::Number(number) => number.to_string(),
        Value::Bool(flag) => flag.to_string(),
        // Arrays, objects, and null carry no header value.
        _ => return None,
    };
    if value.is_empty()
        || value.chars().count() > MAX_PROXY_HEADER_VALUE_CHARS
        || value.contains(['\r', '\n'])
    {
        return None;
    }
    Some((name.to_string(), value))
}

impl BehaviorHints {
    /// Bounded `proxyHeaders.request` headers for header-gated CDN playback.
    /// Malformed entries degrade to headerless playback rather than failing
    /// the stream. Values are secrets — never log or persist them.
    pub(crate) fn proxy_request_headers(&self) -> Vec<(String, String)> {
        let Some(request) = self
            .proxy_headers
            .as_ref()
            .and_then(|headers| headers.get("request"))
            .and_then(|request| request.as_object())
        else {
            return Vec::new();
        };
        let mut headers = Vec::new();
        for (name, value) in request {
            if headers.len() >= MAX_PROXY_REQUEST_HEADERS {
                break;
            }
            if let Some(header) = proxy_request_header(name, value) {
                headers.push(header);
            }
        }
        headers
    }
}

// ─── Unit Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests;
