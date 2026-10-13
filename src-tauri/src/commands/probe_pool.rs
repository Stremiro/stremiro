use super::playback_state::PlaybackStateService;
use super::stream_fetcher::{
    fetch_ranked_streams, resolve_stream_ranking_scope, ResolveFetch, StreamQueryRequest,
    StreamRankingOverrides, StreamRankingScope,
};
use super::stream_resolver::{
    resolve_stream_inner, BestResolvedStream, ProbeError, ResolveStreamError,
    ResolveStreamErrorKind, ResolveStreamParams, ResolvedStream,
};
use super::streaming_helpers::{
    is_legacy_content_key, normalize_http_url, normalize_source_id, normalize_source_key,
    push_bounded_error, stream_absolute_episode_targets, stream_dedup_key,
};
use super::{normalize_media_id, normalize_non_empty, normalize_stream_media_type};
use crate::providers::addons::{
    stream_conflicts_with_episode_targets, AddonStream, AddonTransport,
};
use futures_util::stream::FuturesOrdered;
use futures_util::StreamExt;
use std::collections::HashMap;
use std::time::Duration;
use tauri::AppHandle;

/// Per-probe timeout in the best-stream fan-out — bounded so bad candidates don't chain long failures.
pub(crate) const BEST_STREAM_CANDIDATE_TIMEOUT_SECS: u64 = 10;
pub(crate) const BEST_STREAM_MAX_CANDIDATES: usize = 8;
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
        let id =
            normalize_media_id(id).ok_or_else(|| format!("Media ID is required for {context}."))?;
        let media_type = normalize_stream_media_type(media_type, Some(&id))
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

    /// `fetch_ranked_streams` on this query — rows arrive ingress-filtered and coordinator-ranked.
    pub(crate) async fn fetch_pool(
        &self,
        app: &AppHandle,
        playback_state: &PlaybackStateService,
        provider: &AddonTransport,
        fetch_id: &str,
        resolve: ResolveFetch<'_>,
    ) -> Result<Vec<AddonStream>, String> {
        let (mut streams, is_final_season) = fetch_ranked_streams(
            app,
            playback_state,
            provider,
            &self.request(fetch_id),
            &self.ranking,
            resolve,
        )
        .await?;
        self.retain_episode_candidates(&mut streams, fetch_id, is_final_season);
        Ok(streams)
    }

    fn retain_episode_candidates(
        &self,
        streams: &mut Vec<AddonStream>,
        fetch_id: &str,
        is_final_season: bool,
    ) {
        if self.media_type == "movie" {
            return;
        }
        // Ranking pair usually equals the query pair — dedup so the regex scan
        // doesn't run twice. `is_final_season` was computed for the ranking scope's
        // season; a divergent query season keeps the conservative `false`.
        let mut targets = [
            self.season.zip(self.episode),
            self.ranking.season.zip(self.ranking.episode),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
        targets.extend(
            stream_absolute_episode_targets(
                &self.media_type,
                fetch_id,
                self.season,
                self.episode,
                self.absolute_episode,
            )
            .into_iter()
            .flatten(),
        );
        targets.dedup();
        let final_season_season = if is_final_season {
            self.ranking.season
        } else {
            None
        };
        streams.retain(|stream| {
            !stream_conflicts_with_episode_targets(
                stream.match_texts(),
                &targets,
                final_season_season,
            )
        });
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

/// Serializable probe inputs — no borrowed selector state crosses the concurrency boundary.
struct StreamResolveCandidateInput {
    source_id: Option<String>,
    source_name: Option<String>,
    stream_family: Option<String>,
    stream_key: String,
    direct_url: String,
    request_headers: Vec<(String, String)>,
}

fn build_candidate_input(stream: AddonStream) -> Option<StreamResolveCandidateInput> {
    // Same fetchable gate as ingress: private-literal, userinfo, and non-http(s)
    // URLs never spend a probe. Canonical form stored so the excluded-URL compare
    // matches the normalized recovery URL.
    let direct_url = stream.url.as_deref().and_then(normalize_http_url)?;
    if !crate::providers::addon_resource::is_fetchable_http_url(&direct_url) {
        return None;
    }
    let request_headers = stream.request_headers();
    Some(StreamResolveCandidateInput {
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
        format: resolved.format,
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
    mut candidate: StreamResolveCandidateInput,
    delay: Duration,
    deadline: tokio::time::Instant,
) -> CandidateProbeResult {
    let result = tokio::time::timeout_at(deadline, async {
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        resolve_stream_inner(ResolveStreamParams {
            url: std::mem::take(&mut candidate.direct_url),
            request_headers: std::mem::take(&mut candidate.request_headers),
        })
        .await
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

pub(crate) fn retain_unexcluded_streams(streams: &mut Vec<AddonStream>, excluded_keys: &[String]) {
    if excluded_keys.is_empty() {
        return;
    }
    // A legacy `h:`/`uh:` exclusion binds by recomputing the dedup key once per
    // stream — skipped entirely when no legacy key is present.
    let legacy_keys: Vec<&str> = excluded_keys
        .iter()
        .filter(|key| is_legacy_content_key(key))
        .map(String::as_str)
        .collect();
    streams.retain(|stream| {
        if excluded_keys.contains(&stream.stream_key) {
            return false;
        }
        if legacy_keys.is_empty() {
            return true;
        }
        match stream_dedup_key(stream) {
            Some(dedup) => !legacy_keys.iter().any(|key| *key == dedup),
            None => true,
        }
    });
}

/// Locate the preferred stream in the fetched pool: exact key, then release family,
/// then source identity. Only probeable, non-excluded rows qualify — a key hit on a
/// bad row falls through to softer tiers, which refuse rows whose selection priority
/// trails the pool's best (the exact saved key stays honored). A `source_id` scopes
/// family hits and skips the ambiguous name tier.
fn find_preferred_position(
    streams: &[AddonStream],
    preferred: PreferredStreamHint<'_>,
    excluded_stream_key: Option<&str>,
) -> Option<usize> {
    if preferred.stream_key.is_none()
        && preferred.stream_family.is_none()
        && preferred.source_id.is_none()
        && preferred.source_name.is_none()
    {
        return None;
    }

    // One probeability pass — tier scans would otherwise re-run `is_probeable_stream` per tier.
    let probeable: Vec<bool> = streams.iter().map(is_probeable_stream).collect();
    let eligible = |index: usize, stream: &AddonStream| {
        probeable[index]
            && excluded_stream_key.is_none_or(|key| !preferred_key_matches(stream, key))
    };

    if let Some(key) = preferred.stream_key.and_then(normalize_non_empty) {
        if excluded_stream_key != Some(key.as_str()) {
            if let Some(position) = streams.iter().enumerate().position(|(index, stream)| {
                eligible(index, stream) && preferred_key_matches(stream, &key)
            }) {
                return Some(position);
            }
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

    let best_priority = streams
        .iter()
        .enumerate()
        .find(|(index, stream)| eligible(*index, stream))
        .and_then(|(_, stream)| stream.selection_priority);
    let soft_eligible = |index: usize, stream: &AddonStream| {
        eligible(index, stream)
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
            Ok(Ok(resolved)) if excluded_resolved_url != Some(resolved.url.trim()) => {
                return Ok(candidate_resolved_stream(candidate, resolved));
            }
            Ok(Ok(_)) => {}
            Ok(Err(error)) => {
                rate_limited |= error.rate_limited;
                push_bounded_error(&mut errors, format!("{source_name}: {}", error.message));
            }
            Err(_) => push_bounded_error(
                &mut errors,
                format!("{source_name} timed out after {BEST_STREAM_CANDIDATE_TIMEOUT_SECS}s"),
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

fn build_probe_candidates(
    mut streams: Vec<AddonStream>,
    excluded_stream_key: Option<&str>,
    excluded_resolved_url: Option<&str>,
    preferred: PreferredStreamHint<'_>,
) -> Vec<(StreamResolveCandidateInput, Duration)> {
    let excluded_stream_key = excluded_stream_key.and_then(normalize_non_empty);
    let excluded_resolved_url = excluded_resolved_url.and_then(normalize_non_empty);
    if let Some(position) =
        find_preferred_position(&streams, preferred, excluded_stream_key.as_deref())
    {
        streams[..=position].rotate_right(1);
    }

    let mut candidates: Vec<(StreamResolveCandidateInput, Duration)> =
        Vec::with_capacity(BEST_STREAM_MAX_CANDIDATES);
    let mut host_counts = HashMap::<String, u32>::new();
    for candidate in streams
        .into_iter()
        .filter(|stream| {
            excluded_stream_key
                .as_deref()
                .is_none_or(|key| !preferred_key_matches(stream, key))
        })
        .filter_map(build_candidate_input)
        .filter(|candidate| {
            excluded_resolved_url
                .as_deref()
                .is_none_or(|url| url != candidate.direct_url)
        })
    {
        // Equivalent requests share a probe; different auth headers stay separate even on the same URL.
        if candidates.iter().any(|(existing, _)| {
            existing.direct_url == candidate.direct_url
                && existing.request_headers == candidate.request_headers
        }) {
            continue;
        }
        let url = reqwest::Url::parse(&candidate.direct_url).expect("candidate URL was validated");
        let host = url.host_str().expect("HTTP candidate has a host");
        let count = host_counts.entry(host.to_string()).or_default();
        let delay = SAME_HOST_PROBE_SPACING * *count;
        *count += 1;
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
) -> Result<BestResolvedStream, ResolveStreamError> {
    let inputs = build_probe_candidates(
        streams,
        excluded_stream_key,
        excluded_resolved_url,
        preferred,
    );
    let deadline =
        tokio::time::Instant::now() + Duration::from_secs(BEST_STREAM_CANDIDATE_TIMEOUT_SECS);
    let candidates: FuturesOrdered<_> = inputs
        .into_iter()
        .map(|(candidate, delay)| probe_candidate(candidate, delay, deadline))
        .collect();
    let excluded_resolved_url = excluded_resolved_url.and_then(normalize_non_empty);
    resolve_candidate_results(candidates, excluded_resolved_url.as_deref()).await
}

#[cfg(test)]
mod tests;
