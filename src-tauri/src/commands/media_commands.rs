use super::{
    addon_registry::SourcedAddonSubtitle,
    episode_navigation::build_source_episode_coordinates,
    js_trim,
    media_normalization::with_requested_media_id,
    normalize_media_id, normalize_stream_media_type, normalize_watch_progress_type,
    playback_state::{PlaybackEpisodeMappingSnapshot, PlaybackStateService},
    streaming_helpers::{build_stream_query_ids, push_bounded_error},
    watch_history_commands::{
        build_title_watch_progress_with_priorities, load_entries_with_source_health,
        TitleWatchProgress,
    },
    JS_WHITESPACE,
};
use crate::operational_log::{field, log_warn};
use crate::providers::{
    addon_resource::{meta_for_shape, AddonResourceClient},
    push_unique, Episode, MediaDetails,
};
use futures_util::stream::{self, StreamExt};
use regex::Regex;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tauri::{command, AppHandle, Manager, State};

const MEDIA_SCHEDULE_FETCH_CONCURRENCY_LIMIT: usize = 6;
// Per-burst bound on schedule fetches — every item fans out to a full meta fetch.
// Requests past the bound are served by sequential bursts; nothing is dropped.
const MEDIA_SCHEDULE_MAX_ITEMS: usize = 200;
// Overall batch deadline — uncapped, stalled hosts serialize into minutes.
// On expiry the collected results return instead of failing the page.
const MEDIA_SCHEDULE_FETCH_DEADLINE: Duration = Duration::from_secs(90);

const EPISODE_SEARCH_MAX_EPISODES: usize = 2_000;
const EPISODE_SEARCH_MAX_CHARS: usize = 4_096;
static EPISODE_SEARCH_COORDINATES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^(?:s([0-9]+)[{space}]*e([0-9]+)|([0-9]+)[{space}]*x[{space}]*([0-9]+)|(?:e|ep|episode)[{space}]*([0-9]+))\z",
        space = JS_WHITESPACE,
    ))
    .expect("valid episode search regex")
});

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EpisodeSearchFields {
    season: u32,
    episode: u32,
    title: Option<String>,
    overview: Option<String>,
}

fn episode_search_indices(query: &str, episodes: &[EpisodeSearchFields]) -> Vec<u32> {
    let query = js_trim(query).to_lowercase();
    if query.is_empty() {
        return (0..episodes.len() as u32).collect();
    }
    let coordinates = EPISODE_SEARCH_COORDINATES
        .captures(&query)
        .and_then(|captures| {
            if let Some(episode) = captures.get(5) {
                return episode
                    .as_str()
                    .parse::<u32>()
                    .ok()
                    .map(|episode| (None, episode));
            }
            let season = captures
                .get(1)
                .or_else(|| captures.get(3))?
                .as_str()
                .parse::<u32>()
                .ok()?;
            let episode = captures
                .get(2)
                .or_else(|| captures.get(4))?
                .as_str()
                .parse::<u32>()
                .ok()?;
            Some((Some(season), episode))
        });
    let numeric_query = query.bytes().all(|byte| byte.is_ascii_digit());
    episodes
        .iter()
        .enumerate()
        .filter_map(|(index, episode)| {
            (coordinates.is_some_and(|(season, number)| {
                episode.episode == number && season.is_none_or(|season| episode.season == season)
            }) || (numeric_query && episode.episode.to_string().contains(&query))
                || episode
                    .title
                    .as_ref()
                    .is_some_and(|title| title.to_lowercase().contains(&query))
                || episode
                    .overview
                    .as_ref()
                    .is_some_and(|overview| overview.to_lowercase().contains(&query)))
            .then_some(index as u32)
        })
        .collect()
}

#[command]
pub fn search_episodes(
    query: String,
    episodes: Vec<EpisodeSearchFields>,
) -> Result<Vec<u32>, String> {
    if episodes.len() > EPISODE_SEARCH_MAX_EPISODES {
        return Err("Too many episodes.".to_string());
    }
    if query.chars().nth(EPISODE_SEARCH_MAX_CHARS).is_some() {
        return Err("Episode search query is too long.".to_string());
    }
    Ok(episode_search_indices(&query, &episodes))
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

pub(crate) fn build_media_schedule(
    details: &MediaDetails,
    requested_id: &str,
    include_episodes: bool,
) -> MediaSchedule {
    let mut episodes = details
        .episodes
        .as_deref()
        .filter(|_| include_episodes)
        .into_iter()
        .flatten()
        .map(|episode| MediaScheduleEpisode {
            release_date: episode.release_date.clone(),
            id: episode.id.clone(),
            title: episode.title.clone(),
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
        id: requested_id.to_string(),
        type_: details.type_.clone(),
        title: details.title.clone(),
        poster: details.poster.clone(),
        release_date: details.release_date.clone(),
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

    let details = fetch_media_details_shared_inner(app, client, media_type, id).await?;
    Ok(build_media_schedule(&details, id, include_episodes))
}

/// Cache episode-coordinate mappings and enrich stream targets in one blocking-pool
/// round-trip — the cache pass returns resolved snapshots so enrichment reuses them.
async fn cache_and_enrich_episode_targets(
    app: &AppHandle,
    playback_state: &PlaybackStateService,
    media_type: &str,
    media_id: &str,
    fallback_lookup_id: &str,
    episodes: Vec<Episode>,
) -> Result<Vec<Episode>, String> {
    let app_owned = app.clone();
    let service = playback_state.clone();
    let media_type_owned = media_type.to_string();
    let media_id_owned = media_id.to_string();
    let fallback_owned = fallback_lookup_id.to_string();
    // Retain the payload across a failed hop without deep-cloning it on success.
    let episodes = Arc::new(episodes);
    let cache_episodes = Arc::clone(&episodes);
    let snapshots = super::run_blocking_store_op(move || {
        service.cache_episode_mappings(
            &app_owned,
            &media_type_owned,
            &media_id_owned,
            Some(fallback_owned.as_str()),
            &cache_episodes,
        )
    })
    .await;
    Ok(enrich_episode_targets(
        Arc::unwrap_or_clone(episodes),
        fallback_lookup_id,
        snapshots,
    ))
}

fn enrich_episode_targets(
    mut episodes: Vec<Episode>,
    fallback_lookup_id: &str,
    snapshots: Result<Option<Vec<PlaybackEpisodeMappingSnapshot>>, String>,
) -> Vec<Episode> {
    let snapshots = snapshots.unwrap_or_else(|error| {
        crate::operational_log::log_warn(
            "media-details",
            "cache-episode-mappings",
            "degraded",
            &[crate::operational_log::field("error", error)],
        );
        None
    });
    match snapshots {
        Some(snapshots) => {
            for (episode, snapshot) in episodes.iter_mut().zip(snapshots) {
                episode.stream_lookup_id = Some(snapshot.source_lookup_id);
                episode.stream_season = Some(snapshot.source_season);
                episode.stream_episode = Some(snapshot.source_episode);
            }
        }
        None => {
            for episode in episodes.iter_mut() {
                let source = build_source_episode_coordinates(episode, fallback_lookup_id);
                episode.stream_lookup_id = Some(source.lookup_id);
                episode.stream_season = Some(source.season);
                episode.stream_episode = Some(source.episode);
            }
        }
    }
    episodes
}

async fn fetch_media_details_shared_inner(
    app: &AppHandle,
    client: &AddonResourceClient,
    media_type: &str,
    id: &str,
) -> Result<Arc<MediaDetails>, String> {
    // Same canonical fold as watch progress: Cinemeta serves anime under
    // `series`, so one mapping owns both.
    let media_type = normalize_watch_progress_type(media_type)
        .ok_or_else(|| "Invalid media type. Expected movie or series.".to_string())?;
    super::addon_registry::fetch_meta_details(app, client, media_type, id).await
}

pub(crate) async fn fetch_media_details_inner(
    app: &AppHandle,
    client: &AddonResourceClient,
    media_type: &str,
    id: &str,
    include_episodes: bool,
) -> Result<MediaDetails, String> {
    let details = fetch_media_details_shared_inner(app, client, media_type, id).await?;
    Ok(with_requested_media_id(
        meta_for_shape(&details, include_episodes),
        id,
    ))
}

fn normalize_details_lookup(media_type: &str, id: &str) -> Result<(&'static str, String), String> {
    let id = normalize_media_id(id).ok_or_else(|| "Media ID is required.".to_string())?;
    let media_type = normalize_stream_media_type(media_type, Some(&id))
        .ok_or_else(|| "Invalid media type for details lookup.".to_string())?;
    Ok((media_type, id))
}

#[command]
pub async fn get_media_details(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    client: State<'_, AddonResourceClient>,
    media_type: String,
    id: String,
    include_episodes: Option<bool>,
) -> Result<MediaDetails, super::addon_registry::AddonResourceError> {
    let (media_type, id) = normalize_details_lookup(&media_type, &id)?;
    let include_episodes = include_episodes.unwrap_or(true);

    let mut details =
        fetch_media_details_inner(&app, &client, media_type, &id, include_episodes).await?;

    if let Some(episodes) = details.episodes.as_mut().map(std::mem::take) {
        let fallback_lookup_id = details.imdb_id.as_deref().unwrap_or(id.as_str());
        details.episodes = Some(
            cache_and_enrich_episode_targets(
                &app,
                playback_state.inner(),
                media_type,
                &id,
                fallback_lookup_id,
                episodes,
            )
            .await?,
        );
    }

    Ok(details)
}

/// The two reads the details-route prefetch fires per hover/focus, in one IPC.
/// A details failure degrades to `None`; a store error still fails the bundle.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailsPrefetchBundle {
    pub details: Option<MediaDetails>,
    pub progress: TitleWatchProgress,
}

#[command]
pub async fn get_details_prefetch_bundle(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    client: State<'_, AddonResourceClient>,
    media_type: String,
    id: String,
) -> Result<DetailsPrefetchBundle, String> {
    let (media_type, id) = normalize_details_lookup(&media_type, &id)?;

    // The card shape never carries episodes, so details skips the episode-enrichment
    // hop; the resume read joins the meta fetch with the same source-health join
    // `get_title_watch_progress` performs so donor merge scores identically.
    let progress_id = id.clone();
    let (details, loaded) = tokio::join!(
        fetch_media_details_inner(&app, &client, media_type, &id, false),
        load_entries_with_source_health(&app, playback_state.inner(), move |service, app| {
            service.load_resume_entries_for_media_id(app, &progress_id)
        })
    );
    let (items, source_health_priorities) = loaded?;

    Ok(DetailsPrefetchBundle {
        details: details.ok(),
        progress: build_title_watch_progress_with_priorities(
            items,
            Some(&source_health_priorities),
        ),
    })
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
    let (effective_type, query_ids) = subtitle_lookup_ids(&media_type, &id, season, episode)?;

    super::addon_registry::fetch_addon_subtitles(&app, &client, effective_type, &query_ids).await
}

fn subtitle_lookup_ids(
    media_type: &str,
    id: &str,
    season: Option<u32>,
    episode: Option<u32>,
) -> Result<(&'static str, Vec<String>), String> {
    let id = normalize_media_id(js_trim(id)).ok_or_else(|| "Media ID is required.".to_string())?;
    let media_type = normalize_stream_media_type(js_trim(media_type), Some(&id))
        .ok_or_else(|| "Invalid media type for subtitle lookup.".to_string())?;
    // Subtitle IDs follow stream IDs; anime resolves through series episodes.
    let effective_type = super::media_type::addon_episode_lookup_type(media_type);
    // A single colon can be a namespace (kitsu:48316); only two numeric
    // trailing fields identify an already-scoped episode lookup.
    let episode_scoped = id.rsplit_once(':').is_some_and(|(prefix, episode)| {
        prefix.rsplit_once(':').is_some_and(|(_, season)| {
            [season, episode]
                .iter()
                .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        })
    });
    let query_ids = if effective_type == "movie" || episode_scoped {
        vec![id]
    } else {
        build_stream_query_ids(media_type, &id, season, episode, None)
    };
    Ok((effective_type, query_ids))
}

fn append_media_schedule_echoes(
    schedules: &mut Vec<MediaSchedule>,
    mut schedule: MediaSchedule,
    mut request_types: Vec<String>,
) {
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

pub(crate) async fn fetch_media_schedules(
    app: &AppHandle,
    client: &AddonResourceClient,
    items: Vec<MediaScheduleRequest>,
    on_progress: impl FnMut(Vec<MediaSchedule>),
) -> Result<Vec<MediaSchedule>, String> {
    fetch_media_schedules_inner(app, client, items, None, Some(on_progress)).await
}

pub(crate) async fn fetch_media_schedules_with_response_timeout(
    app: &AppHandle,
    client: &AddonResourceClient,
    items: Vec<MediaScheduleRequest>,
    response_timeout: Option<Duration>,
) -> Result<Vec<MediaSchedule>, String> {
    fetch_media_schedules_inner(
        app,
        client,
        items,
        response_timeout,
        None::<fn(Vec<MediaSchedule>)>,
    )
    .await
}

async fn fetch_media_schedules_inner(
    app: &AppHandle,
    client: &AddonResourceClient,
    items: Vec<MediaScheduleRequest>,
    response_timeout: Option<Duration>,
    mut on_progress: Option<impl FnMut(Vec<MediaSchedule>)>,
) -> Result<Vec<MediaSchedule>, String> {
    // Dedupe fetches on the canonical key, but remember every caller's raw type —
    // the frontend indexes by its own request pair and a `series`+kitsu request
    // normalizes to `anime`, so one fetch must echo a schedule per raw requester.
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
    let mut has_progress = false;
    let mut errors = Vec::new();
    let deadline_at =
        tokio::time::Instant::now() + response_timeout.unwrap_or(MEDIA_SCHEDULE_FETCH_DEADLINE);
    let deadline = tokio::time::sleep_until(deadline_at);
    tokio::pin!(deadline);

    // Sequential bursts keep instantaneous fan-out bounded — constants above own the rationale.
    for chunk in normalized_requests.chunks_mut(MEDIA_SCHEDULE_MAX_ITEMS) {
        if tokio::time::Instant::now() >= deadline_at {
            break;
        }
        let mut pending = stream::iter(chunk.iter_mut().map(std::mem::take).enumerate().map(
            |(index, (request_types, media_type, id))| async move {
                let outcome = if response_timeout.is_some() {
                    // Dropping the join handle at the response cutoff keeps only started
                    // fetches alive to warm the generation-checked metadata cache.
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let client = app.state::<AddonResourceClient>();
                        tokio::time::timeout(
                            MEDIA_SCHEDULE_FETCH_DEADLINE,
                            fetch_media_schedule_inner(&app, client.inner(), &media_type, &id),
                        )
                        .await
                        .unwrap_or_else(|_| Err("Schedule metadata request timed out.".to_string()))
                    })
                    .await
                    .unwrap_or_else(|error| {
                        log_warn(
                            "media-schedule",
                            "fetch_media_schedules",
                            "task-failed",
                            &[field("error", error)],
                        );
                        Err("Schedule metadata task failed.".to_string())
                    })
                } else {
                    fetch_media_schedule_inner(app, client, &media_type, &id).await
                };

                (index, request_types, outcome)
            },
        ))
        .buffer_unordered(MEDIA_SCHEDULE_FETCH_CONCURRENCY_LIMIT)
        .ready_chunks(MEDIA_SCHEDULE_FETCH_CONCURRENCY_LIMIT);

        let mut outcomes = Vec::new();
        loop {
            tokio::select! {
                biased;
                _ = &mut deadline => {
                    push_bounded_error(
                        &mut errors,
                        "Schedule metadata requests timed out. Please try again.",
                    );
                    break;
                },
                next = pending.next() => {
                    let Some(batch) = next else { break };
                    if let Some(on_progress) = on_progress.as_mut() {
                        let mut completed = Vec::new();
                        for (_, request_types, outcome) in batch {
                            match outcome {
                                Ok(schedule) => {
                                    append_media_schedule_echoes(&mut completed, schedule, request_types);
                                }
                                Err(error) => push_bounded_error(&mut errors, error),
                            }
                        }
                        if !completed.is_empty() {
                            has_progress = true;
                            on_progress(completed);
                        }
                    } else {
                        outcomes.extend(batch);
                    }
                }
            }
        }
        outcomes.sort_by_key(|(index, _, _)| *index);

        for (_, request_types, outcome) in outcomes {
            match outcome {
                Ok(schedule) => {
                    // Echo each caller's raw type, not the normalized fetch type.
                    append_media_schedule_echoes(&mut schedules, schedule, request_types);
                }
                Err(error) => {
                    push_bounded_error(&mut errors, error);
                }
            }
        }
    }

    if !has_progress && schedules.is_empty() && !errors.is_empty() {
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
) -> Result<Option<PlaybackEpisodeMappingSnapshot>, String> {
    let id = normalize_media_id(id).ok_or_else(|| "Media ID is required.".to_string())?;
    let media_type = normalize_stream_media_type(media_type, Some(&id))
        .ok_or_else(|| "Invalid media type for episode mapping lookup.".to_string())?;

    if media_type == "movie" {
        return Ok(None);
    }

    // Single point read off the async worker.
    let cached = {
        let app_owned = app.clone();
        let service = playback_state.clone();
        let id_owned = id.clone();
        super::run_blocking_store_op(move || {
            service.get_episode_mapping(
                &app_owned,
                media_type,
                &id_owned,
                canonical_season,
                canonical_episode,
            )
        })
        .await?
    };
    if let Some(mapping) = cached {
        return Ok(Some(mapping));
    }

    let details = fetch_media_details_shared_inner(&app, client, media_type, &id).await?;

    if details.episodes.is_some() {
        let app_owned = app.clone();
        let service = playback_state.clone();
        let id_owned = id.clone();
        let snapshots = super::run_blocking_store_op(move || {
            service.cache_episode_mappings(
                &app_owned,
                media_type,
                &id_owned,
                Some(details.imdb_id.as_deref().unwrap_or(id_owned.as_str())),
                details.episodes.as_deref().unwrap_or_default(),
            )
        })
        .await?;
        if let Some(mapping) = snapshots.and_then(|snapshots| {
            snapshots.into_iter().find(|snapshot| {
                snapshot.canonical_season == canonical_season
                    && snapshot.canonical_episode == canonical_episode
            })
        }) {
            return Ok(Some(mapping));
        }
    }

    // The persisted mapping was checked pre-fetch and `cache_episode_mappings` covered
    // every current episode — nothing between the two can have produced this row.
    Ok(None)
}

#[cfg(test)]
mod tests;
