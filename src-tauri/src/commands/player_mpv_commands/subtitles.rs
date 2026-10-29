//! Download outside the mpv gate; only bounded, self-contained subtitle files enter native code.
//! The native call owns its local input through completion; epochs reject obsolete selections.

use crate::providers::fetch_policy::{
    redirect_target_allowed, same_origin_for_proxy_headers, MAX_REDIRECT_HOPS,
};
use reqwest::{header::HeaderMap, Client, Url};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::Duration;
use tokio::sync::watch;

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_SUBTITLE_BYTES: usize = 8 * 1024 * 1024;
const CANCELLED: &str = "Subtitle selection was cancelled.";

pub(super) static SESSION: LazyLock<SubtitleSession> = LazyLock::new(SubtitleSession::new);
static CLIENT: LazyLock<Client> = LazyLock::new(|| {
    crate::providers::ensure_rustls_crypto_provider();
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .expect("redirect-disabled subtitle client must build")
});

pub(super) struct SubtitleSession {
    epoch: watch::Sender<u64>,
    original_urls: Mutex<HashMap<String, String>>,
}

impl SubtitleSession {
    fn new() -> Self {
        Self {
            epoch: watch::channel(0).0,
            original_urls: Mutex::new(HashMap::new()),
        }
    }

    pub(super) fn cancel(&self) {
        self.epoch
            .send_modify(|epoch| *epoch = epoch.wrapping_add(1));
    }

    pub(super) fn begin(&self) -> SubtitleRequest {
        let cancelled = self.epoch.subscribe();
        let mut epoch = 0;
        self.epoch.send_modify(|current| {
            *current = current.wrapping_add(1);
            epoch = *current;
        });
        SubtitleRequest { epoch, cancelled }
    }

    pub(super) fn clear_tracks(&self) {
        self.original_urls
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
    }

    pub(super) fn register(&self, url: String, input: &SubtitleInput) -> String {
        let path = input.path.to_string_lossy().into_owned();
        self.original_urls
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(path.clone(), url);
        path
    }

    pub(super) fn original_url(&self, path: String) -> String {
        let inputs = self
            .original_urls
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(url) = inputs.get(&path) {
            url.clone()
        } else {
            path
        }
    }

    pub(super) fn discard(&self, path: &str) {
        self.original_urls
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(path);
    }
}

pub(super) struct SubtitleRequest {
    epoch: u64,
    cancelled: watch::Receiver<u64>,
}

impl SubtitleRequest {
    pub(super) fn ensure_current(&self) -> Result<(), String> {
        if *self.cancelled.borrow() == self.epoch {
            Ok(())
        } else {
            Err(CANCELLED.to_string())
        }
    }

    pub(super) async fn download(
        &mut self,
        url: Url,
        headers: HeaderMap,
    ) -> Result<Vec<u8>, String> {
        self.download_with(&CLIENT, url, headers, DOWNLOAD_TIMEOUT)
            .await
    }

    async fn download_with(
        &mut self,
        client: &Client,
        url: Url,
        headers: HeaderMap,
        timeout: Duration,
    ) -> Result<Vec<u8>, String> {
        if *self.cancelled.borrow_and_update() != self.epoch {
            return Err(CANCELLED.to_string());
        }
        tokio::select! {
            biased;
            _ = self.cancelled.changed() => Err(CANCELLED.to_string()),
            result = tokio::time::timeout(timeout, fetch(client, url, headers)) => {
                result.map_err(|_| "Subtitle download timed out.".to_string())?
            }
        }
    }
}

pub(super) fn validate_url(url: &str, title: &str, lang: Option<&str>) -> Result<Url, String> {
    if [Some(url), Some(title), lang]
        .into_iter()
        .flatten()
        .any(|value| value.len() > super::MPV_ARG_MAX_CHARS || value.contains('\0'))
    {
        return Err("Subtitle request contains an unsupported value.".to_string());
    }
    crate::providers::addon_resource::parse_fetchable_http_url(url)
        .ok_or_else(|| "Subtitle URL is blocked by fetch policy.".to_string())
}

pub(super) fn request_headers(fields: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    let mut field = String::new();
    let mut escaped = false;
    for character in fields.chars().chain(std::iter::once(',')) {
        if escaped {
            field.push(character);
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == ',' {
            if let Some((name, value)) = field.split_once(':') {
                if let (Ok(name), Ok(value)) = (
                    reqwest::header::HeaderName::from_bytes(name.trim().as_bytes()),
                    reqwest::header::HeaderValue::from_str(value.trim()),
                ) {
                    headers.append(name, value);
                }
            }
            field.clear();
        } else {
            field.push(character);
        }
    }
    headers
}

async fn fetch(client: &Client, initial: Url, headers: HeaderMap) -> Result<Vec<u8>, String> {
    let mut url = initial.clone();
    for hop in 0..=MAX_REDIRECT_HOPS {
        let mut request = client.get(url.clone());
        if same_origin_for_proxy_headers(&initial, &url) {
            request = request.headers(headers.clone());
        }
        let response = request
            .send()
            .await
            .map_err(|error| format!("Subtitle download failed: {}", error.without_url()))?;
        if response.status().is_redirection() {
            let next = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .and_then(|location| url.join(location).ok())
                .filter(|next| redirect_target_allowed(&initial, next))
                .ok_or_else(|| "Subtitle redirect is invalid or blocked.".to_string())?;
            if hop == MAX_REDIRECT_HOPS {
                return Err("Subtitle download exceeded the redirect limit.".to_string());
            }
            url = next;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!(
                "Subtitle download returned HTTP {}.",
                response.status()
            ));
        }
        return crate::providers::read_bounded_body(response, MAX_SUBTITLE_BYTES, |_| {
            "Subtitle exceeds the 8 MiB limit.".to_string()
        })
        .await
        .map_err(crate::providers::BoundedBodyError::into_message);
    }
    unreachable!("redirect limit is enforced on the last hop")
}

pub(super) struct SubtitleInput {
    pub(super) path: PathBuf,
}

impl SubtitleInput {
    pub(super) fn create(bytes: &[u8]) -> Result<Self, String> {
        if bytes.is_empty() || bytes.len() > MAX_SUBTITLE_BYTES || !is_text_subtitle(bytes) {
            return Err("The response is not a supported text subtitle.".to_string());
        }
        let path =
            std::env::temp_dir().join(format!("stremiro-subtitle-{}.srt", uuid::Uuid::new_v4()));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| "Could not stage the subtitle.".to_string())?;
        let input = Self { path };
        let written = file.write_all(bytes);
        drop(file);
        written.map_err(|_| "Could not write the subtitle.".to_string())?;
        Ok(input)
    }
}

impl Drop for SubtitleInput {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn is_text_subtitle(bytes: &[u8]) -> bool {
    let prefix = &bytes[..bytes.len().min(64 * 1024)];
    let text = if prefix.starts_with(&[0xff, 0xfe]) || prefix.starts_with(&[0xfe, 0xff]) {
        let little_endian = prefix[0] == 0xff;
        let units: Vec<_> = prefix[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| {
                if little_endian {
                    u16::from_le_bytes([pair[0], pair[1]])
                } else {
                    u16::from_be_bytes([pair[0], pair[1]])
                }
            })
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(prefix).into_owned()
    };
    let text = text.trim_start_matches('\u{feff}').trim_start();
    let first = text.lines().next().unwrap_or_default().trim();
    let header = first.to_ascii_lowercase();
    header == "webvtt"
        || header.starts_with("webvtt ")
        || header.starts_with("webvtt\t")
        || matches!(
            header.as_str(),
            "[script info]"
                | "[v4 styles]"
                | "[v4+ styles]"
                | "[events]"
                | "[information]"
                | "[subtitle]"
        )
        || header.starts_with("<sami")
        || (header.starts_with("<tt") || header.starts_with("<?xml"))
            && text.contains("<tt")
            && !text.contains("<!DOCTYPE")
            && !text.contains("<!ENTITY")
        || first.starts_with('{') && first.as_bytes().get(1).is_some_and(u8::is_ascii_digit)
        || first.starts_with('[') && first.as_bytes().get(1).is_some_and(u8::is_ascii_digit)
        || first.as_bytes().first().is_some_and(u8::is_ascii_digit)
            && text.lines().take(3).any(|line| line.contains("-->"))
}

#[cfg(test)]
mod tests;
