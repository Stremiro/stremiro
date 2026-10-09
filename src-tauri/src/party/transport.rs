use std::{sync::Arc, time::Duration};

use iroh::{
    endpoint::{presets, Connection, QuicTransportConfig, RecvStream, SendStream, VarInt},
    Endpoint, EndpointAddr, EndpointId, RelayMode, RelayUrl, SecretKey, TransportAddr,
};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};

use super::protocol::{self, MAX_PACKET};

const ALPN: &[u8] = b"stremiro/party/1";
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Per-connection send queue; a client that falls this far behind is dropped.
pub const OUTBOX_FRAMES: usize = 64;
pub type Outbox = mpsc::Sender<Arc<[u8]>>;
/// A guest's admitted creator connection plus the creator's signed hello.
pub type Joined = (Connection, SendStream, RecvStream, Vec<u8>);

// Only the transport owns invite material and remote addressing. Never accept
// peer-supplied relay servers: an inviter could operate one to harvest IPs.
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Invite {
    pub v: u8,
    pub topic: [u8; 32],
    pub host: EndpointId,
    pub relay: RelayUrl,
}

impl Invite {
    pub fn parse(input: &str) -> Result<Self, String> {
        if input.len() > 2048 {
            return Err("Invite is too long.".into());
        }
        let input = input.trim();
        let token = input.strip_prefix("stremiro://party/").unwrap_or(input);
        let token = token.strip_prefix("#").unwrap_or(token);
        let bytes = protocol::decode_invite_bytes(token).ok_or("Invalid party invite.")?;
        let invite: Self = serde_json::from_slice(&bytes).map_err(|_| "Invalid party invite.")?;
        if invite.v != 1 || !RelayMode::Default.relay_map().contains(&invite.relay) {
            return Err("Invite version or relay is not supported.".into());
        }
        Ok(invite)
    }

    pub fn encode(&self) -> Result<String, String> {
        serde_json::to_vec(self)
            .map(|bytes| format!("stremiro://party/{}", protocol::encode_invite_bytes(&bytes)))
            .map_err(|_| "Could not create invite.".into())
    }

    pub fn addr(&self) -> EndpointAddr {
        EndpointAddr::new(self.host).with_relay_url(self.relay.clone())
    }
}

pub async fn endpoint() -> Result<Endpoint, String> {
    let endpoint = Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::generate())
        .clear_ip_transports()
        .clear_address_lookup()
        .relay_mode(RelayMode::Default)
        .transport_config(
            QuicTransportConfig::builder()
                .max_concurrent_bidi_streams(VarInt::from_u32(1))
                .max_concurrent_uni_streams(VarInt::from_u32(0))
                .stream_receive_window(VarInt::from_u32(65_536))
                .receive_window(VarInt::from_u32(65_536))
                .send_window(65_536)
                .build(),
        )
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .map_err(|_| "Could not start private party transport.")?;
    if tokio::time::timeout(CONNECT_TIMEOUT, endpoint.online())
        .await
        .is_err()
    {
        endpoint.close().await;
        return Err("Could not reach the party relay. Try again.".into());
    }
    // Fail closed if a future dependency change reintroduces a direct address.
    let trusted = RelayMode::Default.relay_map();
    if endpoint
        .addr()
        .addrs
        .iter()
        .any(|addr| !matches!(addr, TransportAddr::Relay(url) if trusted.contains(url)))
    {
        endpoint.close().await;
        return Err("Private party transport is unavailable.".into());
    }
    Ok(endpoint)
}

pub fn invite(endpoint: &Endpoint) -> Result<Invite, String> {
    let relay = endpoint
        .addr()
        .addrs
        .into_iter()
        .find_map(|addr| match addr {
            TransportAddr::Relay(url) if RelayMode::Default.relay_map().contains(&url) => Some(url),
            _ => None,
        })
        .ok_or("Could not reach the party relay.")?;
    Ok(Invite {
        v: 1,
        topic: SecretKey::generate().to_bytes(),
        host: endpoint.id(),
        relay,
    })
}

pub enum NetworkEvent {
    Connected {
        peer: EndpointId,
        connection: Connection,
        packet: Vec<u8>,
        outbox: Outbox,
        admit: oneshot::Sender<Option<Vec<u8>>>,
    },
    Packet {
        peer: EndpointId,
        connection: Connection,
        packet: Vec<u8>,
    },
    Disconnected {
        peer: EndpointId,
        connection: Connection,
    },
}

async fn read_frame(recv: &mut RecvStream) -> Result<Vec<u8>, ()> {
    let mut header = [0; 4];
    recv.read_exact(&mut header).await.map_err(|_| ())?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_PACKET {
        return Err(());
    }
    let mut bytes = vec![0; length];
    recv.read_exact(&mut bytes).await.map_err(|_| ())?;
    Ok(bytes)
}

async fn write_frame(send: &mut SendStream, bytes: &[u8]) -> Result<(), ()> {
    if bytes.is_empty() || bytes.len() > MAX_PACKET {
        return Err(());
    }
    send.write_all(&(bytes.len() as u32).to_be_bytes())
        .await
        .map_err(|_| ())?;
    send.write_all(bytes).await.map_err(|_| ())
}

pub async fn connect(endpoint: &Endpoint, invite: &Invite, hello: &[u8]) -> Result<Joined, String> {
    let result = tokio::time::timeout(CONNECT_TIMEOUT, async {
        let conn = endpoint
            .connect(invite.addr(), ALPN)
            .await
            .map_err(|_| ())?;
        let (mut send, mut recv) = conn.open_bi().await.map_err(|_| ())?;
        write_frame(&mut send, hello).await?;
        let first = read_frame(&mut recv).await?;
        Ok::<_, ()>((conn, send, recv, first))
    })
    .await;
    result
        .map_err(|_| "Could not reach this room. Ask the host to keep Stremiro open and send a fresh invite.")?
        .map_err(|_| "Could not join this room. It may be closed, locked or full. Ask the host to check the room and try again.".into())
}

pub async fn serve(conn: Connection, network: mpsc::Sender<NetworkEvent>) {
    let peer = conn.remote_id();
    let setup = tokio::time::timeout(Duration::from_secs(10), async {
        let (mut send, mut recv) = conn.accept_bi().await.map_err(|_| ())?;
        let packet = read_frame(&mut recv).await?;
        let (outbox, outgoing) = mpsc::channel(OUTBOX_FRAMES);
        let (admit, admission) = oneshot::channel();
        network
            .send(NetworkEvent::Connected {
                peer,
                connection: conn.clone(),
                packet,
                outbox,
                admit,
            })
            .await
            .map_err(|_| ())?;
        let hello = admission.await.map_err(|_| ())?.ok_or(())?;
        write_frame(&mut send, &hello).await?;
        Ok::<_, ()>((send, recv, outgoing))
    })
    .await;
    if let Ok(Ok((send, recv, outgoing))) = setup {
        pump(conn, send, recv, outgoing, network).await;
    } else {
        conn.close(0u32.into(), b"room unavailable");
        let _ = network
            .send(NetworkEvent::Disconnected {
                peer,
                connection: conn.clone(),
            })
            .await;
    }
}

pub async fn pump(
    conn: Connection,
    mut send: SendStream,
    mut recv: RecvStream,
    mut outgoing: mpsc::Receiver<Arc<[u8]>>,
    network: mpsc::Sender<NetworkEvent>,
) {
    let peer = conn.remote_id();
    let read = async {
        loop {
            let packet = read_frame(&mut recv).await?;
            network
                .send(NetworkEvent::Packet {
                    peer,
                    connection: conn.clone(),
                    packet,
                })
                .await
                .map_err(|_| ())?;
        }
        #[allow(unreachable_code)]
        Ok::<(), ()>(())
    };
    let write = async {
        while let Some(bytes) = outgoing.recv().await {
            tokio::time::timeout(Duration::from_secs(5), write_frame(&mut send, &bytes))
                .await
                .map_err(|_| ())??;
        }
        Ok::<(), ()>(())
    };
    tokio::select! { _ = read => {}, _ = write => {}, _ = conn.closed() => {} }
    conn.close(0u32.into(), b"room closed");
    let _ = network
        .send(NetworkEvent::Disconnected {
            peer,
            connection: conn.clone(),
        })
        .await;
}
