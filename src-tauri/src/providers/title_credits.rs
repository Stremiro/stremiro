use super::anime_ids::{parse_anime_id, resolve_anime_ids, AnimeId, AnimeIds, ANIME_ID_MAX};
use super::enrichment::{EnrichmentClient, Source};
use super::skip_times::normalize_imdb_id;
use serde::Serialize;

/// Credits payload crossing IPC; mirrors the frontend `TitleCredits` type.
/// Populated data only - a definitive provider miss yields the empty shape.
#[derive(Debug, Serialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TitleCredits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<&'static str>,
    pub people: Vec<TitlePerson>,
    pub facts: TitleFacts,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_airing_episode: Option<NextAiringEpisode>,
    pub streaming_links: Vec<StreamingLink>,
}

#[derive(Debug, Serialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TitlePerson {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub character: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voice_actor: Option<String>,
}

#[derive(Debug, Serialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TitleFacts {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub studio: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_minutes: Option<u32>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NextAiringEpisode {
    pub episode: u32,
    pub airing_at: u64,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StreamingLink {
    pub site: String,
    pub url: String,
}

const MAX_PEOPLE: usize = 24;
const MAX_STREAMING_SITES: usize = 4;
const MAX_NAME_CHARS: usize = 128;
const MAX_FACT_CHARS: usize = 256;
const MAX_LINK_URL_CHARS: usize = 2048;
const MAX_STUDIOS: usize = 3;
const ROW_SCAN_LIMIT: usize = 64;
const TRANSIENT_ERROR: &str = "Credits data is temporarily unavailable.";

const ANILIST_CREDITS_FIELDS: &str = "id idMal status format duration studios(isMain: true) { nodes { name } } characters(perPage: 12, sort: [ROLE, RELEVANCE, ID]) { edges { role node { name { full } image { large } } voiceActors(language: JAPANESE) { name { full } } } } nextAiringEpisode { episode airingAt } externalLinks { site url type isDisabled }";

/// AniList treats an explicit null variable as a filter: the request must
/// carry exactly one of `id`/`idMal`. `argument` is a fixed literal, never
/// user input.
fn anilist_request_body(argument: &'static str, value: u32) -> Vec<u8> {
    let query = format!(
        "query TitleCredits(${argument}: Int!) {{ Media({argument}: ${argument}, type: ANIME) {{ {ANILIST_CREDITS_FIELDS} }} }}"
    );
    serde_json::json!({"query": query, "variables": {argument: value}})
        .to_string()
        .into_bytes()
}

fn bound_text(value: Option<&serde_json::Value>, max: usize) -> Option<String> {
    let text = value?.as_str()?.trim();
    (!text.is_empty())
        .then(|| text.chars().take(max).collect())
        .filter(|text: &String| !text.is_empty())
}

/// External http(s) link: bounded, no credentials, no non-routable host;
/// returns the normalized URL, not the raw bytes.
fn safe_link_url(value: Option<&serde_json::Value>) -> Option<String> {
    let raw = value?.as_str()?.trim();
    if raw.is_empty() || raw.chars().count() > MAX_LINK_URL_CHARS {
        return None;
    }
    super::addon_resource::parse_fetchable_http_url(raw).map(Into::into)
}

fn image_url(value: Option<&serde_json::Value>) -> Option<String> {
    super::addon_resource::normalize_image_url(value?.as_str()?)
}

/// `get_title_credits` IPC entry point: movie returns empty without HTTP;
/// anime routes AniList, other series route TVmaze. No cross-source fallback.
pub(crate) async fn get_title_credits(
    client: &EnrichmentClient,
    media_type: &str,
    id: &str,
    imdb_id: Option<&str>,
) -> Result<TitleCredits, String> {
    let media_type = media_type.trim();
    if media_type.eq_ignore_ascii_case("movie") {
        return Ok(TitleCredits::default());
    }
    if media_type.eq_ignore_ascii_case("anime") || parse_anime_id(id).is_some() {
        return anilist_credits(client, id, imdb_id).await;
    }
    // Only a provable series shape reaches TVmaze; anything else is empty.
    if !media_type.eq_ignore_ascii_case("series") {
        return Ok(TitleCredits::default());
    }
    tvmaze_credits(client, id, imdb_id).await
}

/// Open only fixed attribution pages or links validated for this title.
pub(crate) async fn validate_title_link(
    client: &EnrichmentClient,
    media_type: &str,
    id: &str,
    imdb_id: Option<&str>,
    url: &str,
) -> Result<(), String> {
    if matches!(
        url,
        "https://www.tvmaze.com"
            | "https://anilist.co"
            | "https://creativecommons.org/licenses/by-sa/4.0/"
    ) {
        return Ok(());
    }
    let credits = get_title_credits(client, media_type, id, imdb_id).await?;
    if credits.streaming_links.iter().any(|link| link.url == url) {
        Ok(())
    } else {
        Err("This title link is unavailable.".to_string())
    }
}

/// A wholly empty payload serializes `source: None` so the wire shape
/// matches the definitive-miss shape (and its shorter frontend TTL).
fn with_source(source: &'static str, mut credits: TitleCredits) -> TitleCredits {
    if credits.people.is_empty()
        && credits.streaming_links.is_empty()
        && credits.facts == TitleFacts::default()
        && credits.next_airing_episode.is_none()
    {
        return TitleCredits::default();
    }
    credits.source = Some(source);
    credits
}

// --- TVmaze ---

async fn tvmaze_credits(
    client: &EnrichmentClient,
    id: &str,
    imdb_id: Option<&str>,
) -> Result<TitleCredits, String> {
    let Some(imdb) = imdb_id
        .and_then(normalize_imdb_id)
        .or_else(|| normalize_imdb_id(id))
    else {
        return Ok(TitleCredits::default());
    };
    let key = format!("tvmaze-lookup:{imdb}");
    let url = format!(
        "{}/lookup/shows?imdb={imdb}",
        client.base_url(Source::Tvmaze)
    );
    let Some(show) = client
        .load(&key, Source::Tvmaze, client.get(&url), decode_tvmaze_show)
        .await?
    else {
        return Ok(TitleCredits::default());
    };
    let show_id = show["id"].as_u64().unwrap_or_default();
    let cast_key = format!("tvmaze-cast:v2:{show_id}");
    let cast_url = format!("{}/shows/{show_id}/cast", client.base_url(Source::Tvmaze));
    // A cast miss still leaves the lookup facts usable.
    let people = client
        .load(
            &cast_key,
            Source::Tvmaze,
            client.get(&cast_url),
            decode_tvmaze_cast,
        )
        .await?
        .unwrap_or_default();
    Ok(with_source(
        "tvmaze",
        TitleCredits {
            people,
            facts: tvmaze_facts(&show),
            ..TitleCredits::default()
        },
    ))
}

fn decode_tvmaze_show(bytes: &[u8]) -> Result<(Option<serde_json::Value>, bool), String> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| TRANSIENT_ERROR.to_string())?;
    if value.is_null() {
        return Ok((None, true));
    }
    // A valid show carries a positive bounded numeric id.
    match value["id"]
        .as_u64()
        .filter(|id| *id > 0 && *id <= ANIME_ID_MAX)
    {
        Some(_) => Ok((Some(value), false)),
        None => Err(TRANSIENT_ERROR.to_string()),
    }
}

fn decode_tvmaze_cast(bytes: &[u8]) -> Result<(Option<Vec<TitlePerson>>, bool), String> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| TRANSIENT_ERROR.to_string())?;
    if value.is_null() {
        return Ok((None, true));
    }
    let rows = value
        .as_array()
        .ok_or_else(|| TRANSIENT_ERROR.to_string())?;
    let people = rows
        .iter()
        .take(ROW_SCAN_LIMIT)
        .filter_map(|row| {
            let person = row.get("person")?;
            let name = bound_text(person.get("name"), MAX_NAME_CHARS)?;
            Some(TitlePerson {
                name,
                image_url: image_url(person.get("image").and_then(|i| i.get("medium"))),
                role: "Cast".to_string(),
                character: bound_text(
                    row.get("character").and_then(|c| c.get("name")),
                    MAX_NAME_CHARS,
                ),
                voice_actor: None,
            })
        })
        .take(MAX_PEOPLE)
        .collect::<Vec<_>>();
    let empty = people.is_empty();
    Ok((Some(people), empty))
}

fn tvmaze_facts(show: &serde_json::Value) -> TitleFacts {
    const WEEKDAYS: [&str; 7] = [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
    ];
    let status = bound_text(show.get("status"), MAX_FACT_CHARS);
    // Only a Running show may advertise its weekly schedule; a finished
    // show's stored row is stale air-time, not upcoming programming.
    let schedule = (status.as_deref() == Some("Running")).then(|| {
        let mut seen = std::collections::HashSet::new();
        let days: Vec<&str> = show["schedule"]["days"]
            .as_array()
            .into_iter()
            .flatten()
            .take(ROW_SCAN_LIMIT)
            .filter_map(serde_json::Value::as_str)
            .filter(|day| WEEKDAYS.contains(day) && seen.insert(*day))
            .take(7)
            .collect();
        let time = show["schedule"]["time"].as_str().filter(|time| {
            time.len() == 5
                && time.as_bytes()[2] == b':'
                && time[..2].bytes().all(|b| b.is_ascii_digit())
                && time[3..].bytes().all(|b| b.is_ascii_digit())
                && time[..2].parse::<u32>().is_ok_and(|h| h < 24)
                && time[3..].parse::<u32>().is_ok_and(|m| m < 60)
        });
        let timezone = show["network"]["country"]["timezone"]
            .as_str()
            .filter(|tz| !tz.is_empty() && tz.len() <= 64);
        if days.is_empty() {
            return None;
        }
        let mut text = days.join(", ");
        if let Some(time) = time {
            text.push_str(" at ");
            text.push_str(time);
        }
        if let Some(tz) = timezone {
            text.push_str(" (");
            text.push_str(tz);
            text.push(')');
        }
        Some(text.chars().take(MAX_FACT_CHARS).collect())
    });
    let runtime_minutes = show["runtime"]
        .as_u64()
        .filter(|mins| (1..=1440).contains(mins))
        .or_else(|| {
            show["averageRuntime"]
                .as_u64()
                .filter(|mins| (1..=1440).contains(mins))
        })
        .and_then(|mins| u32::try_from(mins).ok());
    TitleFacts {
        network: bound_text(show["network"].get("name"), MAX_FACT_CHARS)
            .or_else(|| bound_text(show["webChannel"].get("name"), MAX_FACT_CHARS)),
        status,
        schedule: schedule.flatten(),
        format: bound_text(show.get("type"), MAX_FACT_CHARS),
        runtime_minutes,
        ..TitleFacts::default()
    }
}

// --- AniList ---

async fn anilist_credits(
    client: &EnrichmentClient,
    id: &str,
    imdb_id: Option<&str>,
) -> Result<TitleCredits, String> {
    let Some((argument, value)) = anilist_lookup_ids(client, id, imdb_id).await? else {
        return Ok(TitleCredits::default());
    };
    let body = anilist_request_body(argument, value);
    let key = format!("anilist-credits:v4:{argument}:{value}");
    let url = client.base_url(Source::AniList).to_string();
    client
        .load(
            &key,
            Source::AniList,
            client.post_json(&url, body),
            |bytes| decode_anilist_credits(bytes, argument, value),
        )
        .await
}

/// Pick the single AniList identifier: direct family ids need no bridge;
/// IMDb/kitsu resolve through the cached ARM rows with exactly-one season-1
/// agreement or exactly-one distinct mapping. Anything else is empty.
async fn anilist_lookup_ids(
    client: &EnrichmentClient,
    id: &str,
    imdb_id: Option<&str>,
) -> Result<Option<(&'static str, u32)>, String> {
    match parse_anime_id(id) {
        Some(AnimeId::Mal(mal)) => return Ok(Some(("idMal", mal))),
        Some(AnimeId::AniList(anilist)) => return Ok(Some(("id", anilist))),
        _ => {}
    }
    let rows = match parse_anime_id(id) {
        Some(AnimeId::Kitsu(_)) => resolve_anime_ids(client, id).await?,
        _ => match imdb_id
            .and_then(normalize_imdb_id)
            .or_else(|| normalize_imdb_id(id))
        {
            Some(imdb) => resolve_anime_ids(client, &imdb).await?,
            None => return Ok(None),
        },
    };
    Ok(pick_bridge_pair(&rows))
}

/// Exactly-one rule: all-populated season fields agreeing on season 1 pick
/// the primary entry; failing that, a single distinct mapping total wins;
/// zero or ambiguous mappings yield nothing - never a first-row guess.
fn pick_bridge_pair(rows: &[AnimeIds]) -> Option<(&'static str, u32)> {
    fn preferred(row: &AnimeIds) -> Option<(&'static str, u32)> {
        // AniList id queries hit the primary endpoint; MAL is the fallback.
        row.anilist_id
            .map(|id| ("id", id))
            .or_else(|| row.mal_id.map(|id| ("idMal", id)))
    }
    let mut season_one: Vec<_> = rows
        .iter()
        .filter(|row| {
            [row.tvdb_season, row.tmdb_season]
                .into_iter()
                .flatten()
                .all(|field| field == 1)
                && (row.tvdb_season.is_some() || row.tmdb_season.is_some())
        })
        .filter_map(preferred)
        .collect();
    season_one.sort_unstable();
    season_one.dedup();
    if let [pair] = season_one.as_slice() {
        return Some(*pair);
    }
    let mut all: Vec<_> = rows.iter().filter_map(preferred).collect();
    all.sort_unstable();
    all.dedup();
    match all.as_slice() {
        [pair] => Some(*pair),
        _ => None,
    }
}

fn decode_anilist_credits(
    bytes: &[u8],
    argument: &str,
    expected_id: u32,
) -> Result<(TitleCredits, bool), String> {
    const INVALID: &str = "Invalid credits response.";
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| INVALID.to_string())?;
    if value.is_null() {
        return Ok((TitleCredits::default(), true));
    }
    let object = value.as_object().ok_or_else(|| INVALID.to_string())?;
    // GraphQL errors are failures even at HTTP 200; a wrong-typed field is too.
    if let Some(errors) = object.get("errors") {
        if errors.as_array().is_some_and(|errors| !errors.is_empty()) || !errors.is_array() {
            return Err(INVALID.to_string());
        }
    }
    let media = object
        .get("data")
        .and_then(|data| data.get("Media"))
        .ok_or_else(|| INVALID.to_string())?;
    if media.is_null() {
        return Ok((TitleCredits::default(), true));
    }
    if media[argument].as_u64() != Some(u64::from(expected_id)) {
        return Err(INVALID.to_string());
    }
    // A queried Media must carry its non-null bounded id.
    match media["id"]
        .as_u64()
        .filter(|id| *id > 0 && *id <= ANIME_ID_MAX)
    {
        Some(_) => {}
        None => return Err(INVALID.to_string()),
    }
    let credits = TitleCredits {
        people: anilist_people(media),
        facts: TitleFacts {
            studio: media["studios"]["nodes"]
                .as_array()
                .map(|nodes| {
                    nodes
                        .iter()
                        .filter_map(|node| bound_text(node.get("name"), MAX_NAME_CHARS))
                        .take(MAX_STUDIOS)
                        .collect::<Vec<_>>()
                })
                .filter(|names| !names.is_empty())
                .map(|names| names.join(", ").chars().take(MAX_FACT_CHARS).collect()),
            status: media["status"].as_str().and_then(|status| {
                Some(
                    match status {
                        "FINISHED" => "Finished",
                        "RELEASING" => "Airing",
                        "NOT_YET_RELEASED" => "Not yet aired",
                        "CANCELLED" => "Cancelled",
                        "HIATUS" => "On hiatus",
                        _ => return None,
                    }
                    .to_string(),
                )
            }),
            format: bound_text(media.get("format"), MAX_FACT_CHARS),
            runtime_minutes: media["duration"]
                .as_u64()
                .filter(|mins| (1..=1440).contains(mins))
                .and_then(|mins| u32::try_from(mins).ok()),
            ..TitleFacts::default()
        },
        next_airing_episode: media["nextAiringEpisode"].as_object().and_then(|episode| {
            let number = episode["episode"].as_u64().filter(|n| *n > 0)?;
            let airing_at = episode["airingAt"].as_u64().filter(|t| *t > 0)?;
            // Unix seconds bounded to year 2100.
            (airing_at <= 4_102_444_800).then_some(NextAiringEpisode {
                episode: u32::try_from(number).ok()?,
                airing_at,
            })
        }),
        streaming_links: anilist_streaming(media),
        ..TitleCredits::default()
    };
    let credits = with_source("anilist", credits);
    let empty = credits.source.is_none();
    Ok((credits, empty))
}

fn anilist_people(media: &serde_json::Value) -> Vec<TitlePerson> {
    media["characters"]["edges"]
        .as_array()
        .into_iter()
        .flatten()
        .take(ROW_SCAN_LIMIT)
        .filter_map(|edge| {
            let role = match edge["role"].as_str()? {
                "MAIN" => "Main",
                "SUPPORTING" => "Supporting",
                _ => return None,
            };
            let node = edge.get("node")?;
            Some(TitlePerson {
                name: bound_text(node["name"].get("full"), MAX_NAME_CHARS)?,
                image_url: image_url(node["image"].get("large")),
                role: role.to_string(),
                character: None,
                voice_actor: edge["voiceActors"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find_map(|actor| bound_text(actor["name"].get("full"), MAX_NAME_CHARS)),
            })
        })
        .take(MAX_PEOPLE)
        .collect()
}

fn anilist_streaming(media: &serde_json::Value) -> Vec<StreamingLink> {
    let mut seen = std::collections::HashSet::new();
    media["externalLinks"]
        .as_array()
        .into_iter()
        .flatten()
        .take(ROW_SCAN_LIMIT)
        .filter(|row| {
            row["type"].as_str() == Some("STREAMING") && row["isDisabled"].as_bool() == Some(false)
        })
        .filter_map(|row| {
            let site = bound_text(row.get("site"), MAX_NAME_CHARS)?;
            let url = safe_link_url(row.get("url"))?;
            seen.insert(site.to_lowercase())
                .then_some(StreamingLink { site, url })
        })
        .take(MAX_STREAMING_SITES)
        .collect()
}

#[cfg(test)]
mod tests;
