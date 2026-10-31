use super::encode_uri_component;
use super::enrichment::{EnrichmentClient, Source};
use super::skip_times::normalize_imdb_id;

/// Provider id bound: anything larger is unprovable noise, never an ARM/Kitsu id.
pub(crate) const ANIME_ID_MAX: u64 = 50_000_000;
const SEASON_MAX: u64 = 10_000;
const MAX_ROWS: usize = 64;
const RECOGNIZED_FIELDS: [&str; 6] = [
    "myanimelist",
    "anilist",
    "kitsu",
    "imdb",
    "thetvdb-season",
    "themoviedb-season",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AnimeId {
    Mal(u32),
    Kitsu(u32),
    AniList(u32),
}

/// `kitsu:`/`mal:`/`anilist:` ids whose first segment is a positive ASCII
/// number within the id bound; episode-suffixed ids keep the family match.
pub(crate) fn parse_anime_id(id: &str) -> Option<AnimeId> {
    for (prefix, build) in [
        ("kitsu:", AnimeId::Kitsu as fn(u32) -> AnimeId),
        ("mal:", AnimeId::Mal),
        ("anilist:", AnimeId::AniList),
    ] {
        let Some(rest) = id.strip_prefix(prefix) else {
            continue;
        };
        let segment = rest.split(':').next()?;
        if segment.is_empty() || !segment.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        let value: u64 = segment.parse().ok()?;
        if value == 0 || value > ANIME_ID_MAX {
            return None;
        }
        return Some(build(u32::try_from(value).ok()?));
    }
    None
}

/// One ARM row of cross-database anime ids; seasons align an IMDb entry to
/// the right cour. Missing fields stay `None`; malformed identities fail closed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct AnimeIds {
    pub mal_id: Option<u32>,
    pub anilist_id: Option<u32>,
    pub kitsu_id: Option<u32>,
    pub imdb_id: Option<String>,
    pub tvdb_season: Option<u32>,
    pub tmdb_season: Option<u32>,
}

fn bounded_u32(value: Option<&serde_json::Value>) -> Option<u32> {
    let raw = match value? {
        serde_json::Value::Number(number) => number.as_u64()?,
        serde_json::Value::String(text) => text.trim().parse::<u64>().ok()?,
        _ => return None,
    };
    (raw > 0 && raw <= ANIME_ID_MAX)
        .then(|| u32::try_from(raw).ok())
        .flatten()
}

/// Seasons include 0 (specials numbering) - a conflicting 0 must disagree
/// with a requested 1, not silently become "missing".
fn bounded_season(value: Option<&serde_json::Value>) -> Option<u32> {
    let raw = match value? {
        serde_json::Value::Number(number) => number.as_u64()?,
        serde_json::Value::String(text) => text.trim().parse::<u64>().ok()?,
        _ => return None,
    };
    (raw <= SEASON_MAX)
        .then(|| u32::try_from(raw).ok())
        .flatten()
}

fn row_from_object(object: &serde_json::Map<String, serde_json::Value>) -> Option<AnimeIds> {
    for field in ["thetvdb-season", "themoviedb-season"] {
        if object
            .get(field)
            .is_some_and(|value| !value.is_null() && bounded_season(Some(value)).is_none())
        {
            return None;
        }
    }
    let row = AnimeIds {
        mal_id: bounded_u32(object.get("myanimelist")),
        anilist_id: bounded_u32(object.get("anilist")),
        kitsu_id: bounded_u32(object.get("kitsu")),
        imdb_id: object
            .get("imdb")
            .and_then(serde_json::Value::as_str)
            .and_then(normalize_imdb_id),
        tvdb_season: bounded_season(object.get("thetvdb-season")),
        tmdb_season: bounded_season(object.get("themoviedb-season")),
    };
    for (field, valid) in [
        ("myanimelist", row.mal_id.is_some()),
        ("anilist", row.anilist_id.is_some()),
        ("kitsu", row.kitsu_id.is_some()),
        ("imdb", row.imdb_id.is_some()),
    ] {
        if !valid && object.get(field).is_some_and(|value| !value.is_null()) {
            return None;
        }
    }
    Some(row)
}

/// ARM `/api/v2/imdb` (array) and `/api/v2/ids` (single object) share this
/// `null`/`[]` are definitive misses. Malformed or oversized candidate sets
/// fail closed: dropping candidates could turn ambiguity into a wrong match.
fn decode_arm_ids(bytes: &[u8]) -> Result<(Vec<AnimeIds>, bool), String> {
    const INVALID: &str = "Invalid id-mapping response.";
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| INVALID.to_string())?;
    let non_empty_array = matches!(&value, serde_json::Value::Array(items) if !items.is_empty());
    let rows: Vec<AnimeIds> = match value {
        serde_json::Value::Null => Vec::new(),
        serde_json::Value::Object(object) => {
            // An object with no recognized field isn't a row - it's a
            // provider error body we must not mistake for "no ids".
            if !RECOGNIZED_FIELDS
                .iter()
                .any(|field| object.contains_key(*field))
            {
                return Err(INVALID.to_string());
            }
            vec![row_from_object(&object).ok_or_else(|| INVALID.to_string())?]
        }
        serde_json::Value::Array(items) if items.len() <= MAX_ROWS => items
            .iter()
            .map(|item| {
                item.as_object()
                    .and_then(row_from_object)
                    .ok_or_else(|| INVALID.to_string())
            })
            .collect::<Result<_, _>>()?,
        _ => return Err(INVALID.to_string()),
    };
    let mut seen = std::collections::HashSet::new();
    let rows: Vec<AnimeIds> = rows
        .into_iter()
        .filter(|row| {
            row.mal_id.is_some()
                || row.anilist_id.is_some()
                || row.kitsu_id.is_some()
                || row.imdb_id.is_some()
        })
        .filter(|row| {
            seen.insert((
                row.mal_id,
                row.anilist_id,
                row.kitsu_id,
                row.imdb_id.clone(),
                row.tvdb_season,
                row.tmdb_season,
            ))
        })
        .collect();
    if non_empty_array && rows.is_empty() {
        return Err(INVALID.to_string());
    }
    let empty = rows.is_empty();
    Ok((rows, empty))
}

/// Kitsu `/anime/{id}/mappings` - the ARM-miss fallback. Only exact
/// `myanimelist/anime` / `anilist/anime` site matches count; two distinct ids
/// for one site are ambiguous and error rather than picking the first.
fn decode_kitsu_mappings(bytes: &[u8]) -> Result<(Vec<AnimeIds>, bool), String> {
    const INVALID: &str = "Invalid id-mapping response.";
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| INVALID.to_string())?;
    let Some(items) = value.get("data").and_then(serde_json::Value::as_array) else {
        return if value.is_null() {
            Ok((Vec::new(), true))
        } else {
            Err(INVALID.to_string())
        };
    };
    if items.len() > MAX_ROWS
        || value
            .get("links")
            .and_then(|links| links.get("next"))
            .is_some_and(|next| !next.is_null())
    {
        return Err(INVALID.to_string());
    }
    let mut mal: Option<u32> = None;
    let mut anilist: Option<u32> = None;
    for item in items {
        let attributes = item.get("attributes");
        let site = attributes
            .and_then(|a| a.get("externalSite"))
            .and_then(serde_json::Value::as_str);
        let slot = match site {
            Some("myanimelist/anime") => &mut mal,
            Some("anilist/anime") => &mut anilist,
            _ => continue,
        };
        let id = bounded_u32(attributes.and_then(|a| a.get("externalId")))
            .ok_or_else(|| INVALID.to_string())?;
        if slot.is_some_and(|existing| existing != id) {
            return Err(INVALID.to_string());
        }
        *slot = Some(id);
    }
    let rows = (mal.is_some() || anilist.is_some())
        .then(|| AnimeIds {
            mal_id: mal,
            anilist_id: anilist,
            ..AnimeIds::default()
        })
        .into_iter()
        .collect::<Vec<_>>();
    let empty = rows.is_empty();
    Ok((rows, empty))
}

/// Resolve a Kitsu or IMDb title id to cross-database anime ids, cached by the
/// canonical title root (`kitsu:008671:1:2` shares `kitsu:8671`) - never per
/// episode. Kitsu ids fall back to Kitsu's own mappings on an ARM-empty answer;
/// MAL/AniList ids need no bridge and resolve to nothing here.
pub(crate) async fn resolve_anime_ids(
    client: &EnrichmentClient,
    title_id: &str,
) -> Result<Vec<AnimeIds>, String> {
    let kitsu_id = match parse_anime_id(title_id) {
        Some(AnimeId::Kitsu(id)) => Some(id),
        Some(_) => return Ok(Vec::new()),
        None => None,
    };
    let (canonical, path) = match kitsu_id {
        Some(id) => (
            format!("kitsu:{id}"),
            format!("ids?source=kitsu&id={id}&include=imdb,myanimelist,anilist,kitsu,thetvdb-season,themoviedb-season"),
        ),
        None => {
            let Some(imdb) = normalize_imdb_id(title_id) else {
                return Ok(Vec::new());
            };
            let path = format!(
                "imdb?id={}&include=myanimelist,anilist,kitsu,imdb,thetvdb-season,themoviedb-season",
                encode_uri_component(&imdb)
            );
            (imdb, path)
        }
    };
    let key = format!("anime-ids:{canonical}");
    let url = format!("{}/api/v2/{path}", client.base_url(Source::Arm));
    let rows = client
        .load(&key, Source::Arm, client.get(&url), |bytes| {
            let (rows, empty) = decode_arm_ids(bytes)?;
            if rows.iter().any(|row| match kitsu_id {
                Some(id) => row.kitsu_id.is_some_and(|source| source != id),
                None => row
                    .imdb_id
                    .as_deref()
                    .is_some_and(|source| source != canonical),
            }) {
                return Err("Mismatched id-mapping response.".to_string());
            }
            Ok((rows, empty))
        })
        .await?;
    let Some(id) = kitsu_id.filter(|_| rows.is_empty()) else {
        return Ok(rows);
    };
    let url = format!(
        "{}/anime/{id}/mappings?page[limit]=20",
        client.base_url(Source::Kitsu)
    );
    client
        .load(
            &format!("{key}:mappings"),
            Source::Kitsu,
            client.get(&url),
            decode_kitsu_mappings,
        )
        .await
}

#[cfg(test)]
mod tests;
