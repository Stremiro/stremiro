use super::*;
use crate::test_helpers::TestHttpServer;

const TVMAZE_SHOW: &str = r#"{"id":82,"name":"Game of Thrones","type":"Scripted","status":"Ended","runtime":60,"averageRuntime":61,"network":{"name":"HBO","country":{"timezone":"America/New_York"}},"webChannel":null,"schedule":{"days":["Sunday"],"time":"21:00"}}"#;
const TVMAZE_CAST: &str = r#"[
    {"person":{"name":"Peter Dinklage","image":{"medium":"https://static.tvmaze.com/p.jpg"}},"character":{"name":"Tyrion Lannister"}},
    {"person":{"name":"No Image","image":{"medium":"javascript:alert(1)"}},"character":{"name":"X"}},
    {"person":{"name":42},"character":{}},
    "wrong-type-row"
]"#;
const ANILIST_MEDIA: &str = r#"{"data":{"Media":{"id":16498,"idMal":16498,"status":"RELEASING","format":"TV","duration":24,"studios":{"nodes":[{"name":"Wit Studio"},{"name":"MAP"},{"name":"x"},{"name":"y"}]},"characters":{"edges":[
        {"role":"MAIN","node":{"name":{"full":"Eren Yeager"},"image":{"large":"https://img.co/e.jpg"}},"voiceActors":[{"name":{"full":"Yuki Kaji"}}]},
        {"role":"SUPPORTING","node":{"name":{"full":"Mikasa"},"image":{}},"voiceActors":[]},
        {"role":"BACKGROUND","node":{"name":{"full":"Drop me"},"image":{}},"voiceActors":[]}
    ]},"nextAiringEpisode":{"episode":7,"airingAt":1900000000},"externalLinks":[
        {"site":"Crunchyroll","url":"http://crunchyroll.com/series/1","type":"STREAMING","isDisabled":false},
        {"site":"crunchyroll","url":"https://dup.co/x","type":"STREAMING","isDisabled":false},
        {"site":"Bad","url":"javascript:alert(1)","type":"STREAMING","isDisabled":false}
    ]}}}"#;

#[tokio::test]
async fn tvmaze_lookup_and_cast_cache_separately_with_sibling_isolation() {
    let server = TestHttpServer::new(vec![(200, TVMAZE_SHOW, None), (200, TVMAZE_CAST, None)]);
    let mut client = EnrichmentClient::new(None);
    client.set_base_url(Source::Tvmaze, server.url.clone());
    for _ in 0..2 {
        let credits = get_title_credits(&client, "series", "tt0944947", None)
            .await
            .unwrap();
        assert_eq!(credits.source, Some("tvmaze"));
        // Malformed siblings dropped; valid rows and unsafe image handled.
        assert_eq!(credits.people.len(), 2);
        assert_eq!(credits.people[0].name, "Peter Dinklage");
        assert_eq!(credits.people[0].role, "Cast");
        assert_eq!(
            credits.people[0].character.as_deref(),
            Some("Tyrion Lannister")
        );
        assert!(credits.people[0].image_url.is_some());
        assert!(credits.people[1].image_url.is_none());
        // Ended show: no stale weekly schedule; runtime wins over averageRuntime.
        assert_eq!(credits.facts.network.as_deref(), Some("HBO"));
        assert_eq!(credits.facts.status.as_deref(), Some("Ended"));
        assert_eq!(credits.facts.schedule, None);
        assert_eq!(credits.facts.format.as_deref(), Some("Scripted"));
        assert_eq!(credits.facts.runtime_minutes, Some(60));
    }
    // Cached: no extra HTTP on repeat (lookup+cast = 2 requests total).
    assert_eq!(
        server.finish(),
        ["/lookup/shows?imdb=tt0944947", "/shows/82/cast"]
    );
}

#[tokio::test]
async fn tvmaze_lookup_miss_is_empty_and_server_error_is_err() {
    for (status, expect_err) in [(404u16, false), (503u16, true)] {
        let server = TestHttpServer::new(vec![(status, "{}", None)]);
        let mut client = EnrichmentClient::new(None);
        client.set_base_url(Source::Tvmaze, server.url.clone());
        let result = get_title_credits(&client, "series", "tt0944947", None).await;
        assert_eq!(result.is_err(), expect_err, "{status}");
        if !expect_err {
            assert_eq!(result.unwrap(), TitleCredits::default());
        }
        assert_eq!(server.finish().len(), 1);
    }
    // A cast miss still surfaces lookup facts.
    let server = TestHttpServer::new(vec![(200, TVMAZE_SHOW, None), (404, "{}", None)]);
    let mut client = EnrichmentClient::new(None);
    client.set_base_url(Source::Tvmaze, server.url.clone());
    let credits = get_title_credits(&client, "series", "tt0944947", None)
        .await
        .unwrap();
    assert!(credits.people.is_empty());
    assert_eq!(credits.facts.network.as_deref(), Some("HBO"));
}

#[test]
fn tvmaze_schedule_and_runtime_validation() {
    // Running show: valid weekdays + HH:MM + timezone compose the schedule.
    let show = |body: &str| {
        let value: serde_json::Value = serde_json::from_str(body).unwrap();
        tvmaze_facts(&value)
    };
    let running = show(
        r#"{"id":1,"status":"Running","runtime":0,"averageRuntime":45,"network":{"name":"CBS","country":{"timezone":"America/Chicago"}},"schedule":{"days":["Monday","Sunday","Monday","Notaday"],"time":"20:30"},"type":"Reality"}"#,
    );
    assert_eq!(
        running.schedule.as_deref(),
        Some("Monday, Sunday at 20:30 (America/Chicago)")
    );
    assert_eq!(running.runtime_minutes, Some(45)); // runtime 0 falls back
                                                   // Bad time shapes never advertise.
    for time in ["8:00pm", "24:00", "20:60", "20+1", "ab:cd"] {
        let facts = show(&format!(
            r#"{{"id":1,"status":"Running","schedule":{{"days":["Friday"],"time":"{time}"}}}}"#
        ));
        assert_eq!(facts.schedule.as_deref(), Some("Friday"), "{time}");
    }
}

#[test]
fn anilist_request_carries_exactly_one_identifier() {
    // The body shape is fixed: one variable key, matching Media argument.
    let body: serde_json::Value =
        serde_json::from_slice(&anilist_request_body("idMal", 16498)).unwrap();
    let variables = body["variables"].as_object().unwrap();
    assert_eq!(variables.len(), 1);
    assert_eq!(variables["idMal"], 16498);
    let query = body["query"].as_str().unwrap();
    assert!(query.contains("Media(idMal: $idMal, type: ANIME)"));
    assert!(!query.contains("$id:") && !query.contains("id: $id"));
}

#[tokio::test]
async fn anilist_direct_mal_posts_once_with_zero_bridge() {
    let anilist = TestHttpServer::new(vec![(200, ANILIST_MEDIA, None)]);
    let arm = TestHttpServer::new(vec![]);
    let mut client = EnrichmentClient::new(None);
    client.set_base_url(Source::AniList, anilist.url.clone());
    client.set_base_url(Source::Arm, arm.url.clone());
    let credits = get_title_credits(&client, "anime", "mal:16498", None)
        .await
        .unwrap();
    assert_eq!(credits.source, Some("anilist"));
    assert_eq!(credits.people.len(), 2); // BACKGROUND dropped
    assert_eq!(credits.people[0].name, "Eren Yeager");
    assert_eq!(
        credits.people[0].image_url.as_deref(),
        Some("https://img.co/e.jpg")
    );
    assert_eq!(credits.people[0].role, "Main");
    assert_eq!(credits.people[0].voice_actor.as_deref(), Some("Yuki Kaji"));
    assert_eq!(credits.facts.studio.as_deref(), Some("Wit Studio, MAP, x"));
    assert_eq!(credits.facts.status.as_deref(), Some("Airing"));
    assert_eq!(credits.facts.format.as_deref(), Some("TV"));
    assert_eq!(credits.facts.runtime_minutes, Some(24));
    assert_eq!(
        credits.next_airing_episode,
        Some(NextAiringEpisode {
            episode: 7,
            airing_at: 1_900_000_000
        })
    );
    assert_eq!(
        credits.streaming_links,
        [StreamingLink {
            site: "Crunchyroll".into(),
            url: "http://crunchyroll.com/series/1".into()
        }]
    );
    get_title_credits(&client, "anime", "mal:16498", None)
        .await
        .unwrap();
    assert_eq!(anilist.finish().len(), 1);
    assert!(arm.finish().is_empty());
}

#[tokio::test]
async fn anilist_graphql_and_shape_failures_are_errors_not_misses() {
    // GraphQL errors at 200, malformed roots, missing data/Media: all Err.
    for (index, body) in [
        r#"{"errors":[{"message":"boom"}],"data":{"Media":null}}"#,
        r#"{}"#,
        r#"{"data":{}}"#,
        r#"{"data":{"Media":{}}}"#,
        r#"{"data":{"Media":{"id":0}}}"#,
        r#"{"errors":"nope","data":{"Media":null}}"#,
    ]
    .iter()
    .enumerate()
    {
        let server = TestHttpServer::new(vec![(200, body, None)]);
        let mut client = EnrichmentClient::new(None);
        client.set_base_url(Source::AniList, server.url.clone());
        let id = format!("anilist:{}", 10_000 + index);
        assert!(
            get_title_credits(&client, "anime", &id, None)
                .await
                .is_err(),
            "{body}"
        );
        assert_eq!(server.finish().len(), 1);
    }
    // Explicit data.Media:null is the one documented definitive miss.
    let server = TestHttpServer::new(vec![(200, r#"{"data":{"Media":null}}"#, None)]);
    let mut client = EnrichmentClient::new(None);
    client.set_base_url(Source::AniList, server.url.clone());
    let credits = get_title_credits(&client, "anime", "anilist:999", None)
        .await
        .unwrap();
    assert_eq!(credits, TitleCredits::default());
    assert_eq!(server.finish().len(), 1);
}

#[tokio::test]
async fn empty_payloads_serialize_without_source() {
    // Facts-less, people-less Media is normalized to the default shape so the
    // wire TTL semantics (empty=1h) hold for both providers.
    let server = TestHttpServer::new(vec![(
        200,
        r#"{"data":{"Media":{"id":16498,"idMal":16498,"status":null,"format":null,"duration":null,"studios":{"nodes":[]},"characters":{"edges":[]},"nextAiringEpisode":null,"externalLinks":[]}}}"#,
        None,
    )]);
    let mut client = EnrichmentClient::new(None);
    client.set_base_url(Source::AniList, server.url.clone());
    let credits = get_title_credits(&client, "anime", "mal:16498", None)
        .await
        .unwrap();
    assert_eq!(credits, TitleCredits::default());
}

#[tokio::test]
async fn movie_and_unkeyable_ids_make_no_requests() {
    let server = TestHttpServer::new(vec![]);
    let mut client = EnrichmentClient::new(None);
    client.set_base_url(Source::Tvmaze, server.url.clone());
    client.set_base_url(Source::AniList, server.url.clone());
    client.set_base_url(Source::Arm, server.url.clone());
    assert_eq!(
        get_title_credits(&client, "movie", "tt0133093", None)
            .await
            .unwrap(),
        TitleCredits::default()
    );
    assert_eq!(
        get_title_credits(&client, "series", "custom:42", None)
            .await
            .unwrap(),
        TitleCredits::default()
    );
    // Unknown media types also stay silent.
    assert_eq!(
        get_title_credits(&client, "special", "tt0133093", None)
            .await
            .unwrap(),
        TitleCredits::default()
    );
    assert!(server.finish().is_empty());
}

#[test]
fn streaming_links_use_active_title_destinations_only() {
    let media = serde_json::json!({"externalLinks": [
        {"site":"Official Site", "url":"https://example.com", "type":"INFO", "isDisabled":false},
        {"site":"Disabled", "url":"https://example.com", "type":"STREAMING", "isDisabled":true},
        {"site":"Unsafe", "url":"http://127.0.0.1", "type":"STREAMING", "isDisabled":false},
        {"site":"Crunchyroll", "url":"https://www.crunchyroll.com/one-piece", "type":"STREAMING", "isDisabled":false},
        {"site":"crunchyroll", "url":"https://www.crunchyroll.com/duplicate", "type":"STREAMING", "isDisabled":false},
        {"site":"Hulu", "url":"https://www.hulu.com/one-piece", "type":"STREAMING", "isDisabled":false},
        {"site":"Netflix", "url":"https://www.netflix.com/title/80107103", "type":"STREAMING", "isDisabled":false},
        {"site":"Unknown", "url":"https://example.com", "type":"STREAMING", "isDisabled":null}
    ]});
    assert_eq!(
        anilist_streaming(&media),
        [
            StreamingLink {
                site: "Crunchyroll".into(),
                url: "https://www.crunchyroll.com/one-piece".into()
            },
            StreamingLink {
                site: "Hulu".into(),
                url: "https://www.hulu.com/one-piece".into()
            },
            StreamingLink {
                site: "Netflix".into(),
                url: "https://www.netflix.com/title/80107103".into()
            },
        ]
    );
}

#[tokio::test]
async fn anilist_rejects_unrelated_media_for_both_id_namespaces() {
    for id in ["mal:25777", "anilist:20958"] {
        let server = TestHttpServer::new(vec![(200, ANILIST_MEDIA, None)]);
        let mut client = EnrichmentClient::new(None);
        client.set_base_url(Source::AniList, server.url.clone());
        assert!(
            get_title_credits(&client, "anime", id, None).await.is_err(),
            "{id}"
        );
        assert_eq!(server.finish().len(), 1);
    }
}

#[tokio::test]
async fn title_links_allow_attribution_and_cached_provider_destinations_only() {
    let server = TestHttpServer::new(vec![(200, ANILIST_MEDIA, None)]);
    let trap = TestHttpServer::new(vec![]);
    let mut client = EnrichmentClient::new(None);
    client.set_base_url(Source::AniList, server.url.clone());
    client.set_base_url(Source::Tvmaze, trap.url.clone());
    client.set_base_url(Source::Arm, trap.url.clone());
    for url in [
        "https://www.tvmaze.com",
        "https://anilist.co",
        "https://creativecommons.org/licenses/by-sa/4.0/",
    ] {
        validate_title_link(&client, "series", "tt1", None, url)
            .await
            .unwrap();
    }
    assert!(trap.finish().is_empty());
    validate_title_link(
        &client,
        "anime",
        "mal:16498",
        None,
        "http://crunchyroll.com/series/1",
    )
    .await
    .unwrap();
    for url in [
        "https://anilist.co/anime/111",
        "https://anilist.co.evil.test",
        "https://anilist.co/anime/999999",
        "https://example.com",
        "javascript:alert(1)",
        "file:///C:/Windows",
        "http://127.0.0.1",
    ] {
        assert!(
            validate_title_link(&client, "anime", "mal:16498", None, url)
                .await
                .is_err(),
            "{url}"
        );
    }
    assert!(validate_title_link(
        &client,
        "movie",
        "mal:16498",
        None,
        "https://anilist.co/anime/111"
    )
    .await
    .is_err());
    assert_eq!(server.finish().len(), 1);
}
