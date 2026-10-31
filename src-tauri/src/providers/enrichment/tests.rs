use super::*;
use crate::test_helpers::TestHttpServer;

fn decode_json(bytes: &[u8]) -> Result<(serde_json::Value, bool), String> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| "bad json".to_string())?;
    Ok((value.clone(), value.is_null()))
}

#[tokio::test]
async fn load_caches_single_flight_and_replays_disk_with_original_expiry() {
    let dir = std::env::temp_dir().join(format!("enrich-test-{}", uuid::Uuid::new_v4()));
    let server = TestHttpServer::new(vec![(200, r#"{"ok":1}"#, None)]);
    let mut client = EnrichmentClient::new(Some(dir.clone()));
    client.set_base_url(Source::Kitsu, server.url.clone());
    let url = format!("{}/v2/x", server.url);
    let key = "k:one";

    // Concurrent same-key callers share one HTTP fetch.
    let (a, b) = tokio::join!(
        client.load(key, Source::Kitsu, client.get(&url), decode_json),
        client.load(key, Source::Kitsu, client.get(&url), decode_json),
    );
    assert_eq!(a.unwrap()["ok"], 1);
    assert_eq!(b.unwrap()["ok"], 1);

    // A fresh client on the same disk cache serves without HTTP, and the
    // original expiry rides the envelope rather than resetting to 12h.
    let mut restarted = EnrichmentClient::new(Some(dir.clone()));
    restarted.set_base_url(Source::Kitsu, server.url.clone());
    let hit = restarted
        .load(key, Source::Kitsu, restarted.get(&url), decode_json)
        .await
        .unwrap();
    assert_eq!(hit["ok"], 1);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(server.finish().len(), 1);
}

#[tokio::test]
async fn not_found_is_a_definitive_miss_and_failures_cool_down_per_source() {
    let server = TestHttpServer::new(vec![(404, "{}", None), (503, "{}", None)]);
    let mut client = EnrichmentClient::new(None);
    client.set_base_url(Source::Kitsu, server.url.clone());
    let url = format!("{}/v2/missing", server.url);

    let (value, empty) = client
        .load("miss:1", Source::Kitsu, client.get(&url), decode_json)
        .await
        .map(|v| (v.clone(), v.is_null()))
        .unwrap();
    assert_eq!(value, serde_json::Value::Null);
    assert!(empty);

    // 503 fails, cools the source, and the next caller fails fast (no HTTP).
    assert!(client
        .load("fail:1", Source::Kitsu, client.get(&url), decode_json)
        .await
        .is_err());
    assert!(client.cooldown_until(Source::Kitsu).is_some());
    assert!(client
        .load("fail:2", Source::Kitsu, client.get(&url), decode_json)
        .await
        .is_err());
    assert_eq!(server.finish().len(), 2);
}

#[tokio::test]
async fn retry_after_numeric_and_fixdate_drive_the_cooldown() {
    let server = TestHttpServer::with_headers(vec![
        (429, "{}", vec![("Retry-After", "45")]),
        (
            429,
            "{}",
            vec![("Retry-After", "Wed, 21 Oct 2099 07:28:00 GMT")],
        ),
    ]);
    let mut client = EnrichmentClient::new(None);
    client.set_base_url(Source::Kitsu, server.url.clone());
    let url = format!("{}/v2/r", server.url);

    assert!(client
        .load("r:1", Source::Kitsu, client.get(&url), decode_json)
        .await
        .is_err());
    let until = client.cooldown_until(Source::Kitsu).unwrap();
    let gap = until.duration_since(Instant::now());
    assert!(gap >= Duration::from_secs(44) && gap <= Duration::from_secs(46));

    // A fresh client (clean cooldowns) consumes the IMF-fixdate 429.
    let mut client2 = EnrichmentClient::new(None);
    client2.set_base_url(Source::Kitsu, server.url.clone());
    assert!(client2
        .load("r:2", Source::Kitsu, client2.get(&url), decode_json)
        .await
        .is_err());
    let until = client2.cooldown_until(Source::Kitsu).unwrap();
    assert!(until.duration_since(Instant::now()) > Duration::from_secs(86_400));
    assert_eq!(server.finish().len(), 2);
}

#[test]
fn disk_envelopes_reject_mismatch_corruption_oversize_and_far_future() {
    let dir = std::env::temp_dir().join(format!("enrich-env-{}", uuid::Uuid::new_v4()));
    let path = dir.join("entry.json");
    let write = |envelope: &str| {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, envelope).unwrap();
    };
    let valid = serde_json::json!({
        "key": "k", "expires_at": "2050-01-01T00:00:00.000Z", "response": {"v": 1}
    });
    // SystemTime serde emits an object; build the real envelope instead.
    let valid = serde_json::to_vec(&DiskEnvelope {
        key: "k".into(),
        expires_at: SystemTime::now() + Duration::from_secs(60),
        response: serde_json::value::RawValue::from_string(valid["response"].to_string()).unwrap(),
    })
    .unwrap();
    write(std::str::from_utf8(&valid).unwrap());
    assert!(read_disk_envelope(&path, "k").is_some());
    assert!(read_disk_envelope(&path, "other").is_none());

    write("{corrupt");
    assert!(read_disk_envelope(&path, "k").is_none());
    write(
        &serde_json::to_vec(&DiskEnvelope {
            key: "k".into(),
            expires_at: SystemTime::now() - Duration::from_secs(60),
            response: serde_json::value::RawValue::from_string("null".into()).unwrap(),
        })
        .map(|b| String::from_utf8(b).unwrap())
        .unwrap(),
    );
    assert!(read_disk_envelope(&path, "k").is_none());
    write(
        &serde_json::to_vec(&DiskEnvelope {
            key: "k".into(),
            expires_at: SystemTime::now() + FULL_TTL + Duration::from_secs(3600),
            response: serde_json::value::RawValue::from_string("null".into()).unwrap(),
        })
        .map(|b| String::from_utf8(b).unwrap())
        .unwrap(),
    );
    assert!(read_disk_envelope(&path, "k").is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn empty_and_full_responses_keep_original_disk_expiry() {
    let dir = std::env::temp_dir().join(format!("enrich-ttl-{}", uuid::Uuid::new_v4()));
    let server = TestHttpServer::new(vec![
        (200, "null", None),
        (200, r#"{"ok":1}"#, None),
        (200, r#"{"ok":2}"#, None),
    ]);
    let mut client = EnrichmentClient::new(Some(dir.clone()));
    client.set_base_url(Source::Kitsu, server.url.clone());
    let url = format!("{}/v2/x", server.url);

    client
        .load("empty:key", Source::Kitsu, client.get(&url), decode_json)
        .await
        .unwrap();
    client
        .load("full:key", Source::Kitsu, client.get(&url), decode_json)
        .await
        .unwrap();

    // Semantic-empty stamps EMPTY_TTL; a populated body stamps FULL_TTL.
    let (_, empty_stamp) =
        read_disk_envelope(&client.disk_path("empty:key").unwrap(), "empty:key").unwrap();
    let (_, full_stamp) =
        read_disk_envelope(&client.disk_path("full:key").unwrap(), "full:key").unwrap();
    let now = SystemTime::now();
    let empty_ttl = empty_stamp.duration_since(now).unwrap();
    let full_ttl = full_stamp.duration_since(now).unwrap();
    assert!(empty_ttl <= EMPTY_TTL && empty_ttl >= EMPTY_TTL - Duration::from_secs(1));
    assert!(full_ttl <= FULL_TTL && full_ttl >= FULL_TTL - Duration::from_secs(1));

    // A restarted client adopts the envelope stamp verbatim - no reset, no HTTP.
    let mut restarted = EnrichmentClient::new(Some(dir.clone()));
    restarted.set_base_url(Source::Kitsu, server.url.clone());
    restarted
        .load("empty:key", Source::Kitsu, restarted.get(&url), decode_json)
        .await
        .unwrap();
    assert_eq!(
        restarted.cached("empty:key").map(|entry| entry.expires_at),
        Some(empty_stamp)
    );

    // Rewriting the stamp into the past forces one fresh fetch after restart.
    let path = client.disk_path("empty:key").unwrap();
    let envelope = serde_json::to_vec(&DiskEnvelope {
        key: "empty:key".to_string(),
        expires_at: SystemTime::now() - Duration::from_secs(60),
        response: serde_json::value::RawValue::from_string("null".to_string()).unwrap(),
    })
    .unwrap();
    std::fs::write(&path, &envelope).unwrap();
    let mut fresh = EnrichmentClient::new(Some(dir.clone()));
    fresh.set_base_url(Source::Kitsu, server.url.clone());
    fresh
        .load("empty:key", Source::Kitsu, fresh.get(&url), decode_json)
        .await
        .unwrap();

    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(server.finish().len(), 3);
}

#[test]
fn disk_eviction_and_body_bounds() {
    let dir = std::env::temp_dir().join(format!("enrich-bound-{}", uuid::Uuid::new_v4()));
    // An undeletable oldest victim must not block later writes or eviction.
    std::fs::create_dir_all(dir.join("stuck.json")).unwrap();
    for index in 0..129 {
        let key = format!("bound-{index}");
        let envelope = serde_json::to_vec(&DiskEnvelope {
            key: key.clone(),
            expires_at: SystemTime::now() + Duration::from_secs(3600),
            response: serde_json::value::RawValue::from_string(format!("{{\"i\":{index}}}"))
                .unwrap(),
        })
        .unwrap();
        write_disk_envelope(&dir.join(format!("{key}.json")), &envelope).unwrap();
    }
    let files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .collect();
    assert_eq!(files.len(), DISK_MAX_ENTRIES);
    assert!(dir.join("bound-128.json").exists());

    // A response body beyond MAX_BODY_BYTES is rejected even inside a
    // legal-size envelope.
    let big = "x".repeat(MAX_BODY_BYTES + 500);
    let envelope = serde_json::to_vec(&DiskEnvelope {
        key: "big".to_string(),
        expires_at: SystemTime::now() + Duration::from_secs(3600),
        response: serde_json::value::RawValue::from_string(format!("\"{big}\"")).unwrap(),
    })
    .unwrap();
    assert!(envelope.len() <= DISK_MAX_BYTES);
    let path = dir.join("big.json");
    std::fs::write(&path, &envelope).unwrap();
    assert!(read_disk_envelope(&path, "big").is_none());

    // A whole-envelope oversize is rejected too.
    std::fs::write(&path, vec![b'{'; DISK_MAX_BYTES + 1]).unwrap();
    assert!(read_disk_envelope(&path, "big").is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn concurrent_failures_share_gate_and_negative_cache() {
    // Two different keys, one unpaced source, one scripted 429: the source
    // gate lets the second caller see the fresh cooldown - one HTTP, both Err.
    let server = TestHttpServer::with_headers(vec![
        (429, "{}", Vec::new()),
        (200, r#"{"ok":1}"#, Vec::new()),
    ]);
    let mut client = EnrichmentClient::new(None);
    client.set_base_url(Source::Arm, server.url.clone());
    client.set_base_url(Source::Kitsu, server.url.clone());
    let url = format!("{}/api/v2/x", server.url);
    let (a, b) = tokio::join!(
        client.load("k:1", Source::Arm, client.get(&url), decode_json),
        client.load("k:2", Source::Arm, client.get(&url), decode_json),
    );
    assert!(a.is_err() && b.is_err());
    // A different source is not covered by Arm's cooldown.
    assert!(client
        .load("k:3", Source::Kitsu, client.get(&url), decode_json)
        .await
        .is_ok());
    assert_eq!(server.finish().len(), 2);

    // Concurrent callers on one key share the leader's decode failure.
    let server = TestHttpServer::new(vec![(200, "{bad json", None)]);
    let mut client = EnrichmentClient::new(None);
    client.set_base_url(Source::Kitsu, server.url.clone());
    let url = format!("{}/v2/x", server.url);
    let (a, b) = tokio::join!(
        client.load("same:key", Source::Kitsu, client.get(&url), decode_json),
        client.load("same:key", Source::Kitsu, client.get(&url), decode_json),
    );
    assert!(a.is_err() && b.is_err());
    assert_eq!(server.finish().len(), 1);
}

#[tokio::test]
async fn cooldown_headers_are_bounded_and_validate_dates() {
    // A hostile Retry-After never panics and clamps at MAX_COOLDOWN (7 days).
    let server = TestHttpServer::with_headers(vec![(
        429,
        "{}",
        vec![("Retry-After", "18446744073709551615")],
    )]);
    let mut client = EnrichmentClient::new(None);
    client.set_base_url(Source::Kitsu, server.url.clone());
    assert!(client
        .load(
            "r:max",
            Source::Kitsu,
            client.get(&format!("{}/v2/x", server.url)),
            decode_json,
        )
        .await
        .is_err());
    let until = client.cooldown_until(Source::Kitsu).unwrap();
    assert!(until <= Instant::now() + MAX_COOLDOWN + Duration::from_secs(1));
    assert!(until > Instant::now());

    // IMF-fixdate rejects extra clock components, invalid times/dates/zones.
    for value in [
        "Sun, 06 Nov 1994 08:49:37:99 GMT",
        "Sun, 06 Nov 1994 24:00:00 GMT",
        "Sun, 30 Feb 2024 00:00:00 GMT",
        "Sun, 06 Nov 1994 08:49:37 PST",
    ] {
        assert_eq!(parse_imf_fixdate(value), None, "{value}");
    }

    // AniList exhaustion: Remaining=0 + Reset epoch ~120s out, no Retry-After -
    // the Reset stamp drives the cooldown, not the 30s default.
    let reset = unix_now_secs() + 120;
    let reset = Box::leak(reset.to_string().into_boxed_str()) as &'static str;
    let server = TestHttpServer::with_headers(vec![(
        429,
        "{}",
        vec![("X-RateLimit-Remaining", "0"), ("X-RateLimit-Reset", reset)],
    )]);
    let mut client = EnrichmentClient::new(None);
    client.set_base_url(Source::AniList, server.url.clone());
    assert!(client
        .load(
            "r:al",
            Source::AniList,
            client.get(&format!("{}/graphql", server.url)),
            decode_json,
        )
        .await
        .is_err());
    let until = client.cooldown_until(Source::AniList).unwrap();
    assert!(until.duration_since(Instant::now()) >= Duration::from_secs(110));
    let _ = server.finish();
}
