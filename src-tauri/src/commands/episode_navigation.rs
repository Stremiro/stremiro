use crate::providers::{non_blank_opt, Episode};

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

#[cfg(test)]
mod tests;
