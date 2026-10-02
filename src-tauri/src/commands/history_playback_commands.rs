use super::history_helpers::{
    choose_entry, playable_resume_start_time, sanitize_watch_progress, HistoryEntryQuery,
};
use super::media_commands::resolve_episode_stream_mapping_inner;
use super::playback_state::PlaybackStateService;
use super::WatchProgress;
use crate::providers::{addon_resource::AddonResourceClient, non_blank};
use serde::Serialize;
use tauri::{command, AppHandle, State};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum HistoryPlaybackPlanKind {
    Details,
    Player,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum HistoryPlaybackPlanReason {
    MissingEpisodeContext,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
// Every Option serializes absent — not null — so route-state consumers never
// have to distinguish "missing" from a real zero (`Number(null) === 0` turned
// an absent season into season 0 "Specials").
struct HistoryPlaybackRouteState {
    #[serde(skip_serializing_if = "Option::is_none")]
    from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    season: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    poster: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    backdrop: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_source_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_source_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    selected_stream_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    start_time: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    absolute_season: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    absolute_episode: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_season: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_episode: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resume_from_history: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_lookup_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPlaybackPlan {
    kind: HistoryPlaybackPlanKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<HistoryPlaybackPlanReason>,
    target: String,
    state: HistoryPlaybackRouteState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HistoryPlaybackMediaType {
    Movie,
    Series,
    Anime,
}

impl HistoryPlaybackMediaType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Movie => "movie",
            Self::Series => "series",
            Self::Anime => "anime",
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct HistoryEpisodeContext {
    absolute_season: Option<u32>,
    absolute_episode: Option<u32>,
    stream_season: Option<u32>,
    stream_episode: Option<u32>,
}

#[derive(Debug, Clone)]
struct ResolvedHistoryEpisodeContext {
    absolute_season: Option<u32>,
    absolute_episode: Option<u32>,
    stream_season: Option<u32>,
    stream_episode: Option<u32>,
    stream_lookup_id: String,
}

/// `from` is echoed back into webview route state; the bound mirrors the
/// frontend's `PLAYER_ROUTE_FROM_MAX_CHARS` so direct IPC can't widen it.
const ROUTE_FROM_MAX_CHARS: usize = 2_048;

fn normalize_saved_value(value: Option<&str>) -> Option<String> {
    value.and_then(super::normalize_opaque_field)
}

fn normalize_history_media_type(item: &WatchProgress) -> HistoryPlaybackMediaType {
    match super::media_type::normalize_history_row_media_type(&item.type_, &item.id) {
        "movie" => HistoryPlaybackMediaType::Movie,
        "anime" => HistoryPlaybackMediaType::Anime,
        _ => HistoryPlaybackMediaType::Series,
    }
}

fn is_series_like(item: &WatchProgress) -> bool {
    matches!(
        normalize_history_media_type(item),
        HistoryPlaybackMediaType::Series | HistoryPlaybackMediaType::Anime
    )
}

fn has_explicit_stream_episode_context(item: &WatchProgress) -> bool {
    item.stream_season.is_some() && item.stream_episode.is_some()
}

/// Any anime item whose media id is not already in the tt lookup space can
/// map to different stream coordinates (legacy kitsu: rows resolve to tt
/// seasons/episodes), so a saved item with no lookup id cannot treat
/// absolute coords as stream coords.
fn is_mapped_anime_history_item(item: &WatchProgress) -> bool {
    normalize_history_media_type(item) == HistoryPlaybackMediaType::Anime
        && !item.id.trim().starts_with("tt")
}

/// WatchProgress-side twin of `episode_navigation::build_source_episode_coordinates`:
/// the same stream→absolute fold, extended with the anime-mapping deferral
/// (`stream_*` may hold absolute coords on legacy kitsu rows, so items with
/// no explicit stream context wait for the episode mapping instead).
fn get_episode_context(item: &WatchProgress) -> HistoryEpisodeContext {
    let absolute_season = item.absolute_season.or(item.season);
    let absolute_episode = item.absolute_episode.or(item.episode);
    let should_defer_mapped_anime_coordinates =
        !has_explicit_stream_episode_context(item) && is_mapped_anime_history_item(item);
    let stream_season = item.stream_season.or({
        if should_defer_mapped_anime_coordinates {
            None
        } else {
            absolute_season
        }
    });
    let stream_episode = item.stream_episode.or({
        if should_defer_mapped_anime_coordinates {
            None
        } else {
            absolute_episode
        }
    });

    HistoryEpisodeContext {
        absolute_season,
        absolute_episode,
        stream_season,
        stream_episode,
    }
}

fn has_episode_context(item: &WatchProgress) -> bool {
    if !is_series_like(item) {
        return true;
    }

    let context = get_episode_context(item);
    context.absolute_season.is_some() && context.absolute_episode.is_some()
}

/// Resume never depends on a persisted stream URL: the opaque lookup id is
/// enough to re-resolve a fresh playable URL on player mount, and the media
/// id itself is the fallback when no saved lookup id survives.
fn get_immediate_stream_lookup_id(item: &WatchProgress) -> String {
    normalize_saved_value(item.last_stream_lookup_id.as_deref())
        .unwrap_or_else(|| item.id.trim().to_string())
}

fn build_player_route(
    media_type: HistoryPlaybackMediaType,
    media_id: &str,
    absolute_season: Option<u32>,
    absolute_episode: Option<u32>,
) -> String {
    // Media ids are opaque addon strings: encode so `/`, `?` or `#` stay
    // inside the one route segment.
    let media_id = urlencoding::encode(media_id);
    match (absolute_season, absolute_episode) {
        (Some(season), Some(episode)) => {
            format!(
                "/player/{}/{}/{}/{}",
                media_type.as_str(),
                media_id,
                season,
                episode
            )
        }
        _ => format!("/player/{}/{}", media_type.as_str(), media_id),
    }
}

fn build_details_target(media_type: HistoryPlaybackMediaType, media_id: &str) -> String {
    format!(
        "/details/{}/{}",
        media_type.as_str(),
        urlencoding::encode(media_id)
    )
}

fn build_details_plan(item: &WatchProgress, from: Option<String>) -> HistoryPlaybackPlan {
    HistoryPlaybackPlan {
        kind: HistoryPlaybackPlanKind::Details,
        reason: Some(HistoryPlaybackPlanReason::MissingEpisodeContext),
        target: build_details_target(normalize_history_media_type(item), &item.id),
        state: HistoryPlaybackRouteState {
            from,
            season: get_episode_context(item).absolute_season,
            ..HistoryPlaybackRouteState::default()
        },
    }
}

fn build_player_plan(
    item: &WatchProgress,
    from: Option<String>,
    context: ResolvedHistoryEpisodeContext,
) -> HistoryPlaybackPlan {
    HistoryPlaybackPlan {
        kind: HistoryPlaybackPlanKind::Player,
        reason: None,
        target: build_player_route(
            normalize_history_media_type(item),
            &item.id,
            context.absolute_season,
            context.absolute_episode,
        ),
        state: HistoryPlaybackRouteState {
            from,
            title: normalize_saved_value(Some(item.title.as_str())),
            poster: item.poster.clone(),
            backdrop: item.backdrop.clone(),
            format: normalize_saved_value(item.last_stream_format.as_deref()),
            stream_source_id: normalize_saved_value(item.source_id.as_deref()),
            stream_source_name: normalize_saved_value(item.source_name.as_deref()),
            stream_family: normalize_saved_value(item.stream_family.as_deref()),
            selected_stream_key: normalize_saved_value(item.last_stream_key.as_deref()),
            start_time: playable_resume_start_time(item),
            absolute_season: context.absolute_season,
            absolute_episode: context.absolute_episode,
            stream_season: context.stream_season,
            stream_episode: context.stream_episode,
            resume_from_history: Some(true),
            stream_lookup_id: Some(context.stream_lookup_id),
            ..HistoryPlaybackRouteState::default()
        },
    }
}

fn merge_latest_history_metadata(item: &WatchProgress, latest: &mut WatchProgress) {
    if !non_blank(&latest.title) {
        latest.title = item.title.clone();
    }
    if latest.poster.is_none() {
        latest.poster = item.poster.clone();
    }
    if latest.backdrop.is_none() {
        latest.backdrop = item.backdrop.clone();
    }
}

fn get_latest_history_playback_item(
    app: &AppHandle,
    playback_state: &PlaybackStateService,
    item: &WatchProgress,
) -> Result<WatchProgress, String> {
    let items = playback_state
        .load_resume_entries_for_title(app, &item.type_, &item.id)?
        .into_iter()
        .map(|(_, item)| item)
        .collect::<Vec<_>>();
    let source_health = playback_state.source_health_priorities_for_ids(
        app,
        items.iter().map(|entry| entry.source_id.as_deref()),
    )?;
    let context = get_episode_context(item);

    if let Some(mut latest) = choose_entry(
        items,
        HistoryEntryQuery::Exact {
            media_id: &item.id,
            media_type: &item.type_,
            season: context.absolute_season,
            episode: context.absolute_episode,
        },
        Some(&source_health),
    ) {
        merge_latest_history_metadata(item, &mut latest);
        return Ok(latest);
    }

    Ok(item.clone())
}

async fn resolve_history_episode_context(
    app: AppHandle,
    playback_state: &PlaybackStateService,
    client: &AddonResourceClient,
    item: &WatchProgress,
) -> Option<ResolvedHistoryEpisodeContext> {
    let base_context = get_episode_context(item);
    let stream_lookup_id = get_immediate_stream_lookup_id(item);
    // Canonical coords without a stream pair resolve through the persisted
    // episode mapping; everything else uses the base context as-is.
    let missing_stream_coords =
        base_context.stream_season.is_none() || base_context.stream_episode.is_none();

    if missing_stream_coords {
        if let (Some(absolute_season), Some(absolute_episode)) =
            (base_context.absolute_season, base_context.absolute_episode)
        {
            return resolve_episode_stream_mapping_inner(
                app,
                playback_state,
                client,
                normalize_history_media_type(item).as_str(),
                &item.id,
                absolute_season,
                absolute_episode,
            )
            .await
            .ok()
            .flatten()
            .map(|mapping| ResolvedHistoryEpisodeContext {
                absolute_season: Some(mapping.canonical_season),
                absolute_episode: Some(mapping.canonical_episode),
                stream_season: Some(mapping.source_season),
                stream_episode: Some(mapping.source_episode),
                stream_lookup_id: mapping.lookup_id,
            });
        }
    }

    Some(ResolvedHistoryEpisodeContext {
        absolute_season: base_context.absolute_season,
        absolute_episode: base_context.absolute_episode,
        stream_season: base_context.stream_season,
        stream_episode: base_context.stream_episode,
        stream_lookup_id,
    })
}

#[command]
pub async fn build_history_playback_plan(
    app: AppHandle,
    playback_state: State<'_, PlaybackStateService>,
    client: State<'_, AddonResourceClient>,
    item: WatchProgress,
    from: String,
) -> Result<HistoryPlaybackPlan, String> {
    // Sanitize owns id/type validation: a `Some` result already carries a
    // non-empty bounded id and a canonical type.
    let item = sanitize_watch_progress(item)
        .ok_or_else(|| "Invalid history item for playback planning.".to_string())?;
    let from = normalize_saved_value(Some(from.as_str()));
    if from
        .as_deref()
        .is_some_and(|value| value.chars().count() > ROUTE_FROM_MAX_CHARS)
    {
        return Err("Invalid playback route origin.".to_string());
    }

    // SQLite + store reads are blocking: run the latest-item lookup on the
    // dedicated blocking pool, never on the async worker.
    let latest_item = {
        let app_owned = app.clone();
        let service = playback_state.inner().clone();
        super::run_blocking_store_op(move || {
            get_latest_history_playback_item(&app_owned, &service, &item)
        })
        .await?
    };
    if !has_episode_context(&latest_item) {
        return Ok(build_details_plan(&latest_item, from));
    }

    let Some(resolved_context) =
        resolve_history_episode_context(app, playback_state.inner(), client.inner(), &latest_item)
            .await
    else {
        return Ok(build_details_plan(&latest_item, from));
    };

    Ok(build_player_plan(&latest_item, from, resolved_context))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::test_progress;

    fn progress_item(id: &str, type_: &str) -> WatchProgress {
        WatchProgress {
            id: id.to_string(),
            type_: type_.to_string(),
            title: "Example".to_string(),
            ..test_progress()
        }
    }

    fn context_for(item: &WatchProgress) -> ResolvedHistoryEpisodeContext {
        let base = get_episode_context(item);
        ResolvedHistoryEpisodeContext {
            absolute_season: base.absolute_season,
            absolute_episode: base.absolute_episode,
            stream_season: base.stream_season,
            stream_episode: base.stream_episode,
            stream_lookup_id: get_immediate_stream_lookup_id(item),
        }
    }

    #[test]
    fn player_plan_runs_without_saved_stream_identity() {
        let mut movie = progress_item("tt99", "movie");
        movie.position = 120.0;
        movie.duration = 600.0;

        let plan = build_player_plan(&movie, Some("/".to_string()), context_for(&movie));

        assert_eq!(plan.kind, HistoryPlaybackPlanKind::Player);
        assert_eq!(plan.target, "/player/movie/tt99");
        assert_eq!(plan.state.stream_lookup_id.as_deref(), Some("tt99"));
        assert_eq!(plan.state.start_time, Some(120.0));

        let mut series = progress_item("tt9", "series");
        series.season = Some(1);
        series.episode = Some(5);
        series.absolute_season = Some(1);
        series.absolute_episode = Some(5);
        series.stream_season = Some(2);
        series.stream_episode = Some(17);
        series.position = 300.0;
        series.duration = 1_200.0;

        let plan = build_player_plan(&series, Some("/".to_string()), context_for(&series));

        assert_eq!(plan.kind, HistoryPlaybackPlanKind::Player);
        assert_eq!(plan.target, "/player/series/tt9/1/5");
        assert_eq!(plan.state.absolute_season, Some(1));
        assert_eq!(plan.state.absolute_episode, Some(5));
        assert_eq!(plan.state.stream_season, Some(2));
        assert_eq!(plan.state.stream_episode, Some(17));
        assert_eq!(plan.state.stream_lookup_id.as_deref(), Some("tt9"));
        assert_eq!(plan.state.resume_from_history, Some(true));
    }

    #[test]
    fn player_plan_carries_exact_saved_key_and_source() {
        let mut item = progress_item("tt9", "series");
        item.season = Some(1);
        item.episode = Some(5);
        item.absolute_season = Some(1);
        item.absolute_episode = Some(5);
        item.stream_season = Some(1);
        item.stream_episode = Some(5);
        item.last_stream_key = Some("s:saved".to_string());
        item.last_stream_lookup_id = Some("tt7654321".to_string());
        item.source_id = Some("addon-a".to_string());
        item.source_name = Some("CDN A".to_string());
        item.stream_family = Some("cdn|release:x".to_string());

        let plan = build_player_plan(&item, Some("/".to_string()), context_for(&item));

        assert_eq!(plan.state.selected_stream_key.as_deref(), Some("s:saved"));
        assert_eq!(plan.state.stream_source_id.as_deref(), Some("addon-a"));
        assert_eq!(plan.state.stream_source_name.as_deref(), Some("CDN A"));
        assert_eq!(plan.state.stream_family.as_deref(), Some("cdn|release:x"));
        assert_eq!(plan.state.stream_lookup_id.as_deref(), Some("tt7654321"));
    }

    #[test]
    fn player_plan_omits_start_time_without_playable_resume() {
        let item = progress_item("tt99", "movie");
        let plan = build_player_plan(&item, None, context_for(&item));
        assert_eq!(plan.state.start_time, None);

        let mut completed = progress_item("tt99", "movie");
        completed.position = 590.0;
        completed.duration = 600.0;
        let plan = build_player_plan(&completed, None, context_for(&completed));
        assert_eq!(plan.state.start_time, None);
    }

    #[test]
    fn player_plan_routes_specials_coordinates() {
        let mut item = progress_item("tt9", "series");
        item.season = Some(0);
        item.episode = Some(0);
        item.absolute_season = Some(0);
        item.absolute_episode = Some(0);
        item.stream_season = Some(0);
        item.stream_episode = Some(0);

        let plan = build_player_plan(&item, None, context_for(&item));

        assert_eq!(plan.target, "/player/series/tt9/0/0");
        assert_eq!(plan.state.absolute_season, Some(0));
        assert_eq!(plan.state.absolute_episode, Some(0));
    }

    #[test]
    fn missing_episode_context_routes_to_details() {
        let mut item = progress_item("tt9", "series");
        item.season = Some(2);
        assert!(!has_episode_context(&item));

        let plan = build_details_plan(&item, Some("/continue".to_string()));

        assert_eq!(plan.kind, HistoryPlaybackPlanKind::Details);
        assert_eq!(
            plan.reason,
            Some(HistoryPlaybackPlanReason::MissingEpisodeContext)
        );
        assert_eq!(plan.target, "/details/series/tt9");
        assert_eq!(plan.state.season, Some(2));
        assert_eq!(plan.state.from.as_deref(), Some("/continue"));
    }

    #[test]
    fn episode_context_defers_unmapped_anime_stream_coordinates() {
        let mut item = progress_item("kitsu:42", "anime");
        item.season = Some(1);
        item.episode = Some(12);
        item.absolute_season = Some(1);
        item.absolute_episode = Some(12);

        let context = get_episode_context(&item);

        assert_eq!(context.absolute_season, Some(1));
        assert_eq!(context.absolute_episode, Some(12));
        assert_eq!(context.stream_season, None);
        assert_eq!(context.stream_episode, None);
    }

    #[test]
    fn episode_context_resolves_tt_coordinates_directly() {
        let mut item = progress_item("tt9", "series");
        item.season = Some(1);
        item.episode = Some(5);

        let context = get_episode_context(&item);

        assert_eq!(context.absolute_season, Some(1));
        assert_eq!(context.absolute_episode, Some(5));
        assert_eq!(context.stream_season, Some(1));
        assert_eq!(context.stream_episode, Some(5));
    }
}
