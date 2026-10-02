use super::{normalize_media_image_url, MEDIA_ID_MAX_CHARS, MEDIA_TITLE_MAX_CHARS};
use crate::providers::{
    bound_optional, extract_primary_year, trim_to_max, Episode, MediaDetails, MediaItem,
};
use regex::Regex;
use std::sync::LazyLock;

/// Untrusted addon/backup field bounds shared by the catalog, details, and
/// store normalization paths — one definition for one policy.
pub(crate) const MEDIA_DESCRIPTION_MAX_CHARS: usize = 4_096;
pub(crate) const MEDIA_YEAR_MAX_CHARS: usize = 32;
pub(crate) const MEDIA_GENRES_MAX: usize = 16;
pub(crate) const MEDIA_GENRE_MAX_CHARS: usize = 64;
/// Details-only bounds for pathological meta payloads: response-size caps
/// already keep these unreachable for honest addons, so they bound hostile
/// input without ever truncating real catalogs.
const MEDIA_DETAILS_RATING_MAX_CHARS: usize = 64;
const MEDIA_DETAILS_CAST_MAX: usize = 64;
const MEDIA_DETAILS_CAST_NAME_MAX_CHARS: usize = 128;
const EPISODE_ID_MAX_CHARS: usize = 256;
const EPISODE_TITLE_MAX_CHARS: usize = 512;
const EPISODE_RELEASED_MAX_CHARS: usize = 64;
const EPISODE_OVERVIEW_MAX_CHARS: usize = 4_096;
const EPISODE_THUMBNAIL_MAX_CHARS: usize = 2_048;

// `\b` after the day group fails on ISO datetimes (`2024-07-18T00:00:00.000Z` —
// `8T` is word-to-word), which is exactly the Cinemeta `released` shape; a
// non-digit terminator accepts it while still rejecting a longer digit run.
static RELEASE_DATE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(\d{4})-(\d{2})-(\d{2})(?:[^\d]|$)").expect("valid release date regex")
});

pub(crate) fn build_display_year(value: Option<&str>) -> Option<String> {
    extract_primary_year(value).map(|year| year.to_string())
}

/// Trim + char-bound a required field; the field stays present even when the
/// payload collapses to empty (callers that need a title reject separately).
fn bound_required(value: &str, max_chars: usize) -> String {
    value.trim().chars().take(max_chars).collect()
}

// Display text only: preserve punctuation, language and emoji sequences.
fn normalize_title(value: &str, max_chars: usize) -> String {
    let mut title = String::with_capacity(value.len().min(max_chars));
    let mut length = 0;
    let mut pending_space = false;
    for character in value.chars() {
        if length == max_chars {
            break;
        }
        if character.is_whitespace() {
            pending_space = !title.is_empty();
            continue;
        }
        if character.is_control() || character == '\u{feff}' {
            continue;
        }
        if pending_space {
            if length + 1 == max_chars {
                break;
            }
            title.push(' ');
            length += 1;
            pending_space = false;
        }
        title.push(character);
        length += 1;
    }
    title
}

fn bound_string_list(
    values: Option<Vec<String>>,
    max_items: usize,
    max_chars: usize,
) -> Option<Vec<String>> {
    let bounded: Vec<String> = values
        .unwrap_or_default()
        .iter()
        .filter_map(|value| trim_to_max(value, max_chars))
        .take(max_items)
        .collect();
    (!bounded.is_empty()).then_some(bounded)
}

fn normalize_episode_metadata(mut episode: Episode) -> Episode {
    episode.id = bound_required(&episode.id, EPISODE_ID_MAX_CHARS);
    episode.title = episode
        .title
        .map(|title| normalize_title(&title, EPISODE_TITLE_MAX_CHARS))
        .filter(|title| !title.is_empty());
    episode.released = bound_optional(episode.released, EPISODE_RELEASED_MAX_CHARS);
    episode.release_date = build_release_date(episode.released.as_deref());
    episode.overview = bound_optional(episode.overview, EPISODE_OVERVIEW_MAX_CHARS);
    episode.thumbnail = bound_optional(episode.thumbnail, EPISODE_THUMBNAIL_MAX_CHARS);
    episode
}

pub(crate) fn normalize_episode_metadata_list(episodes: Vec<Episode>) -> Vec<Episode> {
    // The only producer is `parse_episodes`, which already caps at
    // MAX_EPISODES — no second bound needed here.
    episodes
        .into_iter()
        .map(normalize_episode_metadata)
        .collect()
}

pub(crate) fn days_in_month(year: u32, month: u32) -> Option<u32> {
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            let is_leap_year =
                (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400);
            if is_leap_year {
                29
            } else {
                28
            }
        }
        _ => return None,
    };

    Some(days)
}

pub(crate) fn build_release_date(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }

    // Invalid full dates must not fall through to the year-only fallback.
    if let Some(captures) = RELEASE_DATE_REGEX.captures(value) {
        let year = captures.get(1)?.as_str().parse::<u32>().ok()?;
        let month = captures.get(2)?.as_str().parse::<u32>().ok()?;
        let day = captures.get(3)?.as_str().parse::<u32>().ok()?;
        return ((1889..=2100).contains(&year)
            && days_in_month(year, month).is_some_and(|max_day| (1..=max_day).contains(&day)))
        .then(|| format!("{year:04}-{month:02}-{day:02}"));
    }

    extract_primary_year(Some(value)).map(|year| format!("{year:04}-01-01"))
}

pub(crate) fn normalize_media_item(mut item: MediaItem) -> MediaItem {
    item.title = normalize_title(&item.title, MEDIA_TITLE_MAX_CHARS);
    item.poster = item.poster.and_then(|s| normalize_media_image_url(&s));
    item.backdrop = item.backdrop.and_then(|s| normalize_media_image_url(&s));
    item.logo = item.logo.and_then(|s| normalize_media_image_url(&s));
    item.description = bound_optional(item.description, MEDIA_DESCRIPTION_MAX_CHARS);
    item.year = bound_optional(item.year, MEDIA_YEAR_MAX_CHARS);
    item.genres = bound_string_list(item.genres, MEDIA_GENRES_MAX, MEDIA_GENRE_MAX_CHARS);
    let primary_year = extract_primary_year(item.year.as_deref());
    item.display_year = primary_year.map(|year| year.to_string());
    item.primary_year = primary_year;
    item
}

pub(crate) fn normalize_media_items(items: Vec<MediaItem>) -> Vec<MediaItem> {
    items
        .into_iter()
        .map(normalize_media_item)
        .filter(|item| !item.title.is_empty())
        .collect()
}

pub(crate) fn normalize_media_details(
    mut details: MediaDetails,
    requested_id: &str,
) -> MediaDetails {
    // Addons may return an alias; persistence and navigation use the requested identity.
    if details.id != requested_id {
        details.id = requested_id.to_string();
    }
    details.title = normalize_title(&details.title, MEDIA_TITLE_MAX_CHARS);
    details.imdb_id = bound_optional(details.imdb_id, MEDIA_ID_MAX_CHARS);
    details.poster = details.poster.and_then(|s| normalize_media_image_url(&s));
    details.backdrop = details.backdrop.and_then(|s| normalize_media_image_url(&s));
    details.logo = details.logo.and_then(|s| normalize_media_image_url(&s));
    details.description = bound_optional(details.description, MEDIA_DESCRIPTION_MAX_CHARS);
    details.rating = bound_optional(details.rating, MEDIA_DETAILS_RATING_MAX_CHARS);
    details.year = bound_optional(details.year, MEDIA_YEAR_MAX_CHARS);
    details.cast = bound_string_list(
        details.cast,
        MEDIA_DETAILS_CAST_MAX,
        MEDIA_DETAILS_CAST_NAME_MAX_CHARS,
    );
    details.genres = bound_string_list(details.genres, MEDIA_GENRES_MAX, MEDIA_GENRE_MAX_CHARS);
    // Trailers need no bounding here: `parse_trailers` is the only producer
    // and already caps the list and admits strict 11-char YouTube ids only.
    details.display_year = build_display_year(details.year.as_deref());
    // A parsed meta `released` (full ISO date) wins over the year-only
    // fallback so calendar movie events land on the real day, not Jan 1.
    details.release_date = build_release_date(details.release_date.as_deref())
        .or_else(|| build_release_date(details.year.as_deref()));
    details.episodes = details.episodes.take().map(normalize_episode_metadata_list);
    details
}

#[cfg(test)]
mod tests;
