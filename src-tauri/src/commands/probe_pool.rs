use super::playback_state::PlaybackStateService;
use super::stream_fetcher::{
    fetch_ranked_streams, resolve_stream_ranking_scope, StreamQueryRequest, StreamRankingOverrides,
    StreamRankingScope,
};
use super::stream_resolver::{
    is_unresolvable_source_error, missing_direct_url_message, resolve_stream_inner,
    BestResolvedStream, ResolveStreamParams, ResolvedStream,
};
use super::streaming_helpers::{
    is_legacy_content_key, normalize_http_url, normalize_source_id, normalize_source_key,
    stream_dedup_key,
};
use super::{normalize_media_id, normalize_non_empty, normalize_stream_media_type};
use crate::providers::addons::{
    stream_conflicts_with_episode_targets, AddonStream, AddonTransport,
};
use futures_util::stream::FuturesOrdered;
use futures_util::StreamExt;
use std::time::Duration;
use tauri::AppHandle;

/// Timeout for each probe in the best-stream fan-out. Candidates resolve
/// direct addon URLs only, but keeping the window bounded avoids long
/// failure chains when multiple candidates are bad.
pub(crate) const BEST_STREAM_CANDIDATE_TIMEOUT_SECS: u64 = 10;
pub(crate) const BEST_STREAM_MAX_CANDIDATES: usize = 8;

/// Normalized stream-command inputs: validated media identity plus the
/// resolved ranking scope. All three stream commands
/// (`get_stream_selector_data`, `resolve_best_stream`,
/// `recover_playback_stream`) normalize id/type, resolve ranking, and
/// fetch the ranked pool the same way — this is that one path.
pub(crate) struct StreamPoolQuery {
    pub media_type: String,
    pub id: String,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub absolute_episode: Option<u32>,
    pub ranking: StreamRankingScope,
}

impl StreamPoolQuery {
    /// `normalize_media_id` → `normalize_stream_media_type` →
    /// `resolve_stream_ranking_scope`. `context` labels the validation
    /// errors ("stream lookup", "stream recovery").
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

    /// The outbound fetch request. `fetch_id` is normally `self.id`;
    /// recovery passes the addon-indexed lookup id on mapped titles.
    pub(crate) fn request<'a>(&'a self, fetch_id: &'a str) -> StreamQueryRequest<'a> {
        StreamQueryRequest {
            media_type: &self.media_type,
            id: fetch_id,
            season: self.season,
            episode: self.episode,
            absolute_episode: self.absolute_episode,
        }
    }

    /// `fetch_ranked_streams` on this query. Rows arrive ingress-filtered
    /// (`prepare_addon_streams`) and coordinator-ranked.
    pub(crate) async fn fetch_pool(
        &self,
        app: &AppHandle,
        playback_state: &PlaybackStateService,
        provider: &AddonTransport,
        fetch_id: &str,
    ) -> Result<Vec<AddonStream>, String> {
        let (mut streams, is_final_season) = fetch_ranked_streams(
            app,
            playback_state,
            provider,
            &self.request(fetch_id),
            &self.ranking,
        )
        .await?;
        self.retain_episode_candidates(&mut streams, is_final_season);
        Ok(streams)
    }

    fn retain_episode_candidates(&self, streams: &mut Vec<AddonStream>, is_final_season: bool) {
        if self.media_type == "movie" {
            return;
        }
        // The ranking pair equals the query pair whenever no overrides were
        // passed (the common resolve/recovery path) — dedup so the regex
        // scan doesn't run twice per stream. `is_final_season` was computed
        // for the ranking scope's season; a divergent query season keeps the
        // conservative `false`.
        let mut targets = [
            self.season.zip(self.episode),
            self.ranking.season.zip(self.ranking.episode),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
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

/// One fetchable-URL gate for every probe path: candidate extraction, the
/// preferred-position scan, and the resolve pool's retain pass all use it,
/// so a row that cannot spend a probe never slips into the fan-out.
pub(crate) fn is_probeable_stream(stream: &AddonStream) -> bool {
    stream
        .url
        .as_deref()
        .is_some_and(crate::providers::addon_resource::is_fetchable_http_url)
}

/// Derive serializable probe inputs from a ranked stream before spawning
/// probes, so no borrowed selector state crosses the concurrency boundary.
struct StreamResolveCandidateInput {
    source_id: Option<String>,
    source_name: Option<String>,
    stream_family: Option<String>,
    stream_key: String,
    direct_url: String,
    request_headers: Vec<(String, String)>,
}

fn build_candidate_input(stream: &AddonStream) -> Option<StreamResolveCandidateInput> {
    // Same fetchable gate as stream ingress plus the probe: private-literal,
    // userinfo, and non-http(s) URLs never spend a probe task. The canonical
    // form is stored so the excluded-URL compare below matches the
    // normalized recovery URL (raw `HTTPS://X` vs canonical `https://x/`).
    let direct_url = stream.url.as_deref().and_then(normalize_http_url)?;
    if !crate::providers::addon_resource::is_fetchable_http_url(&direct_url) {
        return None;
    }
    Some(StreamResolveCandidateInput {
        source_id: stream.source_id.clone(),
        source_name: stream.source_name.clone(),
        stream_family: stream.stream_family.clone(),
        stream_key: stream.stream_key.clone(),
        direct_url,
        request_headers: stream.request_headers(),
    })
}

fn candidate_resolved_stream(
    candidate: &StreamResolveCandidateInput,
    resolved: ResolvedStream,
) -> BestResolvedStream {
    BestResolvedStream {
        url: resolved.url,
        format: resolved.format,
        source_id: candidate.source_id.clone(),
        source_name: candidate.source_name.clone(),
        stream_family: candidate.stream_family.clone(),
        stream_key: Some(candidate.stream_key.clone()),
        // Bounded at extraction; in-memory only, never logged.
        request_headers: resolved.request_headers,
    }
}

type CandidateProbeResult = (
    StreamResolveCandidateInput,
    Result<Result<ResolvedStream, String>, tokio::time::error::Elapsed>,
);

async fn probe_candidate(candidate: StreamResolveCandidateInput) -> CandidateProbeResult {
    let result = tokio::time::timeout(
        Duration::from_secs(BEST_STREAM_CANDIDATE_TIMEOUT_SECS),
        resolve_stream_inner(ResolveStreamParams {
            url: Some(candidate.direct_url.clone()),
            request_headers: candidate.request_headers.clone(),
        }),
    )
    .await;

    (candidate, result)
}

/// Callers only invoke this with a non-empty source list.
fn unresolvable_sources_message(sources: &mut Vec<String>) -> String {
    sources.sort();
    sources.dedup();
    format!(
        "{} Affected sources: {}.",
        missing_direct_url_message(),
        sources.join(", ")
    )
}

/// The caller's preferred stream identity: the exact stream key when it
/// survives, else the saved source/family. A saved `s:` key (fresh rows) or
/// `h:`/`uh:` key (legacy rows) names the same stream both ways — see
/// `preferred_key_matches`. Signed URLs re-digest across sessions, so a
/// URL-derived key rots even when the same stream is still listed — the
/// source/family fallback recovers that case. `source_id` (the stable addon
/// instance) beats `source_name`, which duplicate display names make
/// ambiguous.
#[derive(Clone, Copy, Default)]
pub(crate) struct PreferredStreamHint<'a> {
    pub stream_key: Option<&'a str>,
    pub source_id: Option<&'a str>,
    pub source_name: Option<&'a str>,
    pub stream_family: Option<&'a str>,
}

/// A preferred key arrives in two forms: current rows persist the prepared
/// `s:{hash}` selector key, while rows written before prepared keys persist
/// the raw `h:`/`uh:` content-dedup key the selector used to carry. Match
/// either so legacy rows still bind to the exact stream; the dedup-key
/// recompute is paid only on the legacy prefixes, never per `s:` row.
fn preferred_key_matches(stream: &AddonStream, key: &str) -> bool {
    if stream.stream_key == key {
        return true;
    }
    is_legacy_content_key(key) && stream_dedup_key(stream).is_some_and(|dedup| dedup == key)
}

/// Locate the preferred stream in the freshly fetched pool: exact key first,
/// then release family, then source identity. Each fallback is weaker, so a
/// key hit never consults the fuzzier tiers. Only probeable, non-excluded
/// rows qualify — a key hit on a stream with no direct URL (e.g. a saved
/// `h:` torrent key) or a row matching the excluded stream must fall through
/// to the softer tiers instead of dead-ending. The soft tiers additionally
/// refuse a row whose coordinator selection priority trails the pool's
/// best, so a stale family/source hint cannot jump past better episode,
/// title, viability, or language matches; the exact saved key stays
/// honored regardless. When a `source_id` is supplied, family hits must
/// come from that same instance and a missed id never falls through to the
/// display-name tier: duplicate addon names make it ambiguous.
fn find_preferred_position(
    streams: &[AddonStream],
    preferred: PreferredStreamHint<'_>,
    excluded_stream_key: Option<&str>,
) -> Option<usize> {
    // One probeability pass: each tier scan below would otherwise re-run
    // `is_probeable_stream` (a URL parse) per stream per tier.
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

    // Every tier below consults `soft_eligible` — when no soft hint exists
    // the probeable-scan for `best_priority` would be computed and discarded
    // (recovery always passes a bare `PreferredStreamHint::default()`).
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
                stream.selection_priority.is_some_and(|candidate| {
                    candidate.0 >= best.0
                        && candidate.1 >= best.1
                        && candidate.2 >= best.2
                        && candidate.3 >= best.3
                        && candidate.4 >= best.4
                })
            })
    };

    // Stored fields are compared against the already-normalized hints, so a
    // trim + case-insensitive compare stands in for re-normalizing each row
    // (equal strings can't exceed the normalizer's length bound).
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

    // Instance id before display name: two addons sharing a name make the
    // name tier ambiguous, while the id names exactly one instance.
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

fn note_candidate_failure(
    candidate: &StreamResolveCandidateInput,
    error: &str,
    unresolvable_requirement_sources: &mut Vec<String>,
    errors: &mut Vec<String>,
) {
    let source_name = candidate.source_name.as_deref().unwrap_or("Unknown source");
    if is_unresolvable_source_error(error) {
        unresolvable_requirement_sources.push(source_name.to_string());
    } else {
        errors.push(format!("{source_name}: {error}"));
    }
}

async fn resolve_candidate_results<S>(
    mut candidates: S,
    excluded_resolved_url: Option<&str>,
) -> Result<BestResolvedStream, String>
where
    S: futures_util::Stream<Item = CandidateProbeResult> + Unpin,
{
    let mut errors = Vec::new();
    let mut unresolvable_requirement_sources = Vec::new();
    while let Some((candidate, result)) = candidates.next().await {
        match result {
            Ok(Ok(resolved)) if excluded_resolved_url != Some(resolved.url.trim()) => {
                return Ok(candidate_resolved_stream(&candidate, resolved));
            }
            Ok(Ok(_)) => {}
            Ok(Err(error)) => note_candidate_failure(
                &candidate,
                &error,
                &mut unresolvable_requirement_sources,
                &mut errors,
            ),
            Err(_) => {
                let source_name = candidate.source_name.as_deref().unwrap_or("Unknown source");
                errors.push(format!(
                    "{} timed out after {}s",
                    source_name, BEST_STREAM_CANDIDATE_TIMEOUT_SECS
                ));
            }
        }
    }

    if !unresolvable_requirement_sources.is_empty() && errors.is_empty() {
        return Err(unresolvable_sources_message(
            &mut unresolvable_requirement_sources,
        ));
    }

    let summary = errors.into_iter().take(3).collect::<Vec<_>>().join(" | ");
    if !unresolvable_requirement_sources.is_empty() {
        // The guard above already returned when only unresolvable failures
        // exist — `errors` (and so `summary`) is non-empty past it.
        return Err(format!(
            "{} Also failed to resolve other candidates: {}",
            missing_direct_url_message(),
            summary
        ));
    }

    Err(if summary.is_empty() {
        "Unable to resolve a playable stream from the best candidates.".to_string()
    } else {
        format!(
            "Unable to resolve a playable stream from the best candidates. {}",
            summary
        )
    })
}

/// Fan out candidates concurrently with a shared per-candidate timeout and
/// consume the results in rank order: the first resolved winner in ranking
/// order is returned and the queued probe futures are dropped once it
/// lands. The preferred probe leads the order so the user's prior stream is
/// the first result considered.
pub(crate) async fn resolve_ranked_best_stream_candidate(
    mut streams: Vec<AddonStream>,
    excluded_stream_key: Option<&str>,
    excluded_resolved_url: Option<&str>,
    preferred: PreferredStreamHint<'_>,
) -> Result<BestResolvedStream, String> {
    let excluded_stream_key = excluded_stream_key.and_then(normalize_non_empty);
    let excluded_resolved_url = excluded_resolved_url.and_then(normalize_non_empty);
    let mut candidates = FuturesOrdered::new();

    if let Some(position) =
        find_preferred_position(&streams, preferred, excluded_stream_key.as_deref())
    {
        let preferred_stream = streams.remove(position);
        // `find_preferred_position` only returns `is_probeable_stream` rows —
        // the same fetchable-URL gate `build_candidate_input` applies — so a
        // found position always yields a candidate; only the excluded-URL
        // check can skip it.
        if let Some(candidate) = build_candidate_input(&preferred_stream) {
            if excluded_resolved_url.as_deref() != Some(candidate.direct_url.as_str()) {
                // The user's prior/picked stream: its probe heads the ordered
                // results, so a resolvable preferred stream always wins over
                // pooled candidates regardless of which settles first.
                candidates.push_back(probe_candidate(candidate));
            }
        }
    }

    // The fetchable gate and exclusions run before the cap so a dead row
    // cannot consume one of the probe slots.
    for candidate in streams
        .into_iter()
        .filter(|stream| {
            excluded_stream_key
                .as_deref()
                .is_none_or(|key| !preferred_key_matches(stream, key))
        })
        .filter_map(|stream| build_candidate_input(&stream))
        .filter(|candidate| {
            excluded_resolved_url
                .as_deref()
                .is_none_or(|url| url != candidate.direct_url)
        })
        .take(BEST_STREAM_MAX_CANDIDATES)
    {
        candidates.push_back(probe_candidate(candidate));
    }

    resolve_candidate_results(candidates, excluded_resolved_url.as_deref()).await
}

#[cfg(test)]
mod tests;
