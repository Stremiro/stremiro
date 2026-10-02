use super::{
    normalize_media_id, normalize_media_image_url, normalize_watch_progress_type, now_unix_millis,
    streaming_helpers::{is_persistable_stream_key, normalize_source_id, normalize_source_key},
    WatchProgress, MEDIA_TITLE_MAX_CHARS,
};
use crate::providers::{bound_optional, non_blank, trim_to_max};
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
/// Clock-skew tolerance for `last_watched`: live saves stamp backend time,
/// so a timestamp beyond now plus this skew comes from a skewed clock or a
/// crafted backup. Without clamping, one far-future row permanently wins the
/// `excluded.last_watched >=` recency guard and all later real saves drop.
const WATCH_PROGRESS_FUTURE_SKEW_MS: u64 = 5 * 60 * 1000;
/// Char bounds for free-text watch-progress fields: opaque stream identities
/// are fixed-shape digests and source names are addon labels, so anything
/// past these caps is malformed input, not a real value.
const STREAM_FORMAT_MAX_CHARS: usize = 64;
pub(crate) const STREAM_KEY_MAX_CHARS: usize = 128;
const STREAM_LOOKUP_ID_MAX_CHARS: usize = 256;
const SOURCE_NAME_MAX_CHARS: usize = 256;
const SOURCE_ID_MAX_CHARS: usize = 256;
const STREAM_FAMILY_MAX_CHARS: usize = 512;
/// Sane bound for season/episode coordinates: real catalogs never approach
/// this, so larger values are corrupt input, not data. `0` stays valid —
/// specials and the `series:{id}:0:0` movie-fallback key both use it.
const EPISODE_COORDINATE_MAX: u32 = 100_000;
/// No real title runs a week; larger finite values are corrupt input.
const WATCH_PROGRESS_MAX_SECS: f64 = 7.0 * 24.0 * 60.0 * 60.0;

pub(crate) fn normalize_episode_coordinate(value: Option<u32>) -> Option<u32> {
    value.filter(|coordinate| *coordinate <= EPISODE_COORDINATE_MAX)
}

/// History-row identity is the `(type, id, season, episode)` tuple — the
/// `movie:{id}` / `series:{id}:{s}:{e}` store key is this backend's
/// serialization of it; any frontend key shape is a separate concern.
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

/// Stream URLs are credential-bearing and short-lived: no watch-progress
/// payload may persist them. Resume re-resolves through the opaque
/// lookup/key/source identities instead, so every URL is dropped here.
pub(crate) fn sanitize_watch_progress(mut progress: WatchProgress) -> Option<WatchProgress> {
    // The id is a store key: reject rather than truncate so two hostile ids
    // can't collide onto one key. An empty id collapses every row onto one
    // `movie:`/`series:0:0` key; the live save path rejects it, so imports
    // must drop it too.
    progress.id = normalize_media_id(&progress.id)?;
    progress.type_ = normalize_watch_progress_type(&progress.type_)?.to_string();
    progress.resume_start_time = None;
    progress.is_watched = false;
    progress.has_started_watching = false;

    // A far-future timestamp would permanently win recency guards and freeze
    // out every later save; clamp to backend now instead of dropping the row.
    let now = now_unix_millis();
    if progress.last_watched > now.saturating_add(WATCH_PROGRESS_FUTURE_SKEW_MS) {
        progress.last_watched = now;
    }

    // Out-of-range coordinates would persist into `series:{id}:{s}:{e}` keys
    // as garbage rows; corrupt coordinates degrade to absent rather than
    // writing a key that can never match a real episode.
    progress.season = normalize_episode_coordinate(progress.season);
    progress.episode = normalize_episode_coordinate(progress.episode);
    progress.absolute_season = normalize_episode_coordinate(progress.absolute_season);
    progress.absolute_episode = normalize_episode_coordinate(progress.absolute_episode);
    progress.stream_season = normalize_episode_coordinate(progress.stream_season);
    progress.stream_episode = normalize_episode_coordinate(progress.stream_episode);

    hydrate_watch_progress_coordinates(&mut progress);
    // Non-finite floats (NaN, ±inf) serialize to JSON null and silently drop
    // the row on read; clamp rather than persist a value that can't round-trip.
    // A finite but absurd value would overflow the hours-watched sum.
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

    // Match the live save path, which stores `Untitled` for empty titles, so
    // exports round-trip through imports without polluting blank rows.
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
    // Legacy `u:`-prefixed keys embed the normalized stream URL verbatim
    // (signed query credentials included); only opaque hash identities may
    // cross the boundary — the `h:`/`uh:` content keys and the `s:` prepared
    // selector key (a SHA-256 over content key + source + transport).
    progress.last_stream_key = bound_optional(progress.last_stream_key, STREAM_KEY_MAX_CHARS)
        .filter(|key| is_persistable_stream_key(key));
    progress.source_name = bound_optional(progress.source_name, SOURCE_NAME_MAX_CHARS);
    progress.source_id = bound_optional(progress.source_id, SOURCE_ID_MAX_CHARS);
    progress.stream_family = bound_optional(progress.stream_family, STREAM_FAMILY_MAX_CHARS);

    Some(progress)
}

pub(crate) fn should_skip_watch_progress_save(
    existing: &WatchProgress,
    incoming: &WatchProgress,
) -> bool {
    if existing.id != incoming.id
        || existing.type_ != incoming.type_
        || existing.season != incoming.season
        || existing.episode != incoming.episode
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

fn is_series_like_watch_progress(item: &WatchProgress) -> bool {
    matches!(item.type_.as_str(), "series" | "anime")
}

fn watch_progress_absolute_season(item: &WatchProgress) -> Option<u32> {
    item.absolute_season.or(item.season)
}

fn watch_progress_absolute_episode(item: &WatchProgress) -> Option<u32> {
    item.absolute_episode.or(item.episode)
}

fn matches_exact_watch_progress_episode(
    item: &WatchProgress,
    season: Option<u32>,
    episode: Option<u32>,
) -> bool {
    match (season, episode) {
        (Some(season), Some(episode)) => {
            (watch_progress_absolute_season(item) == Some(season)
                && watch_progress_absolute_episode(item) == Some(episode))
                || (item.season == Some(season) && item.episode == Some(episode))
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
    if item.absolute_season.is_none() {
        item.absolute_season = item.season;
    }
    if item.absolute_episode.is_none() {
        item.absolute_episode = item.episode;
    }
}

fn merge_watch_progress_coordinates(target: &mut WatchProgress, source: &WatchProgress) {
    if target.season.is_none() {
        target.season = source.season.or(source.absolute_season);
    }
    if target.episode.is_none() {
        target.episode = source.episode.or(source.absolute_episode);
    }
    if target.absolute_season.is_none() {
        target.absolute_season = watch_progress_absolute_season(source);
    }
    if target.absolute_episode.is_none() {
        target.absolute_episode = watch_progress_absolute_episode(source);
    }
    if target.stream_season.is_none() {
        target.stream_season = source.stream_season;
    }
    if target.stream_episode.is_none() {
        target.stream_episode = source.stream_episode;
    }
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
    // Opaque identities only: stream URLs never persist (sanitized to None),
    // so binding must not depend on a URL being present.
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
        .and_then(|id| source_health_priorities?.get(&id).copied())
        .unwrap_or(super::stream_coordinator::DEFAULT_SOURCE_HEALTH_PRIORITY)
}

fn same_source_watch_progress(left: &WatchProgress, right: &WatchProgress) -> bool {
    // Instance ids are the identity of record; once both rows carry one
    // the display name is presentation-only.
    if let (Some(left_id), Some(right_id)) = (
        left.source_id.as_deref().and_then(normalize_source_id),
        right.source_id.as_deref().and_then(normalize_source_id),
    ) {
        return left_id == right_id;
    }

    // Rows saved before `source_id` existed fall back to exact
    // display-name equality — the pre-instance-id semantics — rather than
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
    // Stream URLs are credential-bearing and short-lived: donor URLs are
    // never copied, so merge results stay free of durable URLs.
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
    // Stream URLs are credential-bearing and short-lived: formats ride along
    // with opaque identities, but donor URLs are never merged into the target.
    // The target carries no URL by construction, so gate on the format itself.
    if target.last_stream_format.is_none() && donor.last_stream_format.is_some() {
        target.last_stream_format = donor.last_stream_format.clone();
    }
}

fn has_usable_resume_lookup_id(item: &WatchProgress) -> bool {
    item.last_stream_lookup_id.as_deref().is_some_and(|s| {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            return false;
        }
        if is_series_like_watch_progress(item) {
            trimmed.starts_with("tt")
        } else {
            true
        }
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

/// Keep the latest title metadata and recency, but advance from the furthest
/// watched canonical episode so rewatches cannot suggest an already seen one.
pub(crate) fn choose_up_next_source(
    items: Vec<WatchProgress>,
    source_health_priorities: &HashMap<String, u8>,
) -> Option<WatchProgress> {
    if items.iter().any(is_continue_watching_candidate) {
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

/// Below this fraction a row hasn't meaningfully started: spoiler masking and
/// the furthest-watched scan share the boundary.
fn has_started_watching_progress(item: &WatchProgress) -> bool {
    item.position.is_finite()
        && item.duration.is_finite()
        && item.duration > 0.0
        && item.position / item.duration > WATCH_PROGRESS_STARTED_RATIO
}

/// The one read-side annotation pass: resume offer, watched mark, and
/// started flag come from the same policy the backend decides with, so the UI
/// never re-derives thresholds.
pub(crate) fn with_progress_annotations(mut item: WatchProgress) -> WatchProgress {
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
    if !donor_can_supply_episode_resume(target, donor) {
        return false;
    }

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
    if fallback_id.is_empty() {
        return;
    }

    if is_series_like_watch_progress(item) {
        if fallback_id.starts_with("tt") {
            item.last_stream_lookup_id = Some(fallback_id.to_string());
        }
    } else {
        item.last_stream_lookup_id = Some(fallback_id.to_string());
    }
}

/// Ordering comparator shared by the per-title continue-watching chooser and
/// the global continue-watching list: low-confidence resume positions
/// (startup stubs) demote below meaningful ones, then newest `last_watched`
/// wins — no weighted tie-break, so richer metadata on an older row can never
/// outrank a fresher resume in the same confidence tier.
/// Watched ratios only inform the startup-confidence check; they contribute
/// no ranking points.
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

/// Which entry a caller wants out of one title's history rows: the latest
/// row with donor metadata merged, the best resumable row across episodes,
/// or the latest row matching exact episode coordinates.
pub(crate) enum HistoryEntryQuery<'a> {
    Latest,
    ContinueWatching,
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
        HistoryEntryQuery::ContinueWatching => choose_continue_watching_entry(items),
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
            choose_latest_entry(
                items
                    .into_iter()
                    .filter(|item| {
                        item.id == normalized_id
                            && normalize_watch_progress_type(&item.type_) == Some(normalized_type)
                            && matches_exact_watch_progress_episode(item, season, episode)
                    })
                    .collect(),
                source_health_priorities,
            )
        }
    }
}

fn choose_latest_entry(
    items: Vec<WatchProgress>,
    source_health_priorities: Option<&HashMap<String, u8>>,
) -> Option<WatchProgress> {
    // `min_by_key` keeps stable-sort tie semantics (first row wins) without
    // the full ordering pass — the donor sort below re-orders anyway.
    let mut chosen = items
        .iter()
        .min_by_key(|item| std::cmp::Reverse(item.last_watched))?
        .clone();
    hydrate_watch_progress_lookup_id(&mut chosen);

    if !is_series_like_watch_progress(&chosen) {
        return Some(chosen);
    }

    // The donor scan always runs for series rows — sanitization strips the
    // persisted stream URL to NULL, so no "complete snapshot" early-exit.
    let mut donors = items;
    donors.sort_by_cached_key(|donor| {
        std::cmp::Reverse((
            watch_progress_quality_score(&chosen, donor, source_health_priorities),
            donor.last_watched,
        ))
    });

    for mut donor in donors {
        hydrate_watch_progress_lookup_id(&mut donor);
        merge_watch_progress_from_donor(&mut chosen, &donor, source_health_priorities);
    }

    hydrate_watch_progress_lookup_id(&mut chosen);
    Some(chosen)
}

/// `build_history_key` keys rows by `(id, season, episode)`, so the choice
/// is direct: hydrate every row, keep the playable candidates, and take the
/// first under the shared continue-watching ordering.
fn choose_continue_watching_entry(items: Vec<WatchProgress>) -> Option<WatchProgress> {
    // `min_by` returns the first element on full (confidence, recency) ties —
    // the loader's deterministic DB order — without collecting or sorting the
    // candidate vec.
    items
        .into_iter()
        .map(|mut item| {
            hydrate_watch_progress_lookup_id(&mut item);
            item
        })
        .filter(is_continue_watching_candidate)
        .min_by(compare_continue_watching)
}

pub(crate) fn is_continue_watching_candidate(item: &WatchProgress) -> bool {
    playable_resume_start_time(item).is_some()
}

#[cfg(test)]
mod tests;
