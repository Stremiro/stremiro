use super::streaming_helpers::parse_playback_url;
use crate::providers::fetch_policy::MAX_REDIRECT_HOPS;
use serde::Serialize;
use std::sync::LazyLock;
use std::time::Duration;

/// Shared probe client. Redirects are disabled: `resolve_final_direct_url` walks hops
/// manually so addon `proxyHeaders` secrets are forwarded only to the initial
/// origin, including same-origin redirect hops, never to another host.
static REDIRECT_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    crate::providers::ensure_rustls_crypto_provider();
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(8))
        .build()
        // Fail closed: a builder fallback would silently drop `Policy::none` and bypass the redirect/SSRF gating.
        .expect("redirect-disabled probe client must build")
});

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedStream {
    pub url: String,
    /// mpv string-list of the final origin's bounded headers. Secrets: never log/persist.
    pub mpv_http_header_fields: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BestResolvedStream {
    pub url: String,
    pub cache_ttl_ms: u64,
    /// Stable addon-instance id of the winner: feeds source-health attribution and resume binding.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_family: Option<String>,
    /// Winner's stream identity — after a preferred-pick failover this names the actual stream.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_key: Option<String>,
    /// mpv string-list of the final origin's bounded headers. Secrets: never log/persist.
    pub mpv_http_header_fields: String,
}

/// Why `resolve_best_stream` produced no winner — the frontend picks guidance from `kind`.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolveStreamErrorKind {
    NoStreams,
    NoDirectUrl,
    RateLimited,
    #[default]
    Failed,
    Cancelled,
}

pub type ResolveStreamError = super::CommandError<ResolveStreamErrorKind>;

/// One candidate probe failure. `rate_limited` comes from the HTTP status so callers never sniff message text.
#[derive(Debug)]
pub(crate) struct ProbeError {
    pub message: String,
    pub rate_limited: bool,
}

impl ProbeError {
    fn status(message: String, status: u16) -> Self {
        Self {
            message,
            rate_limited: status == reqwest::StatusCode::TOO_MANY_REQUESTS.as_u16(),
        }
    }
}

impl From<String> for ProbeError {
    fn from(message: String) -> Self {
        Self {
            message,
            rate_limited: false,
        }
    }
}

/// Statuses where the server refuses the probe itself (auth-gated, HEAD-disabled,
/// range-unsupported), not a dead stream — pass the URL through to libmpv.
/// Every other failure stays hard so dead links fail over to the next candidate.
fn is_advisory_probe_status(status: u16) -> bool {
    matches!(status, 401 | 403 | 407 | 405 | 501 | 416)
}

fn validate_probe_content_type(headers: &reqwest::header::HeaderMap) -> Result<(), String> {
    let Some(content_type) = headers.get(reqwest::header::CONTENT_TYPE) else {
        return Ok(());
    };
    let media_type = content_type
        .as_bytes()
        .split(|byte| *byte == b';')
        .next()
        .unwrap_or_default()
        .trim_ascii();
    if media_type.eq_ignore_ascii_case(b"text/html")
        || media_type.eq_ignore_ascii_case(b"application/xhtml+xml")
        || media_type.eq_ignore_ascii_case(b"application/json")
        || media_type.eq_ignore_ascii_case(b"application/x-bittorrent")
    {
        return Err("Direct stream probe returned HTML or JSON instead of media.".to_string());
    }
    Ok(())
}

/// Outbound header map for header-gated CDN playback — entries already bounded; never logged.
fn proxy_header_map(headers: &[(String, String)]) -> reqwest::header::HeaderMap {
    let mut map = reqwest::header::HeaderMap::new();
    for (name, value) in headers {
        let (Ok(header_name), Ok(header_value)) = (
            reqwest::header::HeaderName::from_bytes(name.as_bytes()),
            reqwest::header::HeaderValue::from_str(value),
        ) else {
            continue;
        };
        map.append(header_name, header_value);
    }
    map
}

/// Terminal outcome of the manual redirect walk.
enum ProbeLanding {
    /// Chain terminated at a success/partial response with this landed URL.
    Landed(String),
    /// Chain terminated at a non-success, non-redirect status.
    TerminalStatus(u16),
    /// Chain ended without a followable target (missing/unparseable Location).
    DeadEnd,
}

fn resolve_redirect_url(base: &reqwest::Url, location: &str) -> Result<reqwest::Url, String> {
    let mut target = base
        .join(location)
        .map_err(|_| "Direct stream resolved to an invalid URL.".to_string())?;
    if !location.contains('#') {
        target.set_fragment(base.fragment());
    }
    Ok(target)
}

/// Walk a redirect chain hop-by-hop, re-attaching proxy secrets only on the first
/// hop's origin (a `302` elsewhere must not exfiltrate bearer tokens). Every hop
/// passes `redirect_target_allowed`; violations fail closed.
async fn follow_redirect_hop(
    initial: &reqwest::Url,
    response: reqwest::Response,
    headers: &reqwest::header::HeaderMap,
) -> Result<ProbeLanding, String> {
    let client = &*REDIRECT_CLIENT;
    // Resolve `Location` manually so each hop is gated before request; `base` tracks the issuing hop.
    let mut base = initial.clone();
    let mut current = response;
    let mut hops = 0;
    loop {
        if !current.status().is_redirection() {
            let status = current.status();
            if status.is_success() {
                validate_probe_content_type(current.headers())?;
                return Ok(ProbeLanding::Landed(base.into()));
            }
            return Ok(ProbeLanding::TerminalStatus(status.as_u16()));
        }
        // Matches the policy's `previous().len() > MAX_REDIRECT_HOPS` bound.
        if hops == MAX_REDIRECT_HOPS {
            return Err("Direct stream exceeded the redirect limit.".to_string());
        }
        let next_url = current
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .map(|location| resolve_redirect_url(&base, location));
        drop(current);
        let Some(next_url) = next_url else {
            return Ok(ProbeLanding::DeadEnd);
        };
        let next_url = next_url?;
        if !crate::providers::fetch_policy::redirect_target_allowed(initial, &next_url) {
            return Err("Direct stream resolved to a blocked redirect target.".to_string());
        }
        // One-byte range — an unranged GET on the landing hop would start streaming the whole body.
        let mut request = client
            .get(next_url.clone())
            .header(reqwest::header::RANGE, "bytes=0-0");
        // Same-origin hops keep the addon's required headers; cross-origin hops go without.
        if crate::providers::fetch_policy::same_origin_for_proxy_headers(initial, &next_url) {
            request = request.headers(headers.clone());
        }
        current = request.send().await.map_err(|error| {
            format!(
                "Direct stream redirect probe failed: {}",
                error.without_url()
            )
        })?;
        base = next_url;
        hops += 1;
        // No recheck — `next_url` already passed `redirect_target_allowed`.
    }
}

async fn resolve_final_direct_url(
    direct_url: &reqwest::Url,
    request_headers: &[(String, String)],
) -> Result<String, ProbeError> {
    let client = &*REDIRECT_CLIENT;
    // Header-gated CDNs answer probes only with their required headers — the same entries libmpv will send.
    let headers = proxy_header_map(request_headers);
    // Hop-by-hop HEAD walk — only a HEAD transport failure falls through to the range probe.
    let head_error = match client
        .head(direct_url.clone())
        .headers(headers.clone())
        .send()
        .await
    {
        Ok(resp) if resp.status().is_redirection() => {
            return match follow_redirect_hop(direct_url, resp, &headers).await? {
                ProbeLanding::Landed(landed) => Ok(landed),
                ProbeLanding::TerminalStatus(status) if is_advisory_probe_status(status) => {
                    Ok(direct_url.to_string())
                }
                ProbeLanding::TerminalStatus(status) => Err(ProbeError::status(
                    format!("HEAD redirect chain ended with HTTP {status}"),
                    status,
                )),
                ProbeLanding::DeadEnd => Err("HEAD redirect chain had no followable target."
                    .to_string()
                    .into()),
            };
        }
        // Some servers report a default type on HEAD only; the range GET decides.
        Ok(resp) if resp.status().is_success() => match validate_probe_content_type(resp.headers())
        {
            Ok(()) => return Ok(direct_url.to_string()),
            Err(message) => message.into(),
        },
        // HEAD-only advisory or hard status: the range GET still runs; its error context starts here.
        Ok(resp) => ProbeError::status(
            format!("HEAD probe returned HTTP {}", resp.status().as_u16()),
            resp.status().as_u16(),
        ),
        // reqwest errors embed the full URL (possibly a signed token) — drop it before IPC.
        Err(error) => format!("HEAD probe failed: {}", error.without_url()).into(),
    };
    let head_rate_limited = head_error.rate_limited;
    let head_error = head_error.message;

    match client
        .get(direct_url.clone())
        .headers(headers.clone())
        .header(reqwest::header::RANGE, "bytes=0-0")
        .send()
        .await
    {
        Ok(resp) if resp.status().is_redirection() => {
            match follow_redirect_hop(direct_url, resp, &headers).await? {
                ProbeLanding::Landed(landed) => Ok(landed),
                // Advisory terminal status: pass the original URL to libmpv like a direct advisory.
                ProbeLanding::TerminalStatus(status) if is_advisory_probe_status(status) => {
                    Ok(direct_url.to_string())
                }
                ProbeLanding::TerminalStatus(status) => Err(ProbeError::status(
                    format!("{head_error}; redirect chain ended with HTTP {status}"),
                    status,
                )),
                ProbeLanding::DeadEnd => Err(ProbeError {
                    message: format!("{head_error}; redirect chain had no followable target"),
                    rate_limited: head_rate_limited,
                }),
            }
        }
        Ok(resp) if resp.status().is_success() => {
            validate_probe_content_type(resp.headers())?;
            Ok(direct_url.to_string())
        }
        // Only the GET's own advisory statuses pass — a HEAD-only advisory never overrides a hard GET failure.
        Ok(resp) if is_advisory_probe_status(resp.status().as_u16()) => Ok(direct_url.to_string()),
        Ok(resp) => {
            let status = resp.status().as_u16();
            Err(ProbeError::status(
                format!("{head_error}; range probe returned HTTP {status}"),
                status,
            ))
        }
        Err(error) => Err(ProbeError {
            message: format!("{head_error}; range probe failed: {}", error.without_url()),
            rate_limited: head_rate_limited,
        }),
    }
}

fn format_mpv_http_header_fields(headers: &[(String, String)]) -> String {
    // mpv's string-list uses comma separators and backslash escaping.
    let mut formatted = String::new();
    for (index, (name, value)) in headers.iter().enumerate() {
        if index > 0 {
            formatted.push(',');
        }
        for ch in name.chars().chain(": ".chars()).chain(value.chars()) {
            if matches!(ch, '\\' | ',') {
                formatted.push('\\');
            }
            formatted.push(ch);
        }
    }
    formatted
}

fn build_resolved_direct_stream(
    direct_url: &str,
    final_url: String,
    request_headers: &[(String, String)],
) -> Result<ResolvedStream, String> {
    let initial =
        reqwest::Url::parse(direct_url).map_err(|_| "Invalid direct stream URL.".to_string())?;
    let landed = parse_playback_url(&final_url)
        .ok_or_else(|| "Invalid or oversized resolved stream URL.".to_string())?;
    let request_headers =
        if crate::providers::fetch_policy::same_origin_for_proxy_headers(&initial, &landed) {
            request_headers
        } else {
            &[]
        };
    Ok(ResolvedStream {
        url: final_url,
        mpv_http_header_fields: format_mpv_http_header_fields(request_headers),
    })
}

pub(crate) const MISSING_DIRECT_URL_MESSAGE: &str = "This stream has no direct playback URL. Use a source addon that returns direct-link streams for this content.";

/// Resolve an addon direct stream URL to its playable landing URL, following redirects under the fetch policy.
pub(crate) async fn resolve_stream_inner(
    url: &reqwest::Url,
    request_headers: &[(String, String)],
) -> Result<ResolvedStream, ProbeError> {
    let final_url = resolve_final_direct_url(url, request_headers)
        .await
        .map_err(|error| ProbeError {
            message: format!("Direct stream validation failed: {}", error.message),
            rate_limited: error.rate_limited,
        })?;

    build_resolved_direct_stream(url.as_str(), final_url, request_headers).map_err(ProbeError::from)
}

#[cfg(test)]
mod tests;
