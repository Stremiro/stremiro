use super::streaming_helpers::{infer_stream_mime, normalize_http_url};
use crate::providers::addons::sanitize_addon_log;
use crate::providers::fetch_policy::MAX_REDIRECT_HOPS;
use serde::Serialize;
use std::sync::LazyLock;
use std::time::Duration;

/// Shared HTTP client for direct-stream probes. Re-used across calls to
/// avoid per-request TLS handshake overhead. Redirect following is disabled
/// here: `resolve_final_direct_url` walks hops manually so addon
/// `proxyHeaders` secrets are sent on the first hop only and never forwarded
/// cross-origin (reqwest strips standard auth headers, but a custom-named
/// bearer would otherwise follow a `302` to an attacker host).
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
    /// Bounded `proxyHeaders.request` entries for header-gated CDN playback.
    /// Secrets: never log or persist. Serialized for in-memory player use only.
    pub request_headers: Vec<(String, String)>,
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
    /// Bounded `proxyHeaders.request` entries for header-gated CDN playback.
    /// Secrets: never log or persist. Serialized for in-memory player use only.
    pub request_headers: Vec<(String, String)>,
}

/// Probing is advisory: these statuses mean the server refuses the probe
/// itself (auth-gated, HEAD-disabled, or range-unsupported) rather than
/// proving the stream is dead. Pass the original URL through to libmpv,
/// which retries with required headers and behavior hints. Every other
/// failure stays hard so dead links still fail over to the next candidate.
fn is_advisory_probe_status(status: u16) -> bool {
    matches!(status, 401 | 403 | 407 | 405 | 501 | 416)
}

/// Build the outbound header map for header-gated CDN playback. Extraction
/// already bounds entries; parsing rejects them again here so a malformed
/// hint can never break request construction. Values are never logged.
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

/// Walk one redirect chain hop-by-hop, returning the landing outcome.
/// The first request (issued by the caller with proxy headers) already
/// produced `response`; each further hop is re-issued here, re-attaching
/// proxy secrets only when the hop stays on the first hop's origin and going
/// headerless cross-origin, so a `302` to an attacker host cannot exfiltrate
/// addon bearer tokens. Every hop passes `redirect_target_allowed`;
/// violations fail closed.
async fn follow_redirect_hop(
    initial: &reqwest::Url,
    response: reqwest::Response,
    headers: &reqwest::header::HeaderMap,
) -> Result<ProbeLanding, String> {
    let client = &*REDIRECT_CLIENT;
    // `Policy::none` surfaces 3xx as a plain response: resolve the Location
    // manually so each hop can be gated before it is requested. `base` tracks
    // the last requested URL so relative `Location` values resolve against
    // the hop that issued them, not the first hop.
    let mut base = response.url().clone();
    let mut current = response;
    let mut hops = 0;
    loop {
        if !current.status().is_redirection() {
            let status = current.status();
            if status.is_success() || status == reqwest::StatusCode::PARTIAL_CONTENT {
                // Only the landed URL is needed downstream: drop the response
                // (headers + unread body) so the pooled connection can be
                // reused instead of forcing a fresh TLS handshake per probe.
                let landed = current.url().to_string();
                drop(current);
                return Ok(ProbeLanding::Landed(landed));
            }
            return Ok(ProbeLanding::TerminalStatus(status.as_u16()));
        }
        // Still redirecting after MAX_REDIRECT_HOPS fetches is the policy's
        // `previous().len() > MAX_REDIRECT_HOPS` bound — report it without
        // paying for a throwaway hop whose response would go unexamined.
        if hops == MAX_REDIRECT_HOPS {
            return Err("Direct stream exceeded the redirect limit.".to_string());
        }
        let location = current
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        // Drop headers + unread body before the next hop so the pooled
        // connection is reusable.
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
        // No recheck here: `next_url` already passed `redirect_target_allowed`.
        // The loop re-examines the new response, so a chain landing exactly on
        // the last allowed hop is honored, not reported as over-limit.
    }
}

async fn resolve_final_direct_url(
    direct_url: &str,
    request_headers: &[(String, String)],
) -> Result<String, String> {
    // Validate before any network probe: the shared client would otherwise
    // issue a HEAD/GET to a private/userinfo target before the landed-URL
    // recheck runs. Same gate as subtitles/external URLs.
    if !crate::providers::addon_resource::is_fetchable_http_url(direct_url) {
        return Err("Direct stream URL is blocked by fetch policy.".to_string());
    }
    let client = &*REDIRECT_CLIENT;
    // Header-gated CDNs answer probes only with their required headers: send
    // the addon's bounded `proxyHeaders.request` entries so candidate
    // selection reflects what libmpv will receive. Servers ignore unknown
    // headers, so this degrades safely for plain streams.
    let headers = proxy_header_map(request_headers);
    // `resolve_stream_inner` owns the "Direct stream validation failed"
    // prefix — inner errors carry the bare cause.
    let initial = reqwest::Url::parse(direct_url).map_err(|_| "invalid source URL.".to_string())?;
    // Hop-by-hop HEAD walk (no auto-follow; see `follow_redirect_hop` for the
    // gating). A landed or terminal chain is authoritative — only a HEAD
    // transport failure falls through to the range probe below.
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
                ProbeLanding::TerminalStatus(status) => {
                    Err(format!("HEAD redirect chain ended with HTTP {status}"))
                }
                ProbeLanding::DeadEnd => {
                    Err("HEAD redirect chain had no followable target.".to_string())
                }
            };
        }
        Ok(resp) if resp.status().is_success() => {
            return Ok(initial.to_string());
        }
        Ok(resp) if is_advisory_probe_status(resp.status().as_u16()) => {
            // HEAD-only advisory (auth/405/416): the range GET below still
            // runs authoritatively, but its error context starts here.
            format!("HEAD probe returned HTTP {}", resp.status().as_u16())
        }
        Ok(resp) => format!("HEAD probe returned HTTP {}", resp.status().as_u16()),
        // reqwest errors embed the full request URL, which may carry a
        // signed token: redact before surfacing via IPC.
        Err(error) => format!(
            "HEAD probe failed: {}",
            sanitize_addon_log(&error.to_string())
        ),
    };

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
                // The range GET is authoritative for advisory pass-through:
                // a chain terminating at an auth/HEAD/range refusal passes
                // the original URL to libmpv like a direct advisory status;
                // anything else reports both contexts so dead links fail over.
                ProbeLanding::TerminalStatus(status) if is_advisory_probe_status(status) => {
                    Ok(direct_url.to_string())
                }
                ProbeLanding::TerminalStatus(status) => Err(format!(
                    "{}; redirect chain ended with HTTP {}",
                    head_error, status
                )),
                ProbeLanding::DeadEnd => Err(format!(
                    "{}; redirect chain had no followable target",
                    head_error
                )),
            }
        }
        Ok(resp)
            if resp.status().is_success()
                || resp.status() == reqwest::StatusCode::PARTIAL_CONTENT =>
        {
            Ok(initial.to_string())
        }
        // The range GET is authoritative: it exercises the real resource
        // path, so only its own advisory statuses pass through. A HEAD-only
        // advisory never overrides a hard GET failure; dead links still
        // fail over to the next candidate.
        Ok(resp) if is_advisory_probe_status(resp.status().as_u16()) => {
            // Valid header-dependent, HEAD-incompatible, or
            // range-incompatible direct stream: let libmpv attempt it.
            Ok(direct_url.to_string())
        }
        Ok(resp) => Err(format!(
            "{}; range probe returned HTTP {}",
            head_error,
            resp.status().as_u16()
        )),
        Err(error) => Err(format!(
            "{}; range probe failed: {}",
            head_error,
            sanitize_addon_log(&error.to_string())
        )),
    }
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
        request_headers,
    })
}

/// Matches resolver failures where the addon did not supply a playable URL.
/// Callers use this to aggregate per-source diagnostics instead of treating
/// each one as an unexpected error.
pub(crate) fn is_unresolvable_source_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("no direct playback url") || lower.contains("direct-link")
}

pub(crate) fn missing_direct_url_message() -> &'static str {
    "This stream has no direct playback URL. Use a source addon that returns direct-link streams for this content."
}

pub(crate) struct ResolveStreamParams {
    pub(crate) url: Option<String>,
    /// Bounded `proxyHeaders.request` entries from the addon's behavior
    /// hints. Secrets: never log or persist.
    pub(crate) request_headers: Vec<(String, String)>,
}

/// Resolve an addon-supplied stream to a playable URL.
///
/// Addons are the sole source of playback URLs: a direct `http(s)` URL is
/// followed through redirects and returned, while anything else (info hashes,
/// magnet links, or missing URLs) is reported explicitly so the caller can
/// try the next candidate or tell the user to use a direct-link addon.
pub(crate) async fn resolve_stream_inner(
    params: ResolveStreamParams,
) -> Result<ResolvedStream, String> {
    if let Some(direct_url) = params.url.and_then(|value| normalize_http_url(&value)) {
        let final_url = resolve_final_direct_url(&direct_url, &params.request_headers)
            .await
            .map_err(|error| format!("Direct stream validation failed: {}", error))?;

        return build_resolved_direct_stream(&direct_url, final_url, params.request_headers);
    }

    Err(missing_direct_url_message().to_string())
}

#[cfg(test)]
mod tests;
