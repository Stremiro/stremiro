use super::{
    normalize_media_id, normalize_media_image_url, normalize_watch_progress_type, now_unix_millis,
    streaming_helpers::{is_persistable_stream_key, normalize_source_id, normalize_source_key},
    WatchProgress, MEDIA_TITLE_MAX_CHARS,
};
use crate::providers::{bound_optional, non_blank, trim_to_max};
use std::borrow::Cow;
use std::collections::HashMap;

const WATCH_PROGRESS_POSITION_SAVE_DELTA_SECS: f64 = 4.0;
const WATCH_PROGRESS_DURATION_SAVE_DELTA_SECS: f64 = 1.0;
const WATCH_PROGRESS_MIN_SAVE_INTERVAL_MS: u64 = 15_000;
const WATCH_PROGRESS_NEAR_COMPLETION_RATIO: f64 = 0.97;
const WATCH_PROGRESS_NEAR_COMPLETION_REMAINING_SECS: f64 = 30.0;
const WATCH_PROGRESS_NEAR_COMPLETION_MIN_DURATION_SECS: f64 = 60.0;
pub(super) const WATCH_PROGRESS_MIN_RESUME_POSITION_SECS: f64 = 5.0;
pub(super) const WATCH_PROGRESS_MAX_RESUME_PROGRESS_RATIO: f64 = 0.95;
const WATCH_PROGRESS_STARTED_RATIO: f64 = 0.05;
const WATCH_PROGRESS_LOW_CONFIDENCE_EARLY_POSITION_SECS: f64 = 90.0;
const WATCH_PROGRESS_LOW_CONFIDENCE_PROGRESS_RATIO: f64 = 0.08;
const WATCH_PROGRESS_BETTER_RESUME_POSITION_DELTA_SECS: f64 = 45.0;
const WATCH_PROGRESS_BETTER_RESUME_PROGRESS_RATIO_DELTA: f64 = 0.12;
/// Clock-skew tolerance for `last_watched`: without clamping, one far-future row
/// permanently wins the `excluded.last_watched >=` recency guard and drops later saves.
pub(super) const WATCH_PROGRESS_FUTURE_SKEW_MS: u64 = 5 * 60 * 1000;
/// Char bounds for free-text watch-progress fields — past these caps is malformed input, not a real value.
const STREAM_FORMAT_MAX_CHARS: usize = 64;
pub(crate) const STREAM_KEY_MAX_CHARS: usize = 128;
const STREAM_LOOKUP_ID_MAX_CHARS: usize = 256;
const SOURCE_NAME_MAX_CHARS: usize = 256;
const SOURCE_ID_MAX_CHARS: usize = 256;
const STREAM_FAMILY_MAX_CHARS: usize = 512;
/// Bound for season/episode coordinates: real catalogs never approach this.
/// `0` stays valid — specials and the `series:{id}:0:0` movie-fallback key use it.
const EPISODE_COORDINATE_MAX: u32 = 100_000;
/// No real title runs a week; larger finite values are corrupt input.
const WATCH_PROGRESS_MAX_SECS: f64 = 7.0 * 24.0 * 60.0 * 60.0;

pub(super) fn resume_rows(entries: Vec<(String, WatchProgress)>) -> Vec<WatchProgress> {
    entries.into_iter().map(|(_, row)| row).collect()
}

pub(crate) fn normalize_episode_coordinate(value: Option<u32>) -> Option<u32> {
    value.filter(|coordinate| *coordinate <= EPISODE_COORDINATE_MAX)
}

/// History-row identity is `(type, id, season, episode)` — the `movie:{id}` /
/// `series:{id}:{s}:{e}` store key is this backend's serialization of it.
pub(crate) fn build_history_key(
    canonical_type: &str,
    id: &str,
    season: Option<u32>,
    episode: Option<u32>,
) -> String {
    if canonical_type == "movie" {
        format!("movie:{}", id)
    } else {
        format!(
            "series:{}:{}:{}",
            id,
            season.unwrap_or(0),
            episode.unwrap_or(0)
        )
    }
}

/// Stream URLs are credential-bearing and short-lived: no watch-progress payload may
/// persist them. Resume re-resolves through opaque lookup/key/source identities instead.
pub(crate) fn sanitize_watch_progress(mut progress: WatchProgress) -> Option<WatchProgress> {
    // The id is a store key: reject rather than truncate so hostile ids can't collide.
    // An empty id collapses every row onto one `movie:`/`series:0:0` key.
    progress.id = normalize_media_id(&progress.id)?;
    progress.type_ = normalize_watch_progress_type(&progress.type_)?.to_string();
    progress.resume_start_time = None;
    progress.is_watched = false;
    progress.has_started_watching = false;

    // A far-future timestamp would permanently win recency guards — clamp to backend now.
    let now = now_unix_millis();
    if progress.last_watched > now.saturating_add(WATCH_PROGRESS_FUTURE_SKEW_MS) {
        progress.last_watched = now;
    }

    // Out-of-range coordinates degrade to absent rather than persisting a key
    // that can never match a real episode.
    progress.season = normalize_episode_coordinate(progress.season);
    progress.episode = normalize_episode_coordinate(progress.episode);
    progress.absolute_season = normalize_episode_coordinate(progress.absolute_season);
    progress.absolute_episode = normalize_episode_coordinate(progress.absolute_episode);
    progress.stream_season = normalize_episode_coordinate(progress.stream_season);
    progress.stream_episode = normalize_episode_coordinate(progress.stream_episode);

    hydrate_watch_progress_coordinates(&mut progress);
    // Non-finite floats serialize to JSON null and drop the row on read — clamp
    // rather than persist a value that can't round-trip.
    if !progress.position.is_finite() || progress.position < 0.0 {
        progress.position = 0.0;
    }
    progress.position = progress.position.min(WATCH_PROGRESS_MAX_SECS);
    if !progress.duration.is_finite() || progress.duration < 0.0 {
        progress.duration = 0.0;
    }
    progress.duration = progress.duration.min(WATCH_PROGRESS_MAX_SECS);
    if progress.duration > 0.0 && progress.position > progress.duration {
        progress.position = progress.duration;
    }

    // Sole owner of the persisted `Untitled` fallback — live saves and imports both funnel through here.
    progress.title = trim_to_max(&progress.title, MEDIA_TITLE_MAX_CHARS)
        .unwrap_or_else(|| "Untitled".to_string());
    progress.poster = progress.poster.and_then(|s| normalize_media_image_url(&s));
    progress.backdrop = progress
        .backdrop
        .and_then(|s| normalize_media_image_url(&s));
    progress.last_stream_format =
        bound_optional(progress.last_stream_format, STREAM_FORMAT_MAX_CHARS);
    progress.last_stream_lookup_id =
        bound_optional(progress.last_stream_lookup_id, STREAM_LOOKUP_ID_MAX_CHARS);
    // Only opaque hash identities (`h:`/`uh:`/`s:`) may persist — legacy `u:` keys
    // embed the normalized URL verbatim, signed credentials included.
    progress.last_stream_key = bound_optional(progress.last_stream_key, STREAM_KEY_MAX_CHARS)
        .filter(|key| is_persistable_stream_key(key));
    progress.source_name = bound_optional(progress.source_name, SOURCE_NAME_MAX_CHARS);
    progress.source_id = bound_optional(progress.source_id, SOURCE_ID_MAX_CHARS);
    progress.stream_family = bound_optional(progress.stream_family, STREAM_FAMILY_MAX_CHARS);

    Some(progress)
}

pub(crate) fn prepare_live_watch_progress(
    progress: WatchProgress,
    completed: bool,
) -> Result<Option<WatchProgress>, String> {
    let mut progress = sanitize_watch_progress(progress)
        .ok_or_else(|| "Invalid media id or type for watch progress.".to_string())?;
    if completed {
        progress.duration = progress.duration.max(progress.position).max(1.0);
        progress.position = progress.duration;
    } else if progress.position < WATCH_PROGRESS_MIN_RESUME_POSITION_SECS {
        return Ok(None);
    }
    Ok(Some(progress))
}

pub(crate) fn should_skip_watch_progress_save(
    existing: &WatchProgress,
    incoming: &WatchProgress,
) -> bool {
    if existing.id != incoming.id
        || existing.type_ != incoming.type_
        || existing.season != incoming.season
        || existing.episode != incoming.episode
        || existing.last_watched > now_unix_millis().saturating_add(WATCH_PROGRESS_FUTURE_SKEW_MS)
    {
        return false;
    }

    let metadata_unchanged = existing.last_stream_format == incoming.last_stream_format
        && existing.last_stream_lookup_id == incoming.last_stream_lookup_id
        && existing.last_stream_key == incoming.last_stream_key
        && existing.source_name == incoming.source_name
        && existing.source_id == incoming.source_id
        && existing.stream_family == incoming.stream_family
        && existing.absolute_season == incoming.absolute_season
        && existing.absolute_episode == incoming.absolute_episode
        && existing.stream_season == incoming.stream_season
        && existing.stream_episode == incoming.stream_episode
        && existing.title == incoming.title
        && existing.poster == incoming.poster
        && existing.backdrop == incoming.backdrop;

    if !metadata_unchanged {
        return false;
    }

    let existing_near_completion =
        is_near_completion_watch_progress(existing.position, existing.duration);
    let incoming_near_completion =
        is_near_completion_watch_progress(incoming.position, incoming.duration);

    if (incoming_near_completion && !existing_near_completion)
        || is_watched_progress(existing) != is_watched_progress(incoming)
    {
        return false;
    }

    let watched_delta = incoming.last_watched.saturating_sub(existing.last_watched);
    let position_delta = (incoming.position - existing.position).abs();
    let duration_delta = (incoming.duration - existing.duration).abs();

    watched_delta < WATCH_PROGRESS_MIN_SAVE_INTERVAL_MS
        && position_delta < WATCH_PROGRESS_POSITION_SAVE_DELTA_SECS
        && duration_delta < WATCH_PROGRESS_DURATION_SAVE_DELTA_SECS
}

pub(super) fn is_near_completion_watch_progress(position: f64, duration: f64) -> bool {
    if !position.is_finite()
        || !duration.is_finite()
        || duration < WATCH_PROGRESS_NEAR_COMPLETION_MIN_DURATION_SECS
        || position <= 0.0
    {
        return false;
    }

    let remaining = (duration - position).max(0.0);
    let progress_ratio = position / duration;

    remaining <= WATCH_PROGRESS_NEAR_COMPLETION_REMAINING_SECS
        || progress_ratio >= WATCH_PROGRESS_NEAR_COMPLETION_RATIO
}

pub(crate) fn is_series_like_watch_progress(item: &WatchProgress) -> bool {
    matches!(item.type_.as_str(), "series" | "anime")
}

pub(crate) fn watch_progress_absolute_season(item: &WatchProgress) -> Option<u32> {
    item.absolute_season.or(item.season)
}

pub(crate) fn watch_progress_absolute_episode(item: &WatchProgress) -> Option<u32> {
    item.absolute_episode.or(item.episode)
}

fn matches_exact_watch_progress_episode(
    item: &WatchProgress,
    season: Option<u32>,
    episode: Option<u32>,
) -> bool {
    match (season, episode) {
        (Some(season), Some(episode)) => {
            watch_progress_absolute_season(item) == Some(season)
                && watch_progress_absolute_episode(item) == Some(episode)
        }
        (None, None) => !is_series_like_watch_progress(item),
        _ => false,
    }
}

fn has_episode_context_watch_progress(item: &WatchProgress) -> bool {
    watch_progress_absolute_season(item).is_some()
        && watch_progress_absolute_episode(item).is_some()
}

fn hydrate_watch_progress_coordinates(item: &mut WatchProgress) {
    item.absolute_season = item.absolute_season.or(item.season);
    item.absolute_episode = item.absolute_episode.or(item.episode);
}

fn merge_watch_progress_coordinates(target: &mut WatchProgress, source: &WatchProgress) {
    target.season = target.season.or(source.season).or(source.absolute_season);
    target.episode = target
        .episode
        .or(source.episode)
        .or(source.absolute_episode);
    target.absolute_season = target
        .absolute_season
        .or(watch_progress_absolute_season(source));
    target.absolute_episode = target
        .absolute_episode
        .or(watch_progress_absolute_episode(source));
    target.stream_season = target.stream_season.or(source.stream_season);
    target.stream_episode = target.stream_episode.or(source.stream_episode);
}

fn has_stream_key_watch_progress(item: &WatchProgress) -> bool {
    item.last_stream_key.as_deref().is_some_and(non_blank)
}

fn has_source_identity_watch_progress(item: &WatchProgress) -> bool {
    item.source_id.as_deref().is_some_and(non_blank)
        || item.source_name.as_deref().is_some_and(non_blank)
}

fn has_stream_family_watch_progress(item: &WatchProgress) -> bool {
    item.stream_family.as_deref().is_some_and(non_blank)
}

fn has_source_binding_watch_progress(item: &WatchProgress) -> bool {
    // Opaque identities only — stream URLs never persist, so binding can't depend on one.
    has_usable_resume_lookup_id(item)
        || has_stream_key_watch_progress(item)
        || has_source_identity_watch_progress(item)
        || has_stream_family_watch_progress(item)
}

fn watch_progress_source_priority(
    item: &WatchProgress,
    source_health_priorities: Option<&HashMap<String, u8>>,
) -> u8 {
    item.source_id
        .as_deref()
        .and_then(normalize_source_id)
        .and_then(|id| source_health_priorities?.get(id).copied())
        .unwrap_or(super::stream_coordinator::DEFAULT_SOURCE_HEALTH_PRIORITY)
}

fn same_source_watch_progress(left: &WatchProgress, right: &WatchProgress) -> bool {
    // Instance ids are the identity of record; once both carry one, display name is presentation-only.
    if let (Some(left_id), Some(right_id)) = (
        left.source_id.as_deref().and_then(normalize_source_id),
        right.source_id.as_deref().and_then(normalize_source_id),
    ) {
        return left_id == right_id;
    }

    // Pre-`source_id` rows fall back to exact display-name equality rather than
    // treating every id-less pair as the same source.
    match (
        left.source_name.as_deref().and_then(normalize_source_key),
        right.source_name.as_deref().and_then(normalize_source_key),
    ) {
        (Some(left_source), Some(right_source)) => left_source == right_source,
        _ => false,
    }
}

fn replace_source_metadata_from_donor(target: &mut WatchProgress, donor: &WatchProgress) {
    target.last_stream_lookup_id = donor.last_stream_lookup_id.clone();
    target.last_stream_key = donor.last_stream_key.clone();
    target.source_name = donor.source_name.clone();
    target.source_id = donor.source_id.clone();
    target.stream_family = donor.stream_family.clone();
    // Donor URLs are never copied — merge results stay free of credential-bearing URLs.
    target.last_stream_format = donor.last_stream_format.clone();
}

fn merge_missing_source_metadata_from_donor(target: &mut WatchProgress, donor: &WatchProgress) {
    if !has_usable_resume_lookup_id(target) && has_usable_resume_lookup_id(donor) {
        target.last_stream_lookup_id = donor.last_stream_lookup_id.clone();
    }
    if !has_stream_key_watch_progress(target) && has_stream_key_watch_progress(donor) {
        target.last_stream_key = donor.last_stream_key.clone();
    }
    if !has_source_identity_watch_progress(target) && has_source_identity_watch_progress(donor) {
        target.source_name = donor.source_name.clone();
        target.source_id = donor.source_id.clone();
    }
    if !has_stream_family_watch_progress(target) && has_stream_family_watch_progress(donor) {
        target.stream_family = donor.stream_family.clone();
    }
    // Formats ride along with opaque identities; donor URLs never merge.
    // The target carries no URL by construction — gate on the format itself.
    if target.last_stream_format.is_none() && donor.last_stream_format.is_some() {
        target.last_stream_format = donor.last_stream_format.clone();
    }
}

fn has_usable_resume_lookup_id(item: &WatchProgress) -> bool {
    item.last_stream_lookup_id.as_deref().is_some_and(|s| {
        let trimmed = s.trim();
        !trimmed.is_empty() && (!is_series_like_watch_progress(item) || trimmed.starts_with("tt"))
    })
}

fn has_meaningful_resume_position(item: &WatchProgress) -> bool {
    item.position >= WATCH_PROGRESS_MIN_RESUME_POSITION_SECS
}

pub(crate) fn playable_resume_start_time(item: &WatchProgress) -> Option<f64> {
    if !item.position.is_finite() || item.position < WATCH_PROGRESS_MIN_RESUME_POSITION_SECS {
        return None;
    }

    if item.duration.is_finite()
        && item.duration > 0.0
        && item.position / item.duration >= WATCH_PROGRESS_MAX_RESUME_PROGRESS_RATIO
    {
        return None;
    }

    Some(item.position)
}

fn is_watched_progress(item: &WatchProgress) -> bool {
    item.position.is_finite()
        && item.duration.is_finite()
        && item.duration > 0.0
        && item.position / item.duration >= WATCH_PROGRESS_MAX_RESUME_PROGRESS_RATIO
}

pub(super) fn continue_watching_candidates(
    items: &[WatchProgress],
) -> impl Iterator<Item = &WatchProgress> {
    let mut completed = HashMap::new();
    for row in items.iter().filter(|row| is_watched_progress(row)) {
        if let Some((season, episode)) =
            watch_progress_absolute_season(row).zip(watch_progress_absolute_episode(row))
        {
            completed
                .entry((row.type_.as_str(), row.id.as_str(), season, episode))
                .and_modify(|stamp: &mut u64| *stamp = (*stamp).max(row.last_watched))
                .or_insert(row.last_watched);
        }
    }
    items.iter().filter(move |row| {
        is_continue_watching_candidate(row)
            && !watch_progress_absolute_season(row)
                .zip(watch_progress_absolute_episode(row))
                .is_some_and(|(season, episode)| {
                    completed
                        .get(&(row.type_.as_str(), row.id.as_str(), season, episode))
                        .is_some_and(|stamp| *stamp >= row.last_watched)
                })
    })
}

/// Keeps latest title metadata/recency but advances from the furthest watched
/// canonical episode so rewatches can't suggest an already-seen one.
pub(crate) fn choose_up_next_source(
    items: Vec<WatchProgress>,
    source_health_priorities: &HashMap<String, u8>,
) -> Option<WatchProgress> {
    if continue_watching_candidates(&items).next().is_some() {
        return None;
    }
    let latest = items
        .iter()
        .min_by_key(|item| std::cmp::Reverse(item.last_watched))?;
    if !is_series_like_watch_progress(latest) {
        return None;
    }
    let specials = watch_progress_absolute_season(latest)? == 0;
    let furthest = items
        .iter()
        .filter(|item| is_watched_progress(item))
        .filter_map(|item| {
            let season = watch_progress_absolute_season(item)?;
            let episode = watch_progress_absolute_episode(item)?;
            ((season == 0) == specials).then_some((season, episode))
        })
        .max()?;
    let mut source = choose_latest_entry(items, Some(source_health_priorities))?;
    if !is_watched_progress(&source) {
        return None;
    }
    source.season = Some(furthest.0);
    source.episode = Some(furthest.1);
    source.absolute_season = source.season;
    source.absolute_episode = source.episode;
    // Exact stream identities belong to the watched episode, never its successor.
    source.stream_season = None;
    source.stream_episode = None;
    source.last_stream_lookup_id = None;
    source.last_stream_key = None;
    source.last_stream_format = None;
    source.resume_start_time = None;
    Some(source)
}

/// Below this fraction a row hasn't meaningfully started — spoiler masking and the furthest-watched scan share it.
fn has_started_watching_progress(item: &WatchProgress) -> bool {
    item.position.is_finite()
        && item.duration.is_finite()
        && item.duration > 0.0
        && item.position / item.duration > WATCH_PROGRESS_STARTED_RATIO
}

/// The one read-side annotation pass: resume offer, watched mark, and started flag —
/// the UI never re-derives thresholds.
pub(crate) fn with_progress_annotations(mut item: WatchProgress) -> WatchProgress {
    hydrate_watch_progress_coordinates(&mut item);
    item.resume_start_time = playable_resume_start_time(&item);
    item.is_watched = is_watched_progress(&item);
    item.has_started_watching = has_started_watching_progress(&item);
    item
}

fn watch_progress_ratio(item: &WatchProgress) -> f64 {
    if item.duration > 0.0 {
        (item.position / item.duration).clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn is_low_confidence_resume_position(item: &WatchProgress) -> bool {
    has_meaningful_resume_position(item)
        && item.position <= WATCH_PROGRESS_LOW_CONFIDENCE_EARLY_POSITION_SECS
        && (item.duration <= 0.0
            || watch_progress_ratio(item) <= WATCH_PROGRESS_LOW_CONFIDENCE_PROGRESS_RATIO)
}

fn donor_can_supply_episode_resume(target: &WatchProgress, donor: &WatchProgress) -> bool {
    if !has_meaningful_resume_position(donor) {
        return false;
    }

    !has_episode_context_watch_progress(target)
        || watch_progress_episode_affinity(target, donor) > 0
}

fn donor_has_materially_better_resume(target: &WatchProgress, donor: &WatchProgress) -> bool {
    if donor.position <= target.position || !is_low_confidence_resume_position(target) {
        return false;
    }

    let position_delta = donor.position - target.position;
    let progress_ratio_delta =
        (watch_progress_ratio(donor) - watch_progress_ratio(target)).max(0.0);

    position_delta >= WATCH_PROGRESS_BETTER_RESUME_POSITION_DELTA_SECS
        || progress_ratio_delta >= WATCH_PROGRESS_BETTER_RESUME_PROGRESS_RATIO_DELTA
}

pub(crate) fn hydrate_watch_progress_lookup_id(item: &mut WatchProgress) {
    hydrate_watch_progress_coordinates(item);

    if has_usable_resume_lookup_id(item) {
        return;
    }

    let fallback_id = item.id.trim();
    if !fallback_id.is_empty()
        && (!is_series_like_watch_progress(item) || fallback_id.starts_with("tt"))
    {
        item.last_stream_lookup_id = Some(fallback_id.to_string());
    }
}

/// Ordering comparator shared by the per-title and global continue-watching choosers:
/// low-confidence resume positions (startup stubs) demote below meaningful ones, then
/// newest `last_watched` wins — no tie-break, so richer metadata never outranks a
/// fresher resume in the same confidence tier.
pub(crate) fn compare_continue_watching(
    left: &WatchProgress,
    right: &WatchProgress,
) -> std::cmp::Ordering {
    is_low_confidence_resume_position(left)
        .cmp(&is_low_confidence_resume_position(right))
        .then_with(|| right.last_watched.cmp(&left.last_watched))
}

fn watch_progress_episode_affinity(reference: &WatchProgress, candidate: &WatchProgress) -> u32 {
    let reference_absolute = (
        watch_progress_absolute_season(reference),
        watch_progress_absolute_episode(reference),
    );
    let candidate_absolute = (
        watch_progress_absolute_season(candidate),
        watch_progress_absolute_episode(candidate),
    );

    if reference_absolute.0.is_some()
        && reference_absolute.1.is_some()
        && reference_absolute == candidate_absolute
    {
        return 40;
    }

    if reference.season.is_some()
        && reference.episode.is_some()
        && reference.season == candidate.season
        && reference.episode == candidate.episode
    {
        return 28;
    }

    0
}

fn watch_progress_quality_score(
    reference: &WatchProgress,
    candidate: &WatchProgress,
    source_health_priorities: Option<&HashMap<String, u8>>,
) -> u32 {
    let mut score = watch_progress_episode_affinity(reference, candidate);

    if has_episode_context_watch_progress(candidate) {
        score += 20;
    }
    if has_usable_resume_lookup_id(candidate) {
        score += 20;
    }
    if has_meaningful_resume_position(candidate) {
        score += 16;
    }
    if candidate.duration > 0.0 {
        score += 12;
    }
    if has_stream_key_watch_progress(candidate) {
        score += 6;
    }
    if has_source_identity_watch_progress(candidate) {
        score += 4;
    }
    if has_stream_family_watch_progress(candidate) {
        score += 4;
    }

    match watch_progress_source_priority(candidate, source_health_priorities) {
        0 => score = score.saturating_sub(24),
        1 => score = score.saturating_sub(12),
        3 => score += 6,
        _ => {}
    }

    score
}

fn merge_watch_progress_from_donor(
    target: &mut WatchProgress,
    donor: &WatchProgress,
    source_health_priorities: Option<&HashMap<String, u8>>,
) {
    let donor_can_supply_resume = donor_can_supply_episode_resume(target, donor);
    let should_prefer_donor_resume = donor_can_supply_resume
        && (!has_meaningful_resume_position(target)
            || donor_has_materially_better_resume(target, donor));

    let target_has_source_binding = has_source_binding_watch_progress(target);
    let donor_has_source_binding = has_source_binding_watch_progress(donor);
    let target_source_priority = watch_progress_source_priority(target, source_health_priorities);
    let donor_source_priority = watch_progress_source_priority(donor, source_health_priorities);
    let same_source = same_source_watch_progress(target, donor);
    let should_replace_source_metadata = donor_can_supply_resume
        && target_has_source_binding
        && donor_has_source_binding
        && !same_source
        && donor_source_priority > target_source_priority;
    let can_merge_missing_source_metadata = donor_has_source_binding
        && (!target_has_source_binding
            || same_source
            || donor_source_priority > target_source_priority);

    merge_watch_progress_coordinates(target, donor);

    if should_replace_source_metadata {
        replace_source_metadata_from_donor(target, donor);
    } else if can_merge_missing_source_metadata {
        merge_missing_source_metadata_from_donor(target, donor);
    }
    if should_prefer_donor_resume {
        target.position = donor.position;
    }
    if should_prefer_donor_resume && donor.duration > 0.0 {
        target.duration = donor.duration;
    }
    if target.poster.is_none() && donor.poster.is_some() {
        target.poster = donor.poster.clone();
    }
    if target.backdrop.is_none() && donor.backdrop.is_some() {
        target.backdrop = donor.backdrop.clone();
    }
}

/// Which entry a caller wants out of one title's rows: latest with donor metadata merged, or latest matching exact episode coordinates.
pub(crate) enum HistoryEntryQuery<'a> {
    Latest,
    Exact {
        media_id: &'a str,
        media_type: &'a str,
        season: Option<u32>,
        episode: Option<u32>,
    },
}

pub(crate) fn choose_entry(
    items: Vec<WatchProgress>,
    query: HistoryEntryQuery<'_>,
    source_health_priorities: Option<&HashMap<String, u8>>,
) -> Option<WatchProgress> {
    match query {
        HistoryEntryQuery::Latest => choose_latest_entry(items, source_health_priorities),
        HistoryEntryQuery::Exact {
            media_id,
            media_type,
            season,
            episode,
        } => {
            let normalized_type = normalize_watch_progress_type(media_type)?;
            let normalized_id = media_id.trim();
            if normalized_id.is_empty() {
                return None;
            }
            let mut candidates = items;
            candidates.retain(|item| {
                item.id == normalized_id
                    && normalize_watch_progress_type(&item.type_) == Some(normalized_type)
            });
            let has_canonical_match = candidates
                .iter()
                .any(|item| matches_exact_watch_progress_episode(item, season, episode));
            // Raw coordinates may alias another episode's canonical claim, including for donors.
            candidates.retain(|item| {
                matches_exact_watch_progress_episode(item, season, episode)
                    || (!has_canonical_match
                        && season.is_some()
                        && episode.is_some()
                        && item.season == season
                        && item.episode == episode)
            });
            choose_latest_entry(candidates, source_health_priorities)
        }
    }
}

fn choose_latest_entry(
    mut items: Vec<WatchProgress>,
    source_health_priorities: Option<&HashMap<String, u8>>,
) -> Option<WatchProgress> {
    // `min_by_key` keeps stable-sort tie semantics (first wins) without the full ordering pass.
    let chosen_index = items
        .iter()
        .enumerate()
        .min_by_key(|(_, item)| std::cmp::Reverse(item.last_watched))?
        .0;
    if items.len() == 1 || !is_series_like_watch_progress(&items[chosen_index]) {
        let mut chosen = items.swap_remove(chosen_index);
        hydrate_watch_progress_lookup_id(&mut chosen);
        return Some(chosen);
    }
    let chosen = items[chosen_index].clone();
    Some(merge_watch_progress_donors(
        chosen,
        items.into_iter().map(Cow::Owned),
        source_health_priorities,
    ))
}

/// The donor-merge half of `choose_latest_entry`, shared with the per-episode claimant
/// map: hydrate the seed, then fold co-claimants (quality-sorted, `last_watched` ties)
/// through `merge_watch_progress_from_donor`. Non-series seeds never take donors.
/// Borrowed donors are already hydrated; owned donors must be scored before hydration.
pub(crate) fn merge_watch_progress_donors<'a>(
    mut chosen: WatchProgress,
    donors: impl IntoIterator<Item = Cow<'a, WatchProgress>>,
    source_health_priorities: Option<&HashMap<String, u8>>,
) -> WatchProgress {
    hydrate_watch_progress_lookup_id(&mut chosen);

    if !is_series_like_watch_progress(&chosen) {
        return chosen;
    }

    // Donor scan always runs for series rows — sanitization strips the persisted stream URL, so no early-exit.
    let mut donors: Vec<_> = donors.into_iter().collect();
    donors.sort_by_cached_key(|donor| {
        std::cmp::Reverse((
            watch_progress_quality_score(&chosen, donor, source_health_priorities),
            donor.last_watched,
        ))
    });

    for mut donor in donors {
        if let Cow::Owned(donor) = &mut donor {
            hydrate_watch_progress_lookup_id(donor);
        }
        merge_watch_progress_from_donor(&mut chosen, donor.as_ref(), source_health_priorities);
    }

    hydrate_watch_progress_lookup_id(&mut chosen);
    chosen
}

pub(crate) fn is_continue_watching_candidate(item: &WatchProgress) -> bool {
    playable_resume_start_time(item).is_some()
}

#[cfg(test)]
mod tests;
