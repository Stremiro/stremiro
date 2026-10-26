use super::encode_uri_component;
use super::ttl_cache::{FetchFailure, InFlight, TtlCache};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// One skippable segment (intro/recap/outro/preview); SkipDB decodes via `SkipDbSegmentEntry`.
#[derive(Debug, Serialize, Clone, PartialEq)]
pub(crate) struct SkipSegment {
    #[serde(rename = "type")]
    pub type_: &'static str,
    pub start_time: f64,
    pub end_time: f64,
}

/// SkipDB lookup payload: the submitted segments for the title or episode.
#[derive(Debug, Serialize, Clone, Default, PartialEq)]
pub(crate) struct SkipTimesResult {
    pub segments: Vec<SkipSegment>,
    /// Seconds a manual "skip intro ~Xs" jumps when this episode has no usable intro;
    /// `None` once an intro is known or confirmed absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intro_estimate_secs: Option<f64>,
}

const MIN_SKIP_SEGMENT_DURATION_SECS: f64 = 1.0;
/// SkipDB's segment bounds: at least 5 s, intros at most 5 min.
const MIN_INTRO_ESTIMATE_SECS: f64 = 5.0;
const MAX_INTRO_SECS: f64 = 300.0;
/// The press lands a moment into the intro; stopping short never skips story.
const INTRO_ESTIMATE_LEAD_SECS: f64 = 3.0;

fn normalize_skip_time(value: f64) -> Option<f64> {
    if !value.is_finite() {
        return None;
    }

    Some((value.max(0.0) * 1000.0).round() / 1000.0)
}

fn normalize_skip_segments(
    mut segments: Vec<SkipSegment>,
    duration_secs: Option<f64>,
) -> Vec<SkipSegment> {
    segments.retain_mut(|segment| {
        let Some((start_time, end_time)) =
            normalize_skip_time(segment.start_time).zip(normalize_skip_time(segment.end_time))
        else {
            return false;
        };
        let end_time = duration_secs.map_or(end_time, |duration| end_time.min(duration));
        if end_time - start_time < MIN_SKIP_SEGMENT_DURATION_SECS {
            return false;
        }
        segment.start_time = start_time;
        segment.end_time = end_time;
        true
    });
    segments.sort_by(|left, right| {
        left.start_time
            .total_cmp(&right.start_time)
            .then(left.end_time.total_cmp(&right.end_time))
            .then_with(|| left.type_.cmp(right.type_))
    });

    let mut previous_end = 0.0;
    segments.retain_mut(|segment| {
        segment.start_time = segment.start_time.max(previous_end);
        if segment.end_time - segment.start_time < MIN_SKIP_SEGMENT_DURATION_SECS {
            return false;
        }
        previous_end = segment.end_time;
        true
    });
    segments
}

/// IMDb ids (`tt` + digits) are the only lookup key SkipDB accepts — bound and
/// normalize once so a malformed id never reaches the outbound query.
pub(crate) fn normalize_imdb_id(input: &str) -> Option<String> {
    let trimmed = input.trim();
    let lowered = trimmed.to_ascii_lowercase();
    if lowered.len() < 3
        || lowered.len() > 32
        || !lowered.starts_with("tt")
        || !lowered[2..].bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }

    Some(lowered)
}

pub(crate) struct SkipTimesProvider {
    client: Client,
    cache: TtlCache<SkipTimesResult>,
    in_flight: InFlight,
}

const SKIP_TIMES_CACHE_ENTRIES: usize = 256;
const SKIP_TIMES_TTL: Duration = Duration::from_secs(12 * 60 * 60);
const SKIP_TIMES_EMPTY_TTL: Duration = Duration::from_secs(60 * 60);

/// Bound crowdsourced JSON before allocation — a compromised endpoint must not OOM the app.
const SKIP_TIMES_MAX_BYTES: usize = 256 * 1024;

const SKIPDB_SEGMENTS_URL: &str = "https://api.skipdb.tv/api/segments";
const TRANSIENT_ERROR: &str = "Skip times are temporarily unavailable.";

fn skip_times_body_failure(error: super::BoundedBodyError) -> Result<SkipTimesResult, String> {
    match error {
        super::BoundedBodyError::Read(_) => Err(TRANSIENT_ERROR.to_string()),
        super::BoundedBodyError::TooLarge(_) => Ok(SkipTimesResult::default()),
    }
}

fn skip_times_fetch_failure(error: FetchFailure) -> Result<SkipTimesResult, String> {
    match error {
        FetchFailure::Retryable(message) => Err(message),
        FetchFailure::Fatal(_) => Ok(SkipTimesResult::default()),
    }
}

fn skip_times_http_failure(status: reqwest::StatusCode) -> Result<SkipTimesResult, String> {
    if status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
    {
        Err(TRANSIENT_ERROR.to_string())
    } else {
        Ok(SkipTimesResult::default())
    }
}

impl SkipTimesProvider {
    pub(crate) fn new() -> Self {
        super::ensure_rustls_crypto_provider();
        Self {
            client: Client::builder()
                .user_agent(concat!(
                    "Stremiro/",
                    env!("CARGO_PKG_VERSION"),
                    " (+https://github.com/stremiro/stremiro)"
                ))
                .redirect(super::fetch_policy::ssrf_redirect_policy())
                .connect_timeout(Duration::from_secs(8))
                .timeout(Duration::from_secs(15))
                .pool_idle_timeout(Duration::from_secs(60))
                .build()
                // Fail closed: a fallback client would silently drop the SSRF redirect policy.
                .expect("skip-times HTTP client must build"),
            cache: TtlCache::new(
                SKIP_TIMES_CACHE_ENTRIES,
                SKIP_TIMES_TTL,
                SKIP_TIMES_EMPTY_TTL,
            ),
            in_flight: InFlight::new(SKIP_TIMES_CACHE_ENTRIES),
        }
    }

    /// Cached, single-flight SkipDB lookup keyed by the normalized request:
    /// definitive answers (including "no data") cache, transient errors do not.
    pub(crate) async fn get_segments(
        &self,
        imdb_id: &str,
        season: Option<u32>,
        episode: Option<u32>,
        duration_secs: Option<f64>,
    ) -> Result<SkipTimesResult, String> {
        let key = format!("{imdb_id}:{season:?}:{episode:?}:{duration_secs:?}");
        if let Some(cached) = self.cache.get(&key) {
            return Ok(cached);
        }
        let key_lock = self.in_flight.claim(&key);
        let result = async {
            let _fetch_permit = key_lock.lock().await;
            if let Some(cached) = self.cache.get(&key) {
                return Ok(cached);
            }
            let result = self
                .fetch_segments(imdb_id, season, episode, duration_secs)
                .await?;
            self.cache
                .put(&key, result.clone(), result.segments.is_empty(), || true);
            Ok(result)
        }
        .await;
        self.in_flight.release(&key, &key_lock);
        result
    }

    /// Fetch skippable segments from SkipDB (`GET /api/segments`).
    /// `season`/`episode` are sent together or omitted together; `duration_secs`
    /// enables duration matching (`adjust=conservative` only shifts earlier — a
    /// skip can't land past the content). Definitive answers (data, other 4xx, bad
    /// payload) are `Ok` — missing skip data is a normal crowdsourced condition.
    /// Transient failures (transport, 408, 429, 5xx) are `Err` so the caller neither
    /// caches them as "no data" nor skips its retry.
    async fn fetch_segments(
        &self,
        imdb_id: &str,
        season: Option<u32>,
        episode: Option<u32>,
        duration_secs: Option<f64>,
    ) -> Result<SkipTimesResult, String> {
        use std::fmt::Write as _;

        let mut url = format!(
            "{}?imdb_id={}",
            SKIPDB_SEGMENTS_URL,
            encode_uri_component(imdb_id)
        );
        if let (Some(season), Some(episode)) = (season, episode) {
            let _ = write!(url, "&season={season}&episode={episode}");
        }
        if let Some(duration_secs) = duration_secs {
            let _ = write!(url, "&duration={duration_secs}&adjust=conservative");
        }

        let res = match self.client.get(&url).send().await {
            Ok(response) => response,
            Err(error) => {
                #[cfg(debug_assertions)]
                eprintln!("[SkipTimes] SkipDB request error: {}", error);
                return skip_times_fetch_failure(FetchFailure::from_send_error(
                    &error,
                    TRANSIENT_ERROR.to_string(),
                ));
            }
        };

        let status = res.status();
        if !status.is_success() {
            #[cfg(debug_assertions)]
            eprintln!("[SkipTimes] SkipDB HTTP {status}");
            return skip_times_http_failure(status);
        }

        let bytes = match super::read_bounded_body(res, SKIP_TIMES_MAX_BYTES, |_| {
            "Skip-times response too large.".to_string()
        })
        .await
        {
            Ok(bytes) => bytes,
            Err(error) => {
                #[cfg(debug_assertions)]
                eprintln!("[SkipTimes] body error");
                return skip_times_body_failure(error);
            }
        };
        let body: SkipDbSegmentsResponse = match serde_json::from_slice(&bytes) {
            Ok(b) => b,
            Err(_e) => {
                #[cfg(debug_assertions)]
                eprintln!("[SkipTimes] SkipDB parse error: {}", _e);
                return Ok(SkipTimesResult::default());
            }
        };

        Ok(collect_skip_db_segments(body, duration_secs))
    }
}

/// Per-entry parse isolation: one bad crowdsourced row must not sink the siblings.
fn collect_skip_db_segments(
    body: SkipDbSegmentsResponse,
    duration_secs: Option<f64>,
) -> SkipTimesResult {
    let SkipDbSegmentsResponse {
        segments,
        intro_length_estimate_ms,
    } = body;
    let mut intro_length_secs = intro_length_estimate_ms
        .as_ref()
        .and_then(serde_json::Value::as_f64)
        .map(|ms| ms / 1000.0);
    let mut collected = Vec::with_capacity(4);
    for (segment_type, entry) in [
        ("intro", segments.intro),
        ("recap", segments.recap),
        ("outro", segments.outro),
        ("preview", segments.preview),
    ] {
        let Some(entry) =
            entry.and_then(|value| serde_json::from_value::<SkipDbSegmentEntry>(value).ok())
        else {
            continue;
        };
        // This episode's own intro outranks the season median: its length survives an
        // out-of-range cut, and the 0/0 "confirmed none" sentinel measures zero.
        if segment_type == "intro" {
            if let Some(end_ms) = entry.end_ms {
                intro_length_secs = Some((end_ms - entry.start_ms) / 1000.0);
            }
        }
        if let Some(segment) = entry.into_segment(segment_type, duration_secs) {
            collected.push(segment);
        }
    }
    let segments = normalize_skip_segments(collected, duration_secs);
    let intro_estimate_secs = intro_length_secs
        .filter(|length| *length <= MAX_INTRO_SECS)
        .map(|length| (length - INTRO_ESTIMATE_LEAD_SECS).floor())
        .filter(|secs| *secs >= MIN_INTRO_ESTIMATE_SECS)
        .filter(|_| !segments.iter().any(|segment| segment.type_ == "intro"));
    SkipTimesResult {
        segments,
        intro_estimate_secs,
    }
}

impl Default for SkipTimesProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Deserialize)]
struct SkipDbSegmentsResponse {
    #[serde(default)]
    segments: SkipDbSegments,
    /// Season median intro length; raw so a malformed value can't sink the segments.
    #[serde(default)]
    intro_length_estimate_ms: Option<serde_json::Value>,
}

#[derive(Deserialize, Default)]
struct SkipDbSegments {
    // Raw `Value` slots: a malformed entry fails its own parse, not the whole decode.
    intro: Option<serde_json::Value>,
    recap: Option<serde_json::Value>,
    outro: Option<serde_json::Value>,
    preview: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct SkipDbSegmentEntry {
    start_ms: f64,
    /// May be omitted on outros: they then run to the end of the stream.
    end_ms: Option<f64>,
    /// `exact|shifted|agnostic|out-of-range`; absent on legacy rows — treat missing as usable.
    #[serde(default, rename = "match")]
    match_: Option<String>,
}

impl SkipDbSegmentEntry {
    fn into_segment(self, type_: &'static str, duration_secs: Option<f64>) -> Option<SkipSegment> {
        // An out-of-range match differs too much to shift — its timestamps would land on the wrong scene.
        if self.match_.as_deref() == Some("out-of-range") {
            return None;
        }
        let end_time = match self.end_ms {
            Some(end_ms) => end_ms / 1000.0,
            None if type_ == "outro" => duration_secs?,
            None => return None,
        };
        Some(SkipSegment {
            type_,
            start_time: self.start_ms / 1000.0,
            end_time,
        })
    }
}

#[cfg(test)]
mod tests;
