use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use iroh::{EndpointId, SecretKey, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_PACKET: usize = 4096;
pub const MAX_POSITION: u64 = 86_400_000;
pub const MAX_STREAM_KEY: usize = 2048;
pub const MAX_CHAT_CHARS: usize = 500;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Media {
    pub media_type: String,
    pub media_id: String,
    pub season: Option<u32>,
    pub episode: Option<u32>,
}

impl Media {
    pub fn validate(&self) -> bool {
        matches!(self.media_type.as_str(), "movie" | "series" | "anime")
            && crate::commands::normalize_media_id(&self.media_id).as_ref() == Some(&self.media_id)
            && !self.media_id.contains(['/', '\\', '?', '#'])
            && !self.media_id.chars().any(char::is_control)
            && self.season.is_some() == self.episode.is_some()
            && self.season.is_none_or(|v| v <= 100_000)
            && self.episode.is_none_or(|v| v <= 100_000)
            && (self.media_type != "movie" || self.season.is_none())
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Playback {
    pub media: Media,
    pub pos_ms: u64,
    pub paused: bool,
    pub rate: f64,
    pub dur_ms: u64,
    pub buffering: bool,
    pub stream_digest: Option<String>,
}

impl Playback {
    pub fn validate(&self) -> bool {
        self.media.validate()
            && self.pos_ms <= MAX_POSITION
            && self.dur_ms <= MAX_POSITION
            && self.rate.is_finite()
            && (0.5..=2.0).contains(&self.rate)
            && self.stream_digest.as_ref().is_none_or(|digest| {
                digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit())
            })
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Kind {
    Hello { name: String },
    State { playback: Playback, control: u64 },
    Status { buffering: bool },
    Chat { text: String },
    Lock { locked: bool },
    Remove { member: EndpointId },
    Refresh,
    Leave,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Message {
    pub v: u8,
    pub seq: u64,
    pub at_ms: u64,
    pub kind: Kind,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Packet {
    sender: EndpointId,
    payload: String,
    signature: Signature,
}

fn signing_bytes(topic: &[u8; 32], payload: &str) -> Vec<u8> {
    let mut bytes = b"stremiro-party-v1\0".to_vec();
    bytes.extend_from_slice(topic);
    bytes.extend_from_slice(payload.as_bytes());
    bytes
}

pub fn encode(key: &SecretKey, topic: &[u8; 32], message: &Message) -> Result<Vec<u8>, String> {
    let payload = serde_json::to_string(message).map_err(|_| "Invalid party message.")?;
    let bytes = serde_json::to_vec(&Packet {
        sender: key.public(),
        signature: key.sign(&signing_bytes(topic, &payload)),
        payload,
    })
    .map_err(|_| "Invalid party message.")?;
    if bytes.len() > MAX_PACKET {
        return Err("Party message is too large.".into());
    }
    Ok(bytes)
}

pub fn decode(topic: &[u8; 32], bytes: &[u8]) -> Option<(EndpointId, Message)> {
    if bytes.len() > MAX_PACKET {
        return None;
    }
    let packet: Packet = serde_json::from_slice(bytes).ok()?;
    packet
        .sender
        .verify(&signing_bytes(topic, &packet.payload), &packet.signature)
        .ok()?;
    let message: Message = serde_json::from_str(&packet.payload).ok()?;
    let valid = match &message.kind {
        Kind::Hello { name } => valid_name(name),
        Kind::Chat { text } => valid_text(text, MAX_CHAT_CHARS),
        Kind::State { playback, control } => playback.validate() && *control <= message.at_ms,
        Kind::Status { .. }
        | Kind::Lock { .. }
        | Kind::Remove { .. }
        | Kind::Refresh
        | Kind::Leave => true,
    };
    (message.v == 1 && message.seq > 0 && valid).then_some((packet.sender, message))
}

pub fn valid_text(text: &str, max: usize) -> bool {
    !text.trim().is_empty()
        && !text
            .chars()
            .enumerate()
            .any(|(index, c)| index >= max || (c.is_control() && c != '\n') || is_bidi_control(c))
}

pub fn valid_name(name: &str) -> bool {
    valid_text(name, 32) && !name.contains('\n')
}

// Embedding, override and isolate controls visually reorder a name or the text
// after it; directional marks (LRM/RLM) stay allowed for right-to-left writers.
fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

pub fn digest(topic: &[u8; 32], key: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"stremiro-party-stream-v1\0");
    hash.update(topic);
    hash.update(key.as_bytes());
    format!("{:x}", hash.finalize())
}

pub fn encode_invite_bytes(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn decode_invite_bytes(text: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(text).ok()
}
