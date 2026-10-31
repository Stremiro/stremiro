use super::ttl_cache::{hash_segment, InFlight, TtlCache};
use super::{lock_or_recover, read_bounded_body};
use reqwest::{Client, RequestBuilder, StatusCode};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

/// External metadata/id services sharing one transport, cache and policy.
/// Scoped to these fixed providers - this is not a general request framework.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Source {
    Arm,
    Kitsu,
    Tvmaze,
    AniList,
}

impl Source {
    fn index(self) -> usize {
        match self {
            Self::Arm => 0,
            Self::Kitsu => 1,
            Self::Tvmaze => 2,
            Self::AniList => 3,
        }
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Arm => "arm",
            Self::Kitsu => "kitsu",
            Self::Tvmaze => "tvmaze",
            Self::AniList => "anilist",
        }
    }

    fn base_url(self) -> &'static str {
        match self {
            Self::Arm => "https://arm.haglund.dev",
            Self::Kitsu => "https://kitsu.io/api/edge",
            Self::Tvmaze => "https://api.tvmaze.com",
            Self::AniList => "https://graphql.anilist.co",
        }
    }

    /// Minimum gap between proactive request starts; `None` = no artificial gap.
    fn min_request_gap(self) -> Option<Duration> {
        match self {
            // 30/min live rate - -2 s spacing; 20/10s - -500 ms.
            Self::AniList => Some(Duration::from_secs(2)),
            // 20/10s counting redirects: lookup entails a real second hop.
            Self::Tvmaze => Some(Duration::from_secs(1)),
            _ => None,
        }
    }
}

const MEMORY_ENTRIES: usize = 128;
const FULL_TTL: Duration = Duration::from_secs(12 * 60 * 60);
const EMPTY_TTL: Duration = Duration::from_secs(60 * 60);
const FAILURE_TTL: Duration = Duration::from_secs(30);
const FAILURE_ENTRIES: usize = 128;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_BODY_BYTES: usize = 256 * 1024;
const DISK_MAX_ENTRIES: usize = 128;
const DISK_MAX_BYTES: usize = MAX_BODY_BYTES + 1024;
const DEFAULT_COOLDOWN: Duration = Duration::from_secs(30);
const TRANSIENT_ERROR: &str = "Enrichment data is temporarily unavailable.";

// All filesystem work runs on blocking workers under this one gate.
static DISK_GATE: Mutex<()> = Mutex::new(());

/// Raw upstream bytes plus the expiry the producer assigned; the TtlCache
/// entry's own TTL only bounds retention - the inner stamp governs validity
/// so a disk hit can never extend a shorter original lifetime.
struct CachedBody {
    bytes: Arc<[u8]>,
    expires_at: SystemTime,
}

#[derive(Serialize, Deserialize)]
struct DiskEnvelope {
    key: String,
    expires_at: SystemTime,
    response: Box<serde_json::value::RawValue>,
}

/// One managed enrichment transport: bounded memory + disk caches, per-key
/// single-flight, per-source pacing and cooldowns. Fixed provider roots only.
pub(crate) struct EnrichmentClient {
    client: Client,
    base_urls: [String; 4],
    cache: TtlCache<Arc<CachedBody>>,
    failures: TtlCache<String>,
    disk_dir: Option<PathBuf>,
    in_flight: InFlight,
    cooldowns: Mutex<HashMap<Source, Instant>>,
    gates: [tokio::sync::Mutex<Instant>; 4],
}

impl EnrichmentClient {
    pub(crate) fn new(cache_dir: Option<PathBuf>) -> Self {
        Self {
            client: super::build_provider_http_client(Some(2)),
            base_urls: [
                Source::Arm.base_url().to_string(),
                Source::Kitsu.base_url().to_string(),
                Source::Tvmaze.base_url().to_string(),
                Source::AniList.base_url().to_string(),
            ],
            cache: TtlCache::new(MEMORY_ENTRIES, FULL_TTL, EMPTY_TTL),
            failures: TtlCache::new(FAILURE_ENTRIES, FAILURE_TTL, FAILURE_TTL),
            disk_dir: cache_dir.map(|dir| dir.join("enrichment-v1")),
            in_flight: InFlight::new(MEMORY_ENTRIES),
            cooldowns: Mutex::new(HashMap::new()),
            gates: std::array::from_fn(|_| tokio::sync::Mutex::new(Instant::now())),
        }
    }

    #[cfg(test)]
    pub(crate) fn set_base_url(&mut self, source: Source, url: String) {
        self.base_urls[source.index()] = url;
    }

    pub(crate) fn base_url(&self, source: Source) -> &str {
        &self.base_urls[source.index()]
    }

    pub(crate) fn get(&self, url: &str) -> RequestBuilder {
        self.client.get(url).timeout(REQUEST_TIMEOUT)
    }

    /// POST builder for AniList GraphQL queries (serialized body + Content-Type).
    pub(crate) fn post_json(&self, url: &str, body: Vec<u8>) -> RequestBuilder {
        self.client
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
            .timeout(REQUEST_TIMEOUT)
    }

    #[cfg(test)]
    pub(crate) fn cooldown_until(&self, source: Source) -> Option<Instant> {
        lock_or_recover(&self.cooldowns).get(&source).copied()
    }

    fn cooling_down(&self, source: Source) -> bool {
        let mut cooldowns = lock_or_recover(&self.cooldowns);
        match cooldowns.get(&source) {
            Some(until) if *until > Instant::now() => true,
            Some(_) => {
                cooldowns.remove(&source);
                false
            }
            None => false,
        }
    }

    fn note_cooldown(&self, source: Source, until: Instant) {
        let mut cooldowns = lock_or_recover(&self.cooldowns);
        let entry = cooldowns.entry(source).or_insert(until);
        *entry = (*entry).max(until);
    }

    fn cached(&self, key: &str) -> Option<Arc<CachedBody>> {
        self.cache
            .get(key)
            .filter(|entry| entry.expires_at > SystemTime::now())
    }

    /// Cached-load: decode runs on every path (fresh, memory, disk) so disk
    /// data is never trusted blindly. `decode` returns the value plus a
    /// definitive-empty flag that picks the shorter TTL.
    pub(crate) async fn load<T>(
        &self,
        key: &str,
        source: Source,
        request: RequestBuilder,
        decode: impl Fn(&[u8]) -> Result<(T, bool), String>,
    ) -> Result<T, String> {
        if let Some(hit) = self.cached(key) {
            return decode(&hit.bytes).map(|(value, _)| value);
        }
        let failure_key = format!("{}:{}", source.name(), key);
        if let Some(error) = self.failures.get(&failure_key) {
            return Err(error);
        }
        let key_lock = self.in_flight.claim(key);
        let result = async {
            let _permit = key_lock.lock().await;
            if let Some(hit) = self.cached(key) {
                return decode(&hit.bytes).map(|(value, _)| value);
            }
            if let Some(error) = self.failures.get(&failure_key) {
                return Err(error);
            }
            if let Some((body, expires_at)) = self.read_disk(key).await {
                let entry = Arc::new(CachedBody {
                    bytes: body,
                    expires_at,
                });
                let value = decode(&entry.bytes).map(|(value, is_empty)| (entry, value, is_empty));
                if let Ok((entry, value, is_empty)) = value {
                    self.cache.put(key, entry, is_empty, || true);
                    return Ok(value);
                }
                // Undecodable disk bytes: fall through to a fresh fetch.
            }
            if self.cooling_down(source) {
                return Err(TRANSIENT_ERROR.to_string());
            }
            // One gate per origin serializes pacing AND the whole HTTP read;
            // the cooldown is re-checked under it so a 429 stamped by a
            // concurrent caller still blocks this request.
            let mut gate = self.gates[source.index()].lock().await;
            if self.cooling_down(source) {
                return Err(TRANSIENT_ERROR.to_string());
            }
            if let Some(gap) = source.min_request_gap() {
                let now = Instant::now();
                if *gate > now {
                    tokio::time::sleep(*gate - now).await;
                }
                *gate = Instant::now() + gap;
            }
            let fetched = self.fetch(request, source).await;
            drop(gate);
            let failed = |error: String| {
                crate::operational_log::log_warn(
                    "enrichment",
                    source.name(),
                    "request_failed",
                    &[crate::operational_log::field("error", &error)],
                );
                self.failures
                    .put(&failure_key, error.clone(), true, || true);
                Err(error)
            };
            match fetched {
                Ok(body) => match decode(&body) {
                    Ok((value, is_empty)) => {
                        // The producer stamp is assigned only once
                        // definitive-empty is known; memory and disk share it.
                        let expires_at =
                            SystemTime::now() + if is_empty { EMPTY_TTL } else { FULL_TTL };
                        self.cache.put(
                            key,
                            Arc::new(CachedBody {
                                bytes: body.clone(),
                                expires_at,
                            }),
                            is_empty,
                            || true,
                        );
                        self.write_disk(key, &body, expires_at).await;
                        Ok(value)
                    }
                    Err(error) => failed(error),
                },
                Err(error) => failed(error),
            }
        }
        .await;
        self.in_flight.release(key, &key_lock);
        result
    }

    /// Returns the raw body; the expiry stamp is assigned by `load` after
    /// decode, once definitive-empty is known. 404 maps to canonical `null`
    /// bytes so decoders see one "definitive miss" shape.
    async fn fetch(&self, request: RequestBuilder, source: Source) -> Result<Arc<[u8]>, String> {
        let response = match request.send().await {
            Ok(response) => response,
            Err(_) => {
                self.note_cooldown(source, cooldown_from_now(DEFAULT_COOLDOWN));
                return Err(TRANSIENT_ERROR.to_string());
            }
        };
        let status = response.status();
        self.check_anilist_exhaustion(response.headers(), source);
        if status == StatusCode::NOT_FOUND {
            return Ok(Arc::from("null".as_bytes()));
        }
        if status == StatusCode::TOO_MANY_REQUESTS {
            self.note_cooldown(source, retry_after_until(response.headers()));
            return Err(TRANSIENT_ERROR.to_string());
        }
        if status == StatusCode::REQUEST_TIMEOUT || status.is_server_error() {
            self.note_cooldown(source, cooldown_from_now(DEFAULT_COOLDOWN));
            return Err(TRANSIENT_ERROR.to_string());
        }
        if !status.is_success() {
            return Err(TRANSIENT_ERROR.to_string());
        }
        let bytes = read_bounded_body(response, MAX_BODY_BYTES, |_| {
            "Enrichment response too large.".to_string()
        })
        .await
        .map_err(|error| {
            if matches!(&error, super::BoundedBodyError::Read(_)) {
                self.note_cooldown(source, cooldown_from_now(DEFAULT_COOLDOWN));
            }
            error.into_message()
        })?;
        Ok(Arc::from(bytes.into_boxed_slice()))
    }

    fn check_anilist_exhaustion(&self, headers: &reqwest::header::HeaderMap, source: Source) {
        if source != Source::AniList {
            return;
        }
        let remaining = headers
            .get("x-ratelimit-remaining")
            .and_then(|value| value.to_str().ok());
        if remaining != Some("0") {
            return;
        }
        let reset = headers
            .get("x-ratelimit-reset")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<u64>().ok());
        if let Some(epoch) = reset {
            self.note_cooldown(
                source,
                cooldown_from_now(Duration::from_secs(epoch.saturating_sub(unix_now_secs()))),
            );
        }
    }

    async fn read_disk(&self, key: &str) -> Option<(Arc<[u8]>, SystemTime)> {
        let path = self.disk_path(key)?;
        let key = key.to_string();
        tokio::task::spawn_blocking(move || read_disk_envelope(&path, &key))
            .await
            .ok()?
    }

    fn disk_path(&self, key: &str) -> Option<PathBuf> {
        Some(
            self.disk_dir
                .as_ref()?
                .join(format!("{}.json", hash_segment(key))),
        )
    }

    async fn write_disk(&self, key: &str, body: &[u8], expires_at: SystemTime) {
        let Some(path) = self.disk_path(key) else {
            return;
        };
        let Ok(response) = serde_json::from_slice::<Box<serde_json::value::RawValue>>(body) else {
            return;
        };
        let envelope = DiskEnvelope {
            key: key.to_string(),
            expires_at,
            response,
        };
        let Ok(bytes) = serde_json::to_vec(&envelope) else {
            return;
        };
        if bytes.len() > DISK_MAX_BYTES {
            return;
        }
        let _ = tokio::task::spawn_blocking(move || write_disk_envelope(&path, &bytes)).await;
    }
}

fn unix_now_secs() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// Cooldown deadline arithmetic is checked and clamped: a hostile
/// `Retry-After: u64::MAX` can never panic the deadline.
const MAX_COOLDOWN: Duration = Duration::from_secs(7 * 24 * 60 * 60);

fn cooldown_from_now(delay: Duration) -> Instant {
    Instant::now()
        .checked_add(delay.min(MAX_COOLDOWN))
        .unwrap_or_else(|| Instant::now() + MAX_COOLDOWN)
}

/// 429 cooldown: max(Retry-After, default) - numeric seconds or IMF-fixdate.
fn retry_after_until(headers: &reqwest::header::HeaderMap) -> Instant {
    let supplied = headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            let value = value.trim();
            if let Ok(secs) = value.parse::<u64>() {
                return Some(secs);
            }
            parse_imf_fixdate(value).map(|epoch| epoch.saturating_sub(unix_now_secs()))
        });
    cooldown_from_now(Duration::from_secs(
        supplied.unwrap_or(0).max(DEFAULT_COOLDOWN.as_secs()),
    ))
}

/// IMF-fixdate (`Sun, 06 Nov 1994 08:49:37 GMT`) - epoch seconds; reuses the
/// validated Gregorian ordinal, relative to 1970-01-01.
fn parse_imf_fixdate(value: &str) -> Option<u64> {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let (_, date) = value.split_once(", ")?;
    let mut parts = date.split(' ');
    let day = parts.next()?;
    let month_name = parts.next()?;
    let month = MONTHS.iter().position(|name| *name == month_name)? + 1;
    let year = parts.next()?;
    let mut clock = parts.next()?.split(':');
    let hour: u32 = clock.next()?.parse().ok()?;
    let minute: u32 = clock.next()?.parse().ok()?;
    let second: u32 = clock.next()?.parse().ok()?;
    // Exactly three clock components and exactly one GMT token - no extras.
    if clock.next().is_some() || parts.next() != Some("GMT") || parts.next().is_some() {
        return None;
    }
    if hour >= 24 || minute >= 60 || second >= 60 {
        return None;
    }
    let date = format!("{year}-{month:02}-{day}");
    let ordinal = crate::commands::calendar_commands::date_ordinal(&date)?;
    let epoch = crate::commands::calendar_commands::date_ordinal("1970-01-01")?;
    let days = ordinal.checked_sub(epoch)?;
    Some(days as u64 * 86_400 + hour as u64 * 3_600 + minute as u64 * 60 + second as u64)
}

fn read_disk_envelope(path: &Path, key: &str) -> Option<(Arc<[u8]>, SystemTime)> {
    let bytes = {
        let _guard = lock_or_recover(&DISK_GATE);
        super::read_cache_file(path, DISK_MAX_BYTES)?
    };
    let envelope: DiskEnvelope = serde_json::from_slice(&bytes).ok()?;
    if envelope.key != key || envelope.response.get().len() > MAX_BODY_BYTES {
        return None;
    }
    let remaining = envelope.expires_at.duration_since(SystemTime::now()).ok()?;
    // A farther-future stamp than the producer TTL is forged - reject it.
    if remaining > FULL_TTL {
        return None;
    }
    Some((
        Arc::from(envelope.response.get().as_bytes()),
        envelope.expires_at,
    ))
}

fn write_disk_envelope(path: &Path, bytes: &[u8]) -> Option<()> {
    let _guard = lock_or_recover(&DISK_GATE);
    super::write_cache_file(path, bytes, DISK_MAX_ENTRIES)
}

#[cfg(test)]
mod tests;
