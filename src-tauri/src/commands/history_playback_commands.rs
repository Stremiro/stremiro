use super::history_helpers::{
    choose_entry, is_series_like_watch_progress, playable_resume_start_time, resume_rows,
    sanitize_watch_progress, watch_progress_absolute_episode, watch_progress_absolute_season,
    HistoryEntryQuery,
};
use super::media_commands::resolve_episode_stream_mapping_inner;
use super::playback_state::PlaybackStateService;
use super::WatchProgress;
use crate::providers::{addon_resource::AddonResourceClient, encode_uri_component, non_blank};
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
// Every Option serializes absent, not null — route-state consumers never
// distinguish "missing" from a real zero (`Number(null) === 0` → season 0 "Specials").
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
    #[serde(skip_serializing_if = "Option::is_none")]
    warm_resolve_request: Option<HistoryWarmResolveRequest>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryWarmResolveRequest {
    media_type: &'static str,
    media_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_lookup_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_season: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_episode: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    absolute_season: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    absolute_episode: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    preferred: HistoryPreferredStreamIdentity,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryPreferredStreamIdentity {
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_family: Option<String>,
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

/// Bound `from` before echoing it into webview route state.
const ROUTE_FROM_MAX_CHARS: usize = 2_048;

fn normalize_saved_value(value: Option<&str>) -> Option<String> {
    value.and_then(super::normalize_opaque_field)
}

fn normalize_history_media_type(item: &WatchProgress) -> &'static str {
    super::media_type::normalize_history_row_media_type(&item.type_, &item.id)
}

fn is_series_like(item: &WatchProgress) -> bool {
    normalize_history_media_type(item) != "movie"
}

fn has_explicit_stream_episode_context(item: &WatchProgress) -> bool {
    item.stream_season.is_some() && item.stream_episode.is_some()
}

/// Aliased series/anime can map to a different lookup id and source coordinates.
fn is_mapped_history_item(item: &WatchProgress) -> bool {
    is_series_like(item) && !item.id.trim().starts_with("tt")
}

/// WatchProgress-side twin of `episode_navigation::build_source_episode_coordinates`:
/// aliases without saved source coordinates wait for their episode mapping.
fn get_episode_context(item: &WatchProgress) -> HistoryEpisodeContext {
    let absolute_season = watch_progress_absolute_season(item);
    let absolute_episode = watch_progress_absolute_episode(item);
    let should_defer_mapped_coordinates =
        !has_explicit_stream_episode_context(item) && is_mapped_history_item(item);
    HistoryEpisodeContext {
        absolute_season,
        absolute_episode,
        stream_season: item
            .stream_season
            .or(absolute_season.filter(|_| !should_defer_mapped_coordinates)),
        stream_episode: item
            .stream_episode
            .or(absolute_episode.filter(|_| !should_defer_mapped_coordinates)),
    }
}

fn has_episode_context(item: &WatchProgress) -> bool {
    if !is_series_like(item) {
        return true;
    }

    let context = get_episode_context(item);
    context.absolute_season.is_some() && context.absolute_episode.is_some()
}

/// Resume never depends on a persisted stream URL — the opaque lookup id re-resolves
/// a fresh playable URL on player mount; the media id is the fallback.
fn get_immediate_stream_lookup_id(item: &WatchProgress) -> String {
    normalize_saved_value(item.last_stream_lookup_id.as_deref())
        .unwrap_or_else(|| item.id.trim().to_string())
}

fn build_player_route(
    media_type: &str,
    media_id: &str,
    absolute_season: Option<u32>,
    absolute_episode: Option<u32>,
) -> String {
    // Media ids are opaque addon strings: encode so `/`, `?` or `#` stay
    // inside the one route segment.
    let media_id = encode_uri_component(media_id);
    match (absolute_season, absolute_episode) {
        (Some(season), Some(episode)) => {
            format!("/player/{media_type}/{media_id}/{season}/{episode}")
        }
        _ => format!("/player/{media_type}/{media_id}"),
    }
}

fn build_details_target(media_type: &str, media_id: &str) -> String {
    format!("/details/{media_type}/{}", encode_uri_component(media_id))
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
        warm_resolve_request: None,
    }
}

fn build_player_plan(
    item: &WatchProgress,
    from: Option<String>,
    context: ResolvedHistoryEpisodeContext,
) -> HistoryPlaybackPlan {
    let media_type = normalize_history_media_type(item);
    let state = HistoryPlaybackRouteState {
        from,
        title: normalize_saved_value(Some(item.title.as_str())),
        poster: item.poster.clone(),
        backdrop: item.backdrop.clone(),
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
    };
    // A coordinate-less series warm cannot join the player's mapped replay request.
    let warm_resolve_request = (!(media_type != "movie"
        && (state.absolute_season.is_some() || state.absolute_episode.is_some())
        && state.stream_season.is_none()
        && state.stream_episode.is_none()))
    .then(|| HistoryWarmResolveRequest {
        media_type,
        media_id: item.id.trim().to_string(),
        stream_lookup_id: state.stream_lookup_id.clone(),
        stream_season: state.stream_season,
        stream_episode: state.stream_episode,
        absolute_season: state.absolute_season,
        absolute_episode: state.absolute_episode,
        title: state.title.clone(),
        preferred: HistoryPreferredStreamIdentity {
            stream_key: state.selected_stream_key.clone(),
            source_id: state.stream_source_id.clone(),
            source_name: state.stream_source_name.clone(),
            stream_family: state.stream_family.clone(),
        },
    });
    HistoryPlaybackPlan {
        kind: HistoryPlaybackPlanKind::Player,
        reason: None,
        target: build_player_route(
            media_type,
            &item.id,
            context.absolute_season,
            context.absolute_episode,
        ),
        state,
        warm_resolve_request,
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
    let context = get_episode_context(item);
    let items = resume_rows(match (context.absolute_season, context.absolute_episode) {
        (Some(season), Some(episode)) => playback_state.load_resume_entries_for_episode(
            app,
            &item.type_,
            &item.id,
            season,
            episode,
        )?,
        _ => playback_state.load_resume_entries_for_title(app, &item.type_, &item.id)?,
    });
    // Health only ranks series donors; movies and singleton titles have none.
    let source_health = (items.len() > 1 && is_series_like_watch_progress(item)).then(|| {
        playback_state.source_health_priorities_for_ids(
            app,
            items.iter().map(|entry| entry.source_id.as_deref()),
        )
    });

    if let Some(mut latest) = choose_entry(
        items,
        HistoryEntryQuery::Exact {
            media_id: &item.id,
            media_type: &item.type_,
            season: context.absolute_season,
            episode: context.absolute_episode,
        },
        source_health.as_ref(),
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
) -> Result<Option<ResolvedHistoryEpisodeContext>, String> {
    let base_context = get_episode_context(item);
    let stream_lookup_id = get_immediate_stream_lookup_id(item);
    // Canonical coords without a stream pair resolve through the persisted episode
    // mapping; a lookup failure must surface — only a genuinely absent mapping
    // degrades to the details plan.
    let missing_stream_coords =
        base_context.stream_season.is_none() || base_context.stream_episode.is_none();

    if missing_stream_coords {
        if let (Some(absolute_season), Some(absolute_episode)) =
            (base_context.absolute_season, base_context.absolute_episode)
        {
            return Ok(resolve_episode_stream_mapping_inner(
                app,
                playback_state,
                client,
                normalize_history_media_type(item),
                &item.id,
                absolute_season,
                absolute_episode,
            )
            .await?
            .map(|mapping| ResolvedHistoryEpisodeContext {
                absolute_season: Some(mapping.canonical_season),
                absolute_episode: Some(mapping.canonical_episode),
                stream_season: Some(mapping.source_season),
                stream_episode: Some(mapping.source_episode),
                stream_lookup_id: mapping.source_lookup_id,
            }));
        }
    }

    Ok(Some(ResolvedHistoryEpisodeContext {
        absolute_season: base_context.absolute_season,
        absolute_episode: base_context.absolute_episode,
        stream_season: base_context.stream_season,
        stream_episode: base_context.stream_episode,
        stream_lookup_id,
    }))
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
            .await?
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
    fn watch_progress_accepts_legacy_format_and_defaults_missing_format() {
        let mut payload = serde_json::to_value(progress_item("tt99", "movie")).unwrap();
        assert!(payload.get("last_stream_format").is_none());
        let progress: WatchProgress = serde_json::from_value(payload.clone()).unwrap();
        assert_eq!(progress.last_stream_format, None);

        payload["last_stream_format"] = serde_json::json!("video/mp4");
        let progress: WatchProgress = serde_json::from_value(payload).unwrap();
        assert_eq!(progress.last_stream_format.as_deref(), Some("video/mp4"));
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
        assert_eq!(
            serde_json::to_value(&plan).unwrap()["warmResolveRequest"],
            serde_json::json!({
                "mediaType": "movie", "mediaId": "tt99", "streamLookupId": "tt99",
                "title": "Example", "preferred": {},
            })
        );

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
        item.last_stream_format = Some("video/mp4".to_string());
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
        assert!(serde_json::to_value(&plan).unwrap()["state"]
            .get("format")
            .is_none());
        assert_eq!(
            serde_json::to_value(&plan).unwrap()["warmResolveRequest"],
            serde_json::json!({
                "mediaType": "series", "mediaId": "tt9", "streamLookupId": "tt7654321",
                "streamSeason": 1, "streamEpisode": 5, "absoluteSeason": 1, "absoluteEpisode": 5,
                "title": "Example",
                "preferred": {
                    "streamKey": "s:saved", "sourceId": "addon-a",
                    "sourceName": "CDN A", "streamFamily": "cdn|release:x",
                },
            })
        );
    }

    #[test]
    fn player_plan_omits_start_time_without_playable_resume() {
        let mut item = progress_item("tt99", "movie");
        item.title = " ".to_string();
        let plan = build_player_plan(&item, None, context_for(&item));
        assert_eq!(plan.state.start_time, None);
        assert!(serde_json::to_value(&plan).unwrap()["warmResolveRequest"]
            .get("title")
            .is_none());

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
        let warm = serde_json::to_value(&plan).unwrap()["warmResolveRequest"].clone();
        for field in [
            "absoluteSeason",
            "absoluteEpisode",
            "streamSeason",
            "streamEpisode",
        ] {
            assert_eq!(warm[field], 0);
        }
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
        assert!(serde_json::to_value(&plan)
            .unwrap()
            .get("warmResolveRequest")
            .is_none());
    }

    #[test]
    fn episode_context_defers_aliased_series_and_anime_stream_coordinates() {
        for (id, media_type, encoded_id) in [
            ("kitsu:42/part%?#", "anime", "kitsu%3A42%2Fpart%25%3F%23"),
            (
                "catalog:42/part%?#",
                "series",
                "catalog%3A42%2Fpart%25%3F%23",
            ),
        ] {
            let mut item = progress_item(id, media_type);
            item.season = Some(1);
            item.episode = Some(12);
            item.absolute_season = Some(1);
            item.absolute_episode = Some(12);

            let context = get_episode_context(&item);

            assert_eq!(context.absolute_season, Some(1));
            assert_eq!(context.absolute_episode, Some(12));
            assert_eq!(context.stream_season, None);
            assert_eq!(context.stream_episode, None);
            assert!(has_episode_context(&item));
            let plan = build_player_plan(&item, None, context_for(&item));
            assert!(serde_json::to_value(&plan)
                .unwrap()
                .get("warmResolveRequest")
                .is_none());

            let plan = build_player_plan(
                &item,
                None,
                ResolvedHistoryEpisodeContext {
                    absolute_season: Some(1),
                    absolute_episode: Some(12),
                    stream_season: Some(2),
                    stream_episode: Some(3),
                    stream_lookup_id: "tt7654321".to_string(),
                },
            );
            assert_eq!(
                plan.target,
                format!("/player/{media_type}/{encoded_id}/1/12")
            );
            assert_eq!(plan.state.stream_lookup_id.as_deref(), Some("tt7654321"));
            assert_eq!(plan.state.stream_season, Some(2));
            assert_eq!(plan.state.stream_episode, Some(3));
            assert_eq!(plan.state.selected_stream_key, None);
            assert_eq!(plan.state.stream_source_id, None);
            assert_eq!(plan.state.start_time, None);
            assert_eq!(
                serde_json::to_value(&plan).unwrap()["warmResolveRequest"],
                serde_json::json!({
                    "mediaType": media_type, "mediaId": id,
                    "streamLookupId": "tt7654321", "streamSeason": 2, "streamEpisode": 3,
                    "absoluteSeason": 1, "absoluteEpisode": 12,
                    "title": "Example", "preferred": {},
                })
            );
        }
    }

    #[test]
    fn episode_context_preserves_saved_alias_source_coordinates() {
        for (id, media_type) in [("catalog:42", "series"), ("kitsu:42", "anime")] {
            let mut item = progress_item(id, media_type);
            item.absolute_season = Some(1);
            item.absolute_episode = Some(12);
            item.stream_season = Some(2);
            item.stream_episode = Some(3);
            item.last_stream_lookup_id = Some("tt7654321".to_string());

            let plan = build_player_plan(&item, None, context_for(&item));
            assert_eq!(plan.state.stream_lookup_id.as_deref(), Some("tt7654321"));
            assert_eq!(plan.state.stream_season, Some(2));
            assert_eq!(plan.state.stream_episode, Some(3));
        }
    }

    #[test]
    fn episode_context_resolves_tt_coordinates_directly() {
        for media_type in ["series", "anime"] {
            let mut item = progress_item("tt9", media_type);
            item.season = Some(1);
            item.episode = Some(5);

            let context = get_episode_context(&item);

            assert_eq!(context.absolute_season, Some(1));
            assert_eq!(context.absolute_episode, Some(5));
            assert_eq!(context.stream_season, Some(1));
            assert_eq!(context.stream_episode, Some(5));
            assert_eq!(context_for(&item).stream_lookup_id, "tt9");
        }
    }
}
