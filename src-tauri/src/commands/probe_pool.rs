use super::playback_state::PlaybackStateService;
use super::stream_fetcher::{
    fetch_stream_selector_data, resolve_stream_ranking_scope, ResolveFetch, StreamQueryRequest,
    StreamRankingOverrides, StreamRankingScope,
};
use super::stream_resolver::{
    resolve_stream_inner, BestResolvedStream, ProbeError, ResolveStreamError,
    ResolveStreamErrorKind, ResolvedStream,
};
use super::streaming_helpers::{
    canonicalize_header_identity, is_legacy_content_key, is_prepared_stream_key,
    normalize_source_id, normalize_source_key, push_bounded_error, stream_dedup_key,
};
use super::{js_trim, normalize_media_id, normalize_non_empty, normalize_stream_media_type};
use crate::providers::addons::{remaining_stream_cache_ttl_ms, AddonStream, AddonTransport};
use crate::providers::lock_or_recover;
use futures_util::stream::{self, FuturesUnordered};
use futures_util::StreamExt;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::sync::Mutex;
use std::time::Duration;
use tauri::AppHandle;
use tokio::time::Instant;

/// Per-probe timeout in the best-stream fan-out — bounded so bad candidates don't chain long failures.
pub(crate) const BEST_STREAM_CANDIDATE_TIMEOUT_SECS: u64 = 10;
pub(crate) const BEST_STREAM_MAX_CANDIDATES: usize = 24;
const BEST_STREAM_PROBE_CONCURRENCY: usize = 8;
const SAME_HOST_PROBE_SPACING: Duration = Duration::from_millis(150);

/// Normalized stream-command inputs: validated media identity plus the resolved
/// ranking scope — the one path shared by all three stream commands
/// (`get_stream_selector_data`, `resolve_best_stream`, `recover_playback_stream`).
pub(crate) struct StreamPoolQuery {
    pub media_type: String,
    pub id: String,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub absolute_episode: Option<u32>,
    pub ranking: StreamRankingScope,
}

impl StreamPoolQuery {
    /// `normalize_media_id` → `normalize_stream_media_type` → `resolve_stream_ranking_scope`.
    /// `context` labels validation errors ("stream lookup", "stream recovery").
    pub(crate) fn new(
        media_type: &str,
        id: &str,
        season: Option<u32>,
        episode: Option<u32>,
        absolute_episode: Option<u32>,
        overrides: StreamRankingOverrides,
        context: &str,
    ) -> Result<Self, String> {
        let id = normalize_media_id(js_trim(id))
            .ok_or_else(|| format!("Media ID is required for {context}."))?;
        let media_type = normalize_stream_media_type(js_trim(media_type), Some(&id))
            .ok_or_else(|| format!("Invalid media type for {context}."))?
            .to_string();
        let ranking = resolve_stream_ranking_scope(&media_type, &id, season, episode, overrides)?;
        Ok(Self {
            media_type,
            id,
            season,
            episode,
            absolute_episode,
            ranking,
        })
    }

    /// The outbound fetch request; recovery passes the addon-indexed lookup id on mapped titles.
    pub(crate) fn request<'a>(&'a self, fetch_id: &'a str) -> StreamQueryRequest<'a> {
        StreamQueryRequest {
            media_type: &self.media_type,
            id: fetch_id,
            season: self.season,
            episode: self.episode,
            absolute_episode: self.absolute_episode,
        }
    }

    /// Rows arrive ingress-filtered and coordinator-ranked.
    pub(crate) async fn fetch_pool(
        &self,
        app: &AppHandle,
        playback_state: &PlaybackStateService,
        provider: &AddonTransport,
        fetch_id: &str,
        resolve: ResolveFetch<'_>,
        deadline: Instant,
    ) -> Result<Vec<AddonStream>, String> {
        let data = fetch_stream_selector_data(
            app,
            playback_state,
            provider,
            &self.request(fetch_id),
            &self.ranking,
            None,
            Some(resolve),
            Some(deadline),
        )
        .await?;
        if data.streams.is_empty() {
            if let Some(error) = data.fatal_error_message {
                return Err(error);
            }
        }
        Ok(data.streams)
    }
}

/// One fetchable-URL gate shared by candidate extraction, the preferred-position
/// scan, and the resolve pool's retain pass.
pub(crate) fn is_probeable_stream(stream: &AddonStream) -> bool {
    stream
        .url
        .as_deref()
        .is_some_and(crate::providers::addon_resource::is_fetchable_http_url)
}

fn probe_url_identity(url: &str) -> &str {
    let url = url.trim();
    // Fragments can guide the player, but HTTP never sends them.
    url.split_once('#').map_or(url, |(request, _)| request)
}

#[derive(Eq)]
pub(super) struct ProbeRequestIdentity {
    pub(super) url: reqwest::Url,
    pub(super) headers: Vec<(String, String)>,
}

impl PartialEq for ProbeRequestIdentity {
    fn eq(&self, other: &Self) -> bool {
        probe_url_identity(self.url.as_str()) == probe_url_identity(other.url.as_str())
            && self.headers == other.headers
    }
}

impl ProbeRequestIdentity {
    pub(super) fn from_stream(stream: &AddonStream) -> Option<Self> {
        let url = crate::providers::addon_resource::parse_fetchable_http_url(
            stream.url.as_deref()?.trim(),
        )?;
        let mut headers = stream.request_headers();
        canonicalize_header_identity(&mut headers);
        Some(Self { url, headers })
    }
}

/// Owned probe inputs — no borrowed selector state crosses the concurrency boundary.
struct StreamResolveCandidateInput {
    pool_fetched_at: Option<std::time::Instant>,
    source_id: Option<String>,
    source_name: Option<String>,
    stream_family: Option<String>,
    stream_key: String,
    direct_url: reqwest::Url,
    request_headers: Vec<(String, String)>,
}

fn build_candidate_input(stream: AddonStream) -> Option<StreamResolveCandidateInput> {
    // Same fetchable gate as ingress: private-literal, userinfo, and non-http(s)
    // URLs never spend a probe. Canonical form stored so the excluded-URL compare
    // matches the normalized recovery URL.
    let direct_url =
        crate::providers::addon_resource::parse_fetchable_http_url(stream.url.as_deref()?.trim())?;
    let request_headers = stream.request_headers();
    Some(StreamResolveCandidateInput {
        pool_fetched_at: stream.pool_fetched_at,
        source_id: stream.source_id,
        source_name: stream.source_name,
        stream_family: stream.stream_family,
        stream_key: stream.stream_key,
        direct_url,
        request_headers,
    })
}

fn candidate_resolved_stream(
    candidate: StreamResolveCandidateInput,
    resolved: ResolvedStream,
) -> BestResolvedStream {
    BestResolvedStream {
        url: resolved.url,
        cache_ttl_ms: remaining_stream_cache_ttl_ms(
            candidate.pool_fetched_at,
            std::time::Instant::now(),
        ),
        source_id: candidate.source_id,
        source_name: candidate.source_name,
        stream_family: candidate.stream_family,
        stream_key: Some(candidate.stream_key),
        // Bounded at extraction; in-memory only, never logged.
        mpv_http_header_fields: resolved.mpv_http_header_fields,
    }
}

type CandidateProbeResult = (
    StreamResolveCandidateInput,
    Result<Result<ResolvedStream, ProbeError>, tokio::time::error::Elapsed>,
);

async fn probe_candidate(
    candidate: StreamResolveCandidateInput,
    delay: Duration,
    deadline: tokio::time::Instant,
) -> CandidateProbeResult {
    let result = tokio::time::timeout_at(deadline, async {
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        resolve_stream_inner(candidate.direct_url.as_str(), &candidate.request_headers).await
    })
    .await;

    (candidate, result)
}

/// The caller's preferred stream identity: exact stream key when it survives, else
/// saved source/family — signed URLs re-digest across sessions, so a URL-derived key
/// rots even when the same stream is still listed. `source_id` beats `source_name`,
/// which duplicate display names make ambiguous.
#[derive(Clone, Copy, Default)]
pub(crate) struct PreferredStreamHint<'a> {
    pub stream_key: Option<&'a str>,
    pub source_id: Option<&'a str>,
    pub source_name: Option<&'a str>,
    pub stream_family: Option<&'a str>,
}

/// A preferred key arrives as the prepared `s:{hash}` selector key or, on older
/// rows, the raw `h:`/`uh:` content-dedup key. Match either so legacy rows still
/// bind; the dedup-key recompute is paid only on legacy prefixes.
fn preferred_key_matches(stream: &AddonStream, key: &str) -> bool {
    if stream.stream_key == key {
        return true;
    }
    is_legacy_content_key(key) && stream_dedup_key(stream).is_some_and(|dedup| dedup == key)
}

pub(crate) struct StreamExclusions<'a> {
    keys: HashSet<&'a str>,
    has_legacy_keys: bool,
    resolved_url: Option<reqwest::Url>,
    requests: Mutex<Vec<ProbeRequestIdentity>>,
}

impl<'a> StreamExclusions<'a> {
    pub(crate) fn new(
        excluded_keys: &'a [String],
        failed_key: Option<&'a str>,
        resolved_url: Option<&str>,
    ) -> Self {
        let keys: HashSet<_> = excluded_keys
            .iter()
            .map(String::as_str)
            .chain(failed_key)
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .collect();
        Self {
            has_legacy_keys: keys.iter().any(|key| is_legacy_content_key(key)),
            keys,
            resolved_url: resolved_url
                .filter(|_| failed_key.is_none_or(|key| !is_prepared_stream_key(key.trim())))
                .and_then(crate::providers::addon_resource::parse_fetchable_http_url),
            requests: Mutex::new(Vec::new()),
        }
    }

    fn matches_key(&self, stream: &AddonStream) -> bool {
        self.keys.contains(stream.stream_key.as_str())
            || (self.has_legacy_keys
                && stream_dedup_key(stream).is_some_and(|key| self.keys.contains(key.as_str())))
    }

    pub(crate) fn retain(&self, streams: &mut Vec<AddonStream>) {
        let mut requests = lock_or_recover(&self.requests);
        // Exact keys identify requests; legacy content keys retain their payload-only matching.
        for stream in streams
            .iter()
            .filter(|stream| self.keys.contains(stream.stream_key.as_str()))
        {
            if let Some(request) = ProbeRequestIdentity::from_stream(stream) {
                if !requests.contains(&request) {
                    requests.push(request);
                }
            }
        }
        streams.retain(|stream| {
            if self.matches_key(stream) {
                return false;
            }
            if requests.is_empty() && self.resolved_url.is_none() {
                return true;
            }
            ProbeRequestIdentity::from_stream(stream).is_none_or(|request| {
                !requests.contains(&request)
                    && self.resolved_url.as_ref().is_none_or(|url| {
                        probe_url_identity(url.as_str()) != probe_url_identity(request.url.as_str())
                    })
            })
        });
    }
}

/// Locate the preferred stream in the fetched pool: exact key, then release family,
/// then source identity. Only probeable, non-excluded rows qualify — a key hit on a
/// bad row falls through to softer tiers, which refuse rows whose selection priority
/// trails the pool's best (the exact saved key stays honored). A `source_id` scopes
/// family hits and skips the ambiguous name tier.
fn find_preferred_position(
    streams: &[AddonStream],
    preferred: PreferredStreamHint<'_>,
) -> Option<usize> {
    if preferred.stream_key.is_none()
        && preferred.stream_family.is_none()
        && preferred.source_id.is_none()
        && preferred.source_name.is_none()
    {
        return None;
    }

    if let Some(key) = preferred.stream_key.and_then(normalize_non_empty) {
        if let Some(position) = streams
            .iter()
            .position(|stream| preferred_key_matches(stream, &key) && is_probeable_stream(stream))
        {
            return Some(position);
        }
    }

    let stream_family = preferred.stream_family.and_then(normalize_source_key);
    let source_id = preferred.source_id.and_then(normalize_source_id);
    let source_name = preferred.source_name.and_then(normalize_source_key);

    // Every tier below consults `soft_eligible` — skip the `best_priority` scan
    // when no soft hint exists (recovery always passes a bare hint).
    if stream_family.is_none() && source_id.is_none() && source_name.is_none() {
        return None;
    }

    let probeable: Vec<bool> = streams.iter().map(is_probeable_stream).collect();
    let best_priority = streams
        .iter()
        .enumerate()
        .find(|(index, _)| probeable[*index])
        .and_then(|(_, stream)| stream.selection_priority);
    let soft_eligible = |index: usize, stream: &AddonStream| {
        probeable[index]
            && best_priority.is_none_or(|best| {
                stream
                    .selection_priority
                    .is_some_and(|candidate| candidate.covers(&best))
            })
    };

    // Stored fields compare against already-normalized hints — a trim +
    // case-insensitive compare stands in for re-normalizing each row.
    if let Some(family) = stream_family {
        if let Some(position) = streams.iter().enumerate().position(|(index, stream)| {
            soft_eligible(index, stream)
                && stream
                    .stream_family
                    .as_deref()
                    .is_some_and(|value| value.trim().eq_ignore_ascii_case(&family))
                && source_id.as_deref().is_none_or(|id| {
                    stream
                        .source_id
                        .as_deref()
                        .is_some_and(|value| value.trim() == id)
                })
        }) {
            return Some(position);
        }
    }

    // Instance id before display name — two addons sharing a name make the name tier ambiguous.
    if let Some(source_id) = source_id {
        return streams.iter().enumerate().position(|(index, stream)| {
            soft_eligible(index, stream)
                && stream
                    .source_id
                    .as_deref()
                    .is_some_and(|value| value.trim() == source_id)
        });
    }

    source_name.and_then(|source| {
        streams.iter().enumerate().position(|(index, stream)| {
            soft_eligible(index, stream)
                && stream
                    .source_name
                    .as_deref()
                    .is_some_and(|value| value.trim().eq_ignore_ascii_case(&source))
        })
    })
}

async fn resolve_candidate_results<S>(
    mut candidates: S,
    excluded_resolved_url: Option<&str>,
) -> Result<BestResolvedStream, ResolveStreamError>
where
    S: futures_util::Stream<Item = CandidateProbeResult> + Unpin,
{
    let mut errors = Vec::new();
    let mut rate_limited = false;
    while let Some((candidate, result)) = candidates.next().await {
        let source_name = candidate.source_name.as_deref().unwrap_or("Unknown source");
        match result {
            Ok(Ok(resolved))
                if excluded_resolved_url.is_none_or(|url| {
                    probe_url_identity(url) != probe_url_identity(&resolved.url)
                }) =>
            {
                return Ok(candidate_resolved_stream(candidate, resolved));
            }
            Ok(Ok(_)) => {}
            Ok(Err(error)) => {
                rate_limited |= error.rate_limited;
                push_bounded_error(&mut errors, format!("{source_name}: {}", error.message));
            }
            Err(_) => push_bounded_error(
                &mut errors,
                format!("{source_name} timed out while resolving."),
            ),
        }
    }

    let summary = errors.join(" | ");
    let message = if summary.is_empty() {
        "Unable to resolve a playable stream from the best candidates.".to_string()
    } else {
        format!("Unable to resolve a playable stream from the best candidates. {summary}")
    };
    let kind = if rate_limited {
        ResolveStreamErrorKind::RateLimited
    } else {
        ResolveStreamErrorKind::Failed
    };
    Err(ResolveStreamError::new(kind, message))
}

async fn resolve_probe_candidates<P, F>(
    inputs: Vec<(StreamResolveCandidateInput, Duration)>,
    excluded_stream_key: Option<&str>,
    excluded_resolved_url: Option<&str>,
    deadline: Instant,
    mut started_requests: Option<&mut Vec<ProbeRequestIdentity>>,
    mut probe: P,
) -> Result<BestResolvedStream, ResolveStreamError>
where
    P: FnMut(StreamResolveCandidateInput, Duration, Instant) -> F,
    F: Future<Output = CandidateProbeResult>,
{
    let started = Instant::now();
    let excluded_resolved_url = excluded_resolved_url
        .filter(|_| excluded_stream_key.is_none_or(|key| !is_prepared_stream_key(key.trim())));
    let mut inputs = inputs
        .into_iter()
        .enumerate()
        .map(move |(rank, (candidate, delay))| {
            if let Some(requests) = started_requests.as_deref_mut() {
                let mut headers = candidate.request_headers.clone();
                canonicalize_header_identity(&mut headers);
                requests.push(ProbeRequestIdentity {
                    url: candidate.direct_url.clone(),
                    headers,
                });
            }
            let probe = probe(candidate, delay.saturating_sub(started.elapsed()), deadline);
            async move { (rank, probe.await) }
        });
    let mut pending = FuturesUnordered::new();
    pending.extend(inputs.by_ref().take(BEST_STREAM_PROBE_CONCURRENCY));
    let candidates = stream::unfold(
        (pending, inputs, BTreeMap::new(), 0, false),
        move |(mut pending, mut inputs, mut completed, mut next_rank, mut has_winner)| async move {
            loop {
                if let Some(result) = completed.remove(&next_rank) {
                    next_rank += 1;
                    return Some((result, (pending, inputs, completed, next_rank, has_winner)));
                }
                let (rank, result) = pending.next().await?;
                if matches!(&result.1, Ok(Ok(resolved)) if excluded_resolved_url.is_none_or(|url| {
                    probe_url_identity(url) != probe_url_identity(&resolved.url)
                })) {
                    has_winner = true;
                } else if !has_winner && Instant::now() < deadline {
                    if let Some(next) = inputs.next() {
                        pending.push(next);
                    }
                }
                completed.insert(rank, result);
            }
        },
    );
    resolve_candidate_results(Box::pin(candidates), excluded_resolved_url).await
}

fn build_probe_candidates(
    mut streams: Vec<AddonStream>,
    excluded_stream_key: Option<&str>,
    excluded_resolved_url: Option<&str>,
    preferred: PreferredStreamHint<'_>,
) -> Vec<(StreamResolveCandidateInput, Duration)> {
    let excluded_stream_key = excluded_stream_key.and_then(normalize_non_empty);
    if excluded_stream_key.is_some() || excluded_resolved_url.is_some() {
        StreamExclusions::new(&[], excluded_stream_key.as_deref(), excluded_resolved_url)
            .retain(&mut streams);
    }
    if let Some(position) = find_preferred_position(&streams, preferred) {
        streams[..=position].rotate_right(1);
    }

    let mut candidates: Vec<(StreamResolveCandidateInput, Duration)> =
        Vec::with_capacity(BEST_STREAM_MAX_CANDIDATES);
    let mut header_identities = Vec::with_capacity(BEST_STREAM_MAX_CANDIDATES);
    let mut host_counts = HashMap::<String, u32>::new();
    for candidate in streams.into_iter().filter_map(build_candidate_input) {
        let mut headers = candidate.request_headers.clone();
        canonicalize_header_identity(&mut headers);
        // Equivalent requests share a probe; different auth headers stay separate even on the same URL.
        if candidates
            .iter()
            .zip(&header_identities)
            .any(|((existing, _), existing_headers)| {
                probe_url_identity(existing.direct_url.as_str())
                    == probe_url_identity(candidate.direct_url.as_str())
                    && existing_headers == &headers
            })
        {
            continue;
        }
        let host = candidate
            .direct_url
            .host_str()
            .expect("HTTP candidate has a host");
        let count = host_counts.entry(host.to_string()).or_default();
        let delay = SAME_HOST_PROBE_SPACING * *count;
        *count += 1;
        header_identities.push(headers);
        candidates.push((candidate, delay));
        if candidates.len() == BEST_STREAM_MAX_CANDIDATES {
            break;
        }
    }
    candidates
}

/// Stagger same-host requests within one probe deadline, retaining rank order
/// and cancelling outstanding probes as soon as the first ranked winner lands.
pub(crate) async fn resolve_ranked_best_stream_candidate(
    streams: Vec<AddonStream>,
    excluded_stream_key: Option<&str>,
    excluded_resolved_url: Option<&str>,
    preferred: PreferredStreamHint<'_>,
    deadline: Instant,
    started_requests: Option<&mut Vec<ProbeRequestIdentity>>,
) -> Result<BestResolvedStream, ResolveStreamError> {
    let deadline =
        deadline.min(Instant::now() + Duration::from_secs(BEST_STREAM_CANDIDATE_TIMEOUT_SECS));
    if deadline <= Instant::now() {
        return Err(ResolveStreamError::new(
            ResolveStreamErrorKind::Failed,
            "Stream resolution timed out.",
        ));
    }
    let inputs = build_probe_candidates(
        streams,
        excluded_stream_key,
        excluded_resolved_url,
        preferred,
    );
    let excluded_resolved_url = excluded_resolved_url.and_then(normalize_non_empty);
    resolve_probe_candidates(
        inputs,
        excluded_stream_key,
        excluded_resolved_url.as_deref(),
        deadline,
        started_requests,
        probe_candidate,
    )
    .await
}

#[cfg(test)]
mod tests;
