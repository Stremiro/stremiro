use super::*;

#[test]
fn parse_anime_id_accepts_positive_numeric_family_roots() {
    for (id, expected) in [
        ("kitsu:44081", Some(AnimeId::Kitsu(44081))),
        ("mal:16498", Some(AnimeId::Mal(16498))),
        ("anilist:1535", Some(AnimeId::AniList(1535))),
        ("kitsu:1:1:1", Some(AnimeId::Kitsu(1))),
        ("kitsu:50000000", Some(AnimeId::Kitsu(50_000_000))),
        ("kitsu:abc", None),
        ("mal:0", None),
        ("anilist:", None),
        ("kitsu:50000001", None),
        ("kitsu:99999999999999999999999", None),
        ("tt2560140", None),
        ("kitsu:-1", None),
        ("kitsux:1", None),
    ] {
        assert_eq!(parse_anime_id(id), expected, "{id}");
    }
}

#[test]
fn decode_arm_ids_handles_objects_arrays_null_and_malformed_rows() {
    // Single-object `/v2/ids` answer.
    let (rows, empty) = decode_arm_ids(
        br#"{"imdb":"tt2560140","myanimelist":25777,"anilist":20958,"kitsu":8671,"thetvdb-season":2,"themoviedb-season":2}"#,
    )
    .unwrap();
    assert!(!empty);
    assert_eq!(rows[0].mal_id, Some(25777));
    assert_eq!(rows[0].tvdb_season, Some(2));

    // Array answer with sibling isolation and dedupe.
    let (rows, empty) = decode_arm_ids(
        br#"[{"myanimelist":16498,"thetvdb-season":1},{"myanimelist":16498,"thetvdb-season":1},{"malformed":true}]"#,
    )
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert!(!empty);

    // Canonical miss and empty array are definitive empties.
    for bytes in [b"null".as_slice(), b"[]".as_slice()] {
        let (rows, empty) = decode_arm_ids(bytes).unwrap();
        assert!(rows.is_empty() && empty);
    }

    // A non-empty array of all-malformed rows is an error, not "no data".
    assert!(decode_arm_ids(br#"[{"bogus":1},{"nope":2}]"#).is_err());
    // Bad top-level shapes are errors.
    for bytes in [b"42".as_slice(), b"\"x\"".as_slice(), b"{bad".as_slice()] {
        assert!(decode_arm_ids(bytes).is_err());
    }
    // Provided-but-malformed recognized fields reject the object outright.
    for bytes in [
        br#"{"myanimelist":50000001}"#.as_slice(),
        br#"{"myanimelist":"bad"}"#.as_slice(),
    ] {
        assert!(decode_arm_ids(bytes).is_err());
    }
    // Recognized all-null fields remain a definitive miss.
    let (rows, empty) = decode_arm_ids(br#"{"myanimelist":null,"imdb":null}"#).unwrap();
    assert!(rows.is_empty() && empty);
}

#[test]
fn decode_arm_ids_keeps_season_zero_and_rejects_over_bound_seasons() {
    // Season 0 is meaningful (specials) and must not become "missing".
    let (rows, _) =
        decode_arm_ids(br#"{"myanimelist":1,"thetvdb-season":0,"themoviedb-season":0}"#).unwrap();
    assert_eq!(rows[0].tvdb_season, Some(0));
    assert_eq!(rows[0].tmdb_season, Some(0));
    // A conflicting 0-vs-1 pair stays conflicting (full-row dedupe keeps both).
    let (rows, _) = decode_arm_ids(
        br#"[{"myanimelist":1,"thetvdb-season":0},{"myanimelist":1,"thetvdb-season":1}]"#,
    )
    .unwrap();
    assert_eq!(rows.len(), 2);
    // Provided-but-over-bound season fields reject the row, not silently drop.
    for body in [
        br#"{"myanimelist":1,"thetvdb-season":10001}"#.as_slice(),
        br#"{"myanimelist":1,"themoviedb-season":"huge"}"#.as_slice(),
    ] {
        assert!(decode_arm_ids(body).is_err(), "{body:?}");
    }
}

#[test]
fn decode_kitsu_mappings_rejects_distinct_ids_for_one_site() {
    // Two distinct MAL ids is ambiguity - an error, never a first-row guess.
    assert!(decode_kitsu_mappings(
        br#"{"data":[
            {"attributes":{"externalSite":"myanimelist/anime","externalId":"1"}},
            {"attributes":{"externalSite":"myanimelist/anime","externalId":"2"}}
        ]}"#
    )
    .is_err());
    // Identical duplicates are fine.
    let (rows, _) = decode_kitsu_mappings(
        br#"{"data":[
            {"attributes":{"externalSite":"myanimelist/anime","externalId":"1"}},
            {"attributes":{"externalSite":"myanimelist/anime","externalId":"1"}}
        ]}"#,
    )
    .unwrap();
    assert_eq!(rows[0].mal_id, Some(1));
}

#[tokio::test]
async fn canonical_root_shares_one_request_across_suffix_variants() {
    use crate::test_helpers::TestHttpServer;
    let server = TestHttpServer::new(vec![(
        200,
        r#"{"myanimelist":25777,"thetvdb-season":2}"#,
        None,
    )]);
    let mut client = EnrichmentClient::new(None);
    client.set_base_url(Source::Arm, server.url.clone());
    for id in ["kitsu:8671", "kitsu:008671:1:2", "kitsu:8671:1:12"] {
        resolve_anime_ids(&client, id).await.unwrap();
    }
    assert_eq!(
        server.finish(),
        ["/api/v2/ids?source=kitsu&id=8671&include=imdb,myanimelist,anilist,kitsu,thetvdb-season,themoviedb-season"]
    );
    // Invalid tt ids and bridge-free MAL/AniList ids never reach a request.
    let server = TestHttpServer::new(vec![]);
    let mut client = EnrichmentClient::new(None);
    client.set_base_url(Source::Arm, server.url.clone());
    for id in ["tt", "ttabc", "tt123:1", "", "mal:38524", "anilist:20958"] {
        assert!(
            resolve_anime_ids(&client, id).await.unwrap().is_empty(),
            "{id}"
        );
    }
    assert!(server.finish().is_empty());
}

#[test]
fn decode_kitsu_mappings_takes_exact_site_matches_only() {
    let (rows, empty) = decode_kitsu_mappings(
        br#"{"data":[
            {"attributes":{"externalSite":"myanimelist/anime","externalId":"16498"}},
            {"attributes":{"externalSite":"anilist/anime","externalId":"16498"}},
            {"attributes":{"externalSite":"themoviedb","externalId":"999"}},
            {"attributes":{"externalSite":"myanimelist","externalId":"1"}}
        ]}"#,
    )
    .unwrap();
    assert!(!empty);
    assert_eq!(rows[0].mal_id, Some(16498));
    assert_eq!(rows[0].anilist_id, Some(16498));

    let (rows, empty) = decode_kitsu_mappings(br#"{"data":[]}"#).unwrap();
    assert!(rows.is_empty() && empty);
    assert!(decode_kitsu_mappings(b"42").is_err());
}

#[test]
fn kitsu_mappings_reject_incomplete_or_malformed_identity_sets() {
    for body in [
        serde_json::json!({"data":[{"attributes":{"externalSite":"myanimelist/anime","externalId":"1"}}],"links":{"next":"https://kitsu.io/next"}}),
        serde_json::json!({"data":[{"attributes":{"externalSite":"myanimelist/anime","externalId":"1"}},{"attributes":{"externalSite":"myanimelist/anime","externalId":"bad"}}]}),
        serde_json::json!({"data":vec![serde_json::json!({"attributes":{"externalSite":"myanimelist/anime","externalId":"1"}}); MAX_ROWS + 1]}),
    ] {
        assert!(
            decode_kitsu_mappings(&serde_json::to_vec(&body).unwrap()).is_err(),
            "{body}"
        );
    }
}

#[test]
fn arm_mapping_never_selects_from_partial_or_malformed_candidates() {
    for body in [
        r#"[{"myanimelist":1,"thetvdb-season":1},{"myanimelist":2,"thetvdb-season":"bad"}]"#,
        r#"[{"myanimelist":1,"thetvdb-season":1},{"myanimelist":"bad","anilist":2,"thetvdb-season":1}]"#,
    ] {
        assert!(decode_arm_ids(body.as_bytes()).is_err(), "{body}");
    }
    let rows = vec![serde_json::json!({"myanimelist":1,"thetvdb-season":1}); MAX_ROWS + 1];
    assert!(decode_arm_ids(&serde_json::to_vec(&rows).unwrap()).is_err());
}

#[tokio::test]
async fn arm_mapping_rejects_a_different_source_identity() {
    use crate::test_helpers::TestHttpServer;
    for (id, body) in [
        ("kitsu:8671", r#"{"kitsu":7442,"myanimelist":16498}"#),
        ("tt2560140", r#"[{"imdb":"tt0877057","myanimelist":1535}]"#),
        (
            "tt2560140",
            r#"[{"imdb":"tt2560140","myanimelist":16498},{"imdb":"tt0877057","myanimelist":16498}]"#,
        ),
    ] {
        let server = TestHttpServer::new(vec![(200, body, None)]);
        let mut client = EnrichmentClient::new(None);
        client.set_base_url(Source::Arm, server.url.clone());
        assert!(resolve_anime_ids(&client, id).await.is_err(), "{id}");
        assert_eq!(server.finish().len(), 1);
    }
}

#[tokio::test]
async fn kitsu_ids_bridge_through_arm_and_fall_back_to_mappings() {
    use crate::test_helpers::TestHttpServer;

    // ARM object answer carries the MAL id.
    let server = TestHttpServer::new(vec![(
        200,
        r#"{"imdb":"tt2560140","myanimelist":25777,"anilist":20958,"kitsu":8671,"thetvdb-season":2,"themoviedb-season":2}"#,
        None,
    )]);
    let mut client = EnrichmentClient::new(None);
    client.set_base_url(Source::Arm, server.url.clone());
    let rows = resolve_anime_ids(&client, "kitsu:8671").await.unwrap();
    assert_eq!(rows[0].mal_id, Some(25777));
    assert_eq!(
        server.finish(),
        ["/api/v2/ids?source=kitsu&id=8671&include=imdb,myanimelist,anilist,kitsu,thetvdb-season,themoviedb-season"]
    );

    // ARM definitive null - one Kitsu mappings request, cached afterwards.
    let arm = TestHttpServer::new(vec![(200, "null", None)]);
    let kitsu = TestHttpServer::new(vec![(
        200,
        r#"{"data":[{"attributes":{"externalSite":"myanimelist/anime","externalId":"41982"}}]}"#,
        None,
    )]);
    let mut client = EnrichmentClient::new(None);
    client.set_base_url(Source::Arm, arm.url.clone());
    client.set_base_url(Source::Kitsu, kitsu.url.clone());
    let rows = resolve_anime_ids(&client, "kitsu:41982").await.unwrap();
    assert_eq!(rows[0].mal_id, Some(41982));
    resolve_anime_ids(&client, "kitsu:41982").await.unwrap();
    assert_eq!(arm.finish().len(), 1);
    assert_eq!(kitsu.finish(), ["/anime/41982/mappings?page[limit]=20"]);

    // Adjacent episodes share the title-level resolve: one ARM call total.
    let arm = TestHttpServer::new(vec![(
        200,
        r#"[{"myanimelist":16498,"thetvdb-season":1},{"myanimelist":25777,"thetvdb-season":2}]"#,
        None,
    )]);
    let mut client = EnrichmentClient::new(None);
    client.set_base_url(Source::Arm, arm.url.clone());
    for _ in 0..3 {
        let rows = resolve_anime_ids(&client, "tt2560140").await.unwrap();
        assert_eq!(rows.len(), 2);
    }
    assert_eq!(
        arm.finish(),
        ["/api/v2/imdb?id=tt2560140&include=myanimelist,anilist,kitsu,imdb,thetvdb-season,themoviedb-season"]
    );
}
