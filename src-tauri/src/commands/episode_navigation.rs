use crate::providers::{non_blank_opt, Episode};
use serde::{Deserialize, Serialize};
use tauri::command;

use super::calendar_commands::date_ordinal;
use super::{js_trim, normalize_media_id, MEDIA_ID_MAX_CHARS};

const EPISODE_NAVIGATION_MAX_EPISODES: usize = 2_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EpisodeNavigationRequest {
    episodes: Vec<NavigationCoordinate>,
    season: u32,
    episode: u32,
    today: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NavigationCoordinate {
    season: u32,
    episode: u32,
    release_date: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UnairedEpisodesRequest {
    release_dates: Vec<Option<String>>,
    today: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EpisodeNavigation {
    previous_index: Option<usize>,
    next_index: Option<usize>,
}

/// Specials (season 0) and regular seasons are separate sequences: neither
/// steps into the other.
pub(crate) fn coordinate_neighbours<T: Copy>(
    episodes: impl Iterator<Item = T>,
    current: (u32, u32),
    coordinates: impl Fn(T) -> (u32, u32),
) -> (Option<T>, Option<T>) {
    let mut previous = None;
    let mut next = None;
    for candidate in episodes {
        let coordinate = coordinates(candidate);
        if (coordinate.0 == 0) != (current.0 == 0) {
            continue;
        }
        if coordinate < current
            && previous.is_none_or(|previous| coordinate >= coordinates(previous))
        {
            previous = Some(candidate);
        } else if coordinate > current && next.is_none_or(|next| coordinate < coordinates(next)) {
            next = Some(candidate);
        }
    }
    (previous, next)
}

/// Undated and unparseable release dates count as aired.
fn is_aired_by(release_date: Option<&str>, today: u32) -> bool {
    // Normalized release dates are local calendar days, never UTC instants.
    release_date
        .and_then(|date| date.trim().get(..10))
        .and_then(date_ordinal)
        .is_none_or(|date| date <= today)
}

fn local_today(today: &str) -> Result<u32, String> {
    date_ordinal(today).ok_or_else(|| "Invalid local episode date.".to_string())
}

fn player_episode_navigation(
    episodes: &[NavigationCoordinate],
    current: (u32, u32),
    today: u32,
) -> EpisodeNavigation {
    let (previous, next) =
        coordinate_neighbours(episodes.iter().enumerate(), current, |(_, episode)| {
            (episode.season, episode.episode)
        });
    let next = next.filter(|(_, episode)| is_aired_by(episode.release_date.as_deref(), today));
    EpisodeNavigation {
        previous_index: previous.map(|(index, _)| index),
        next_index: next.map(|(index, _)| index),
    }
}

#[command]
pub(crate) fn get_episode_navigation(
    request: EpisodeNavigationRequest,
) -> Result<EpisodeNavigation, String> {
    if request.episodes.len() > EPISODE_NAVIGATION_MAX_EPISODES {
        return Err("Too many episodes.".to_string());
    }
    let today = local_today(&request.today)?;
    Ok(player_episode_navigation(
        &request.episodes,
        (request.season, request.episode),
        today,
    ))
}

/// Indices of episodes that have not aired by the caller's local day.
#[command]
pub(crate) fn get_unaired_episode_indices(
    request: UnairedEpisodesRequest,
) -> Result<Vec<usize>, String> {
    if request.release_dates.len() > EPISODE_NAVIGATION_MAX_EPISODES {
        return Err("Too many episodes.".to_string());
    }
    let today = local_today(&request.today)?;
    Ok(request
        .release_dates
        .iter()
        .enumerate()
        .filter(|(_, date)| !is_aired_by(date.as_deref(), today))
        .map(|(index, _)| index)
        .collect())
}

// In-process only: never serialized to IPC or persisted, so no serde derives.
#[derive(Debug, Clone)]
pub(crate) struct SourceEpisodeCoordinates {
    pub lookup_id: String,
    pub season: u32,
    pub episode: u32,
}

pub(crate) fn build_source_episode_coordinates(
    episode: &Episode,
    fallback_lookup_id: &str,
) -> SourceEpisodeCoordinates {
    // Empty/blank addon IDs count as missing so degenerate payloads fall
    // through to the IMDb anchor and caller fallback like the UI layer does.
    SourceEpisodeCoordinates {
        lookup_id: non_blank_opt(episode.stream_lookup_id.as_deref())
            .unwrap_or(fallback_lookup_id)
            .to_string(),
        season: episode.stream_season.unwrap_or(episode.season),
        episode: episode.stream_episode.unwrap_or(episode.episode),
    }
}

pub(crate) fn additional_episode_video_id(
    episode: &Episode,
    source: &SourceEpisodeCoordinates,
) -> Option<String> {
    // Metadata normalization truncates at this boundary; never request a possibly clipped id.
    if episode.id.chars().nth(MEDIA_ID_MAX_CHARS - 1).is_some() {
        return None;
    }
    let id = normalize_media_id(js_trim(&episode.id))?;
    (id != source.lookup_id
        && id != format!("{}:{}:{}", source.lookup_id, source.season, source.episode))
    .then_some(id)
}

#[cfg(test)]
mod tests;
