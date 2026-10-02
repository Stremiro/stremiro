use super::addon_registry::load_enabled_addons_snapshot;
use super::browse_genre_commands::build_browse_genres;
use super::media_normalization::normalize_media_item;
use super::search_commands::{
    query_search_catalog_for_request, SearchCatalogPage, SearchCatalogRequest,
};
use crate::providers::{addon_resource::AddonResourceClient, MediaItem};
use futures_util::future::join_all;
use std::collections::{HashMap, HashSet};
use tauri::{command, AppHandle, State};

const MAX_SIMILAR_TITLES: usize = 20;
const MAX_SEED_GENRES: usize = 2;
const YEAR_SPAN: f64 = 25.0;
const RANK_SPAN: usize = 50;

/// Match the UI's genre seed/key normalization: JavaScript trim includes BOM
/// and excludes NEXT LINE from Unicode whitespace.
fn js_trim(value: &str) -> &str {
    value.trim_matches(|character: char| {
        character == '\u{feff}' || (character.is_whitespace() && character != '\u{85}')
    })
}

fn lower_genres(item: &MediaItem) -> HashSet<String> {
    item.genres
        .iter()
        .flatten()
        .map(|genre| js_trim(genre).to_lowercase())
        .filter(|genre| !genre.is_empty())
        .collect()
}

fn primary_year(item: &MediaItem) -> Option<u32> {
    // Preserve the recommendation policy's first four-digit year, including
    // historical dates outside the search catalog's narrower year bounds.
    item.year
        .as_ref()?
        .as_bytes()
        .windows(4)
        .find(|window| window.iter().all(u8::is_ascii_digit))
        .map(|digits| {
            digits
                .iter()
                .fold(0, |year, digit| year * 10 + u32::from(digit - b'0'))
        })
}

struct RankedTitle {
    item: MediaItem,
    genre_score: f64,
    score: f64,
}

fn rank_similar_titles(source: &MediaItem, lists: Vec<Vec<MediaItem>>) -> Vec<MediaItem> {
    let source_genres = lower_genres(source);
    if source_genres.is_empty() {
        return Vec::new();
    }
    let source_year = primary_year(source);
    let source_animated = source_genres.contains("animation");
    let mut indices = HashMap::<String, usize>::new();
    let mut ranked = Vec::<RankedTitle>::new();

    for list in lists {
        for (index, candidate) in list.into_iter().enumerate() {
            if candidate.id == source.id || candidate.type_ != source.type_ {
                continue;
            }
            let genres = lower_genres(&candidate);
            if genres.contains("animation") != source_animated {
                continue;
            }
            let shared = genres.intersection(&source_genres).count();
            if shared == 0 {
                continue;
            }
            let genre_score = shared as f64 / (source_genres.len() + genres.len() - shared) as f64;
            let year_score = match (source_year, primary_year(&candidate)) {
                (Some(source_year), Some(year)) => {
                    1.0 - f64::from(source_year.abs_diff(year)).min(YEAR_SPAN) / YEAR_SPAN
                }
                _ => 0.5,
            };
            let rank_score = 1.0 - index.min(RANK_SPAN) as f64 / RANK_SPAN as f64;
            let score = genre_score * 0.6 + year_score * 0.25 + rank_score * 0.15;

            if let Some(&existing_index) = indices.get(&candidate.id) {
                let existing = &mut ranked[existing_index];
                if genre_score > existing.genre_score
                    || (genre_score == existing.genre_score && score > existing.score)
                {
                    *existing = RankedTitle {
                        item: candidate,
                        genre_score,
                        score,
                    };
                }
            } else {
                indices.insert(candidate.id.clone(), ranked.len());
                ranked.push(RankedTitle {
                    item: candidate,
                    genre_score,
                    score,
                });
            }
        }
    }

    // Stable ties retain first appearance across seed pages, including when
    // a later page supplies a better copy of the same title.
    ranked.sort_by(|a, b| {
        b.genre_score
            .total_cmp(&a.genre_score)
            .then_with(|| b.score.total_cmp(&a.score))
    });
    ranked
        .into_iter()
        .take(MAX_SIMILAR_TITLES)
        .map(|entry| entry.item)
        .collect()
}

fn ranked_catalog_pages(
    source: &MediaItem,
    pages: Vec<Result<SearchCatalogPage, String>>,
) -> Result<Vec<MediaItem>, String> {
    let mut lists = Vec::new();
    let mut first_error = None;
    for page in pages {
        match page {
            Ok(page) => lists.push(page.items),
            Err(error) => {
                first_error.get_or_insert(error);
            }
        }
    }
    if lists.is_empty() {
        if let Some(error) = first_error {
            return Err(error);
        }
    }
    Ok(rank_similar_titles(source, lists))
}

/// Animated series browse the anime catalog so recommendations stay animated.
fn similar_titles_media_type(source: &MediaItem, source_genres: &HashSet<String>) -> &'static str {
    if source.type_ == "movie" {
        "movie"
    } else if source_genres.contains("animation") {
        "anime"
    } else {
        "series"
    }
}

/// First unique source genres the browse catalog can filter by, in the
/// catalog's declared spelling and the source's genre order.
fn similar_titles_seed_genres(source: &MediaItem, supported: &[String]) -> Vec<String> {
    let supported: HashMap<String, &str> = supported
        .iter()
        .map(|genre| (js_trim(genre).to_lowercase(), js_trim(genre)))
        .collect();
    let mut seeds: Vec<String> = Vec::with_capacity(MAX_SEED_GENRES);
    for genre in source.genres.iter().flatten() {
        if seeds.len() >= MAX_SEED_GENRES {
            break;
        }
        if let Some(&declared) = supported.get(&js_trim(genre).to_lowercase()) {
            if !seeds.iter().any(|seed| seed == declared) {
                seeds.push(declared.to_string());
            }
        }
    }
    seeds
}

/// Fetch and rank inside Rust: seed selection reads the same manifest
/// snapshot the catalog fetch uses, candidate pages never enter the WebView,
/// and only the bounded recommendation rail crosses IPC.
#[command]
pub async fn query_similar_titles(
    app: AppHandle,
    client: State<'_, AddonResourceClient>,
    source: MediaItem,
) -> Result<Vec<MediaItem>, String> {
    // The source crosses IPC: bound its genre list and year like any catalog
    // item before they drive ranking and seed fetches.
    let source = normalize_media_item(source);
    let media_type = similar_titles_media_type(&source, &lower_genres(&source));
    let addons = load_enabled_addons_snapshot(&app).await?;
    let browse_genres = build_browse_genres(&addons);
    let seed_genres = similar_titles_seed_genres(&source, browse_genres.for_media_type(media_type));
    let pages = join_all(seed_genres.into_iter().map(|genre| {
        query_search_catalog_for_request(
            &app,
            &client,
            SearchCatalogRequest::for_genre(media_type, genre),
        )
    }))
    .await;
    ranked_catalog_pages(&source, pages)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::test_media_item;

    fn item(id: &str, genres: &[&str], year: Option<&str>) -> MediaItem {
        MediaItem {
            genres: Some(genres.iter().map(|genre| (*genre).to_string()).collect()),
            year: year.map(str::to_string),
            ..test_media_item(id, "series")
        }
    }

    #[test]
    fn ranking_preserves_genre_priority_duplicate_selection_and_stable_ties() {
        let source = item(
            "source",
            &["\u{feff} Drama \u{feff}", "Mystery"],
            Some("2024–"),
        );
        assert!(lower_genres(&item("newline", &["\u{85}Drama\u{85}"], None))
            .contains("\u{85}drama\u{85}"));
        let mut wrong_type = item("wrong-type", &["Drama", "Mystery"], Some("2024"));
        wrong_type.type_ = "movie".to_string();
        let ranked = rank_similar_titles(
            &source,
            vec![
                vec![
                    source.clone(),
                    item("partial", &["Drama"], Some("2024")),
                    item("duplicate", &["Drama"], None),
                    item("animated", &["Drama", "Mystery", "Animation"], Some("2024")),
                    wrong_type,
                    item("unrelated", &["Comedy"], Some("2024")),
                    item("first-tie", &["Mystery", "DRAMA"], Some("1980")),
                ],
                vec![
                    item("duplicate", &["Drama", "Mystery"], Some("2024")),
                    item("second-tie", &["Drama", "Mystery"], Some("1980")),
                ],
            ],
        );
        let ids: Vec<_> = ranked.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, ["duplicate", "second-tie", "first-tie", "partial"]);
        assert_eq!(ranked[0].genres.as_ref().unwrap().len(), 2);

        let ties = rank_similar_titles(
            &source,
            vec![
                vec![item("first", &["Drama"], None)],
                vec![item("second", &["Drama"], None)],
            ],
        );
        assert_eq!(ties[0].id, "first");
        assert_eq!(ties[1].id, "second");
    }

    #[test]
    fn seeds_use_declared_spelling_and_media_type_follows_animation() {
        let source = item("s", &[" drama", "Mystery", "DRAMA", "Thriller"], None);
        let supported = ["Drama", "Thriller", " Mystery "].map(str::to_string);
        assert_eq!(
            similar_titles_seed_genres(&source, &supported),
            ["Drama", "Mystery"]
        );

        assert_eq!(
            similar_titles_media_type(&source, &lower_genres(&source)),
            "series"
        );
        let animated = item("a", &["Animation", "Drama"], None);
        assert_eq!(
            similar_titles_media_type(&animated, &lower_genres(&animated)),
            "anime"
        );
        let mut movie = item("m", &["Animation"], None);
        movie.type_ = "movie".to_string();
        assert_eq!(
            similar_titles_media_type(&movie, &lower_genres(&movie)),
            "movie"
        );
    }

    #[test]
    fn ranking_caps_results_and_preserves_first_ascii_year_policy() {
        let source = item("source", &["Animation"], Some("1870"));
        assert_eq!(
            primary_year(&item("year", &[], Some("１２００ 1870–2025"))),
            Some(1870)
        );
        let candidates = (0..40)
            .map(|index| item(&index.to_string(), &["Animation"], None))
            .collect();
        let ranked = rank_similar_titles(&source, vec![candidates]);
        assert_eq!(ranked.len(), MAX_SIMILAR_TITLES);
        assert_eq!(ranked[0].id, "0");
        assert_eq!(ranked[19].id, "19");
    }

    #[test]
    fn page_failures_keep_successful_pages_and_propagate_first_error_only_when_all_fail() {
        let source = item("source", &["Drama"], None);
        let page = |items| {
            Ok(SearchCatalogPage {
                items,
                next_skip: Some(100),
            })
        };
        assert!(
            ranked_catalog_pages(&source, vec![Err("first".into()), page(vec![])])
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            ranked_catalog_pages(&source, vec![Err("first".into()), Err("second".into())])
                .unwrap_err(),
            "first"
        );
        let ranked = ranked_catalog_pages(
            &source,
            vec![
                Err("first".into()),
                page(vec![item("result", &["Drama"], None)]),
            ],
        )
        .unwrap();
        assert_eq!(ranked[0].id, "result");
    }
}
