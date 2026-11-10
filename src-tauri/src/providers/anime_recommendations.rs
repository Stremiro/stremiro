use super::anime_ids::ANIME_ID_MAX;
use super::enrichment::{EnrichmentClient, Source};
use super::title_credits::anilist_lookup_ids;

const MAX_RECOMMENDATIONS: usize = 25;
const MAX_TITLE_CHARS: usize = 512;
const MAX_SYNONYMS: usize = 16;
const INVALID: &str = "Invalid anime recommendations response.";

#[derive(Debug)]
pub(crate) struct AnimeRecommendation {
    pub anilist_id: u32,
    pub mal_id: Option<u32>,
    pub titles: Vec<String>,
}

pub(crate) async fn anime_recommendations(
    client: &EnrichmentClient,
    source_id: &str,
) -> Result<Vec<AnimeRecommendation>, String> {
    let Some((argument, id)) = anilist_lookup_ids(client, source_id, None).await? else {
        return Ok(Vec::new());
    };
    let query = format!(
        "query SimilarAnime(${argument}: Int!) {{ Media({argument}: ${argument}, type: ANIME) {{ id idMal recommendations(perPage: 25, sort: [RATING_DESC, ID]) {{ nodes {{ rating mediaRecommendation {{ id idMal type title {{ romaji english native }} synonyms }} }} }} }} }}"
    );
    let body = serde_json::json!({"query": query, "variables": {argument: id}})
        .to_string()
        .into_bytes();
    let url = client.base_url(Source::AniList);
    client
        .load(
            &format!("anilist-recommendations:v1:{argument}:{id}"),
            Source::AniList,
            client.post_json(url, body),
            |bytes| decode_recommendations(bytes, argument, id),
        )
        .await
}

fn numeric_id(value: &serde_json::Value) -> Option<u32> {
    value
        .as_u64()
        .filter(|id| (1..=ANIME_ID_MAX).contains(id))
        .map(|id| id as u32)
}

fn decode_recommendations(
    bytes: &[u8],
    argument: &str,
    expected_id: u32,
) -> Result<(Vec<AnimeRecommendation>, bool), String> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| INVALID.to_string())?;
    if let Some(errors) = value.get("errors") {
        if !errors.as_array().is_some_and(Vec::is_empty) {
            return Err(INVALID.to_string());
        }
    }
    let media = value
        .get("data")
        .and_then(|data| data.get("Media"))
        .ok_or_else(|| INVALID.to_string())?;
    if media.is_null() {
        return Ok((Vec::new(), true));
    }
    if numeric_id(&media[argument]) != Some(expected_id) || numeric_id(&media["id"]).is_none() {
        return Err(INVALID.to_string());
    }
    let nodes = media["recommendations"]["nodes"]
        .as_array()
        .ok_or_else(|| INVALID.to_string())?;
    let mut seen = std::collections::HashSet::new();
    let mut recommendations: Vec<_> = nodes
        .iter()
        .take(MAX_RECOMMENDATIONS)
        .filter_map(|node| {
            let rating = node["rating"].as_i64().filter(|rating| *rating > 0)?;
            let item = &node["mediaRecommendation"];
            if item["type"].as_str() != Some("ANIME") {
                return None;
            }
            let anilist_id = numeric_id(&item["id"])?;
            if !seen.insert(anilist_id) {
                return None;
            }
            let titles = ["romaji", "english", "native"]
                .into_iter()
                .map(|field| &item["title"][field])
                .chain(
                    item["synonyms"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .take(MAX_SYNONYMS),
                )
                .filter_map(|title| title.as_str())
                .filter_map(|title| super::trim_to_max(title, MAX_TITLE_CHARS))
                .collect();
            Some((
                rating,
                AnimeRecommendation {
                    anilist_id,
                    mal_id: numeric_id(&item["idMal"]),
                    titles,
                },
            ))
        })
        .collect();
    recommendations.sort_by_key(|item| std::cmp::Reverse(item.0));
    let recommendations: Vec<_> = recommendations.into_iter().map(|(_, item)| item).collect();
    let empty = recommendations.is_empty();
    Ok((recommendations, empty))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn direct_anilist_recommendations_share_one_cached_request() {
        let server = crate::test_helpers::TestHttpServer::new(vec![(
            200,
            r#"{"data":{"Media":{"id":21,"recommendations":{"nodes":[{"rating":9,"mediaRecommendation":{"id":20,"idMal":20,"type":"ANIME","title":{"english":"Naruto"}}}]}}}}"#,
            None,
        )]);
        let mut client = EnrichmentClient::new(None);
        client.set_base_url(Source::AniList, server.url.clone());
        let (first, second) = tokio::join!(
            anime_recommendations(&client, "anilist:21"),
            anime_recommendations(&client, "anilist:21:1:2"),
        );
        assert_eq!(first.unwrap()[0].anilist_id, 20);
        assert_eq!(second.unwrap()[0].anilist_id, 20);
        assert_eq!(
            anime_recommendations(&client, "anilist:21")
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(server.finish().len(), 1);
    }

    #[test]
    fn recommendations_validate_source_and_keep_positive_anime_votes() {
        let value = serde_json::json!({"data": {"Media": {"id": 21, "idMal": 21,
        "recommendations": {"nodes": [
            {"rating": 3, "mediaRecommendation": {"id": 20, "idMal": 20, "type": "ANIME", "title": {"english": "Naruto"}, "synonyms": ["NARUTO", null]}},
            {"rating": 10, "mediaRecommendation": {"id": 11061, "idMal": 11061, "type": "ANIME", "title": {"romaji": "HUNTER×HUNTER (2011)", "english": "Hunter x Hunter (2011)"}}},
            {"rating": -1, "mediaRecommendation": {"id": 1, "type": "ANIME"}},
            {"rating": 20, "mediaRecommendation": {"id": 4, "type": "MANGA"}},
            {"rating": 30, "mediaRecommendation": null},
            {"rating": 3, "mediaRecommendation": {"id": 20, "idMal": 20, "type": "ANIME"}}
        ]}}}});
        let bytes = serde_json::to_vec(&value).unwrap();
        let (items, empty) = decode_recommendations(&bytes, "id", 21).unwrap();
        assert!(!empty);
        assert_eq!(
            items.iter().map(|item| item.anilist_id).collect::<Vec<_>>(),
            [11061, 20]
        );
        assert_eq!(items[0].mal_id, Some(11061));
        assert_eq!(items[1].titles, ["Naruto", "NARUTO"]);
        assert!(decode_recommendations(&bytes, "id", 22).is_err());
        assert!(decode_recommendations(
            br#"{"data":{"Media":null},"errors":[{"message":"rate limit"}]}"#,
            "id",
            21
        )
        .is_err());
        assert!(decode_recommendations(br#"{"data":{"Media":{}}}"#, "id", 21).is_err());
        assert!(
            decode_recommendations(br#"{"data":{"Media":null}}"#, "id", 21)
                .unwrap()
                .1
        );
    }
}
