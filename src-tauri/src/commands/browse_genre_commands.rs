use super::addon_registry::load_enabled_addons_snapshot;
use super::config_store::AddonConfig;
use serde::Serialize;
use std::collections::HashSet;
use tauri::{command, AppHandle};

// Cinemeta's declared genre sets. Only used when no enabled addon manifest
// enumerates genre options: the manifest options are the source of truth
// whenever they exist (and while manifests are still being classified).
const MOVIE_GENRE_FALLBACK: [&str; 19] = [
    "Action",
    "Adventure",
    "Animation",
    "Biography",
    "Comedy",
    "Crime",
    "Documentary",
    "Drama",
    "Family",
    "Fantasy",
    "History",
    "Horror",
    "Mystery",
    "Romance",
    "Sci-Fi",
    "Sport",
    "Thriller",
    "War",
    "Western",
];
const SERIES_ONLY_GENRES: [&str; 3] = ["Game-Show", "Reality-TV", "Talk-Show"];
/// Anime browses Cinemeta series filtered by this genre, so it is implied by
/// the anime tab and never offered as a menu entry there.
const ANIME_CATEGORY_GENRE: &str = "animation";

/// Genre menu entries per browse tab, in manifest-declared order.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct BrowseGenres {
    pub movie: Vec<String>,
    pub series: Vec<String>,
    pub anime: Vec<String>,
}

/// The `year` catalog's required `genre` extra enumerates years, not genres.
fn is_year_option(value: &str) -> bool {
    value.len() == 4 && value.bytes().all(|byte| byte.is_ascii_digit())
}

/// Union of manifest-declared `genre` extra options across enabled addons
/// for one catalog type, deduped ASCII-case-insensitively (first spelling
/// wins), with Cinemeta's list as the fallback.
fn collect_catalog_genres(addons: &[AddonConfig], catalog_type: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut options = Vec::new();
    let catalogs = addons
        .iter()
        .filter_map(|addon| addon.capabilities.as_ref())
        .flat_map(|manifest| &manifest.catalogs)
        .filter(|catalog| catalog.type_.trim().eq_ignore_ascii_case(catalog_type));
    for catalog in catalogs {
        let genre_options = catalog
            .extras
            .iter()
            .filter(|extra| extra.name.trim().eq_ignore_ascii_case("genre"))
            .flat_map(|extra| &extra.options);
        for option in genre_options {
            let option = option.trim();
            if option.is_empty() || is_year_option(option) {
                continue;
            }
            if seen.insert(option.to_ascii_lowercase()) {
                options.push(option.to_string());
            }
        }
    }

    if options.is_empty() {
        options.extend(
            MOVIE_GENRE_FALLBACK
                .iter()
                .map(|genre| (*genre).to_string()),
        );
        if catalog_type == "series" {
            options.extend(SERIES_ONLY_GENRES.iter().map(|genre| (*genre).to_string()));
        }
    }
    options
}

pub(crate) fn build_browse_genres(addons: &[AddonConfig]) -> BrowseGenres {
    let series = collect_catalog_genres(addons, "series");
    let anime = series
        .iter()
        .filter(|genre| !genre.eq_ignore_ascii_case(ANIME_CATEGORY_GENRE))
        .cloned()
        .collect();
    BrowseGenres {
        movie: collect_catalog_genres(addons, "movie"),
        series,
        anime,
    }
}

impl BrowseGenres {
    /// Options for one browse tab (`movie`, `series`, or `anime`).
    pub(crate) fn for_media_type(&self, media_type: &str) -> &[String] {
        match media_type {
            "movie" => &self.movie,
            "anime" => &self.anime,
            _ => &self.series,
        }
    }
}

#[command]
pub async fn get_browse_genres(app: AppHandle) -> Result<BrowseGenres, String> {
    let addons = load_enabled_addons_snapshot(&app).await?;
    Ok(build_browse_genres(&addons))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::addon_manifest::{
        AddonCatalogCapability, AddonCatalogExtra, AddonManifest,
    };

    fn addon(catalogs: Vec<(&str, Vec<&str>)>) -> AddonConfig {
        AddonConfig {
            id: "addon".to_string(),
            url: "https://addon.test/manifest.json".to_string(),
            name: "Addon".to_string(),
            enabled: true,
            capabilities: Some(AddonManifest {
                name: "Addon".to_string(),
                resources: Vec::new(),
                catalogs: catalogs
                    .into_iter()
                    .map(|(type_, options)| AddonCatalogCapability {
                        type_: type_.to_string(),
                        id: "top".to_string(),
                        extras: vec![AddonCatalogExtra {
                            name: "genre".to_string(),
                            is_required: false,
                            options: options.into_iter().map(str::to_string).collect(),
                        }],
                    })
                    .collect(),
            }),
        }
    }

    #[test]
    fn manifest_options_union_in_order_without_years_or_case_duplicates() {
        let genres = build_browse_genres(&[
            addon(vec![
                ("movie", vec![" Drama ", "2024", "Comedy"]),
                ("series", vec!["Animation", "Drama"]),
            ]),
            addon(vec![("Movie", vec!["drama", "Horror", ""])]),
        ]);
        assert_eq!(genres.movie, ["Drama", "Comedy", "Horror"]);
        assert_eq!(genres.series, ["Animation", "Drama"]);
        assert_eq!(genres.anime, ["Drama"]);
    }

    #[test]
    fn unclassified_registry_falls_back_to_cinemeta_lists() {
        let genres = build_browse_genres(&[]);
        assert_eq!(genres.movie.len(), MOVIE_GENRE_FALLBACK.len());
        assert!(genres.series.iter().any(|genre| genre == "Reality-TV"));
        assert!(!genres.movie.iter().any(|genre| genre == "Reality-TV"));
        assert!(!genres.anime.iter().any(|genre| genre == "Animation"));
    }
}
