use super::ttl_cache::FetchFailure;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use urlencoding::encode;

/// One skippable segment (intro/recap/outro/preview); SkipDB decodes via `SkipDbSegmentEntry`.
#[derive(Debug, Serialize, Clone, PartialEq)]
pub(crate) struct SkipSegment {
    #[serde(rename = "type")]
    pub type_: String,
    pub start_time: f64,
    pub end_time: f64,
}

/// SkipDB lookup payload: the submitted segments for the title or episode.
#[derive(Debug, Serialize, Clone, Default)]
pub(crate) struct SkipTimesResult {
    pub segments: Vec<SkipSegment>,
}

const MIN_SKIP_SEGMENT_DURATION_SECS: f64 = 1.0;

fn normalize_skip_time(value: f64) -> Option<f64> {
    if !value.is_finite() {
        return None;
    }

    Some((value.max(0.0) * 1000.0).round() / 1000.0)
}

fn normalize_skip_segments(mut segments: Vec<SkipSegment>) -> Vec<SkipSegment> {
    segments.retain_mut(|segment| {
        let Some((start_time, end_time)) =
            normalize_skip_time(segment.start_time).zip(normalize_skip_time(segment.end_time))
        else {
            return false;
        };
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
            .then_with(|| left.type_.cmp(&right.type_))
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
}

/// Bound crowdsourced JSON before allocation — a compromised endpoint must not OOM the app.
const SKIP_TIMES_MAX_BYTES: usize = 256 * 1024;

const SKIPDB_SEGMENTS_URL: &str = "https://api.skipdb.tv/api/segments";
const TRANSIENT_ERROR: &str = "Skip times are temporarily unavailable.";

async fn read_skip_times_body(
    response: reqwest::Response,
) -> Result<Vec<u8>, super::BoundedBodyError> {
    super::read_bounded_body(response, SKIP_TIMES_MAX_BYTES, |_| {
        "Skip-times response too large.".to_string()
    })
    .await
}

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
        }
    }

    /// Fetch skippable segments from SkipDB (`GET /api/segments`).
    /// `season`/`episode` are sent together or omitted together; `duration_secs`
    /// enables duration matching (`adjust=conservative` only shifts earlier — a
    /// skip can't land past the content). Definitive answers (data, other 4xx, bad
    /// payload) are `Ok` — missing skip data is a normal crowdsourced condition.
    /// Transient failures (transport, 408, 429, 5xx) are `Err` so the caller neither
    /// caches them as "no data" nor skips its retry.
    pub(crate) async fn get_segments(
        &self,
        imdb_id: &str,
        season: Option<u32>,
        episode: Option<u32>,
        duration_secs: Option<f64>,
    ) -> Result<SkipTimesResult, String> {
        let mut url = format!("{}?imdb_id={}", SKIPDB_SEGMENTS_URL, encode(imdb_id));
        if let (Some(season), Some(episode)) = (season, episode) {
            url.push_str(&format!("&season={season}&episode={episode}"));
        }
        if let Some(duration_secs) = duration_secs {
            url.push_str(&format!("&duration={duration_secs}&adjust=conservative"));
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

        let bytes = match read_skip_times_body(res).await {
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

        Ok(SkipTimesResult {
            segments: normalize_skip_segments(collect_skip_db_segments(
                body.segments,
                duration_secs,
            )),
        })
    }
}

/// Per-entry parse isolation: one bad crowdsourced row must not sink the siblings.
fn collect_skip_db_segments(
    segments: SkipDbSegments,
    duration_secs: Option<f64>,
) -> Vec<SkipSegment> {
    let mut collected = Vec::with_capacity(4);
    for (segment_type, entry) in [
        ("intro", segments.intro),
        ("recap", segments.recap),
        ("outro", segments.outro),
        ("preview", segments.preview),
    ] {
        if let Some(segment) = entry
            .and_then(|value| serde_json::from_value::<SkipDbSegmentEntry>(value).ok())
            .and_then(|entry| entry.into_segment(segment_type, duration_secs))
        {
            collected.push(segment);
        }
    }
    collected
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
            type_: type_.to_string(),
            start_time: self.start_ms / 1000.0,
            end_time,
        })
    }
}

#[cfg(test)]
mod tests;
