use super::{
    addon_registry::SourcedAddonSubtitle,
    episode_navigation::{build_source_episode_coordinates, SourceEpisodeCoordinates},
    media_normalization::{build_release_date, normalize_media_details},
    normalize_media_id, normalize_stream_media_type, normalize_watch_progress_type,
    playback_state::{PlaybackEpisodeMappingSnapshot, PlaybackStateService},
};
use crate::providers::{addon_resource::AddonResourceClient, push_unique, Episode, MediaDetails};
use futures_util::stream::{self, StreamExt};
use std::collections::HashMap;
use std::time::Duration;
use tauri::{command, AppHandle, State};

const MEDIA_SCHEDULE_FETCH_CONCURRENCY_LIMIT: usize = 6;
// Per-burst bound on schedule fetches: every item fans out to a full meta
// fetch (up to `MAX_CATALOG_SOURCES` sources), so one burst stays finite.
// Requests past the bound are served by sequential bursts — same
// instantaneous fan-out, no silently dropped titles.
const MEDIA_SCHEDULE_MAX_ITEMS: usize = 200;
// Overall batch deadline: with no cap, a few stalled hosts (each up to the
// provider client timeout) serialize into minutes of fetch time. On expiry
// the results already collected are returned instead of failing the page.
const MEDIA_SCHEDULE_FETCH_DEADLINE: Duration = Duration::from_secs(90);

// Internal-only: the history-playback planner consumes this in-process; no
// command returns it, so it carries no IPC derives.
#[derive(Debug)]
pub struct EpisodeStreamMapping {
    pub lookup_id: String,
    pub canonical_season: u32,
    pub canonical_episode: u32,
    pub source_season: u32,
    pub source_episode: u32,
}

impl From<PlaybackEpisodeMappingSnapshot> for EpisodeStreamMapping {
    fn from(value: PlaybackEpisodeMappingSnapshot) -> Self {
        Self {
            lookup_id: value.source_lookup_id,
            canonical_season: value.canonical_season,
            canonical_episode: value.canonical_episode,
            source_season: value.source_season,
            source_episode: value.source_episode,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MediaScheduleEpisode {
    pub id: String,
    pub title: Option<String>,
    pub season: u32,
    pub episode: u32,
    /// None for undated or invalid dates: the calendar skips them, but Up
    /// Next must still see the episode so it never skips past it.
    pub release_date: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MediaSchedule {
    pub id: String,
    pub type_: String,
    pub title: String,
    pub poster: Option<String>,
    pub release_date: Option<String>,
    pub episodes: Vec<MediaScheduleEpisode>,
}

#[derive(Debug)]
pub(crate) struct MediaScheduleRequest {
    pub media_type: String,
    pub id: String,
}

fn schedule_episode_release_date(episode: &Episode) -> Option<String> {
    episode
        .release_date
        .clone()
        .or_else(|| build_release_date(episode.released.as_deref()))
}

pub(crate) fn build_media_schedule(mut details: MediaDetails) -> MediaSchedule {
    let mut episodes = details
        .episodes
        .take()
        .unwrap_or_default()
        .into_iter()
        .map(|episode| MediaScheduleEpisode {
            release_date: schedule_episode_release_date(&episode),
            id: episode.id,
            title: episode.title,
            season: episode.season,
            episode: episode.episode,
        })
        .collect::<Vec<_>>();

    // Dated episodes first so duplicate ids resolve to a dated claimant.
    episodes.sort_by(|left, right| {
        (left.release_date.is_none(), &left.release_date)
            .cmp(&(right.release_date.is_none(), &right.release_date))
            .then_with(|| left.season.cmp(&right.season))
            .then_with(|| left.episode.cmp(&right.episode))
            .then_with(|| left.id.cmp(&right.id))
    });

    MediaSchedule {
        id: details.id,
        type_: details.type_,
        title: details.title,
        poster: details.poster,
        release_date: details.release_date,
        episodes,
    }
}

async fn fetch_media_schedule_inner(
    app: &AppHandle,
    client: &AddonResourceClient,
    media_type: &str,
    id: &str,
) -> Result<MediaSchedule, String> {
    let include_episodes = media_type != "movie";

    Ok(build_media_schedule(
        fetch_media_details_inner(app, client, media_type, id, include_episodes).await?,
    ))
}

fn source_coordinates_from_mapping(
    mapping: PlaybackEpisodeMappingSnapshot,
) -> SourceEpisodeCoordinates {
    SourceEpisodeCoordinates {
        lookup_id: mapping.source_lookup_id,
        season: mapping.source_season,
        episode: mapping.source_episode,
    }
}

/// Cache episode-coordinate mappings and enrich stream targets in one
/// blocking-pool round-trip. The cache pass returns the snapshots it
/// resolved, so enrichment applies them directly instead of re-reading the
/// store once per episode.
pub(crate) async fn cache_and_enrich_episode_targets(
    app: &AppHandle,
    playback_state: &PlaybackStateService,
    media_type: &str,
    media_id: &str,
    fallback_lookup_id: &str,
    mut episodes: Vec<Episode>,
) -> Result<Vec<Episode>, String> {
    let app_owned = app.clone();
    let service = playback_state.clone();
    let media_type_owned = media_type.to_string();
    let media_id_owned = media_id.to_string();
    let fallback_owned = fallback_lookup_id.to_string();
    super::run_blocking_store_op(move || {
        let snapshots = match service.cache_episode_mappings(
            &app_owned,
            &media_type_owned,
            &media_id_owned,
            Some(fallback_owned.as_str()),
            &episodes,
        ) {
            Ok(snapshots) => snapshots,
            // A mapping-store failure degrades to payload-derived targets
            // (the `None` arm below): the details payload stays servable
            // and streams still resolve.
            Err(_error) => {
                #[cfg(debug_assertions)]
                eprintln!("Episode mapping cache failed: {_error}");
                None
            }
        };
        match snapshots {
            Some(snapshots) => {
                for (episode, snapshot) in episodes.iter_mut().zip(snapshots) {
                    let source = source_coordinates_from_mapping(snapshot);
                    episode.stream_lookup_id = Some(source.lookup_id);
                    episode.stream_season = Some(source.season);
                    episode.stream_episode = Some(source.episode);
                }
            }
            // Scope inputs failed normalization: no stored mapping can exist,
            // so enrich straight from the episode payload.
            None => {
                for episode in episodes.iter_mut() {
                    let source = build_source_episode_coordinates(episode, &fallback_owned);
                    episode.stream_lookup_id = Some(source.lookup_id);
                    episode.stream_season = Some(source.season);
                    episode.stream_episode = Some(source.episode);
                }
            }
        }
        Ok(episodes)
    })
    .await
}

pub(crate) async fn fetch_media_details_inner(
    app: &AppHandle,
    client: &AddonResourceClient,
    media_type: &str,
    id: &str,
    include_episodes: bool,
) -> Result<MediaDetails, String> {
    // Same canonical fold as watch progress: Cinemeta serves anime under
    // `series`, so one mapping owns both.
    let media_type = normalize_watch_progress_type(media_type)
        .ok_or_else(|| "Invalid media type. Expected movie or series.".to_string())?
        .to_string();
    super::addon_registry::fetch_meta_details(app, client, &media_type, id, include_episodes)
        .await
        .map(|details| normalize_media_details(details, id))
}

#[command]
pub async fn get_media_details(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    client: State<'_, AddonResourceClient>,
    media_type: String,
    id: String,
    include_episodes: Option<bool>,
) -> Result<MediaDetails, String> {
    let id = normalize_media_id(&id).ok_or_else(|| "Media ID is required.".to_string())?;
    let media_type = normalize_stream_media_type(&media_type, Some(&id))
        .ok_or_else(|| "Invalid media type for details lookup.".to_string())?
        .to_string();
    let include_episodes = include_episodes.unwrap_or(true);

    let mut details =
        fetch_media_details_inner(&app, &client, &media_type, &id, include_episodes).await?;

    if let Some(episodes) = details.episodes.as_mut().map(std::mem::take) {
        let fallback_lookup_id = details
            .imdb_id
            .as_deref()
            .unwrap_or(id.as_str())
            .to_string();
        details.episodes = Some(
            cache_and_enrich_episode_targets(
                &app,
                playback_state.inner(),
                &media_type,
                &id,
                &fallback_lookup_id,
                episodes,
            )
            .await?,
        );
    }

    Ok(details)
}

#[command]
pub async fn get_addon_subtitles(
    app: AppHandle,
    client: State<'_, AddonResourceClient>,
    media_type: String,
    id: String,
    season: Option<u32>,
    episode: Option<u32>,
) -> Result<Vec<SourcedAddonSubtitle>, String> {
    let id = normalize_media_id(&id).ok_or_else(|| "Media ID is required.".to_string())?;
    let media_type = normalize_stream_media_type(&media_type, Some(&id))
        .ok_or_else(|| "Invalid media type for subtitle lookup.".to_string())?
        .to_string();
    // Subtitle IDs follow stream IDs; anime resolves through series episodes.
    let effective_type = super::media_type::addon_episode_lookup_type(&media_type);
    let lookup_id = match (season, episode) {
        (Some(season), Some(episode)) if effective_type != "movie" => {
            format!("{id}:{season}:{episode}")
        }
        _ => id,
    };

    super::addon_registry::fetch_addon_subtitles(&app, &client, effective_type, &lookup_id).await
}

pub(crate) async fn fetch_media_schedules(
    app: &AppHandle,
    client: &AddonResourceClient,
    items: Vec<MediaScheduleRequest>,
) -> Result<Vec<MediaSchedule>, String> {
    // Dedupe fetches on the canonical key, but remember every caller's raw
    // type per fetch: the frontend indexes results by its own request pair,
    // and a `series` request with a kitsu id normalizes to `anime` here — so
    // one canonical fetch must echo one schedule per raw requester.
    let mut fetch_index_by_key: HashMap<String, usize> = HashMap::new();
    let mut normalized_requests: Vec<(Vec<String>, String, String)> =
        Vec::with_capacity(items.len());

    for item in items {
        // A single malformed id in the library/history batch must not blank the
        // whole schedule view — drop the row and keep the rest.
        let Some(id) = normalize_media_id(&item.id) else {
            continue;
        };
        let Some(media_type) = normalize_stream_media_type(&item.media_type, Some(&id)) else {
            continue;
        };
        let request_key = format!("{media_type}:{id}");
        let request_type = item.media_type.trim().to_string();

        if let Some(&index) = fetch_index_by_key.get(&request_key) {
            // One echo per distinct raw spelling — identical repeats of the
            // same request pair would only clone+push a duplicate row.
            push_unique(&mut normalized_requests[index].0, &request_type);
            continue;
        }

        fetch_index_by_key.insert(request_key, normalized_requests.len());
        normalized_requests.push((vec![request_type], media_type.to_string(), id));
    }

    if normalized_requests.is_empty() {
        return Ok(Vec::new());
    }

    let mut schedules = Vec::new();
    let mut errors = Vec::new();

    // Sequential bursts of MEDIA_SCHEDULE_MAX_ITEMS serve the whole
    // request while keeping instantaneous fan-out bounded — the constants
    // above own the rationale.
    let mut requests = normalized_requests.into_iter();
    while requests.len() > 0 {
        let chunk: Vec<_> = requests.by_ref().take(MEDIA_SCHEDULE_MAX_ITEMS).collect();

        let mut pending = stream::iter(chunk.into_iter().enumerate().map(
            |(index, (request_types, media_type, id))| {
                let app = app.clone();
                async move {
                    let outcome = fetch_media_schedule_inner(&app, client, &media_type, &id).await;

                    (index, request_types, outcome)
                }
            },
        ))
        .buffer_unordered(MEDIA_SCHEDULE_FETCH_CONCURRENCY_LIMIT);

        // Collect incrementally under a per-burst deadline so a few stalled
        // hosts return partial results instead of pinning the calendar view
        // for the full per-request timeout chain; the next burst still runs.
        let deadline = tokio::time::sleep(MEDIA_SCHEDULE_FETCH_DEADLINE);
        tokio::pin!(deadline);
        let mut outcomes = Vec::new();
        loop {
            tokio::select! {
                _ = &mut deadline => {
                    if errors.len() < 3 {
                        errors.push("Schedule metadata requests timed out. Please try again.".to_string());
                    }
                    break;
                },
                next = pending.next() => {
                    let Some(outcome) = next else { break };
                    outcomes.push(outcome);
                }
            }
        }
        outcomes.sort_by_key(|(index, _, _)| *index);

        for (_, mut request_types, outcome) in outcomes {
            match outcome {
                Ok(mut schedule) => {
                    // Echo each caller's type, not the normalized fetch type.
                    // The fetched schedule moves into the final echo; only
                    // earlier aliases pay a clone.
                    if let Some(last_type) = request_types.pop() {
                        for request_type in request_types {
                            let mut echo = schedule.clone();
                            echo.type_ = request_type;
                            schedules.push(echo);
                        }
                        schedule.type_ = last_type;
                        schedules.push(schedule);
                    }
                }
                Err(error) => {
                    if errors.len() < 3 {
                        errors.push(error);
                    }
                }
            }
        }
    }

    if schedules.is_empty() && !errors.is_empty() {
        return Err(errors.join(" | "));
    }

    Ok(schedules)
}

pub(crate) async fn resolve_episode_stream_mapping_inner(
    app: AppHandle,
    playback_state: &PlaybackStateService,
    client: &AddonResourceClient,
    media_type: &str,
    id: &str,
    canonical_season: u32,
    canonical_episode: u32,
) -> Result<Option<EpisodeStreamMapping>, String> {
    let id = normalize_media_id(id).ok_or_else(|| "Media ID is required.".to_string())?;
    let media_type = normalize_stream_media_type(media_type, Some(&id))
        .ok_or_else(|| "Invalid media type for episode mapping lookup.".to_string())?
        .to_string();

    if media_type == "movie" {
        return Ok(None);
    }

    // Single point read off the async worker.
    let cached = {
        let app_owned = app.clone();
        let service = playback_state.clone();
        let media_type_owned = media_type.clone();
        let id_owned = id.clone();
        super::run_blocking_store_op(move || {
            service.get_episode_mapping(
                &app_owned,
                &media_type_owned,
                &id_owned,
                canonical_season,
                canonical_episode,
            )
        })
        .await?
    };
    if let Some(mapping) = cached {
        return Ok(Some(mapping.into()));
    }

    let mut details = fetch_media_details_inner(&app, client, &media_type, &id, true).await?;

    if let Some(episodes) = details.episodes.take() {
        let fallback_lookup_id = details
            .imdb_id
            .as_deref()
            .unwrap_or(id.as_str())
            .to_string();
        let app_owned = app.clone();
        let service = playback_state.clone();
        let media_type_owned = media_type.clone();
        let id_owned = id.clone();
        let snapshots = super::run_blocking_store_op(move || {
            service.cache_episode_mappings(
                &app_owned,
                &media_type_owned,
                &id_owned,
                Some(fallback_lookup_id.as_str()),
                &episodes,
            )
        })
        .await?;
        if let Some(mapping) = snapshots.and_then(|snapshots| {
            snapshots.into_iter().find(|snapshot| {
                snapshot.canonical_season == canonical_season
                    && snapshot.canonical_episode == canonical_episode
            })
        }) {
            return Ok(Some(mapping.into()));
        }
    }

    // A persisted mapping was already checked before the details fetch, and
    // `cache_episode_mappings` returned snapshots for every current episode —
    // nothing between the two can have produced a row for this coordinate.
    Ok(None)
}

#[cfg(test)]
mod tests;
