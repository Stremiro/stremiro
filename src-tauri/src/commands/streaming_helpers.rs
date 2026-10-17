use super::config_store::AddonConfig;
use super::history_helpers::STREAM_KEY_MAX_CHARS;
use super::language::bracketed_language_tags;
use crate::providers::addon_resource::is_magnet_url;
use crate::providers::addons::{
    language_mention_is_audio, normalize_separators, stream_contains_batch_texts, AddonStream,
    StreamDeliveryKind, StreamFlags, StreamPresentation, StreamReleaseKind, StreamResolution,
    StreamResolutionTier, STREAM_SIZE_REGEX,
};
use crate::providers::{non_blank, push_unique};
use regex::Regex;
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::LazyLock;

static STREAM_FAMILY_EPISODE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i)",
        r"\bs\d{1,2}e\d{1,4}(?:-?e\d{1,4})*\b",
        r"|\b\d{1,2}x\d{1,4}\b",
        r"|\b(?:episode|ep)\.?\s*\d{1,4}\b",
        r"|(?:^|\s|\b)(?:#(?P<hash_episode>\d{1,4})",
        r"|(?:season\s*\d+\s*)?-\s*(?P<dash_episode>\d{2,4}))\b"
    ))
    .expect("valid stream family episode regex")
});
static STREAM_FAMILY_SIZE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b\d+(?:[.,]\d+)?\s*(?:k|m|g|t)i?b\b").expect("valid stream family size regex")
});
static STREAM_FAMILY_NON_WORD_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^a-z0-9]+").expect("valid stream family non-word regex"));
/// Emoji/pictograph blocks addons decorate names with, plus joiners and variation selectors.
const STREAM_PICTOGRAPH_CLASS: &str = r"\x{1F000}-\x{1FAFF}\x{2300}-\x{23FF}\x{2600}-\x{27BF}\x{2B00}-\x{2BFF}\x{200D}\x{20E3}\x{FE0E}\x{FE0F}\x{E0020}-\x{E007F}";
static STREAM_NON_META_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"[^{STREAM_PICTOGRAPH_CLASS}\s\[\]|]"))
        .expect("valid stream meta-only regex")
});
static STREAM_PICTOGRAPH_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!("[{STREAM_PICTOGRAPH_CLASS}]+")).expect("valid stream pictograph regex")
});
static STREAM_BRACKET_PADDING_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"([\[(])\s+|\s+([\])])").expect("valid stream bracket padding regex")
});
static STREAM_EMPTY_BRACKETS_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\]|\(\)").expect("valid stream empty brackets regex"));
static STREAM_FILENAME_HINT_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)([\w].*\d{3,4}p|S\d{1,2}E\d{1,4})").expect("valid stream filename hint regex")
});
static STREAM_CLIP_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    // Only release-position markers count; title words before episode/year/quality tokens do not.
    Regex::new(concat!(
        r"(?i)\b(?:s[0-9]{1,2}(?:e[0-9]{1,4})*|[0-9]{1,2}x[0-9]{1,4}",
        r"|(?:19|20)[0-9]{2}|[0-9]{3,4}p|[48]k)\b[^\r\n]*\b(?:sample|trailer|teaser)\b",
        r"|\b(?:sample|trailer|teaser)\.(?:mkv|mp4|avi|webm|mov|m4v|ts|m2ts)\b"
    ))
    .expect("valid stream clip regex")
});

fn normalize_stream_family_component(value: &str) -> Option<String> {
    // `_` is a word char and defeats the `\b` anchors below — normalize separators
    // first or `_`-joined release names keep episode/size tokens and fragment the key.
    let value = normalize_separators(value);
    // Strip sizes first so a dash followed by "12 GB" cannot leave a stray "GB".
    let normalized = STREAM_FAMILY_SIZE_REGEX.replace_all(&value, " ");
    let normalized =
        STREAM_FAMILY_EPISODE_REGEX.replace_all(&normalized, |captures: &regex::Captures<'_>| {
            let bare_episode = captures
                .name("hash_episode")
                .or_else(|| captures.name("dash_episode"))
                .and_then(|value| value.as_str().parse::<u32>().ok());
            if bare_episode.is_some_and(|number| (1900..=2099).contains(&number)) {
                captures[0].to_string()
            } else {
                " ".to_string()
            }
        });
    let normalized_lower = normalized.to_ascii_lowercase();
    let normalized = STREAM_FAMILY_NON_WORD_REGEX.replace_all(&normalized_lower, " ");
    let mut component = String::new();
    for token in normalized.split_whitespace().take(12) {
        if !component.is_empty() {
            component.push('-');
        }
        component.push_str(token);
    }

    if component.is_empty() {
        None
    } else {
        Some(component)
    }
}

/// Test wrapper — production batches call `derive_stream_family_normalized` directly.
#[cfg(test)]
pub(crate) fn derive_stream_family(stream: &AddonStream, source_id: &str) -> Option<String> {
    let source_key = stream_family_source_key(source_id)?;
    Some(derive_stream_family_normalized(stream, &source_key))
}

fn stream_family_source_key(source_id: &str) -> Option<String> {
    let source_id = normalize_source_id(source_id)?;
    Some(format!("v2:{:x}", Sha256::digest(source_id.as_bytes())))
}

pub(crate) fn is_current_stream_family(value: &str) -> bool {
    let Some((source, family)) = value.split_once('|') else {
        return false;
    };
    source.strip_prefix("v2:").is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }) && family.split_once(':').is_some_and(|(kind, component)| {
        matches!(kind, "binge" | "release" | "delivery")
            && !component.is_empty()
            && component
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    })
}

/// Source digest is constant across the batch and never exposes credential-bearing addon ids.
fn derive_stream_family_normalized(stream: &AddonStream, source_key: &str) -> String {
    if let Some(binge_group) = stream
        .behavior_hints
        .as_ref()
        .and_then(|hints| hints.binge_group.as_deref())
        .and_then(normalize_stream_family_component)
    {
        return stream_family(source_key, "binge", &binge_group);
    }

    let hint = stream
        .behavior_hints
        .as_ref()
        .and_then(|hints| hints.filename.as_deref())
        .or(stream.name.as_deref())
        .or(stream.title.as_deref())
        .and_then(normalize_stream_family_component);

    hint.map_or_else(
        || {
            let delivery = match stream_delivery_kind(stream) {
                StreamDeliveryKind::Cached => "cached",
                StreamDeliveryKind::Http => "http",
                StreamDeliveryKind::PeerToPeer => "p2p",
            };
            stream_family(source_key, "delivery", delivery)
        },
        |value| stream_family(source_key, "release", &value),
    )
}

fn stream_family(source_key: &str, kind: &str, component: &str) -> String {
    // Consumers drop identities past this bound; digest long components instead.
    if source_key.len() + kind.len() + component.len() + 2 > SOURCE_IDENTITY_MAX_CHARS {
        format!(
            "{source_key}|{kind}:{:x}",
            Sha256::digest(component.as_bytes())
        )
    } else {
        format!("{source_key}|{kind}:{component}")
    }
}

fn stream_delivery_kind(stream: &AddonStream) -> StreamDeliveryKind {
    // Without a direct HTTP URL the row resolves as P2P whatever the `cached` hint claims.
    if !stream.url.as_deref().is_some_and(is_http_url) {
        StreamDeliveryKind::PeerToPeer
    } else if stream.cached {
        StreamDeliveryKind::Cached
    } else {
        StreamDeliveryKind::Http
    }
}

pub(crate) fn normalize_http_url(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    let parsed = reqwest::Url::parse(trimmed).ok()?;
    match parsed.scheme() {
        "http" | "https" => Some(parsed.to_string()),
        _ => None,
    }
}

pub(crate) fn is_http_url(input: &str) -> bool {
    // Scheme probe only — `normalize_http_url` would allocate a String per call just to drop it.
    let trimmed = input.trim();
    !trimmed.is_empty()
        && reqwest::Url::parse(trimmed)
            .ok()
            .is_some_and(|parsed| matches!(parsed.scheme(), "http" | "https"))
}

pub(crate) fn has_playable_stream_source(stream: &AddonStream) -> bool {
    if stream.info_hash.as_deref().is_some_and(non_blank) {
        return true;
    }
    let Some(url) = stream.url.as_deref().map(str::trim) else {
        return false;
    };
    if url.is_empty() {
        return false;
    }
    if is_magnet_url(url) {
        return true;
    }
    is_http_url(url)
}

pub(crate) fn is_placeholder_no_stream(stream: &AddonStream) -> bool {
    let texts = stream.match_texts();
    let name = texts.name.as_deref().unwrap_or("");
    let title = texts.title.as_deref().unwrap_or("");
    // `no_streams_available` arrives as an underscore literal; match texts normalize `_` to space.
    let filename = texts.filename.as_deref().unwrap_or("");

    name.contains("[blocked]")
        || name.contains("no streams available")
        || title.contains("no streams found for this content")
        || title.contains("no streams available")
        || filename.contains("no streams available")
}

/// Hash segment cap so `h:{hash}:{file_idx}` fits `STREAM_KEY_MAX_CHARS` (persisted as
/// `last_stream_key`). Real btih/btmh values are far shorter; only hostile payloads reach this.
const STREAM_HASH_KEY_MAX_CHARS: usize = STREAM_KEY_MAX_CHARS - 16;

fn stream_hash_dedup_key(hash: String, file_idx: Option<u32>) -> String {
    // Byte length bounds char count from above — a short hash skips the rebuilding collect.
    let hash: String = if hash.len() <= STREAM_HASH_KEY_MAX_CHARS {
        hash
    } else {
        hash.chars().take(STREAM_HASH_KEY_MAX_CHARS).collect()
    };
    format!("h:{}:{}", hash, file_idx.unwrap_or(0))
}

pub(crate) fn stream_dedup_key(stream: &AddonStream) -> Option<String> {
    if let Some(hash) = stream
        .info_hash
        .as_deref()
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .map(|h| h.to_ascii_lowercase())
    {
        return Some(stream_hash_dedup_key(hash, stream.file_idx));
    }

    // Magnet-only streams (URL but no `info_hash` — allowed by the addon spec) reuse the
    // `xt` hash as the `h:` identity so they dedupe against field-carrying duplicates.
    if let Some(hash) = stream.url.as_deref().and_then(magnet_xt_hash) {
        return Some(stream_hash_dedup_key(hash, stream.file_idx));
    }

    // URL variants of one file dedupe together; distinct file_idx stay separate. The URL is
    // hashed — `stream_key` is webview-facing/persisted and may carry signed-query credentials.
    stream
        .url
        .as_deref()
        .and_then(normalize_stream_dedup_url)
        .map(|url| {
            format!(
                "uh:{:016x}:{}",
                stream_url_key_digest(&url),
                stream.file_idx.unwrap_or(0)
            )
        })
}

/// `xt` content hash from a `magnet:` URL (`urn:btih:`/`urn:btmh:`), lowercased.
/// Content-derived (not credential-bearing), so safe as a persisted dedup identity.
fn magnet_xt_hash(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if !is_magnet_url(trimmed) {
        return None;
    }
    let parsed = reqwest::Url::parse(trimmed).ok()?;
    parsed
        .query_pairs()
        .filter(|(key, _)| key.eq_ignore_ascii_case("xt"))
        .filter_map(|(_, value)| {
            let lowered = value.to_ascii_lowercase();
            lowered
                .strip_prefix("urn:btih:")
                .or_else(|| lowered.strip_prefix("urn:btmh:"))
                .map(str::to_string)
        })
        .find(|hash| !hash.is_empty())
}

/// 64-bit stream-URL fingerprint: first 8 bytes of SHA-256 over the canonicalized URL.
/// Truncation is safe — streams per title sit far below the birthday bound — and the
/// digest is irreversible, so dedup keys carry no credential material.
fn stream_url_key_digest(normalized_url: &str) -> u64 {
    let digest = Sha256::digest(normalized_url.as_bytes());
    digest[..8]
        .iter()
        .fold(0u64, |acc, byte| (acc << 8) | u64::from(*byte))
}

/// Canonical stream-URL form for dedup: lowercase host, sorted query (tracking keys dropped),
/// credentials/fragment cleared. `None` for unparseable URLs — never key on raw attacker bytes.
fn normalize_stream_dedup_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut parsed = reqwest::Url::parse(trimmed).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    parsed.set_username("").ok();
    parsed.set_password(None).ok();
    parsed.set_fragment(None);
    let mut pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .filter(|(key, _)| {
            ![
                "utm_source",
                "utm_medium",
                "utm_campaign",
                "utm_term",
                "utm_content",
                "fbclid",
                "gclid",
                "msclkid",
                "ref",
                "referrer",
            ]
            .iter()
            .any(|tracking_key| key.eq_ignore_ascii_case(tracking_key))
        })
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    pairs.sort();
    parsed.query_pairs_mut().clear().extend_pairs(
        pairs
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str())),
    );
    Some(parsed.to_string())
}

/// Resolution points for the composite quality score (`StreamMatchText::flags` classifier).
fn stream_resolution_quality_points(tier: StreamResolutionTier) -> i32 {
    match tier {
        StreamResolutionTier::P2160 => 400,
        StreamResolutionTier::P1080 => 300,
        StreamResolutionTier::P720 => 200,
        StreamResolutionTier::P480 => 100,
        StreamResolutionTier::Sd => 0,
    }
}

fn stream_resolution(tier: StreamResolutionTier) -> StreamResolution {
    match tier {
        StreamResolutionTier::P2160 => StreamResolution::P2160,
        StreamResolutionTier::P1080 => StreamResolution::P1080,
        StreamResolutionTier::P720 => StreamResolution::P720,
        // Badge enum stops at three tiers: 480p ranks above SD but presents as SD.
        StreamResolutionTier::P480 | StreamResolutionTier::Sd => StreamResolution::Sd,
    }
}

fn is_meta_only(value: &str) -> bool {
    value.len() < 6 || !STREAM_NON_META_REGEX.is_match(value)
}

fn looks_like_filename(value: &str) -> bool {
    STREAM_FILENAME_HINT_REGEX.is_match(value) || value.len() > 30
}

fn get_display_lines(stream: &AddonStream) -> (&str, Cow<'_, str>) {
    let raw_name = stream.name.as_deref().unwrap_or("");
    let raw_title = stream.title.as_deref().unwrap_or("");
    let name_first_line = raw_name.lines().next().map(str::trim).unwrap_or("");
    let title_first_line = raw_title.lines().next().map(str::trim).unwrap_or("");

    if is_meta_only(name_first_line) && looks_like_filename(title_first_line) {
        let mut stream_title = String::new();
        for line in raw_name.lines().skip(1) {
            if stream_title.is_empty() {
                stream_title.push_str(line.trim_start());
            } else {
                stream_title.push(' ');
                stream_title.push_str(line);
            }
        }
        stream_title.truncate(stream_title.trim_end().len());

        return (
            title_first_line,
            if stream_title.is_empty() {
                Cow::Borrowed(title_first_line)
            } else {
                Cow::Owned(stream_title)
            },
        );
    }

    (
        if name_first_line.is_empty() {
            if title_first_line.is_empty() {
                "Unknown"
            } else {
                title_first_line
            }
        } else {
            name_first_line
        },
        Cow::Borrowed(if title_first_line.is_empty() {
            if name_first_line.is_empty() {
                "Unknown"
            } else {
                name_first_line
            }
        } else {
            title_first_line
        }),
    )
}

pub(crate) fn format_stream_size_label(raw_text: &str, size_bytes: Option<u64>) -> Option<String> {
    if let Some(captures) = STREAM_SIZE_REGEX.captures(raw_text) {
        let amount = captures
            .get(1)
            .map(|capture| capture.as_str())
            .unwrap_or_default();
        let unit = captures
            .get(2)
            .map(|capture| capture.as_str())
            .unwrap_or_default()
            .to_ascii_uppercase()
            .replace('I', "");

        return Some(format!("{}{}", amount, unit));
    }

    size_bytes.map(|size_bytes| {
        // Display-only; precision loss past 2^53 only affects the fractional digit.
        #[allow(clippy::cast_precision_loss)]
        let gb = size_bytes as f64 / 1_073_741_824.0;
        if gb >= 1.0 {
            format!("{gb:.1}GB")
        } else {
            format!("{}MB", size_bytes / 1_048_576)
        }
    })
}

/// Display-only cleanup: drops addon emoji decoration. Pictographs become spaces first
/// so `💾1.2GB👤5` cannot fuse into `1.2GB5`.
fn strip_display_pictographs(value: &str) -> Cow<'_, str> {
    let trimmed =
        value.trim_matches(|c: char| matches!(c, '|' | '·' | '•' | '-' | ':') || c.is_whitespace());
    let mut previous_space = false;
    let needs_spacing = trimmed.chars().any(|character| {
        let whitespace = character.is_whitespace();
        let needs_spacing = whitespace && (character != ' ' || previous_space);
        previous_space = whitespace;
        needs_spacing
    });
    if !needs_spacing
        && !STREAM_PICTOGRAPH_REGEX.is_match(trimmed)
        && !STREAM_BRACKET_PADDING_REGEX.is_match(trimmed)
        && !STREAM_EMPTY_BRACKETS_REGEX.is_match(trimmed)
    {
        return Cow::Borrowed(trimmed);
    }

    let spaced = STREAM_PICTOGRAPH_REGEX.replace_all(value, " ");
    let mut normalized = String::with_capacity(spaced.len());
    for token in spaced.split_whitespace() {
        if !normalized.is_empty() {
            normalized.push(' ');
        }
        normalized.push_str(token);
    }
    let unpadded = STREAM_BRACKET_PADDING_REGEX.replace_all(&normalized, "${1}${2}");
    let cleaned = STREAM_EMPTY_BRACKETS_REGEX.replace_all(&unpadded, " ");
    let mut display = String::with_capacity(cleaned.len());
    for token in cleaned
        .trim_matches(|c: char| matches!(c, '|' | '·' | '•' | '-' | ':') || c.is_whitespace())
        .split_whitespace()
    {
        if !display.is_empty() {
            display.push(' ');
        }
        display.push_str(token);
    }
    Cow::Owned(display)
}

fn stream_audio_evidence(stream: &AddonStream, flags: StreamFlags) -> (bool, bool) {
    let mut languages = Vec::new();
    'fields: for text in [stream.name.as_deref(), stream.title.as_deref()]
        .into_iter()
        .flatten()
    {
        for (range, language) in bracketed_language_tags(text) {
            if !language_mention_is_audio(&text[range.end..]) {
                continue;
            }
            if languages.contains(&language) {
                continue;
            }
            languages.push(language);
            if languages.len() == 3 {
                break 'fields;
            }
        }
    }
    let language_tag_count = languages.len();
    (
        language_tag_count == 2 || flags.dual_audio || flags.english_japanese_pair,
        language_tag_count > 2 || flags.multi_audio,
    )
}

fn build_stream_presentation(stream: &AddonStream, raw_text: &mut String) -> StreamPresentation {
    let (raw_source_name, raw_stream_title) = get_display_lines(stream);
    let source_name = strip_display_pictographs(raw_source_name);
    let stream_title = match strip_display_pictographs(&raw_stream_title) {
        cleaned if cleaned.is_empty() || cleaned == raw_stream_title => {
            raw_stream_title.into_owned()
        }
        cleaned => cleaned.into_owned(),
    };
    raw_text.clear();
    raw_text.push_str(stream.name.as_deref().unwrap_or(""));
    raw_text.push(' ');
    raw_text.push_str(stream.title.as_deref().unwrap_or(""));
    let texts = stream.match_texts();
    let flags = texts.flags;

    let is_dts = !flags.dts_hd && flags.dts;
    let (is_dual_audio, is_multi_audio) = stream_audio_evidence(stream, flags);
    let delivery_kind = stream_delivery_kind(stream);

    StreamPresentation {
        source_name: if source_name.is_empty() {
            "Unknown".to_string()
        } else {
            source_name.into_owned()
        },
        stream_title,
        resolution: stream_resolution(flags.resolution),
        delivery_kind,
        delivery_label: match delivery_kind {
            // Wire `cached` flag carries no resolver-service identity — never a branded badge.
            StreamDeliveryKind::Cached => "Cached".to_string(),
            StreamDeliveryKind::Http => "HTTP".to_string(),
            StreamDeliveryKind::PeerToPeer => "P2P".to_string(),
        },
        is_instantly_playable: !matches!(delivery_kind, StreamDeliveryKind::PeerToPeer),
        hdr_label: if flags.dolby_vision {
            Some("DV".to_string())
        } else if flags.hdr10_plus {
            Some("HDR10+".to_string())
        } else if flags.hdr {
            Some("HDR".to_string())
        } else {
            None
        },
        audio_label: if flags.atmos {
            Some("Atmos".to_string())
        } else if flags.dts_hd {
            Some("DTS-HD".to_string())
        } else if is_dts {
            Some("DTS".to_string())
        } else if flags.eac3 {
            Some("DD+".to_string())
        } else if flags.aac {
            Some("AAC".to_string())
        } else {
            None
        },
        codec_label: if flags.av1 {
            Some("AV1".to_string())
        } else if flags.hevc {
            Some("HEVC".to_string())
        } else {
            None
        },
        multi_audio_label: if is_multi_audio {
            Some("MULTI".to_string())
        } else if is_dual_audio {
            Some("DUAL".to_string())
        } else {
            None
        },
        size_label: format_stream_size_label(raw_text, stream.size_bytes),
        is_batch: stream_contains_batch_texts(texts),
    }
}

pub(crate) fn prepare_addon_streams(
    streams: Vec<AddonStream>,
    source_name: &str,
    source_id: &str,
) -> Vec<AddonStream> {
    let source_key = stream_family_source_key(source_id);
    let mut prepared = Vec::with_capacity(streams.len());
    let mut raw_text = String::new();

    for mut stream in streams {
        // Playable-source probe first — the placeholder test allocates lowered match texts.
        if !has_playable_stream_source(&stream) || is_placeholder_no_stream(&stream) {
            continue;
        }

        // The prepared key doubles as the opaque `stream_key` used by selector picks,
        // saved-stream resume, and recovery exclusion.
        let Some(dedup_key) = prepared_stream_key(&stream, source_id) else {
            continue;
        };

        stream.source_name = Some(source_name.to_string());
        stream.source_id = Some(source_id.to_string());
        stream.stream_family = source_key
            .as_deref()
            .map(|source| derive_stream_family_normalized(&stream, source));
        stream.stream_key = dedup_key;
        stream.presentation = build_stream_presentation(&stream, &mut raw_text);
        prepared.push(stream);
    }

    prepared
}

pub(crate) fn canonicalize_header_identity(headers: &mut [(String, String)]) {
    for (name, _) in &mut *headers {
        name.make_ascii_lowercase();
    }
    headers.sort();
}

/// Prepared identity key: content identity + source + transport shape (direct URL, request
/// headers), hashed so `stream_key` stays opaque — URLs may carry signed credentials and
/// header values are secrets. Same addon + same transport dedupes; anything else does not.
fn prepared_stream_key(stream: &AddonStream, source_id: &str) -> Option<String> {
    let content_key = stream_dedup_key(stream)?;
    let direct_url = stream.url.as_deref().and_then(normalize_http_url);
    let mut headers = stream.request_headers();
    canonicalize_header_identity(&mut headers);
    let mut hasher = Sha256::new();
    serde_json::to_writer(&mut hasher, &(source_id, content_key, direct_url, headers)).ok()?;
    Some(format!("s:{:x}", hasher.finalize()))
}

/// Prepared selector key (`s:{sha256}`) — the form fresh resume rows persist.
pub(crate) fn is_prepared_stream_key(key: &str) -> bool {
    key.starts_with("s:")
}

/// Legacy `h:`/`uh:` dedup-key forms persisted before prepared keys existed.
/// Resume binds these by recomputing the dedup key; prepared keys match by equality.
pub(crate) fn is_legacy_content_key(key: &str) -> bool {
    key.starts_with("h:") || key.starts_with("uh:")
}

/// Every stream-key form that may persist as `last_stream_key`: opaque hash identities
/// only — the legacy `u:` form embedded the raw URL and stays excluded. Single owner so
/// producers and resume/probe consumers can't drift.
pub(crate) fn is_persistable_stream_key(key: &str) -> bool {
    is_prepared_stream_key(key) || is_legacy_content_key(key)
}

/// Bounded per-source error aggregation shared by the fan-out merges: keep the first
/// few failures so every caller joins and caps identically.
const MAX_SUMMARIZED_ERRORS: usize = 3;

pub(crate) fn push_bounded_error(errors: &mut Vec<String>, error: impl Into<String>) {
    if errors.len() < MAX_SUMMARIZED_ERRORS {
        errors.push(error.into());
    }
}

impl From<&AddonStream> for AddonStream {
    fn from(stream: &AddonStream) -> Self {
        stream.clone()
    }
}

pub(crate) fn merge_unique_streams<S: std::borrow::Borrow<AddonStream> + Into<AddonStream>>(
    merged: &mut Vec<AddonStream>,
    seen: &mut std::collections::HashSet<String>,
    streams: impl IntoIterator<Item = S>,
) {
    for stream in streams {
        // `prepare_addon_streams` already keyed the stream; recompute nothing.
        let key = &stream.borrow().stream_key;
        if !key.is_empty() && !seen.contains(key) {
            seen.insert(key.clone());
            merged.push(stream.into());
        }
    }
}

pub(crate) fn stream_absolute_episode_targets(
    media_type: &str,
    id: &str,
    season: Option<u32>,
    episode: Option<u32>,
    absolute_episode: Option<u32>,
) -> Option<[(u32, u32); 2]> {
    if !matches!(media_type, "anime" | "series") || !id.starts_with("tt") {
        return None;
    }
    let season = season?;
    let episode = episode?;
    let absolute_episode = absolute_episode.filter(|absolute| *absolute != episode)?;
    Some([(season, absolute_episode), (1, absolute_episode)])
}

pub(crate) fn build_stream_query_ids(
    media_type: &str,
    id: &str,
    season: Option<u32>,
    episode: Option<u32>,
    absolute_episode: Option<u32>,
) -> Vec<String> {
    let (Some(s), Some(e)) = (season, episode) else {
        return vec![id.to_string()];
    };

    let mut ids = vec![format!("{}:{}:{}", id, s, e)];

    if media_type == "anime" || media_type == "series" {
        if id.starts_with("tt") {
            // Addons index long-running IMDB titles differently: absolute numbering under
            // the real or season-1 slot, season 0 for specials. Both media types try
            // absolute coordinates; anime additionally retries season-1 and season-0 forms.
            if media_type == "anime" && s != 1 {
                push_unique(&mut ids, format!("{}:1:{}", id, e));
            }
            if let Some(targets) =
                stream_absolute_episode_targets(media_type, id, season, episode, absolute_episode)
            {
                for (target_season, target_episode) in targets {
                    push_unique(&mut ids, format!("{id}:{target_season}:{target_episode}"));
                }
            }
            if media_type == "anime" {
                push_unique(&mut ids, format!("{}:0:{}", id, e));
            }
        } else if media_type == "anime" {
            // Namespaced anime ids (kitsu:, …) index episodes flat — `{id}:{episode}` —
            // so the `{id}:{s}:{e}` probe above misses them. Retry bare-episode and
            // absolute-episode forms; the per-addon id-prefix gate still filters.
            push_unique(&mut ids, format!("{}:{}", id, e));
            if let Some(abs_ep) = absolute_episode.filter(|abs_ep| *abs_ep != e) {
                push_unique(&mut ids, format!("{}:{}", id, abs_ep));
            }
        }
    }

    ids
}

pub(crate) fn build_addon_source_priority_map<'a>(
    addons: impl IntoIterator<Item = &'a AddonConfig, IntoIter: ExactSizeIterator>,
) -> HashMap<String, u32> {
    let addons = addons.into_iter();
    let total = u32::try_from(addons.len()).unwrap_or(u32::MAX);
    let mut priorities = HashMap::new();

    for (idx, addon) in addons.enumerate() {
        // Instance ids are the ordering key — addons sharing a display name keep independent ranks.
        let Some(normalized) = normalize_source_id(&addon.id) else {
            continue;
        };
        let rank = u32::try_from(idx).unwrap_or(u32::MAX);
        priorities
            .entry(normalized)
            .or_insert(total.saturating_sub(rank));
    }

    priorities
}

pub(crate) fn stream_source_priority(
    normalized_source: Option<&str>,
    priorities: &HashMap<String, u32>,
) -> u32 {
    normalized_source
        .and_then(|name| priorities.get(name).copied())
        .unwrap_or(0)
}

/// Source-identity normalization: trim, drop empties, char-bound. The bound matters —
/// normalized values persist as snapshot keys, so an unbounded IPC `source_name`/
/// `stream_family` would land in `playback_state.json` verbatim.
const SOURCE_IDENTITY_MAX_CHARS: usize = 256;

/// Display-name key: id gate plus ASCII lowercase (display names match case-insensitively; ids don't).
pub(crate) fn normalize_source_key(value: &str) -> Option<String> {
    normalize_source_id(value).map(|mut id| {
        id.make_ascii_lowercase();
        id
    })
}

/// Stable addon-instance identity (`AddonConfig.id`). Unlike `normalize_source_key` this
/// is case-sensitive — ids are opaque exact strings (usually the transport URL), not
/// display names. Trim + bound only.
pub(crate) fn normalize_source_id(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > SOURCE_IDENTITY_MAX_CHARS {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Persisted source-health key suffix for an instance id — `id:` keeps the keyspace distinct from display names.
pub(crate) fn source_health_key(source_id: &str) -> String {
    format!("id:{source_id}")
}

/// The `name + title` language haystack, shared by the language-preference and
/// audio-bonus scores. Backed by the cached match text so callers never re-lowercase.
pub(crate) fn stream_language_haystack(stream: &AddonStream) -> &str {
    stream.match_texts().name_title_haystack()
}

/// Composite quality score over the stream's flag memo; sole owner of the quality
/// constants, shared with the presentation badge (`StreamMatchText::flags`).
pub(crate) fn stream_quality_score(flags: StreamFlags) -> i32 {
    let mut score = 0;

    score += stream_resolution_quality_points(flags.resolution);

    score += match flags.release {
        StreamReleaseKind::Remux => 35,
        StreamReleaseKind::BluRay => 30,
        StreamReleaseKind::WebDl => 25,
        StreamReleaseKind::WebRip => 20,
        StreamReleaseKind::Hdtv => 10,
        StreamReleaseKind::Other => 0,
    };

    if flags.dolby_vision {
        score += 55;
    } else if flags.hdr10_plus {
        score += 52;
    } else if flags.hdr {
        score += 50;
    }

    if flags.atmos {
        score += 15;
    } else if flags.dts_hd {
        score += 13;
    } else if flags.dts || flags.eac3 {
        score += 10;
    } else if flags.surround {
        score += 8;
    }

    if flags.hevc {
        score += 5;
    }

    if flags.capture_release {
        score -= 250;
    }

    score
}

/// Oversize demotion thresholds: past the cap a stream ranks below at-limit peers in its
/// tier (4K gets the larger cap — remux sizes are inherent). Applied via `stream_resolution_priority`.
const OVERSIZE_LIMIT_BYTES: u64 = 15 * 1024 * 1024 * 1024;
const OVERSIZE_LIMIT_BYTES_UHD: u64 = 20 * 1024 * 1024 * 1024;

/// The resolution/delivery half of the coordinator's recommendation key. Not itself
/// ordered: `StreamRecommendationKey` is the sort key; `oversize` is a flag, not a rank.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct StreamResolutionPriority {
    pub viability: u8,
    pub quality: i32,
    pub language_bonus: u8,
    pub oversize: bool,
    pub seeders: u32,
    pub size_bytes: u64,
}

pub(crate) fn stream_resolution_priority(
    stream: &AddonStream,
    flags: StreamFlags,
) -> StreamResolutionPriority {
    // A magnet-only stream (URL `xt`, no `info_hash` field) shares the `h:` dedup
    // identity with the field-carrying spelling, so it earns the same viability —
    // otherwise arrival order decides the rank input.
    let has_info_hash = stream.info_hash.as_deref().is_some_and(non_blank)
        || stream.url.as_deref().and_then(magnet_xt_hash).is_some();

    let texts = stream.match_texts();
    let is_clip = [
        texts.filename.as_deref(),
        texts.title.as_deref(),
        texts.name.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(|text| STREAM_CLIP_REGEX.is_match(text));
    let viability = if is_clip {
        0
    } else if matches!(
        stream.presentation.delivery_kind,
        StreamDeliveryKind::Cached
    ) {
        4
    } else if matches!(stream.presentation.delivery_kind, StreamDeliveryKind::Http) {
        3
    } else if has_info_hash {
        2
    } else {
        1
    };

    let size_bytes = stream.size_bytes.unwrap_or(0);
    // Prepared streams already carry the evidence; unprepared rows have no delivery label.
    let has_audio_bonus = if stream.presentation.delivery_label.is_empty() {
        let (dual_audio, multi_audio) = stream_audio_evidence(stream, flags);
        dual_audio || multi_audio
    } else {
        stream.presentation.multi_audio_label.is_some()
    };
    let oversize_limit = if matches!(stream.presentation.resolution, StreamResolution::P2160) {
        OVERSIZE_LIMIT_BYTES_UHD
    } else {
        OVERSIZE_LIMIT_BYTES
    };

    StreamResolutionPriority {
        viability,
        quality: stream_quality_score(flags),
        language_bonus: u8::from(has_audio_bonus),
        oversize: size_bytes > oversize_limit,
        seeders: stream.seeders.unwrap_or(0),
        size_bytes,
    }
}
