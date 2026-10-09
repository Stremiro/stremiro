use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use iroh::{endpoint::Connection, Endpoint, EndpointId};
use serde::{Deserialize, Serialize};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinSet,
};

use super::{
    protocol::{self, Kind, Media, Message, Playback},
    sync::{self, Clock, Correction, Notice},
    transport::{self, Invite, Joined, NetworkEvent, Outbox},
};

const MAX_MEMBERS: usize = 16;
const MAX_PACKETS_PER_SECOND: u32 = 50;
pub(super) const ROOM_LOST: &str =
    "The room closed or its connection was lost. Your playback continues.";

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberView {
    pub id: String,
    pub name: String,
    pub creator: bool,
    pub you: bool,
    pub buffering: bool,
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatView {
    pub id: String,
    pub member_id: String,
    pub name: String,
    pub text: String,
}

/// UI view of the shared clock. Position stays out so heartbeats that only
/// advance it do not republish; `party_follow` returns the live position.
#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedPlayback {
    pub media: Media,
    pub paused: bool,
    pub rate: f64,
    /// The sharer fingerprinted its source, so `party_match_stream` can look for it.
    pub matchable: bool,
}

#[derive(Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub session: String,
    pub revision: u64,
    pub active: bool,
    pub creator: bool,
    pub locked: bool,
    pub syncing: bool,
    pub members: Vec<MemberView>,
    pub chat: Vec<ChatView>,
    pub playback: Option<SharedPlayback>,
    pub playback_is_local: bool,
    /// Display id of the member whose control produced the shared playback.
    pub playback_by: Option<String>,
    pub error: Option<String>,
}

struct Member {
    name: String,
    seq: u64,
    at_ms: u64,
    window: Instant,
    messages: u32,
    chats: VecDeque<Instant>,
    hello: Vec<u8>,
    buffering: bool,
}

impl Member {
    fn accept(&mut self, message: &Message, now: Instant, removal: bool) -> bool {
        if now.duration_since(self.window) >= Duration::from_secs(1) {
            self.window = now;
            self.messages = 0;
        }
        self.messages += 1;
        if (self.messages > MAX_PACKETS_PER_SECOND && !removal)
            || message.seq <= self.seq
            || message.at_ms < self.at_ms
            || message.at_ms > now_ms().saturating_add(5000)
        {
            return false;
        }
        if matches!(message.kind, Kind::Chat { .. }) {
            while self
                .chats
                .front()
                .is_some_and(|at| now.duration_since(*at) >= Duration::from_secs(10))
            {
                self.chats.pop_front();
            }
            if self.chats.len() >= 20 {
                return false;
            }
            self.chats.push_back(now);
        }
        self.seq = message.seq;
        self.at_ms = message.at_ms;
        true
    }
}

/// A local player sample. The stream key stays on this device: only its
/// room-scoped digest enters signed state.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Report {
    pub playback: Playback,
    pub stream_key: Option<String>,
    pub token: String,
}

pub enum Operation {
    Chat(String),
    Name(String),
    Lock(bool),
    /// Replies with the room's live position for the shared media.
    Follow(bool, oneshot::Sender<Option<u64>>),
    Report(Report, oneshot::Sender<Result<Correction, String>>),
    /// `(stream_key, content_key)` candidates; replies with the stream key
    /// whose content (or exact key) digest matches the shared source.
    Match(
        Vec<(String, Option<String>)>,
        oneshot::Sender<Option<String>>,
    ),
    Leave,
}

pub struct Request {
    pub operation: Operation,
    pub reply: oneshot::Sender<Result<(), String>>,
}

struct Client {
    outbox: Outbox,
    connection: Connection,
}

impl Drop for Client {
    fn drop(&mut self) {
        self.connection.close(0u32.into(), b"room closed");
    }
}

pub struct Room {
    endpoint: Endpoint,
    invite: Invite,
    members: BTreeMap<EndpointId, Member>,
    clients: BTreeMap<EndpointId, Client>,
    state: Option<Clock>,
    state_packet: Option<Vec<u8>>,
    lock_packet: Option<Vec<u8>>,
    chat: VecDeque<ChatView>,
    locked: bool,
    syncing: bool,
    force_share: bool,
    sources_noticed: bool,
    seq: u64,
    sent_at: u64,
    last_local: Option<(Playback, Instant)>,
    last_sent: Instant,
    session: String,
    revision: Arc<AtomicU64>,
    emit: Box<dyn Fn(&Snapshot) + Send>,
    snapshots: watch::Sender<Snapshot>,
}

fn display_id(id: EndpointId) -> String {
    // Byte slicing would panic on a shorter/multibyte string if the id's
    // display format ever changed; char-boundary truncation cannot.
    id.to_string().chars().take(12).collect()
}

impl Room {
    pub fn new(
        endpoint: Endpoint,
        invite: Invite,
        name: String,
        emit: impl Fn(&Snapshot) + Send + 'static,
        snapshots: watch::Sender<Snapshot>,
        revision: Arc<AtomicU64>,
    ) -> Self {
        let creator = endpoint.id() == invite.host;
        let mut room = Self {
            endpoint,
            invite,
            members: BTreeMap::new(),
            clients: BTreeMap::new(),
            state: None,
            state_packet: None,
            lock_packet: None,
            chat: VecDeque::new(),
            locked: false,
            syncing: creator,
            force_share: false,
            sources_noticed: false,
            seq: 0,
            sent_at: 0,
            last_local: None,
            last_sent: Instant::now(),
            session: uuid::Uuid::new_v4().to_string(),
            revision,
            emit: Box::new(emit),
            snapshots,
        };
        // Keep the signed hello for reconnect snapshots; the identity key is
        // generated for this room and disappears when its endpoint closes.
        let _ = room.local(Kind::Hello { name });
        room
    }

    fn is_creator(&self) -> bool {
        self.endpoint.id() == self.invite.host
    }

    pub fn hello(&self) -> Vec<u8> {
        // `new` always writes the self member; if a future change breaks
        // that, an empty frame is rejected downstream instead of panicking.
        self.members
            .get(&self.endpoint.id())
            .map(|member| member.hello.clone())
            .unwrap_or_default()
    }

    pub fn session_id(&self) -> &str {
        &self.session
    }

    fn publish(&mut self, error: Option<String>, active: bool) {
        let me = self.endpoint.id();
        let state = self.state.as_ref().filter(|_| active);
        let mut snapshot = Snapshot {
            session: self.session.clone(),
            revision: 0,
            active,
            creator: self.is_creator(),
            locked: self.locked,
            syncing: self.syncing,
            members: if active {
                self.members
                    .iter()
                    .map(|(id, member)| MemberView {
                        id: display_id(*id),
                        name: member.name.clone(),
                        creator: *id == self.invite.host,
                        you: *id == me,
                        buffering: member.buffering,
                    })
                    .collect()
            } else {
                Vec::new()
            },
            chat: if active {
                self.chat.iter().cloned().collect()
            } else {
                Vec::new()
            },
            playback: state.map(|clock| SharedPlayback {
                media: clock.playback.media.clone(),
                paused: clock.playback.paused,
                rate: clock.playback.rate,
                matchable: clock.playback.stream_digest.is_some(),
            }),
            playback_is_local: state.is_some_and(|clock| clock.actor == me),
            playback_by: state.map(|clock| display_id(clock.actor)),
            error,
        };
        let unchanged = {
            let previous = self.snapshots.borrow();
            snapshot.revision = previous.revision;
            *previous == snapshot
        };
        if unchanged {
            return;
        }
        snapshot.revision = self.revision.fetch_add(1, Ordering::Relaxed) + 1;
        self.snapshots.send_replace(snapshot.clone());
        (self.emit)(&snapshot);
    }

    fn local(&mut self, kind: Kind) -> Result<(), String> {
        self.seq = self.seq.checked_add(1).ok_or("Party sequence exhausted.")?;
        self.sent_at = now_ms().max(self.sent_at).max(match &kind {
            Kind::State { control, .. } => *control,
            _ => 0,
        });
        let message = Message {
            v: 1,
            seq: self.seq,
            at_ms: self.sent_at,
            kind,
        };
        let bytes = protocol::encode(self.endpoint.secret_key(), &self.invite.topic, &message)?;
        if !self.apply(self.endpoint.id(), &message, &bytes) {
            return Err("Party action was rejected or rate limited.".into());
        }
        // State sends feed the heartbeat interval — reannounce/admit
        // publishes count too, or the next report emits a duplicate beat.
        if matches!(message.kind, Kind::State { .. }) {
            self.last_sent = Instant::now();
        }
        self.broadcast(&bytes, None);
        Ok(())
    }

    fn broadcast(&mut self, bytes: &[u8], except: Option<EndpointId>) {
        if self.clients.is_empty() {
            return;
        }
        let packet: Arc<[u8]> = bytes.into();
        self.clients.retain(|id, client| {
            Some(*id) == except || client.outbox.try_send(packet.clone()).is_ok()
        });
    }

    fn apply(&mut self, sender: EndpointId, message: &Message, bytes: &[u8]) -> bool {
        let now = Instant::now();
        if let Kind::Hello { name } = &message.kind {
            if !self.members.contains_key(&sender) {
                if self.locked || self.members.len() >= MAX_MEMBERS {
                    return false;
                }
                // Admission checks run before the identity takes a member
                // slot: a rejected hello must not reserve room capacity.
                let mut candidate = Member {
                    name: name.clone(),
                    seq: 0,
                    at_ms: 0,
                    window: now,
                    messages: 0,
                    chats: VecDeque::new(),
                    hello: Vec::new(),
                    buffering: false,
                };
                if !candidate.accept(message, now, false) {
                    return false;
                }
                candidate.hello = bytes.to_vec();
                self.members.insert(sender, candidate);
                return true;
            }
        }
        // Creator-signed removals must reach every member even when join/leave
        // bursts fill the bucket; author, sequence and timestamp checks still apply.
        let removal = sender == self.invite.host
            && matches!(message.kind, Kind::Remove { member }
                if member != self.invite.host && member != self.endpoint.id());
        let Some(member) = self.members.get_mut(&sender) else {
            return false;
        };
        if !member.accept(message, now, removal) {
            return false;
        }
        match &message.kind {
            Kind::Hello { name } => {
                member.name = name.clone();
                member.hello = bytes.to_vec();
            }
            Kind::State { playback, control } => {
                member.buffering = playback.buffering;
                let wins = self
                    .state
                    .as_ref()
                    .is_none_or(|clock| (*control, sender) >= (clock.control, clock.actor));
                if wins {
                    self.state = Some(Clock {
                        playback: playback.clone(),
                        received: now,
                        actor: sender,
                        control: *control,
                    });
                    self.state_packet = Some(bytes.to_vec());
                }
            }
            Kind::Status { buffering } => {
                member.buffering = *buffering;
            }
            Kind::Chat { text } => {
                self.chat.push_back(ChatView {
                    id: format!("{}:{}", display_id(sender), message.seq),
                    member_id: display_id(sender),
                    name: member.name.clone(),
                    text: text.clone(),
                });
                while self.chat.len() > 200 {
                    self.chat.pop_front();
                }
            }
            Kind::Lock { locked } => {
                if sender != self.invite.host {
                    return false;
                }
                self.locked = *locked;
                self.lock_packet = Some(bytes.to_vec());
            }
            Kind::Remove { member } => {
                // Creator connection closure owns self-removal; preserve local identity.
                if sender != self.invite.host
                    || *member == self.invite.host
                    || *member == self.endpoint.id()
                {
                    return false;
                }
                self.members.remove(member);
                self.clients.remove(member);
            }
            Kind::Refresh => {
                if sender != self.invite.host {
                    return false;
                }
            }
            Kind::Leave => {
                self.members.remove(&sender);
                self.clients.remove(&sender);
            }
        }
        true
    }

    fn report(&mut self, report: Report) -> Result<Correction, String> {
        let Report {
            playback: mut local,
            stream_key,
            token,
        } = report;
        if token.len() > 100
            || !local.rate.is_finite()
            || stream_key
                .as_ref()
                .is_some_and(|key| key.is_empty() || key.len() > protocol::MAX_STREAM_KEY)
        {
            return Err("Invalid party playback state.".into());
        }
        // Room playback is bounded to 0.5–2x; a local speed outside it is pulled in.
        let limited = !(0.5..=2.0).contains(&local.rate);
        local.rate = local.rate.clamp(0.5, 2.0);
        local.stream_digest = stream_key.map(|key| protocol::digest(&self.invite.topic, &key));
        if !local.validate() {
            return Err("Invalid party playback state.".into());
        }
        if !self.syncing {
            return Ok(Correction::default());
        }
        let first = token.is_empty();
        if first {
            self.sources_noticed = false;
        }
        let me = self.endpoint.id();
        let now = Instant::now();
        let changed = self.last_local.as_ref().is_some_and(|(previous, at)| {
            // Same extrapolation as the shared clock: a stream stopped at its
            // duration must not "advance" into a phantom seek.
            let expected = sync::playback_position(previous, *at, now);
            previous.media != local.media
                || previous.paused != local.paused
                || (previous.rate - local.rate).abs() > 0.05
                || (!local.buffering
                    && !previous.buffering
                    && (expected - local.pos_ms as f64).abs() > 1500.0)
        });
        let fresh = self
            .state
            .as_ref()
            .is_some_and(|clock| clock.actor != me && token != clock.token());
        let media_changed = self
            .last_local
            .as_ref()
            .is_some_and(|(previous, _)| previous.media != local.media)
            && self
                .state
                .as_ref()
                .is_some_and(|clock| clock.playback.media != local.media);
        // A departed authority stops heartbeating, and newcomers reject its
        // cached state without its identity: a member already synced to that
        // media carries the clock on instead (other titles stay untouched).
        let orphaned = !fresh
            && self.state.as_ref().is_some_and(|clock| {
                !self.members.contains_key(&clock.actor) && clock.playback.media == local.media
            });
        let should_share = self.force_share
            || self.state.is_none()
            || media_changed
            || orphaned
            || (changed && !fresh);
        let mut shared_rate = None;
        let mut shared_pause = None;
        if should_share {
            if let Some(clock) = self.state.as_ref().filter(|clock| clock.actor != me) {
                // A pause/seek takes control, not ownership of the temporary drift speed.
                if self.last_local.as_ref().is_some_and(|(previous, _)| {
                    (previous.rate - local.rate).abs() <= 0.001
                        && (local.rate - clock.playback.rate).abs() > 0.001
                }) {
                    local.rate = clock.playback.rate;
                    shared_rate = Some(local.rate);
                }
                // The departed member's cache stall is not the new authority's pause.
                if orphaned
                    && !self.force_share
                    && clock.playback.buffering
                    && !clock.playback.paused
                    && local.paused
                {
                    local.paused = false;
                    shared_pause = Some(false);
                }
            }
        }
        let buffering_changed = self
            .members
            .get(&me)
            .is_some_and(|member| member.buffering != local.buffering);
        let heartbeat = self.state.as_ref().is_some_and(|clock| clock.actor == me)
            && (buffering_changed
                || now.duration_since(self.last_sent) >= Duration::from_millis(2500));
        if should_share || heartbeat {
            let previous_control = self.state.as_ref().map_or(0, |clock| clock.control);
            let control = if should_share {
                now_ms().max(previous_control.saturating_add(1))
            } else {
                previous_control
            };
            self.local(Kind::State {
                playback: local.clone(),
                control,
            })?;
            self.force_share = false;
            self.publish(None, true);
        } else if buffering_changed {
            self.local(Kind::Status {
                buffering: local.buffering,
            })?;
            self.publish(None, true);
        }
        let clock = self
            .state
            .as_ref()
            .filter(|clock| clock.playback.media == local.media);
        let remote = clock.filter(|clock| clock.actor != me);
        let mut correction = match (clock, remote) {
            (_, Some(remote)) => sync::correction(remote, &local, now, fresh),
            // Own state still yields a token, so the next remote control is
            // attributed instead of being mistaken for a first sync.
            (Some(own), None) => Correction {
                token: own.token(),
                rate: shared_rate,
                paused: shared_pause,
                ..Correction::default()
            },
            (None, None) => Correction::default(),
        };
        if limited {
            correction.notices.push(Notice::SpeedLimited);
            correction.rate.get_or_insert(local.rate);
        }
        if let Some(remote) = remote {
            if fresh {
                let by = self
                    .members
                    .get(&remote.actor)
                    .map_or("Someone", |member| member.name.as_str());
                correction.notices.extend(sync::control_notice(
                    &correction,
                    remote.playback.paused,
                    local.pos_ms,
                    first,
                    by.to_string(),
                ));
            }
            if !self.sources_noticed && sync::sources_differ(remote, &local) {
                self.sources_noticed = true;
                correction.notices.push(Notice::SourcesDiffer);
            }
        }
        let mut applied = local;
        if let Some(pos) = correction.seek_ms {
            applied.pos_ms = pos;
        }
        if let Some(paused) = correction.paused {
            applied.paused = paused;
        }
        if let Some(rate) = correction.rate {
            applied.rate = rate;
        }
        self.last_local = Some((applied, now));
        Ok(correction)
    }

    fn matching_stream(&self, candidates: Vec<(String, Option<String>)>) -> Option<String> {
        let target = self.state.as_ref()?.playback.stream_digest.as_deref()?;
        let matches = |key: &str| protocol::digest(&self.invite.topic, key) == target;
        candidates
            .into_iter()
            .find(|(key, content)| content.as_deref().is_some_and(matches) || matches(key))
            .map(|(key, _)| key)
    }

    fn perform(&mut self, operation: Operation) -> Result<(), String> {
        match operation {
            Operation::Chat(text) => self.local(Kind::Chat { text }),
            Operation::Name(name) => self.local(Kind::Hello { name }),
            Operation::Lock(locked) if self.is_creator() => self.local(Kind::Lock { locked }),
            Operation::Lock(_) => Err("Only the creator can lock this room.".into()),
            Operation::Follow(share, reply) => {
                self.syncing = true;
                self.force_share = share;
                if !share {
                    self.last_local = None;
                }
                let now = Instant::now();
                let _ = reply.send(
                    self.state
                        .as_ref()
                        .map(|clock| clock.position(now).round() as u64),
                );
                Ok(())
            }
            Operation::Report(report, reply) => {
                let _ = reply.send(self.report(report));
                Ok(())
            }
            Operation::Match(keys, reply) => {
                let _ = reply.send(self.matching_stream(keys));
                Ok(())
            }
            // Closing the connections ends membership even if the signed
            // leave is rate limited, so leaving always succeeds locally.
            Operation::Leave => {
                let _ = self.local(Kind::Leave);
                Ok(())
            }
        }
    }

    /// Re-signs local authority state at its live position, so members that
    /// just joined or refreshed receive a freshly sequenced control.
    fn reannounce(&mut self) {
        // Borrow for the actor check so a guest's publish clone isn't built
        // only to be dropped.
        let Some(clock) = self
            .state
            .as_ref()
            .filter(|clock| clock.actor == self.endpoint.id())
        else {
            return;
        };
        let position = clock.position(Instant::now()).round() as u64;
        let mut playback = clock.playback.clone();
        playback.pos_ms = position;
        let control = clock.control;
        let _ = self.local(Kind::State { playback, control });
    }

    fn admit(
        &mut self,
        peer: EndpointId,
        connection: Connection,
        packet: &[u8],
        outbox: Outbox,
    ) -> bool {
        let admitted = !self.clients.contains_key(&peer)
            && protocol::decode(&self.invite.topic, packet).is_some_and(|(sender, message)| {
                sender == peer
                    && matches!(message.kind, Kind::Hello { .. })
                    && self.apply(sender, &message, packet)
            });
        if !admitted {
            return false;
        }
        // Replay identity before state. Signatures stay on the original bytes.
        for (id, member) in &self.members {
            if *id != peer && *id != self.endpoint.id() {
                let _ = outbox.try_send(member.hello.as_slice().into());
            }
        }
        for bytes in [&self.state_packet, &self.lock_packet]
            .into_iter()
            .flatten()
        {
            let _ = outbox.try_send(bytes.as_slice().into());
        }
        self.broadcast(packet, Some(peer));
        self.clients.insert(peer, Client { outbox, connection });
        let _ = self.local(Kind::Refresh);
        let _ = self.local(Kind::Lock {
            locked: self.locked,
        });
        self.reannounce();
        true
    }

    fn receive(&mut self, peer: EndpointId, connection: &Connection, packet: &[u8]) {
        if self
            .clients
            .get(&peer)
            .is_none_or(|client| client.connection.stable_id() != connection.stable_id())
        {
            return;
        }
        let Some((sender, message)) = protocol::decode(&self.invite.topic, packet) else {
            self.clients.remove(&peer);
            return;
        };
        let creator = self.is_creator();
        // The creator binds every author to its QUIC peer; guests only hear the creator.
        if creator && sender != peer {
            self.clients.remove(&peer);
            return;
        }
        if !self.apply(sender, &message, packet) {
            // Only the creator drops a flooding peer. Guests drop over-limit packets
            // instead: windows are not aligned across members, and a join burst
            // must not disconnect every guest from the room.
            if creator
                && self
                    .members
                    .get(&sender)
                    .is_some_and(|member| member.messages > MAX_PACKETS_PER_SECOND)
            {
                self.clients.remove(&peer);
            }
            return;
        }
        if creator {
            self.broadcast(packet, Some(peer));
        }
        if matches!(message.kind, Kind::Refresh) {
            // Hostile input must never panic here; skip identity replay if
            // this participant somehow no longer holds a member entry.
            if let Some(name) = self
                .members
                .get(&self.endpoint.id())
                .map(|member| member.name.clone())
            {
                let _ = self.local(Kind::Hello { name });
            }
            self.reannounce();
        }
    }

    /// Returns true when a guest lost its creator connection, which ends the room.
    fn disconnect(&mut self, peer: EndpointId, connection: &Connection) -> bool {
        if self
            .clients
            .get(&peer)
            .is_some_and(|client| client.connection.stable_id() != connection.stable_id())
        {
            return false;
        }
        if !self.is_creator() && peer == self.invite.host {
            return true;
        }
        self.clients.remove(&peer);
        if self.members.contains_key(&peer) {
            let _ = self.local(Kind::Remove { member: peer });
        }
        false
    }

    pub async fn run(mut self, mut requests: mpsc::Receiver<Request>, guest: Option<Joined>) {
        let (network, mut incoming) = mpsc::channel(128);
        let mut tasks = JoinSet::new();
        if let Some((conn, send, recv, first)) = guest {
            let authentic =
                protocol::decode(&self.invite.topic, &first).is_some_and(|(sender, message)| {
                    sender == self.invite.host
                        && matches!(message.kind, Kind::Hello { .. })
                        && self.apply(sender, &message, &first)
                });
            if !authentic {
                self.publish(Some("Room authentication failed.".into()), false);
                self.endpoint.close().await;
                return;
            }
            let (outbox, outgoing) = mpsc::channel(transport::OUTBOX_FRAMES);
            self.clients.insert(
                self.invite.host,
                Client {
                    outbox,
                    connection: conn.clone(),
                },
            );
            tasks.spawn(transport::pump(conn, send, recv, outgoing, network.clone()));
        }
        self.publish(None, true);
        let mut error = None;
        let mut dirty = false;
        let mut publish_tick = tokio::time::interval(Duration::from_millis(250));
        publish_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            let accepting = self.is_creator() && tasks.len() < MAX_MEMBERS - 1;
            tokio::select! {
                // Requests poll ahead of network events: local ops must
                // answer within REQUEST_TIMEOUT even under packet load.
                biased;
                _ = publish_tick.tick(), if dirty => {
                    dirty = false;
                    self.publish(None, true);
                }
                request = requests.recv() => {
                    let Some(Request { operation, reply }) = request else { break };
                    if reply.is_closed() { continue; }
                    let leaving = matches!(operation, Operation::Leave);
                    let report = matches!(operation, Operation::Report(..));
                    let _ = reply.send(self.perform(operation));
                    if leaving {
                        break;
                    }
                    if !report {
                        self.publish(None, true);
                        dirty = false;
                    }
                }
                connection = self.endpoint.accept(), if accepting => {
                    let Some(connection) = connection else { break };
                    let network = network.clone();
                    tasks.spawn(async move {
                        let handshake = tokio::time::timeout(Duration::from_secs(10), connection);
                        if let Ok(Ok(conn)) = handshake.await {
                            transport::serve(conn, network).await;
                        }
                    });
                }
                event = incoming.recv() => {
                    let Some(event) = event else { break };
                    match event {
                        NetworkEvent::Connected { peer, connection, packet, outbox, admit } => {
                            let admitted = self.admit(peer, connection, &packet, outbox);
                            let _ = admit.send(admitted.then(|| self.hello()));
                        }
                        NetworkEvent::Packet { peer, connection, packet } => {
                            self.receive(peer, &connection, &packet);
                        }
                        NetworkEvent::Disconnected { peer, connection } => {
                            if self.disconnect(peer, &connection) {
                                error = Some(ROOM_LOST.into());
                                break;
                            }
                        }
                    }
                    dirty = true;
                }
                _ = tasks.join_next(), if !tasks.is_empty() => {}
            }
        }
        tasks.abort_all();
        self.clients.clear();
        self.publish(error, false);
        self.endpoint.close().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn room() -> Room {
        room_with_host(None).await
    }

    /// `host: None` builds the creator room; `Some` builds a guest room that
    /// trusts that key as its creator.
    async fn room_with_host(host: Option<&iroh::SecretKey>) -> Room {
        let endpoint = Endpoint::builder(iroh::endpoint::presets::Minimal)
            .clear_ip_transports()
            .bind_addr("127.0.0.1:0")
            .unwrap()
            .clear_address_lookup()
            .relay_mode(iroh::RelayMode::Disabled)
            .bind()
            .await
            .unwrap();
        let invite = Invite {
            v: 1,
            topic: [7; 32],
            host: host.map_or_else(|| endpoint.id(), |key| key.public()),
            relay: iroh::RelayMode::Default
                .relay_map()
                .urls::<Vec<_>>()
                .remove(0),
        };
        let (snapshots, _) = watch::channel(Snapshot::default());
        Room::new(
            endpoint,
            invite,
            "Creator".into(),
            |_| {},
            snapshots,
            Arc::new(AtomicU64::new(0)),
        )
    }

    fn receive(room: &mut Room, key: &iroh::SecretKey, seq: u64, kind: Kind) -> bool {
        let message = Message {
            v: 1,
            seq,
            at_ms: now_ms().max(room.sent_at).max(match &kind {
                Kind::State { control, .. } => *control,
                _ => 0,
            }),
            kind,
        };
        let bytes = protocol::encode(key, &room.invite.topic, &message).unwrap();
        let (sender, message) = protocol::decode(&room.invite.topic, &bytes).unwrap();
        room.apply(sender, &message, &bytes)
    }

    fn report(
        room: &mut Room,
        playback: &Playback,
        stream_key: Option<&str>,
        token: &str,
    ) -> Correction {
        room.report(Report {
            playback: playback.clone(),
            stream_key: stream_key.map(Into::into),
            token: token.into(),
        })
        .unwrap()
    }

    #[tokio::test]
    async fn membership_requires_hello_respects_creator_lock_and_caps_at_sixteen() {
        let mut room = room().await;
        let guest = iroh::SecretKey::generate();
        assert!(!receive(
            &mut room,
            &guest,
            1,
            Kind::Chat {
                text: "Unknown".into()
            }
        ));
        assert!(receive(
            &mut room,
            &guest,
            1,
            Kind::Hello {
                name: "Guest".into()
            }
        ));
        assert!(!receive(&mut room, &guest, 2, Kind::Lock { locked: true }));
        assert!(!room.locked);
        room.local(Kind::Lock { locked: true }).unwrap();
        let other = iroh::SecretKey::generate();
        assert!(!receive(
            &mut room,
            &other,
            1,
            Kind::Hello {
                name: "Other".into()
            }
        ));
        assert!(receive(
            &mut room,
            &guest,
            3,
            Kind::Chat {
                text: "Still here".into()
            }
        ));
        room.local(Kind::Lock { locked: false }).unwrap();
        for _ in 0..14 {
            assert!(receive(
                &mut room,
                &iroh::SecretKey::generate(),
                1,
                Kind::Hello {
                    name: "Guest".into()
                }
            ));
        }
        assert_eq!(room.members.len(), 16);
        assert!(!receive(
            &mut room,
            &other,
            1,
            Kind::Hello {
                name: "Other".into()
            }
        ));
        room.publish(None, true);
        let revision = room.snapshots.borrow().revision;
        room.publish(None, true);
        assert_eq!(room.snapshots.borrow().revision, revision);
        room.endpoint.close().await;
    }

    #[tokio::test]
    async fn rejected_hellos_never_reserve_member_slots() {
        let mut room = room().await;
        let skewed = iroh::SecretKey::generate();
        // A future-dated hello fails admission and must not leave a member
        // behind; leaked entries could fill all 16 slots with dead identities.
        let message = Message {
            v: 1,
            seq: 1,
            at_ms: now_ms() + 60_000,
            kind: Kind::Hello {
                name: "Skewed".into(),
            },
        };
        let bytes = protocol::encode(&skewed, &room.invite.topic, &message).unwrap();
        let (sender, message) = protocol::decode(&room.invite.topic, &bytes).unwrap();
        assert!(!room.apply(sender, &message, &bytes));
        assert!(!room.members.contains_key(&sender));
        // The slot was not consumed: the same identity joins once sequenced sanely.
        assert!(receive(
            &mut room,
            &skewed,
            2,
            Kind::Hello {
                name: "Guest".into()
            }
        ));
        assert_eq!(room.members.len(), 2);
        // Rejected packets from admitted members still consume their rate budget.
        let future = Message { seq: 3, ..message };
        for _ in 0..MAX_PACKETS_PER_SECOND {
            assert!(!room.apply(sender, &future, &bytes));
        }
        assert!(room.members[&sender].messages > MAX_PACKETS_PER_SECOND);
        room.endpoint.close().await;
    }

    #[tokio::test]
    async fn creator_removal_survives_a_burst_but_keeps_author_and_replay_checks() {
        let mut creator = room().await;
        let host = creator.endpoint.secret_key().clone();
        let victim = iroh::SecretKey::generate();
        let mut guest = room_with_host(Some(&host)).await;
        for room in [&mut creator, &mut guest] {
            assert!(receive(
                room,
                &victim,
                1,
                Kind::Hello {
                    name: "Guest".into()
                }
            ));
        }
        assert!(receive(
            &mut guest,
            &host,
            1,
            Kind::Hello {
                name: "Host".into()
            }
        ));
        creator.members.get_mut(&host.public()).unwrap().messages = MAX_PACKETS_PER_SECOND;
        guest.members.get_mut(&host.public()).unwrap().messages = MAX_PACKETS_PER_SECOND;
        let removal = Kind::Remove {
            member: victim.public(),
        };
        creator.local(removal.clone()).unwrap();
        assert!(!creator.members.contains_key(&victim.public()));
        assert!(receive(&mut guest, &host, creator.seq, removal.clone()));
        assert!(!guest.members.contains_key(&victim.public()));
        assert!(!receive(&mut guest, &host, creator.seq, removal.clone()));
        assert!(receive(
            &mut guest,
            &victim,
            2,
            Kind::Hello {
                name: "Guest".into()
            }
        ));
        assert!(!receive(&mut guest, &victim, 3, removal));
        assert!(guest.members.contains_key(&victim.public()));
        creator.endpoint.close().await;
        guest.endpoint.close().await;
    }

    #[tokio::test]
    async fn guest_ignores_live_self_removal_and_survives_refresh() {
        let host = iroh::SecretKey::generate();
        let mut room = room_with_host(Some(&host)).await;
        assert!(receive(
            &mut room,
            &host,
            1,
            Kind::Hello {
                name: "Host".into()
            }
        ));
        // A hostile host cannot eject a live guest from its own room view;
        // the real ejection path ends the room through the closed connection.
        let self_id = room.endpoint.id();
        assert!(!receive(
            &mut room,
            &host,
            2,
            Kind::Remove { member: self_id }
        ));
        assert!(room.members.contains_key(&room.endpoint.id()));
        assert!(receive(&mut room, &host, 3, Kind::Refresh));
        assert!(room.members.contains_key(&room.endpoint.id()));
        assert_eq!(room.members.len(), 2);
        room.endpoint.close().await;
    }

    #[tokio::test]
    async fn remote_corrections_do_not_echo_and_old_heartbeats_cannot_undo_controls() {
        let mut room = room().await;
        let local = super::super::tests::playback();
        report(&mut room, &local, None, "");
        let guest = iroh::SecretKey::generate();
        assert!(receive(
            &mut room,
            &guest,
            1,
            Kind::Hello {
                name: "Guest".into()
            }
        ));
        let mut remote = local.clone();
        remote.pos_ms = 20_000;
        remote.paused = true;
        let control = room.state.as_ref().unwrap().control + 1;
        assert!(receive(
            &mut room,
            &guest,
            2,
            Kind::State {
                playback: remote.clone(),
                control
            }
        ));
        let correction = report(&mut room, &local, None, "");
        assert_eq!(correction.seek_ms, Some(20_000));
        assert_eq!(correction.paused, Some(true));
        assert_eq!(correction.notices, [Notice::Synced]);
        let settled = report(&mut room, &remote, None, &correction.token);
        assert!(settled.notices.is_empty());
        assert_eq!(room.state.as_ref().unwrap().actor, guest.public());
        let mut resumed = remote.clone();
        resumed.paused = false;
        assert!(receive(
            &mut room,
            &guest,
            3,
            Kind::State {
                playback: resumed,
                control: control + 1
            }
        ));
        let attributed = report(&mut room, &remote, None, &settled.token);
        assert_eq!(attributed.notices, [Notice::Resumed { by: "Guest".into() }]);
        room.force_share = true;
        report(&mut room, &local, None, "");
        assert_eq!(room.state.as_ref().unwrap().actor, room.endpoint.id());
        assert!(receive(
            &mut room,
            &guest,
            4,
            Kind::State {
                playback: remote,
                control
            }
        ));
        assert_eq!(room.state.as_ref().unwrap().actor, room.endpoint.id());
        let mut next = super::super::tests::playback();
        next.media.media_id = "tt456".into();
        report(&mut room, &next, Some("h:file:0"), "");
        assert_eq!(room.state.as_ref().unwrap().playback.media, next.media);
        // The same file served through another addon matches by content;
        // an exact selector key still matches on its own.
        assert_eq!(
            room.matching_stream(vec![
                ("s:a".into(), Some("h:file:1".into())),
                ("s:b".into(), Some("h:file:0".into())),
            ])
            .as_deref(),
            Some("s:b")
        );
        assert_eq!(
            room.matching_stream(vec![("h:file:0".into(), None)])
                .as_deref(),
            Some("h:file:0")
        );
        next.rate = 0.25;
        let limited = report(&mut room, &next, None, "");
        assert_eq!(limited.rate, Some(0.5));
        assert_eq!(limited.notices, [Notice::SpeedLimited]);
        assert_eq!(room.state.as_ref().unwrap().playback.rate, 0.5);
        room.endpoint.close().await;
    }

    #[tokio::test]
    async fn synced_member_carries_the_clock_after_the_authority_leaves() {
        let mut room = room().await;
        let local = super::super::tests::playback();
        report(&mut room, &local, None, "");
        let guest = iroh::SecretKey::generate();
        let hello = Kind::Hello {
            name: "Guest".into(),
        };
        assert!(receive(&mut room, &guest, 1, hello));
        let control = room.state.as_ref().unwrap().control + 1;
        let playback = local.clone();
        assert!(receive(
            &mut room,
            &guest,
            2,
            Kind::State { playback, control }
        ));
        // The pending control applies before any takeover.
        let synced = report(&mut room, &local, None, "");
        assert_eq!(room.state.as_ref().unwrap().actor, guest.public());
        report(&mut room, &local, None, &synced.token);
        assert_eq!(room.state.as_ref().unwrap().actor, guest.public());
        // The guest's state was stamped at its control, up to 1ms ahead of the
        // wall clock; a leave in that millisecond would be a decreasing timestamp.
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert!(receive(&mut room, &guest, 3, Kind::Leave));
        report(&mut room, &local, None, &synced.token);
        assert_eq!(room.state.as_ref().unwrap().actor, room.endpoint.id());
        room.endpoint.close().await;
    }

    #[tokio::test]
    async fn local_control_does_not_promote_a_drift_nudge_to_room_speed() {
        for (position, departed) in [
            (9_000, false),
            (11_000, false),
            (9_000, true),
            (11_000, true),
        ] {
            let mut room = room().await;
            let local = super::super::tests::playback();
            report(&mut room, &local, None, "");
            let guest = iroh::SecretKey::generate();
            assert!(receive(
                &mut room,
                &guest,
                1,
                Kind::Hello {
                    name: "Guest".into()
                }
            ));
            let control = room.state.as_ref().unwrap().control + 1;
            assert!(receive(
                &mut room,
                &guest,
                2,
                Kind::State {
                    playback: local.clone(),
                    control
                }
            ));
            let synced = report(&mut room, &local, None, "");
            let mut drifting = local.clone();
            drifting.pos_ms = position;
            let nudge = report(&mut room, &drifting, None, &synced.token);
            drifting.rate = nudge.rate.unwrap();
            if departed {
                tokio::time::sleep(Duration::from_millis(5)).await;
                assert!(receive(&mut room, &guest, 3, Kind::Leave));
            } else {
                drifting.paused = true;
                let (reply, _) = oneshot::channel();
                room.perform(Operation::Follow(true, reply)).unwrap();
            }
            let shared = report(&mut room, &drifting, None, &nudge.token);
            let clock = room.state.as_ref().unwrap();
            assert_eq!(clock.actor, room.endpoint.id());
            assert_eq!(clock.playback.paused, !departed);
            assert_eq!(clock.playback.rate, 1.0);
            assert_eq!(shared.rate, Some(1.0));
            drifting.rate = 1.5;
            let (reply, _) = oneshot::channel();
            room.perform(Operation::Follow(true, reply)).unwrap();
            report(&mut room, &drifting, None, &shared.token);
            assert_eq!(room.state.as_ref().unwrap().playback.rate, 1.5);
            room.endpoint.close().await;
        }
    }

    #[tokio::test]
    async fn departed_buffering_authority_does_not_leave_a_permanent_pause() {
        for paused in [false, true] {
            let mut room = room().await;
            let mut local = super::super::tests::playback();
            report(&mut room, &local, None, "");
            let guest = iroh::SecretKey::generate();
            assert!(receive(
                &mut room,
                &guest,
                1,
                Kind::Hello {
                    name: "Guest".into()
                }
            ));
            let control = room.state.as_ref().unwrap().control + 1;
            let mut remote = local.clone();
            remote.buffering = true;
            remote.paused = paused;
            assert!(receive(
                &mut room,
                &guest,
                2,
                Kind::State {
                    playback: remote,
                    control
                }
            ));
            let held = report(&mut room, &local, None, "");
            assert_eq!(held.paused, Some(true));
            local.paused = true;
            report(&mut room, &local, None, &held.token);
            tokio::time::sleep(Duration::from_millis(5)).await;
            assert!(receive(&mut room, &guest, 3, Kind::Leave));
            let takeover = report(&mut room, &local, None, &held.token);
            let clock = room.state.as_ref().unwrap();
            assert_eq!(clock.actor, room.endpoint.id());
            assert_eq!(clock.playback.paused, paused);
            assert!(!clock.playback.buffering);
            assert_eq!(takeover.paused, (!paused).then_some(false));
            room.endpoint.close().await;
        }
    }

    #[tokio::test]
    async fn buffering_updates_authority_clock_without_taking_control() {
        let mut room = room().await;
        let mut local = super::super::tests::playback();
        let initial = report(&mut room, &local, None, "");
        let control = room.state.as_ref().unwrap().control;
        local.buffering = true;
        report(&mut room, &local, None, &initial.token);
        let clock = room.state.as_ref().unwrap();
        assert!(clock.playback.buffering);
        assert_eq!(clock.control, control);
        assert_eq!(
            clock.position(Instant::now() + Duration::from_secs(1)),
            local.pos_ms as f64
        );
        local.buffering = false;
        report(&mut room, &local, None, &initial.token);
        assert!(!room.state.as_ref().unwrap().playback.buffering);
        assert_eq!(room.state.as_ref().unwrap().control, control);
        assert!(
            room.state
                .as_ref()
                .unwrap()
                .position(Instant::now() + Duration::from_secs(1))
                >= local.pos_ms as f64 + 1000.0
        );

        let host = iroh::SecretKey::generate();
        let mut guest = room_with_host(Some(&host)).await;
        assert!(receive(
            &mut guest,
            &host,
            1,
            Kind::Hello {
                name: "Host".into()
            }
        ));
        assert!(receive(
            &mut guest,
            &host,
            2,
            Kind::State {
                playback: local.clone(),
                control
            }
        ));
        guest.syncing = true;
        local.buffering = true;
        report(&mut guest, &local, None, "");
        assert!(guest.members[&guest.endpoint.id()].buffering);
        assert_eq!(guest.state.as_ref().unwrap().actor, host.public());
        room.endpoint.close().await;
        guest.endpoint.close().await;
    }

    #[tokio::test]
    async fn stopped_report_at_stream_end_does_not_reannounce_past_eof() {
        let mut room = room().await;
        let mut local = super::super::tests::playback();
        local.dur_ms = 60_000;
        local.pos_ms = 60_000;
        let first = report(&mut room, &local, None, "");
        let control = room.state.as_ref().unwrap().control;
        // Age the last sample past the changed threshold; pin last_sent so
        // only changed-detection can broadcast.
        if let Some((_, at)) = room.last_local.as_mut() {
            *at = Instant::now() - Duration::from_secs(2);
        }
        room.last_sent = Instant::now();
        report(&mut room, &local, None, &first.token);
        // The ended stream's expected position caps at its duration: repeat
        // report is no phantom seek and takes no new control.
        let clock = room.state.as_ref().unwrap();
        assert_eq!(clock.control, control);
        assert_eq!(
            clock.position(Instant::now() + Duration::from_secs(2)),
            60_000.0
        );
        room.endpoint.close().await;
    }

    #[tokio::test]
    async fn cancelled_queued_action_does_not_lock_room() {
        let room = room().await;
        let snapshots = room.snapshots.subscribe();
        let (requests, receiver) = mpsc::channel(2);
        let (reply, response) = oneshot::channel();
        drop(response);
        requests
            .try_send(Request {
                operation: Operation::Lock(true),
                reply,
            })
            .unwrap();
        let (reply, response) = oneshot::channel();
        requests
            .try_send(Request {
                operation: Operation::Leave,
                reply,
            })
            .unwrap();
        room.run(receiver, None).await;
        assert!(response.await.unwrap().is_ok());
        assert!(!snapshots.borrow().locked);
        assert!(!snapshots.borrow().active);
    }

    fn member(now: Instant) -> Member {
        Member {
            name: "Guest".into(),
            seq: 0,
            at_ms: 0,
            window: now,
            messages: 0,
            chats: VecDeque::new(),
            hello: Vec::new(),
            buffering: false,
        }
    }

    #[test]
    fn ordering_rejects_replays_backwards_time_and_future_without_advancing() {
        let now = Instant::now();
        let mut member = member(now);
        let message = Message {
            v: 1,
            seq: 1,
            at_ms: now_ms(),
            kind: Kind::Hello {
                name: "Guest".into(),
            },
        };
        assert!(member.accept(&message, now, false));
        assert!(!member.accept(&message, now, false));
        let backwards = Message {
            seq: 2,
            at_ms: message.at_ms - 1,
            ..message.clone()
        };
        assert!(!member.accept(&backwards, now, false));
        let future = Message {
            seq: 2,
            at_ms: now_ms() + 60_000,
            ..message.clone()
        };
        assert!(!member.accept(&future, now, false));
        assert_eq!(member.seq, 1);
        assert!(member.accept(&Message { seq: 3, ..message }, now, false));
    }

    #[test]
    fn flood_bucket_covers_all_kinds_and_chat_window_expires() {
        let now = Instant::now();
        let mut member = member(now);
        for seq in 1..=50 {
            assert!(member.accept(
                &Message {
                    v: 1,
                    seq,
                    at_ms: now_ms(),
                    kind: Kind::Status { buffering: false }
                },
                now,
                false
            ));
        }
        assert!(!member.accept(
            &Message {
                v: 1,
                seq: 51,
                at_ms: now_ms(),
                kind: Kind::Leave
            },
            now,
            false
        ));
        member.messages = 0;
        for seq in 51..=70 {
            assert!(member.accept(
                &Message {
                    v: 1,
                    seq,
                    at_ms: now_ms(),
                    kind: Kind::Chat {
                        text: "hello".into()
                    }
                },
                now,
                false
            ));
        }
        let chat = Message {
            v: 1,
            seq: 71,
            at_ms: now_ms(),
            kind: Kind::Chat {
                text: "hello".into(),
            },
        };
        assert!(!member.accept(&chat, now, false));
        assert!(member.accept(&chat, now + Duration::from_secs(10), false));
    }
}
