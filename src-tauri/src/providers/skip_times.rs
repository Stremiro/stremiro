use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use urlencoding::encode;

/// A single skippable segment (intro, recap, outro, preview). Serialize-only:
/// SkipDB payloads decode through `SkipDbSegmentEntry` instead.
#[derive(Debug, Serialize, Clone, PartialEq)]
pub(crate) struct SkipSegment {
    #[serde(rename = "type")]
    pub type_: String,
    /// Segment start in seconds
    pub start_time: f64,
    /// Segment end in seconds
    pub end_time: f64,
}

/// SkipDB lookup payload: the submitted segments for the title or episode.
#[derive(Debug, Serialize, Clone, Default)]
pub(crate) struct SkipTimesResult {
    pub segments: Vec<SkipSegment>,
}

const MIN_SKIP_SEGMENT_DURATION_SECS: f64 = 1.0;
const SKIP_SEGMENT_OVERLAP_EPSILON_SECS: f64 = 0.25;

fn normalize_skip_time(value: f64) -> Option<f64> {
    if !value.is_finite() {
        return None;
    }

    Some((value.max(0.0) * 1000.0).round() / 1000.0)
}

fn normalize_skip_segments(segments: Vec<SkipSegment>) -> Vec<SkipSegment> {
    let mut normalized_segments = segments
        .into_iter()
        .filter_map(|segment| {
            let type_ = crate::commands::normalize_opaque_field(&segment.type_)?;
            let start_time = normalize_skip_time(segment.start_time)?;
            let end_time = normalize_skip_time(segment.end_time)?;

            if end_time - start_time < MIN_SKIP_SEGMENT_DURATION_SECS {
                return None;
            }

            Some(SkipSegment {
                type_,
                start_time,
                end_time,
            })
        })
        .collect::<Vec<_>>();

    normalized_segments.sort_by(|left, right| {
        left.start_time
            .total_cmp(&right.start_time)
            .then(left.end_time.total_cmp(&right.end_time))
            .then_with(|| left.type_.cmp(&right.type_))
    });

    let mut merged_segments: Vec<SkipSegment> = Vec::with_capacity(normalized_segments.len());

    for mut segment in normalized_segments {
        if let Some(previous_segment) = merged_segments.last_mut() {
            if segment.type_ == previous_segment.type_
                && segment.start_time
                    <= previous_segment.end_time + SKIP_SEGMENT_OVERLAP_EPSILON_SECS
            {
                previous_segment.end_time = previous_segment.end_time.max(segment.end_time);
                continue;
            }

            segment.start_time = segment.start_time.max(previous_segment.end_time);
            if segment.end_time - segment.start_time < MIN_SKIP_SEGMENT_DURATION_SECS {
                continue;
            }
        }

        merged_segments.push(segment);
    }

    merged_segments
}

/// IMDb ids (`tt` + digits) are the only lookup key SkipDB accepts. Bounded
/// and normalized once so a malformed id never reaches the outbound query.
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

/// SkipDB responses are small crowdsourced JSON. Bound them before
/// allocation so a compromised endpoint cannot OOM the app via unbounded
/// `res.json()` materialization.
const SKIP_TIMES_MAX_BYTES: usize = 256 * 1024;

const SKIPDB_SEGMENTS_URL: &str = "https://api.skipdb.tv/api/segments";

async fn read_bounded_body(response: reqwest::Response) -> Result<Vec<u8>, String> {
    super::read_bounded_body(response, SKIP_TIMES_MAX_BYTES, |_| {
        "Skip-times response too large.".to_string()
    })
    .await
    .map_err(|error| error.into_message())
}

impl SkipTimesProvider {
    pub(crate) fn new() -> Self {
        super::ensure_rustls_crypto_provider();
        Self {
            client: Client::builder()
                .user_agent("Stremiro/0.4 (+https://github.com/stremiro/stremiro)")
                .redirect(super::fetch_policy::ssrf_redirect_policy())
                .connect_timeout(Duration::from_secs(8))
                .timeout(Duration::from_secs(15))
                .pool_idle_timeout(Duration::from_secs(60))
                .build()
                // Fail closed: a default-client fallback would silently drop
                // the SSRF redirect policy installed above.
                .expect("skip-times HTTP client must build"),
        }
    }

    /// Fetch skippable segments from the SkipDB API (`GET /api/segments`).
    ///
    /// `season`/`episode` are passed together for episodes and omitted
    /// together for movies, per the API contract. The stream `duration_secs`
    /// enables SkipDB's duration matching: with `adjust=conservative`
    /// timestamps are shifted earlier to fit this cut (never later, so a skip
    /// can't land past the content), and an outro without `end_ms` resolves
    /// to the stream duration. Entries reported `out-of-range` are dropped —
    /// they belong to a different cut and would place the skip wrongly.
    ///
    /// Always returns an empty result on transport/parse failure: missing
    /// skip data is a normal crowdsourced condition, not an app error.
    pub(crate) async fn get_segments(
        &self,
        imdb_id: &str,
        season: Option<u32>,
        episode: Option<u32>,
        duration_secs: Option<f64>,
    ) -> SkipTimesResult {
        let mut url = format!("{}?imdb_id={}", SKIPDB_SEGMENTS_URL, encode(imdb_id));
        if let (Some(season), Some(episode)) = (season, episode) {
            url.push_str(&format!("&season={season}&episode={episode}"));
        }
        if let Some(duration_secs) = duration_secs {
            url.push_str(&format!("&duration={duration_secs}&adjust=conservative"));
        }

        let res = match self.client.get(&url).send().await {
            Ok(response) => response,
            Err(_e) => {
                #[cfg(debug_assertions)]
                eprintln!("[SkipTimes] SkipDB request error: {}", _e);
                return SkipTimesResult::default();
            }
        };

        if !res.status().is_success() {
            #[cfg(debug_assertions)]
            eprintln!("[SkipTimes] SkipDB HTTP {}", res.status());
            return SkipTimesResult::default();
        }

        let bytes = match read_bounded_body(res).await {
            Ok(bytes) => bytes,
            Err(_too_large) => {
                // Oversize crowdsourced payloads degrade to "no data" —
                // never a playback error — but stay distinguishable in
                // debug traces from transport/parse failures.
                #[cfg(debug_assertions)]
                eprintln!("[SkipTimes] {_too_large}");
                return SkipTimesResult::default();
            }
        };
        let body: SkipDbSegmentsResponse = match serde_json::from_slice(&bytes) {
            Ok(b) => b,
            Err(_e) => {
                #[cfg(debug_assertions)]
                eprintln!("[SkipTimes] SkipDB parse error: {}", _e);
                return SkipTimesResult::default();
            }
        };

        SkipTimesResult {
            segments: normalize_skip_segments(collect_skip_db_segments(body.segments)),
        }
    }
}

/// One bad crowdsourced row must not sink the siblings: each slot parses
/// independently (`serde_json::from_value` per entry), matching the
/// per-item `filter_map`/`ok()` isolation the other providers use.
fn collect_skip_db_segments(segments: SkipDbSegments) -> Vec<SkipSegment> {
    let mut collected = Vec::with_capacity(4);
    for (segment_type, entry) in [
        ("intro", segments.intro),
        ("recap", segments.recap),
        ("outro", segments.outro),
        ("preview", segments.preview),
    ] {
        let segment = entry
            .and_then(|value| serde_json::from_value::<SkipDbSegmentEntry>(value).ok())
            .and_then(|entry| entry.into_segment(segment_type));
        if let Some(segment) = segment {
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

// ─── SkipDB deserialization ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct SkipDbSegmentsResponse {
    #[serde(default)]
    segments: SkipDbSegments,
}

#[derive(Deserialize, Default)]
struct SkipDbSegments {
    // Raw `Value` slots so a malformed entry fails its own per-entry parse
    // instead of the whole `SkipDbSegmentsResponse` decode.
    intro: Option<serde_json::Value>,
    recap: Option<serde_json::Value>,
    outro: Option<serde_json::Value>,
    preview: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct SkipDbSegmentEntry {
    start_ms: f64,
    /// Omitted on outro rows that run to the end of the stream. The API
    /// substitutes the stream duration when one is sent; without it these
    /// rows carry no usable cut.
    end_ms: Option<f64>,
    /// `exact | shifted | agnostic | out-of-range`. Absent on legacy rows —
    /// treat a missing match as usable rather than dropping real data.
    #[serde(default, rename = "match")]
    match_: Option<String>,
}

impl SkipDbSegmentEntry {
    fn into_segment(self, type_: &'static str) -> Option<SkipSegment> {
        // The closest stored cut differs too much from this stream to shift
        // reliably — its timestamps would place the skip on the wrong scene.
        if self.match_.as_deref() == Some("out-of-range") {
            return None;
        }
        Some(SkipSegment {
            type_: type_.to_string(),
            start_time: self.start_ms / 1000.0,
            end_time: self.end_ms? / 1000.0,
        })
    }
}

#[cfg(test)]
mod tests;
