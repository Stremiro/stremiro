use std::time::{Duration, Instant};

use iroh::{RelayMode, SecretKey};

use super::{
    commands::MatchStreamRequest,
    protocol::{self, Kind, Media, Message, Playback},
    sync::{self, Clock},
    transport::{self, Invite, NetworkEvent},
};

pub(super) fn playback() -> Playback {
    Playback {
        media: Media {
            media_type: "movie".into(),
            media_id: "tt123".into(),
            season: None,
            episode: None,
        },
        pos_ms: 10_000,
        paused: false,
        rate: 1.0,
        dur_ms: 100_000,
        buffering: false,
        stream_digest: None,
    }
}

#[test]
fn signed_packets_bind_author_room_version_and_payload() {
    let key = SecretKey::generate();
    let topic = [7; 32];
    let message = Message {
        v: 1,
        seq: 1,
        at_ms: 100,
        kind: Kind::Hello {
            name: "Alice".into(),
        },
    };
    let bytes = protocol::encode(&key, &topic, &message).unwrap();
    assert_eq!(protocol::decode(&topic, &bytes).unwrap().0, key.public());
    assert!(protocol::decode(&[8; 32], &bytes).is_none());
    let altered = String::from_utf8(bytes).unwrap().replace("Alice", "Other");
    assert!(protocol::decode(&topic, altered.as_bytes()).is_none());
    let wrong_version = Message { v: 2, ..message };
    assert!(protocol::decode(
        &topic,
        &protocol::encode(&key, &topic, &wrong_version).unwrap()
    )
    .is_none());
    assert!(protocol::decode(&topic, &[0; protocol::MAX_PACKET + 1]).is_none());
}

#[test]
fn invite_round_trip_bounds_and_untrusted_relay_rejection() {
    let relay = RelayMode::Default.relay_map().urls::<Vec<_>>().remove(0);
    let invite = Invite {
        v: 1,
        topic: [4; 32],
        host: SecretKey::generate().public(),
        relay,
    };
    let encoded = invite.encode().unwrap();
    let parsed = Invite::parse(&encoded).unwrap();
    assert_eq!(parsed.topic, invite.topic);
    assert_eq!(parsed.host, invite.host);
    assert!(parsed
        .addr()
        .addrs
        .iter()
        .all(iroh::TransportAddr::is_relay));
    assert!(Invite::parse(encoded.strip_prefix("stremiro://party/").unwrap()).is_ok());
    assert!(Invite::parse(&format!(
        "#{}",
        encoded.strip_prefix("stremiro://party/").unwrap()
    ))
    .is_ok());
    assert!(Invite::parse(&"x".repeat(2049)).is_err());
    let malicious = Invite {
        relay: "https://attacker.example/".parse().unwrap(),
        ..invite
    };
    assert!(Invite::parse(&malicious.encode().unwrap()).is_err());
}

#[test]
fn remote_playback_rejects_locators_coordinates_and_extreme_values() {
    let mut state = playback();
    assert!(state.validate());
    state.media.media_id = "https://example.org/private".into();
    assert!(!state.validate());
    state = playback();
    state.media.episode = Some(1);
    assert!(!state.validate());
    state = playback();
    state.rate = f64::NAN;
    assert!(!state.validate());
    state = playback();
    state.rate = 2.1;
    assert!(!state.validate());
    state = playback();
    state.pos_ms = protocol::MAX_POSITION + 1;
    assert!(!state.validate());
    state = playback();
    state.stream_digest = Some("raw locator".into());
    assert!(!state.validate());
}

#[test]
fn stream_fingerprints_are_room_scoped_and_deterministic() {
    assert_eq!(
        protocol::digest(&[1; 32], "h:file:0"),
        protocol::digest(&[1; 32], "h:file:0")
    );
    assert_ne!(
        protocol::digest(&[1; 32], "h:file:0"),
        protocol::digest(&[2; 32], "h:file:0")
    );
    assert_ne!(
        protocol::digest(&[1; 32], "h:file:0"),
        protocol::digest(&[1; 32], "h:file:1")
    );
}

#[test]
fn drift_nudges_in_both_directions_then_restores_rate_and_clamps_seek() {
    let now = Instant::now();
    let clock = Clock {
        playback: playback(),
        received: now,
        actor: SecretKey::generate().public(),
        control: 1,
    };
    let mut local = playback();
    local.pos_ms = 9_000;
    assert_eq!(
        sync::correction(&clock, &local, now, false).rate,
        Some(1.02)
    );
    local.pos_ms = 11_000;
    assert_eq!(
        sync::correction(&clock, &local, now, false).rate,
        Some(0.98)
    );
    local.pos_ms = 10_000;
    local.rate = 1.02;
    assert_eq!(sync::correction(&clock, &local, now, false).rate, Some(1.0));
    local.pos_ms = 0;
    local.dur_ms = 5_000;
    assert_eq!(
        sync::correction(&clock, &local, now, true).seek_ms,
        Some(5_000)
    );
    assert_eq!(clock.position(now + Duration::from_secs(1)), 11_000.0);
    local.buffering = true;
    assert!(sync::correction(&clock, &local, now, false)
        .seek_ms
        .is_none());
    assert_eq!(
        sync::correction(&clock, &local, now, true).seek_ms,
        Some(5_000)
    );
    assert!(sync::sources_differ(&clock, &local));
    // A stalled authority holds followers in place of catch-up seeks and nudges,
    // and the hold is neither announced as a pause nor hides a real jump.
    let mut stalled = clock.clone();
    stalled.playback.buffering = true;
    let mut ahead = playback();
    ahead.pos_ms = 13_000;
    let held = sync::correction(&stalled, &ahead, now, false);
    assert_eq!(
        (held.paused, held.seek_ms, held.rate),
        (Some(true), Some(10_000), None)
    );
    let by = || "Alex".to_string();
    assert_eq!(
        sync::control_notice(&held, false, 11_000, false, by()),
        None
    );
    let jumped = sync::correction(&stalled, &ahead, now, true);
    assert_eq!(
        sync::control_notice(&jumped, false, 40_000, false, by()),
        Some(sync::Notice::Jumped {
            by: by(),
            to_ms: 10_000
        })
    );
    assert_eq!(
        sync::control_notice(&held, true, 13_000, false, by()),
        Some(sync::Notice::Paused { by: by() })
    );
    ahead.paused = true;
    assert_eq!(
        sync::correction(&clock, &ahead, now, false).paused,
        Some(false)
    );
    local.dur_ms = 0;
    assert!(sync::correction(&clock, &local, now, true)
        .seek_ms
        .is_none());
    assert!(!sync::sources_differ(&clock, &local));
}

fn match_request(payload: serde_json::Value) -> MatchStreamRequest {
    serde_json::from_value(payload).unwrap()
}

#[test]
fn match_stream_request_maps_player_fields_to_a_pool_query() {
    let movie = match_request(serde_json::json!({
        "mediaId": "tt123",
        "mediaType": "movie",
    }));
    let query = movie.into_query().unwrap();
    assert_eq!(query.id, "tt123");
    assert_eq!(query.media_type, "movie");
    assert_eq!(query.season, None);
    assert_eq!(query.ranking.media_id, "tt123");
    assert_eq!(query.ranking.media_type, "movie");
    assert_eq!(query.ranking.season, None);
    assert_eq!(query.ranking.episode, None);

    let anime = match_request(serde_json::json!({
        "mediaId": "kitsu:456",
        "mediaType": "anime",
        "streamLookupId": "tt789",
        "streamSeason": 1,
        "streamEpisode": 5,
        "absoluteSeason": 3,
        "absoluteEpisode": 105,
        "title": "Mapped Show",
    }));
    let query = anime.into_query().unwrap();
    // Source coordinates drive the addon fetch; canonical ones drive ranking.
    assert_eq!(query.id, "tt789");
    assert_eq!(query.media_type, "anime");
    assert_eq!(query.season, Some(1));
    assert_eq!(query.episode, Some(5));
    assert_eq!(query.absolute_episode, Some(105));
    assert_eq!(query.ranking.media_id, "kitsu:456");
    assert_eq!(query.ranking.media_type, "anime");
    assert_eq!(query.ranking.title.as_deref(), Some("Mapped Show"));
    assert_eq!(query.ranking.season, Some(3));
    assert_eq!(query.ranking.episode, Some(105));

    let series = match_request(serde_json::json!({
        "mediaId": "tt222",
        "mediaType": "series",
        "streamSeason": 2,
        "streamEpisode": 3,
    }));
    let query = series.into_query().unwrap();
    assert_eq!(query.id, "tt222");
    assert_eq!(query.media_type, "series");
    assert_eq!(query.absolute_episode, None);
    assert_eq!(query.ranking.media_id, "tt222");
    assert_eq!(query.ranking.media_type, "series");
    assert_eq!(query.ranking.season, Some(2));
    assert_eq!(query.ranking.episode, Some(3));
    assert_eq!(query.ranking.title, None);
}

#[test]
fn match_stream_request_rejects_unusable_lookup_and_unknown_fields() {
    for stream_lookup_id in ["", "   "] {
        let request = match_request(serde_json::json!({
            "mediaId": "tt123",
            "mediaType": "movie",
            "streamLookupId": stream_lookup_id,
        }));
        assert!(request.into_query().is_err());
    }
    for payload in [
        serde_json::json!({"mediaId": "tt123", "mediaType": "movie", "bogus": 1}),
        serde_json::json!({"mediaId": "tt123", "mediaType": "movie", "streamSeason": "2"}),
        serde_json::json!({"mediaType": "movie"}),
    ] {
        assert!(serde_json::from_value::<MatchStreamRequest>(payload).is_err());
    }
}

#[test]
fn position_extrapolation_caps_known_duration_and_freezes_when_stalled() {
    let now = Instant::now();
    let mut clock = Clock {
        playback: playback(),
        received: now,
        actor: SecretKey::generate().public(),
        control: 1,
    };
    // Known duration caps near EOF; unknown duration runs to the bound.
    clock.playback.pos_ms = 99_000;
    assert_eq!(clock.position(now + Duration::from_secs(5)), 100_000.0);
    clock.playback.dur_ms = 0;
    assert_eq!(clock.position(now + Duration::from_secs(5)), 104_000.0);
    clock.playback.pos_ms = protocol::MAX_POSITION - 500;
    assert_eq!(
        clock.position(now + Duration::from_secs(5)),
        protocol::MAX_POSITION as f64
    );
    clock.playback.dur_ms = 100_000;
    clock.playback.pos_ms = 10_000;
    clock.playback.paused = true;
    assert_eq!(clock.position(now + Duration::from_secs(5)), 10_000.0);
    clock.playback.paused = false;
    clock.playback.buffering = true;
    assert_eq!(clock.position(now + Duration::from_secs(5)), 10_000.0);
    // Corrections still extrapolate — the seek lands on the clamped cap.
    clock.playback.buffering = false;
    clock.playback.pos_ms = 99_000;
    let mut local = playback();
    local.pos_ms = 0;
    assert_eq!(
        sync::correction(&clock, &local, now + Duration::from_secs(5), true).seek_ms,
        Some(100_000)
    );
}

#[test]
fn notices_keep_the_webview_wire_shape() {
    let jumped = sync::Notice::Jumped {
        by: "Alex".into(),
        to_ms: 754_000,
    };
    assert_eq!(
        serde_json::to_string(&[jumped, sync::Notice::SpeedLimited]).unwrap(),
        r#"[{"kind":"jumped","by":"Alex","toMs":754000},{"kind":"speedLimited"}]"#
    );
}

#[test]
fn text_rejects_controls_and_bidi_overrides_but_keeps_emoji_and_marks() {
    assert!(protocol::valid_name("Ana 👩‍👩‍👧"));
    assert!(protocol::valid_name("\u{200F}שלום"));
    assert!(!protocol::valid_name("   "));
    assert!(!protocol::valid_name("two\nlines"));
    assert!(!protocol::valid_name(&"x".repeat(33)));
    assert!(!protocol::valid_name("evil\u{202E}gnp.exe"));
    let max = protocol::MAX_CHAT_CHARS;
    assert!(!protocol::valid_text("hi\u{2066}there", max));
    assert!(!protocol::valid_text("bell\u{7}", max));
    assert!(protocol::valid_text("multi\nline", max));
    assert!(protocol::valid_text(&"👋".repeat(max), max));
    assert!(!protocol::valid_text(&"👋".repeat(max + 1), max));
}

// Explicit live smoke: two ephemeral clients, production relay and real QUIC.
// Kept out of the offline suite; no secrets or message contents are logged.
#[tokio::test]
#[ignore = "requires access to the production party relay"]
async fn private_relay_round_trip() {
    let host = transport::endpoint().await.unwrap();
    let guest = transport::endpoint().await.unwrap();
    let invite = transport::invite(&host).unwrap();
    let topic = invite.topic;
    let hello = |endpoint: &iroh::Endpoint| {
        protocol::encode(
            endpoint.secret_key(),
            &invite.topic,
            &Message {
                v: 1,
                seq: 1,
                at_ms: super::room::now_ms(),
                kind: Kind::Hello {
                    name: "Local test".into(),
                },
            },
        )
        .unwrap()
    };
    let host_hello = hello(&host);
    let guest_hello = hello(&guest);
    let accepting = host.clone();
    let (network, mut events) = tokio::sync::mpsc::channel(8);
    let serving = tokio::spawn(async move {
        let conn = accepting.accept().await.unwrap().await.unwrap();
        transport::serve(conn, network).await;
    });
    let joining = guest.clone();
    let joined =
        tokio::spawn(async move { transport::connect(&joining, &invite, &guest_hello).await });
    let event = tokio::time::timeout(Duration::from_secs(20), events.recv())
        .await
        .unwrap()
        .unwrap();
    let NetworkEvent::Connected {
        peer,
        packet,
        outbox,
        admit,
        ..
    } = event
    else {
        panic!("expected admission");
    };
    assert_eq!(protocol::decode(&topic, &packet).unwrap().0, guest.id());
    assert!(admit.send(Some(host_hello)).is_ok());
    let (conn, send, recv, first) = joined.await.unwrap().unwrap();
    assert_eq!(conn.remote_id(), host.id());
    assert!(!conn.paths().is_empty());
    assert!(conn
        .paths()
        .iter()
        .all(|path| path.remote_addr().is_relay()));
    assert_ne!(peer, host.id());
    assert_eq!(protocol::decode(&topic, &first).unwrap().0, host.id());
    let (guest_outbox, outgoing) = tokio::sync::mpsc::channel(8);
    let (guest_network, mut guest_events) = tokio::sync::mpsc::channel(8);
    let pumping = tokio::spawn(transport::pump(conn, send, recv, outgoing, guest_network));
    let chat = |endpoint: &iroh::Endpoint| {
        protocol::encode(
            endpoint.secret_key(),
            &topic,
            &Message {
                v: 1,
                seq: 2,
                at_ms: super::room::now_ms(),
                kind: Kind::Chat {
                    text: "Relay check".into(),
                },
            },
        )
        .unwrap()
    };
    outbox.send(chat(&host).into()).await.unwrap();
    guest_outbox.send(chat(&guest).into()).await.unwrap();
    for (events, author) in [(&mut events, guest.id()), (&mut guest_events, host.id())] {
        let event = tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .unwrap()
            .unwrap();
        let NetworkEvent::Packet { packet, .. } = event else {
            panic!("expected packet");
        };
        assert_eq!(protocol::decode(&topic, &packet).unwrap().0, author);
    }
    drop(outbox);
    drop(guest_outbox);
    host.close().await;
    guest.close().await;
    serving.await.unwrap();
    pumping.await.unwrap();
}

#[tokio::test]
#[ignore = "requires access to the production party relay"]
async fn rooms_route_chat_controls_lock_and_creator_close() {
    use super::room::{Operation, Report, Request, Room, Snapshot};
    use std::sync::{atomic::AtomicU64, Arc};
    use tokio::sync::{mpsc, oneshot, watch};

    async fn action(requests: &mpsc::Sender<Request>, operation: Operation) {
        let (reply, response) = oneshot::channel();
        requests.send(Request { operation, reply }).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), response)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
    async fn until(
        snapshots: &mut watch::Receiver<Snapshot>,
        predicate: impl Fn(&Snapshot) -> bool,
    ) {
        tokio::time::timeout(Duration::from_secs(8), async {
            while !predicate(&snapshots.borrow()) {
                snapshots.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
    }

    let host = transport::endpoint().await.unwrap();
    let invite = transport::invite(&host).unwrap();
    let revision = Arc::new(AtomicU64::new(0));
    let (host_snapshots, mut host_view) = watch::channel(Snapshot::default());
    let host_room = Room::new(
        host.clone(),
        invite.clone(),
        "Creator".into(),
        |_| {},
        host_snapshots,
        revision.clone(),
    );
    let (host_requests, receiver) = mpsc::channel(32);
    let hosting = tokio::spawn(host_room.run(receiver, None));
    until(&mut host_view, |view| view.active).await;

    let guest = transport::endpoint().await.unwrap();
    let (guest_snapshots, mut guest_view) = watch::channel(Snapshot::default());
    let guest_room = Room::new(
        guest.clone(),
        invite.clone(),
        "Guest".into(),
        |_| {},
        guest_snapshots,
        revision,
    );
    let guest_hello = guest_room.hello();
    let connection = transport::connect(&guest, &invite, &guest_hello)
        .await
        .unwrap();
    let (guest_requests, receiver) = mpsc::channel(32);
    let joining = tokio::spawn(guest_room.run(receiver, Some(connection)));
    until(&mut guest_view, |view| {
        view.active && view.members.len() == 2
    })
    .await;
    // A rejected second connection must not remove the admitted connection.
    assert!(transport::connect(&guest, &invite, &guest_hello)
        .await
        .is_err());
    action(&guest_requests, Operation::Chat("Room check".into())).await;
    until(&mut host_view, |view| view.chat.len() == 1).await;
    assert_eq!(host_view.borrow().members.len(), 2);
    action(&host_requests, Operation::Chat("Reply".into())).await;
    until(&mut guest_view, |view| view.chat.len() == 2).await;

    let (reply, report) = oneshot::channel();
    action(
        &host_requests,
        Operation::Report(
            Report {
                playback: playback(),
                stream_key: None,
                token: String::new(),
            },
            reply,
        ),
    )
    .await;
    report.await.unwrap().unwrap();
    until(&mut guest_view, |view| view.playback.is_some()).await;
    let (reply, position) = oneshot::channel();
    action(&guest_requests, Operation::Follow(false, reply)).await;
    assert!(position.await.unwrap().unwrap() >= 10_000);
    let (reply, report) = oneshot::channel();
    let mut behind = playback();
    behind.pos_ms = 0;
    action(
        &guest_requests,
        Operation::Report(
            Report {
                playback: behind,
                stream_key: None,
                token: String::new(),
            },
            reply,
        ),
    )
    .await;
    assert!(report.await.unwrap().unwrap().seek_ms.unwrap() >= 10_000);

    let late = transport::endpoint().await.unwrap();
    let hello = protocol::encode(
        late.secret_key(),
        &invite.topic,
        &Message {
            v: 1,
            seq: 1,
            at_ms: super::room::now_ms(),
            kind: Kind::Hello {
                name: "Late".into(),
            },
        },
    )
    .unwrap();
    let (conn, send, recv, _) = transport::connect(&late, &invite, &hello).await.unwrap();
    until(&mut host_view, |view| view.members.len() == 3).await;
    let (outbox, outgoing) = mpsc::channel(8);
    let (events, _incoming) = mpsc::channel(8);
    let pumping = tokio::spawn(transport::pump(conn, send, recv, outgoing, events));
    // A valid signature from another room member still fails QUIC author binding.
    outbox.send(guest_hello.into()).await.unwrap();
    until(&mut host_view, |view| view.members.len() == 2).await;
    tokio::time::timeout(Duration::from_secs(5), pumping)
        .await
        .unwrap()
        .unwrap();
    assert!(host_view
        .borrow()
        .chat
        .iter()
        .all(|chat| chat.name != "Late"));
    action(&host_requests, Operation::Lock(true)).await;
    until(&mut guest_view, |view| view.locked).await;
    assert!(transport::connect(&late, &invite, &hello).await.is_err());
    late.close().await;
    action(&host_requests, Operation::Leave).await;
    until(&mut guest_view, |view| !view.active).await;
    assert!(guest_view.borrow().error.is_some());
    assert!(guest_view.borrow().chat.is_empty());
    tokio::time::timeout(Duration::from_secs(8), hosting)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(8), joining)
        .await
        .unwrap()
        .unwrap();
}
