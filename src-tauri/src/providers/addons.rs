mod stream_match;
mod transport;

use serde::{Deserialize, Serialize};
use serde_json::Value;

// Re-exports keep the `providers::addons::X` surface unchanged for the
// commands/* consumers; the match battery lives in `stream_match` and
// fetch/decode/cache in `transport`.
pub(crate) use stream_match::{
    normalize_separators, stream_conflicts_with_episode_targets, stream_contains_batch_texts,
    stream_episode_match_texts, StreamEpisodeMatch, StreamEpisodeMatchKind, StreamFlags,
    StreamMatchSummary, StreamMatchText, StreamReleaseKind, StreamResolutionTier, StreamTitleMatch,
};
// Only test code calls this directly; production reads `StreamMatchText::flags`.
#[cfg(test)]
pub(crate) use stream_match::detect_stream_flags;
pub(crate) use transport::{sanitize_addon_log, AddonTransport};

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
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

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) enum StreamDeliveryKind {
    #[default]
    #[serde(rename = "p2p")]
    PeerToPeer,
    Cached,
    Http,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StreamPresentation {
    /// Display label parsed from the stream's own `name`/`title` text (first
    /// line, leading meta stripped) — e.g. the release group or debrid tag
    /// the addon embedded. NOT the producing addon's name; that lives on
    /// `AddonStream.source_name` / `source_id`.
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

/// Canonical Stremio stream object returned by any addon declaring the
/// `stream` resource.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddonStream {
    // Raw addon fields below stay Rust-side: resolution runs by
    // `stream_key`, so name/title/hash/url/hints never cross into the webview
    // payload (behavior hints can carry proxy-header secrets).
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

    // Computed fields; serde keeps old wire working.
    /// Hydration-derived availability hint — consumed Rust-side by delivery
    /// classification and family derivation; the wire exposes only the
    /// `presentation.deliveryKind` verdict.
    #[serde(default, skip_serializing)]
    pub cached: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seeders: Option<u32>,
    #[serde(default, alias = "size_bytes", skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    /// Which addon/source produced this stream (set by commands.rs, not from the addon payload).
    #[serde(
        default,
        alias = "source_name",
        skip_serializing_if = "Option::is_none"
    )]
    pub source_name: Option<String>,
    /// Stable instance id of the producing addon config (set by commands.rs):
    /// the selector filters on this rather than the display name.
    #[serde(default, alias = "source_id", skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    /// Stable backend-derived identity for release families that can be reused across nearby episodes.
    #[serde(
        default,
        alias = "stream_family",
        skip_serializing_if = "Option::is_none"
    )]
    pub stream_family: Option<String>,
    /// Canonical backend-issued identity for selection, history, and recovery flows.
    #[serde(rename = "streamKey", alias = "stream_key", default)]
    pub stream_key: String,
    /// Short user-facing explanation from the backend coordinator for why this stream ranks here.
    #[serde(default, alias = "recommendation_reasons")]
    pub recommendation_reasons: Vec<String>,
    /// Structured episode/title match facts, set during coordinator ranking.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub match_summary: Option<StreamMatchSummary>,
    /// Dev-only dump of the full sort key, populated only in debug builds
    /// (`cfg!(debug_assertions)`) so the release payload is byte-identical.
    /// `skip_deserializing` keeps an addon payload from forging it.
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub rank_debug: Option<String>,
    #[serde(skip)]
    pub(crate) selection_priority: Option<(StreamEpisodeMatchKind, bool, i8, u8, u8)>,
    /// Backend-prepared presentation facts so the UI can render without reparsing raw stream text.
    #[serde(default)]
    pub presentation: StreamPresentation,
    /// Lazily computed lowered match text shared by every ranking layer
    /// (transport sort, presentation build, coordinator). The matchable
    /// fields are fixed at decode time, so the first probe fills this once
    /// and later layers reuse it. Never serialized and never read from the
    /// wire: an addon payload cannot smuggle precomputed ranking text in.
    #[serde(skip)]
    pub(crate) match_text: std::sync::OnceLock<StreamMatchText>,
}

impl AddonStream {
    /// Lowered, separator-normalized match text, computed at most once per
    /// stream and shared by transport rank, presentation, and coordinator
    /// ranking. `name`, `title`, and `behavior_hints.filename` are
    /// decode-time fields — callers must not mutate them after the first
    /// match probe.
    pub(crate) fn match_texts(&self) -> &StreamMatchText {
        self.match_text.get_or_init(|| StreamMatchText::lower(self))
    }

    /// Request headers required to play this stream, lifted out of
    /// `behaviorHints.proxyHeaders.request`.
    pub(crate) fn request_headers(&self) -> Vec<(String, String)> {
        self.behavior_hints
            .as_ref()
            .map(BehaviorHints::proxy_request_headers)
            .unwrap_or_default()
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

/// Maximum `proxyHeaders.request` entries honored per stream. Protocol hints
/// carry a handful of CDN auth headers; the cap keeps a malicious addon from
/// stuffing unbounded header lists into probe requests and player state.
const MAX_PROXY_REQUEST_HEADERS: usize = 8;
const MAX_PROXY_HEADER_NAME_CHARS: usize = 128;
const MAX_PROXY_HEADER_VALUE_CHARS: usize = 4 * 1024;

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

/// Headers owned by the HTTP transport itself. An addon hint carrying one of
/// these would collide with the client's own framing (notably a second
/// `Range` next to the probe's `bytes=0-0`, which servers may reject),
/// misroute the request (`Host`), or leak proxy credentials, so they are
/// never forwarded. Content headers (`Authorization`, `Cookie`, `Referer`,
/// `User-Agent`, custom tokens) pass through.
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
    /// Only the `request` object is honored; malformed entries degrade to
    /// headerless playback instead of failing the stream or risking response
    /// splitting. Header values are secrets (bearer tokens): callers must
    /// never log or persist the result.
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
