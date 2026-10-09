pub mod commands;
mod protocol;
mod room;
mod sync;
#[cfg(test)]
mod tests;
mod transport;

use std::{
    panic::AssertUnwindSafe,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot, watch, Mutex},
    task::JoinHandle,
};

use futures_util::FutureExt;
use room::{Operation, Request, Snapshot, ROOM_LOST};
use tauri::Emitter;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);

struct Session {
    id: String,
    requests: mpsc::Sender<Request>,
    task: JoinHandle<()>,
    invite: String,
}

pub struct PartyService {
    session: Arc<Mutex<Option<Session>>>,
    /// Serializes room creation only: `start` holds it across endpoint and
    /// relay IO, so a slow join never wedges chat, leave, or snapshot reads
    /// on a live room — the session lock itself is taken only for the
    /// inspect and install steps.
    start_gate: Mutex<()>,
    snapshots: watch::Sender<Snapshot>,
    revision: Arc<AtomicU64>,
}

impl Default for PartyService {
    fn default() -> Self {
        let (snapshots, _) = watch::channel(Snapshot::default());
        Self {
            session: Arc::new(Mutex::new(None)),
            start_gate: Mutex::new(()),
            snapshots,
            revision: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl PartyService {
    async fn start(
        &self,
        app: tauri::AppHandle,
        name: String,
        invite: Option<transport::Invite>,
    ) -> Result<Snapshot, String> {
        if !protocol::valid_name(&name) {
            return Err("Use a display name of 1–32 plain characters.".into());
        }
        let _start = self.start_gate.lock().await;
        {
            let session = self.session.lock().await;
            if session.as_ref().is_some_and(|s| !s.task.is_finished()) {
                return Err("Leave your current room first.".into());
            }
        }
        let endpoint = transport::endpoint().await?;
        let joining = invite.is_some();
        let invite = match invite {
            Some(invite) => invite,
            None => match transport::invite(&endpoint) {
                Ok(invite) => invite,
                Err(error) => {
                    endpoint.close().await;
                    return Err(error);
                }
            },
        };
        let encoded = invite.encode()?;
        let emit_app = app.clone();
        let room = room::Room::new(
            endpoint.clone(),
            invite.clone(),
            name,
            move |snapshot| {
                let _ = emit_app.emit("party://event", snapshot);
            },
            self.snapshots.clone(),
            self.revision.clone(),
        );
        let guest = if joining {
            match transport::connect(&endpoint, &invite, &room.hello()).await {
                Ok(conn) => Some(conn),
                Err(error) => {
                    endpoint.close().await;
                    return Err(error);
                }
            }
        } else {
            None
        };
        let (requests, receiver) = mpsc::channel(32);
        let mut ready = self.snapshots.subscribe();
        let id = room.session_id().to_string();
        let starting_id = id.clone();
        let ending_id = id.clone();
        let sessions = self.session.clone();
        let snapshots = self.snapshots.clone();
        let revision = self.revision.clone();
        let crash_app = app;
        let task = tokio::spawn(async move {
            // `run` publishes the inactive snapshot on a clean exit; a panic
            // skips it, so the tail owns that fallback — a dead room must
            // never stay active in the snapshot.
            if AssertUnwindSafe(room.run(receiver, guest))
                .catch_unwind()
                .await
                .is_err()
            {
                let snapshot = Snapshot {
                    session: ending_id.clone(),
                    revision: revision.fetch_add(1, Ordering::Relaxed) + 1,
                    error: Some(ROOM_LOST.into()),
                    ..Snapshot::default()
                };
                snapshots.send_replace(snapshot.clone());
                let _ = crash_app.emit("party://event", &snapshot);
            }
            let mut session = sessions.lock().await;
            if session.as_ref().is_some_and(|s| s.id == ending_id) {
                session.take();
            }
        });
        *self.session.lock().await = Some(Session {
            id,
            requests,
            task,
            invite: encoded,
        });
        if !matches!(
            tokio::time::timeout(REQUEST_TIMEOUT, ready.changed()).await,
            Ok(Ok(()))
        ) {
            let ending = {
                let mut session = self.session.lock().await;
                if session.as_ref().is_some_and(|s| s.id == starting_id) {
                    session.take()
                } else {
                    None
                }
            };
            if let Some(ending) = ending {
                ending.task.abort();
            }
            endpoint.close().await;
            return Err("Room startup timed out.".into());
        }
        let snapshot = ready.borrow().clone();
        if !snapshot.active {
            return Err(snapshot
                .error
                .unwrap_or_else(|| "Could not join room.".into()));
        }
        Ok(snapshot)
    }

    fn is_current(&self, session_id: &str) -> bool {
        let snapshot = self.snapshots.borrow();
        snapshot.active && snapshot.session == session_id
    }

    fn require_current(&self, session_id: &str) -> Result<(), String> {
        if self.is_current(session_id) {
            Ok(())
        } else {
            Err("This room is no longer active.".into())
        }
    }

    async fn request_sender(&self, session_id: &str) -> Result<mpsc::Sender<Request>, String> {
        let session = self.session.lock().await;
        self.require_current(session_id)?;
        match session.as_ref() {
            Some(session) if session.id == session_id => {
                // A finished-but-uncollected task means the room just
                // died; its exit snapshot may not have landed yet.
                if session.task.is_finished() {
                    return Err("Room stopped.".into());
                }
                Ok(session.requests.clone())
            }
            Some(_) => Err("This room is no longer active.".into()),
            None => Err("No active party.".into()),
        }
    }

    async fn request(&self, session_id: &str, operation: Operation) -> Result<(), String> {
        let requests = self.request_sender(session_id).await?;
        let (reply, response) = oneshot::channel();
        requests
            .try_send(Request { operation, reply })
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => "Party is busy. Try again.".to_string(),
                mpsc::error::TrySendError::Closed(_) => "Room stopped.".to_string(),
            })?;
        tokio::time::timeout(REQUEST_TIMEOUT, response)
            .await
            .map_err(|_| "Party action timed out.")?
            .map_err(|_| "Room stopped.")?
    }

    /// Runs an operation whose room reply travels on its own typed channel.
    async fn ask<T>(
        &self,
        session_id: &str,
        operation: impl FnOnce(oneshot::Sender<T>) -> Operation,
    ) -> Result<T, String> {
        let (reply, response) = oneshot::channel();
        self.request(session_id, operation(reply)).await?;
        response.await.map_err(|_| "Room stopped.".into())
    }

    async fn leave(&self, session_id: &str) -> Result<(), String> {
        self.request(session_id, Operation::Leave).await?;
        let ending = {
            let mut session = self.session.lock().await;
            if session.as_ref().is_some_and(|s| s.id == session_id) {
                session.take()
            } else {
                None
            }
        };
        if let Some(mut ending) = ending {
            if tokio::time::timeout(REQUEST_TIMEOUT, &mut ending.task)
                .await
                .is_err()
            {
                ending.task.abort();
                // The aborted task never ran its exit publish; retire the
                // snapshot so a dead room is not reported active.
                self.snapshots.send_replace(Snapshot {
                    revision: self.revision.fetch_add(1, Ordering::Relaxed) + 1,
                    session: session_id.to_string(),
                    ..Snapshot::default()
                });
            }
        }
        Ok(())
    }

    /// Leaves on app exit so peers see the room end now rather than after the
    /// QUIC idle timeout. Bounded: exit never waits on an unreachable relay.
    pub fn shutdown(&self) {
        let session = {
            let snapshot = self.snapshots.borrow();
            if !snapshot.active {
                return;
            }
            snapshot.session.clone()
        };
        tauri::async_runtime::block_on(async {
            let _ = tokio::time::timeout(Duration::from_millis(1500), self.leave(&session)).await;
        });
    }
}
