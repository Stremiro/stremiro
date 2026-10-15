use super::addon_registry::load_enabled_addons_snapshot;
use super::browse_genre_commands::build_browse_genres;
use super::media_normalization::normalize_media_item;
use super::resume_store::ResumeStore;
use super::search_commands::{
    query_search_catalog_for_request, SearchCatalogPage, SearchCatalogRequest,
};
use crate::providers::{
    addon_resource::AddonResourceClient, first_ascii_year_run, MediaDetails, MediaItem,
};
use futures_util::future::join_all;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use tauri::{command, AppHandle, Manager, State};

const MAX_SIMILAR_TITLES: usize = 20;
const MAX_SEED_GENRES: usize = 3;
const YEAR_SPAN: f64 = 25.0;
const RANK_SPAN: usize = 50;
const STOPWORDS: &[&str] = &[
    "about", "after", "all", "also", "and", "are", "been", "before", "being", "but", "can",
    "during", "for", "from", "had", "has", "have", "her", "hers", "him", "his", "how", "into",
    "its", "more", "not", "one", "only", "other", "our", "out", "part", "she", "some", "than",
    "that", "the", "their", "them", "then", "there", "these", "they", "this", "those", "through",
    "two", "was", "were", "what", "when", "where", "which", "who", "will", "with", "would", "you",
    "your",
];

/// Match the UI's genre seed/key normalization: JavaScript trim includes BOM
/// and excludes NEXT LINE from Unicode whitespace.
fn js_trim(value: &str) -> &str {
    value.trim_matches(|character: char| {
        character == '\u{feff}' || (character.is_whitespace() && character != '\u{85}')
    })
}

fn lower_genres(item: &MediaItem) -> BTreeSet<String> {
    item.genres
        .iter()
        .flatten()
        .map(|genre| js_trim(genre).to_lowercase())
        .filter(|genre| !genre.is_empty())
        .collect()
}

fn tokens(value: &str) -> BTreeSet<String> {
    value
        .to_lowercase()
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| word.chars().count() >= 3 && !STOPWORDS.contains(word))
        .map(str::to_string)
        .collect()
}

struct IdfWeights<'a> {
    weights: HashMap<&'a str, f64>,
    unseen: f64,
}

impl<'a> IdfWeights<'a> {
    fn new(documents: impl Iterator<Item = (&'a str, &'a BTreeSet<String>)>) -> Self {
        let mut ids = HashSet::new();
        let mut seen = HashSet::new();
        let mut frequencies = HashMap::<&str, usize>::new();
        for (id, terms) in documents {
            ids.insert(id);
            for term in terms {
                // Overlapping seed pages must not make a title count as several documents.
                if seen.insert((id, term.as_str())) {
                    *frequencies.entry(term.as_str()).or_default() += 1;
                }
            }
        }
        let count = ids.len() as f64;
        Self {
            weights: frequencies
                .into_iter()
                .map(|(term, frequency)| (term, (1.0 + count / (1.0 + frequency as f64)).ln()))
                .collect(),
            unseen: (1.0 + count).ln(),
        }
    }

    fn weight(&self, term: &str) -> f64 {
        self.weights.get(term).copied().unwrap_or(self.unseen)
    }
}

fn weighted_jaccard(
    source: &BTreeSet<String>,
    candidate: &BTreeSet<String>,
    weights: &IdfWeights<'_>,
) -> f64 {
    let shared: f64 = source
        .intersection(candidate)
        .map(|term| weights.weight(term))
        .sum();
    let union: f64 = source
        .union(candidate)
        .map(|term| weights.weight(term))
        .sum();
    if union > 0.0 {
        shared / union
    } else {
        0.0
    }
}

fn weighted_norm_squared(terms: &BTreeSet<String>, weights: &IdfWeights<'_>) -> f64 {
    terms.iter().map(|term| weights.weight(term).powi(2)).sum()
}

fn cosine_similarity(
    source: &BTreeSet<String>,
    candidate: &BTreeSet<String>,
    weights: &IdfWeights<'_>,
    source_norm_squared: f64,
) -> Option<f64> {
    if source.is_empty() || candidate.is_empty() {
        return None;
    }
    let shared: f64 = source
        .intersection(candidate)
        .map(|term| weights.weight(term).powi(2))
        .sum();
    Some(
        (shared / (source_norm_squared * weighted_norm_squared(candidate, weights)).sqrt())
            .clamp(0.0, 1.0),
    )
}

fn primary_year(item: &MediaItem) -> Option<u32> {
    // Preserve the recommendation policy's first four-digit year, including
    // historical dates outside the search catalog's narrower year bounds.
    item.year.as_deref().and_then(first_ascii_year_run)
}

struct Candidate {
    item: Option<MediaItem>,
    genres: BTreeSet<String>,
    description: BTreeSet<String>,
    title: BTreeSet<String>,
    catalog_index: usize,
}

impl Candidate {
    fn item(&self) -> &MediaItem {
        self.item.as_ref().expect("candidate has not been consumed")
    }
}

struct RankedTitle {
    candidate_index: usize,
    score: f64,
    watched: bool,
}

fn rank_similar_titles(
    source: &MediaItem,
    lists: Vec<Vec<MediaItem>>,
    watched: &HashSet<String>,
) -> Vec<MediaItem> {
    let source_genres = lower_genres(source);
    if source_genres.is_empty() {
        return Vec::new();
    }
    let source_year = primary_year(source);
    let source_animated = source_genres.contains("animation");
    let source_description = tokens(source.description.as_deref().unwrap_or_default());
    let source_title = tokens(&source.title);
    let mut candidates = Vec::new();
    for list in lists {
        for (index, candidate) in list.into_iter().enumerate() {
            if candidate.id == source.id || candidate.type_ != source.type_ {
                continue;
            }
            let genres = lower_genres(&candidate);
            if genres.contains("animation") != source_animated {
                continue;
            }
            if genres.is_disjoint(&source_genres) {
                continue;
            }
            candidates.push(Candidate {
                description: tokens(candidate.description.as_deref().unwrap_or_default()),
                title: tokens(&candidate.title),
                genres,
                catalog_index: index,
                item: Some(candidate),
            });
        }
    }
    if candidates.is_empty() {
        return Vec::new();
    }
    let genre_weights = IdfWeights::new(
        candidates
            .iter()
            .map(|candidate| (candidate.item().id.as_str(), &candidate.genres)),
    );
    let description_weights = IdfWeights::new(
        candidates
            .iter()
            .map(|candidate| (candidate.item().id.as_str(), &candidate.description)),
    );
    let title_weights = IdfWeights::new(
        candidates
            .iter()
            .map(|candidate| (candidate.item().id.as_str(), &candidate.title)),
    );
    // Keep the squared norms so the denominator's floating-point evaluation
    // remains identical while the invariant source work happens only once.
    let source_description_norm_squared =
        weighted_norm_squared(&source_description, &description_weights);
    let source_title_norm_squared = weighted_norm_squared(&source_title, &title_weights);
    let mut indices = HashMap::<&str, usize>::new();
    let mut ranked = Vec::<RankedTitle>::new();
    for (candidate_index, candidate) in candidates.iter().enumerate() {
        let item = candidate.item();
        let genre_score = weighted_jaccard(&source_genres, &candidate.genres, &genre_weights);
        let content_score = cosine_similarity(
            &source_description,
            &candidate.description,
            &description_weights,
            source_description_norm_squared,
        );
        let title_score = cosine_similarity(
            &source_title,
            &candidate.title,
            &title_weights,
            source_title_norm_squared,
        )
        .unwrap_or(0.0);
        let year_score = match (source_year, primary_year(item)) {
            (Some(source_year), Some(year)) => {
                1.0 - f64::from(source_year.abs_diff(year)).min(YEAR_SPAN) / YEAR_SPAN
            }
            _ => 0.5,
        };
        let rank_score = 1.0 - candidate.catalog_index.min(RANK_SPAN) as f64 / RANK_SPAN as f64;
        let base_score =
            genre_score * 0.40 + title_score * 0.10 + year_score * 0.15 + rank_score * 0.10;
        // Missing descriptions leave the known signals' relative weights unchanged.
        let score = content_score.map_or(base_score / 0.75, |content| base_score + content * 0.25);
        let entry = RankedTitle {
            candidate_index,
            score,
            watched: watched.contains(&item.id),
        };
        if let Some(&existing_index) = indices.get(item.id.as_str()) {
            let existing = &mut ranked[existing_index];
            if score > existing.score {
                *existing = entry;
            }
        } else {
            indices.insert(item.id.as_str(), ranked.len());
            ranked.push(entry);
        }
    }

    // Stable ties retain first appearance across seed pages, including when
    // a later page supplies a better copy of the same title.
    ranked.sort_by(|a, b| {
        a.watched
            .cmp(&b.watched)
            .then_with(|| b.score.total_cmp(&a.score))
    });
    ranked
        .into_iter()
        .take(MAX_SIMILAR_TITLES)
        .map(|entry| {
            candidates[entry.candidate_index]
                .item
                .take()
                .expect("ranked candidate is unique")
        })
        .collect()
}

fn ranked_catalog_pages(
    source: &MediaItem,
    pages: Vec<Result<SearchCatalogPage, String>>,
    watched: &HashSet<String>,
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
    Ok(rank_similar_titles(source, lists, watched))
}

/// Animated series browse the anime catalog so recommendations stay animated.
fn similar_titles_media_type(source: &MediaItem, source_genres: &BTreeSet<String>) -> &'static str {
    if source.type_ == "movie" {
        "movie"
    } else if source_genres.contains("animation") {
        "anime"
    } else {
        "series"
    }
}

fn similar_titles_seed_genres(source: &MediaItem, supported: &[String]) -> Vec<String> {
    let supported: HashMap<String, &str> = supported
        .iter()
        .map(|genre| (js_trim(genre).to_lowercase(), js_trim(genre)))
        .collect();
    let mut seeds: Vec<String> = Vec::with_capacity(MAX_SEED_GENRES);
    for genre in source.genres.iter().flatten() {
        if let Some(&declared) = supported.get(&js_trim(genre).to_lowercase()) {
            if !seeds.iter().any(|seed| seed == declared) {
                seeds.push(declared.to_string());
            }
        }
    }
    // Broad genres return near-identical pages; spend the fetch budget on
    // specific ones first (stable sort keeps the source order otherwise).
    seeds.sort_by_key(|genre| matches!(genre.to_lowercase().as_str(), "drama" | "comedy"));
    seeds.truncate(MAX_SEED_GENRES);
    seeds
}

fn resume_store_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("playback_resume.sqlite3"))
        .map_err(|error| error.to_string())
}

fn watch_seed(details: MediaDetails) -> Option<MediaItem> {
    let seed = normalize_media_item(MediaItem {
        id: details.id,
        type_: details.type_,
        title: details.title,
        year: details.year,
        genres: details.genres,
        poster: details.poster,
        backdrop: None,
        logo: None,
        description: details.description,
        primary_year: None,
        display_year: None,
    });
    (!seed.title.is_empty()
        && seed
            .genres
            .as_ref()
            .is_some_and(|genres| !genres.is_empty()))
    .then_some(seed)
}

#[command]
pub async fn get_recent_watch_seed(
    app: AppHandle,
    client: State<'_, AddonResourceClient>,
) -> Result<Option<MediaItem>, String> {
    let resume_path = resume_store_path(&app)?;
    let titles =
        super::run_blocking_store_op(move || ResumeStore::load_recent_titles(&resume_path)).await?;
    for (media_type, id) in titles {
        if let Ok(details) =
            super::media_commands::fetch_media_details_inner(&app, &client, &media_type, &id, false)
                .await
        {
            if let Some(seed) = watch_seed(details) {
                return Ok(Some(seed));
            }
        }
    }
    Ok(None)
}

/// Fetch and rank inside Rust: seed selection reads the same manifest snapshot the
/// catalog fetch uses; only the bounded recommendation rail crosses IPC.
#[command]
pub async fn query_similar_titles(
    app: AppHandle,
    client: State<'_, AddonResourceClient>,
    source: MediaItem,
) -> Result<Vec<MediaItem>, String> {
    // The source crosses IPC: bound its fields like any catalog item before
    // they drive ranking and seed fetches.
    let source = normalize_media_item(source);
    let media_type = similar_titles_media_type(&source, &lower_genres(&source));
    let addons = load_enabled_addons_snapshot(&app).await?;
    let browse_genres = build_browse_genres(&addons);
    let seed_genres = similar_titles_seed_genres(&source, browse_genres.for_media_type(media_type));
    if seed_genres.is_empty() {
        return Ok(Vec::new());
    }
    let resume_path = resume_store_path(&app);
    let watched_media_type = source.type_.clone();
    let watched = super::run_blocking_store_op(move || {
        ResumeStore::load_watched_title_ids(&resume_path?, &watched_media_type)
    });
    let pages = join_all(seed_genres.into_iter().map(|genre| {
        query_search_catalog_for_request(
            &app,
            &client,
            SearchCatalogRequest::for_genre(media_type, genre),
        )
    }));
    let (pages, watched) = tokio::join!(pages, watched);
    ranked_catalog_pages(&source, pages, &watched.unwrap_or_default())
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

    fn described_item(id: &str, genres: &[&str], description: &str) -> MediaItem {
        MediaItem {
            description: Some(description.to_string()),
            ..item(id, genres, None)
        }
    }

    #[test]
    fn ranking_preserves_hard_filters_best_duplicate_and_stable_ties() {
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
            &HashSet::new(),
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
            &HashSet::new(),
        );
        assert_eq!(ties[0].id, "first");
        assert_eq!(ties[1].id, "second");

        assert!(rank_similar_titles(
            &item("empty", &[], None),
            vec![vec![item("candidate", &["Drama"], None)]],
            &HashSet::new(),
        )
        .is_empty());
    }

    #[test]
    fn rare_shared_genres_outrank_ubiquitous_drama() {
        let source = item("source", &["Drama", "Mystery"], None);
        let mut candidates: Vec<_> = (0..12)
            .map(|index| item(&format!("drama-{index}"), &["Drama"], None))
            .collect();
        candidates.push(item("rare", &["Mystery"], None));
        let ranked = rank_similar_titles(&source, vec![candidates], &HashSet::new());
        assert_eq!(ranked[0].id, "rare");
    }

    #[test]
    fn content_can_outweigh_greater_genre_overlap_and_select_the_best_copy() {
        let description = "Astronaut explores distant planets aboard spaceship";
        let source = described_item("source", &["Drama", "Mystery"], description);
        let unrelated = described_item(
            "unrelated",
            &["Drama", "Mystery"],
            "Lawyer defends innocent family during courtroom trial",
        );
        let relevant = described_item("duplicate", &["Mystery"], description);
        let ranked = rank_similar_titles(
            &source,
            vec![
                vec![
                    unrelated,
                    described_item("duplicate", &["Drama", "Mystery"], "Courtroom trial"),
                ],
                vec![relevant],
            ],
            &HashSet::new(),
        );
        assert_eq!(ranked.len(), 2);
        assert_eq!(ranked[0].id, "duplicate");
        assert_eq!(ranked[0].description.as_deref(), Some(description));
        assert_eq!(ranked[0].genres.as_ref().unwrap(), &["Mystery"]);
    }

    #[test]
    fn distinctive_description_tokens_and_franchise_titles_lift_matches() {
        let source = described_item(
            "source",
            &["Drama"],
            "Family investigates cryptographic conspiracy",
        );
        let mut candidates: Vec<_> = (0..12)
            .map(|index| described_item(&format!("family-{index}"), &["Drama"], "Family"))
            .collect();
        candidates.push(described_item(
            "rare",
            &["Drama"],
            "Cryptographic conspiracy",
        ));
        let ranked = rank_similar_titles(&source, vec![candidates], &HashSet::new());
        assert_eq!(ranked[0].id, "rare");

        let source = MediaItem {
            title: "Dune".into(),
            ..item("source", &["Sci-Fi"], None)
        };
        let sequel = MediaItem {
            title: "DUNE: Part Two".into(),
            ..item("sequel", &["Sci-Fi"], None)
        };
        let ranked = rank_similar_titles(
            &source,
            vec![vec![item("adventure", &["Sci-Fi"], None), sequel]],
            &HashSet::new(),
        );
        assert_eq!(ranked[0].id, "sequel");
        assert_eq!(
            tokens("THE café, x 42 123. DUNE dune Part TWO with"),
            ["123", "café", "dune"]
                .map(str::to_string)
                .into_iter()
                .collect()
        );
    }

    #[test]
    fn missing_descriptions_reweight_known_signals_without_losing_candidates() {
        let description = "Astronaut explores distant planets";
        let mut source = described_item("source", &["Sci-Fi"], description);
        let candidates = vec![
            item("missing", &["Sci-Fi"], None),
            described_item("matched", &["Sci-Fi"], description),
            described_item("unrelated", &["Sci-Fi"], "Detective solves murder"),
        ];
        let ranked = rank_similar_titles(&source, vec![candidates.clone()], &HashSet::new());
        assert_eq!(
            ranked
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["matched", "missing", "unrelated"]
        );
        source.description = Some("The and with".into());
        let ranked = rank_similar_titles(&source, vec![candidates], &HashSet::new());
        assert_eq!(
            ranked
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["missing", "matched", "unrelated"]
        );
    }

    #[test]
    fn document_frequency_counts_duplicate_titles_only_once() {
        let first = tokens("common rare");
        let second = tokens("common");
        let original = IdfWeights::new([("first", &first), ("second", &second)].into_iter());
        let repeated = IdfWeights::new(
            [("first", &first), ("second", &second), ("first", &first)].into_iter(),
        );
        assert_eq!(original.weight("common"), repeated.weight("common"));
        assert_eq!(original.weight("rare"), repeated.weight("rare"));
        assert!(original.weight("rare") > original.weight("common"));
    }

    #[test]
    fn watched_titles_follow_unwatched_without_being_removed() {
        let source = item("source", &["Drama", "Mystery"], Some("2024"));
        let ranked = rank_similar_titles(
            &source,
            vec![vec![
                item("watched", &["Drama", "Mystery"], Some("2024")),
                item("unwatched", &["Drama"], Some("1980")),
            ]],
            &HashSet::from(["watched".into()]),
        );
        assert_eq!(
            ranked
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["unwatched", "watched"]
        );
    }

    #[test]
    fn seeds_defer_broad_genres_use_declared_spelling_and_cap_fetches() {
        let source = item(
            "s",
            &[
                " drama", "Comedy", "Mystery", "DRAMA", "Thriller", "Unknown", "Sci-Fi",
            ],
            None,
        );
        let supported = ["Drama", "Comedy", "Thriller", " Mystery ", "Sci-Fi"].map(str::to_string);
        assert_eq!(
            similar_titles_seed_genres(&source, &supported),
            ["Mystery", "Thriller", "Sci-Fi"]
        );
        assert_eq!(
            similar_titles_seed_genres(&source, &["Drama", " Mystery "].map(str::to_string)),
            ["Mystery", "Drama"]
        );
        assert_eq!(
            similar_titles_seed_genres(
                &item("broad", &["Comedy", "Drama"], None),
                &["Drama", "Comedy"].map(str::to_string),
            ),
            ["Comedy", "Drama"]
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
        let ranked = rank_similar_titles(&source, vec![candidates], &HashSet::new());
        assert_eq!(ranked.len(), MAX_SIMILAR_TITLES);
        assert_eq!(ranked[0].id, "0");
        assert_eq!(ranked[19].id, "19");

        let candidates = (0..40)
            .map(|index| item(&index.to_string(), &["Animation"], None))
            .chain([item("not-animated", &["Drama"], None)])
            .collect();
        let watched = (0..25).map(|index| index.to_string()).collect();
        let ranked = rank_similar_titles(&source, vec![candidates], &watched);
        assert_eq!(ranked.len(), MAX_SIMILAR_TITLES);
        assert_eq!(ranked[0].id, "25");
        assert_eq!(ranked[14].id, "39");
        assert_eq!(ranked[15].id, "0");
        assert_eq!(ranked[19].id, "4");
    }

    #[test]
    fn watch_seed_requires_usable_genres_and_preserves_bounded_description() {
        let mut details = MediaDetails {
            id: "source".into(),
            imdb_id: None,
            type_: "series".into(),
            title: "Source".into(),
            year: None,
            genres: Some(vec![" ".into()]),
            poster: None,
            backdrop: None,
            logo: None,
            description: Some("x".repeat(5_000)),
            display_year: None,
            release_date: None,
            rating: None,
            runtime: None,
            cast: None,
            directors: None,
            trailers: None,
            episodes: None,
            seasons: None,
        };
        assert!(watch_seed(details.clone()).is_none());
        details.genres = Some(vec!["Mystery".into()]);
        let seed = watch_seed(details.clone()).unwrap();
        assert_eq!(seed.description.unwrap().chars().count(), 4_096);
        assert_eq!(seed.genres.unwrap(), ["Mystery"]);
        details.title = " ".into();
        assert!(watch_seed(details).is_none());
    }

    #[test]
    fn page_failures_keep_successful_pages_and_propagate_first_error_only_when_all_fail() {
        let source = item("source", &["Drama"], None);
        let page = |items| {
            Ok(SearchCatalogPage {
                items,
                next_skip: Some(100),
                all_cursors: None,
            })
        };
        assert!(ranked_catalog_pages(
            &source,
            vec![Err("first".into()), page(vec![])],
            &HashSet::new()
        )
        .unwrap()
        .is_empty());
        assert_eq!(
            ranked_catalog_pages(
                &source,
                vec![Err("first".into()), Err("second".into())],
                &HashSet::new()
            )
            .unwrap_err(),
            "first"
        );
        let ranked = ranked_catalog_pages(
            &source,
            vec![
                Err("first".into()),
                page(vec![item("result", &["Drama"], None)]),
            ],
            &HashSet::new(),
        )
        .unwrap();
        assert_eq!(ranked[0].id, "result");
    }
}
