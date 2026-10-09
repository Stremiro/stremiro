use super::streaming_helpers::infer_stream_mime;
use crate::providers::addons::sanitize_addon_log;
use crate::providers::fetch_policy::MAX_REDIRECT_HOPS;
use serde::Serialize;
use std::sync::LazyLock;
use std::time::Duration;

/// Shared probe client (avoids per-request TLS handshakes). Redirects are
/// disabled: `resolve_final_direct_url` walks hops manually so addon
/// `proxyHeaders` secrets go to the first hop only — a custom-named bearer
/// must never follow a `302` to an attacker host.
static REDIRECT_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    crate::providers::ensure_rustls_crypto_provider();
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(8))
        .build()
        // Fail closed: a builder fallback would silently drop `Policy::none`
        // and let the manual redirect/SSRF gating below be bypassed.
        .expect("redirect-disabled probe client must build")
});

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedStream {
    pub url: String,
    pub format: String,
    /// mpv string-list encoding of the final origin's bounded request headers.
    /// Secrets: never log or persist. Serialized for in-memory player use only.
    pub mpv_http_header_fields: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BestResolvedStream {
    pub url: String,
    pub format: String,
    /// Stable addon-instance id that served the winner: feeds source-health
    /// attribution and resume binding, independent of the display name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_family: Option<String>,
    /// Stream identity of the resolved winner: after a preferred-pick
    /// failover this names the actual stream, not the requested one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_key: Option<String>,
    /// mpv string-list encoding of the final origin's bounded request headers.
    /// Secrets: never log or persist. Serialized for in-memory player use only.
    pub mpv_http_header_fields: String,
}

/// Why `resolve_best_stream` produced no winner. The frontend picks its
/// guidance from `kind`; `message` is display text only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolveStreamErrorKind {
    NoStreams,
    NoDirectUrl,
    RateLimited,
    Failed,
}

#[derive(Debug, Serialize)]
pub struct ResolveStreamError {
    pub kind: ResolveStreamErrorKind,
    pub message: String,
}

impl ResolveStreamError {
    pub(crate) fn new(kind: ResolveStreamErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl From<String> for ResolveStreamError {
    fn from(message: String) -> Self {
        Self::new(ResolveStreamErrorKind::Failed, message)
    }
}

/// One candidate probe failure. `rate_limited` is set from the HTTP status
/// where the probe saw one, so callers never sniff the message text.
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

/// These statuses mean the server refuses the probe itself (auth-gated,
/// HEAD-disabled, range-unsupported), not that the stream is dead — pass the
/// URL through to libmpv. Every other failure stays hard so dead links fail
/// over to the next candidate.
fn is_advisory_probe_status(status: u16) -> bool {
    matches!(status, 401 | 403 | 407 | 405 | 501 | 416)
}

/// Outbound header map for header-gated CDN playback. Entries are already
/// bounded; parse failures degrade to skipped entries. Never logged.
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

/// Walk one redirect chain hop-by-hop. Each further hop re-attaches proxy
/// secrets only when it stays on the first hop's origin (a `302` to an
/// attacker host must not exfiltrate bearer tokens). Every hop passes
/// `redirect_target_allowed`; violations fail closed.
async fn follow_redirect_hop(
    initial: &reqwest::Url,
    response: reqwest::Response,
    headers: &reqwest::header::HeaderMap,
) -> Result<ProbeLanding, String> {
    let client = &*REDIRECT_CLIENT;
    // Resolve `Location` manually so each hop is gated before it is
    // requested; `base` tracks the hop that issued it for relative targets.
    let mut base = response.url().clone();
    let mut current = response;
    let mut hops = 0;
    loop {
        if !current.status().is_redirection() {
            let status = current.status();
            if status.is_success() {
                return Ok(ProbeLanding::Landed(current.url().to_string()));
            }
            return Ok(ProbeLanding::TerminalStatus(status.as_u16()));
        }
        // Matches the policy's `previous().len() > MAX_REDIRECT_HOPS` bound —
        // report without paying for a throwaway hop.
        if hops == MAX_REDIRECT_HOPS {
            return Err("Direct stream exceeded the redirect limit.".to_string());
        }
        let location = current
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        drop(current);
        let Some(location) = location else {
            return Ok(ProbeLanding::DeadEnd);
        };
        let next_url = base
            .join(&location)
            .map_err(|_| "Direct stream resolved to an invalid URL.".to_string())?;
        if !crate::providers::fetch_policy::redirect_target_allowed(initial, &next_url) {
            return Err("Direct stream resolved to a blocked redirect target.".to_string());
        }
        let mut request = client.get(next_url.clone());
        // Same-origin hops keep the addon's required headers; cross-origin
        // hops go headerless.
        if crate::providers::fetch_policy::same_origin_for_proxy_headers(initial, &next_url) {
            request = request.headers(headers.clone());
        }
        current = request.send().await.map_err(|error| {
            format!(
                "Direct stream redirect probe failed: {}",
                sanitize_addon_log(&error.to_string())
            )
        })?;
        base = next_url;
        hops += 1;
        // No recheck: `next_url` already passed `redirect_target_allowed`, so
        // a chain landing exactly on the last allowed hop is honored.
    }
}

async fn resolve_final_direct_url(
    direct_url: &str,
    request_headers: &[(String, String)],
) -> Result<String, ProbeError> {
    // Gate before any network probe — same check as subtitles/external URLs.
    if !crate::providers::addon_resource::is_fetchable_http_url(direct_url) {
        return Err("Direct stream URL is blocked by fetch policy."
            .to_string()
            .into());
    }
    let client = &*REDIRECT_CLIENT;
    // Header-gated CDNs answer probes only with their required headers — the
    // same entries libmpv will send. Unknown headers degrade safely.
    let headers = proxy_header_map(request_headers);
    // `resolve_stream_inner` owns the "validation failed" prefix — inner
    // errors carry the bare cause.
    let initial = reqwest::Url::parse(direct_url).map_err(|_| "invalid source URL.".to_string())?;
    // Hop-by-hop HEAD walk. A landed/terminal chain is authoritative — only a
    // HEAD transport failure falls through to the range probe below.
    let head_error = match client
        .head(direct_url)
        .headers(headers.clone())
        .send()
        .await
    {
        Ok(resp) if resp.status().is_redirection() => {
            return match follow_redirect_hop(&initial, resp, &headers).await? {
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
        Ok(resp) if resp.status().is_success() => {
            return Ok(initial.to_string());
        }
        // HEAD-only advisory or hard status: the range GET below still runs
        // authoritatively, but its error context starts here.
        Ok(resp) => ProbeError::status(
            format!("HEAD probe returned HTTP {}", resp.status().as_u16()),
            resp.status().as_u16(),
        ),
        // reqwest errors embed the full request URL, which may carry a
        // signed token: redact before surfacing via IPC.
        Err(error) => format!(
            "HEAD probe failed: {}",
            sanitize_addon_log(&error.to_string())
        )
        .into(),
    };
    let head_rate_limited = head_error.rate_limited;
    let head_error = head_error.message;

    match client
        .get(direct_url)
        .headers(headers.clone())
        .header("Range", "bytes=0-0")
        .send()
        .await
    {
        Ok(resp) if resp.status().is_redirection() => {
            match follow_redirect_hop(&initial, resp, &headers).await? {
                ProbeLanding::Landed(landed) => Ok(landed),
                // Advisory terminal status: pass the original URL to libmpv
                // like a direct advisory; hard failures report both contexts.
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
        Ok(resp) if resp.status().is_success() => Ok(initial.to_string()),
        // Only the range GET's own advisory statuses pass through — a
        // HEAD-only advisory never overrides a hard GET failure.
        Ok(resp) if is_advisory_probe_status(resp.status().as_u16()) => Ok(direct_url.to_string()),
        Ok(resp) => {
            let status = resp.status().as_u16();
            Err(ProbeError::status(
                format!("{head_error}; range probe returned HTTP {status}"),
                status,
            ))
        }
        Err(error) => Err(ProbeError {
            message: format!(
                "{}; range probe failed: {}",
                head_error,
                sanitize_addon_log(&error.to_string())
            ),
            rate_limited: head_rate_limited,
        }),
    }
}

fn format_mpv_http_header_fields(headers: &[(String, String)]) -> String {
    // mpv's string-list uses comma separators and backslash escaping.
    let escape = |value: &str| value.replace('\\', "\\\\").replace(',', "\\,");
    headers
        .iter()
        .map(|(name, value)| format!("{}: {}", escape(name), escape(value)))
        .collect::<Vec<_>>()
        .join(",")
}

fn build_resolved_direct_stream(
    direct_url: &str,
    final_url: String,
    request_headers: Vec<(String, String)>,
) -> Result<ResolvedStream, String> {
    let initial =
        reqwest::Url::parse(direct_url).map_err(|_| "Invalid direct stream URL.".to_string())?;
    let landed =
        reqwest::Url::parse(&final_url).map_err(|_| "Invalid resolved stream URL.".to_string())?;
    let request_headers =
        if crate::providers::fetch_policy::same_origin_for_proxy_headers(&initial, &landed) {
            request_headers
        } else {
            Vec::new()
        };
    Ok(ResolvedStream {
        format: infer_stream_mime(&final_url).to_string(),
        url: final_url,
        mpv_http_header_fields: format_mpv_http_header_fields(&request_headers),
    })
}

pub(crate) const MISSING_DIRECT_URL_MESSAGE: &str = "This stream has no direct playback URL. Use a source addon that returns direct-link streams for this content.";

pub(crate) struct ResolveStreamParams {
    /// Canonical `http(s)` URL that already passed the fetchable-URL gate
    /// (`build_candidate_input`); the probe re-checks it before any request.
    pub(crate) url: String,
    /// Bounded `proxyHeaders.request` entries from the addon's behavior
    /// hints. Secrets: never log or persist.
    pub(crate) request_headers: Vec<(String, String)>,
}

/// Resolve an addon-supplied direct stream URL to its playable landing URL,
/// following redirects under the fetch policy.
pub(crate) async fn resolve_stream_inner(
    params: ResolveStreamParams,
) -> Result<ResolvedStream, ProbeError> {
    let final_url = resolve_final_direct_url(&params.url, &params.request_headers)
        .await
        .map_err(|error| ProbeError {
            message: format!("Direct stream validation failed: {}", error.message),
            rate_limited: error.rate_limited,
        })?;

    build_resolved_direct_stream(&params.url, final_url, params.request_headers)
        .map_err(ProbeError::from)
}

#[cfg(test)]
mod tests;
