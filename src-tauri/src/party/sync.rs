use std::time::Instant;

use serde::Serialize;

use super::protocol::Playback;

// Remote seeks under this distance are sync nudges, not something to announce.
const ANNOUNCED_JUMP_MS: u64 = 3000;

#[derive(Clone)]
pub struct Clock {
    pub playback: Playback,
    pub received: Instant,
    pub actor: iroh::EndpointId,
    pub control: u64,
}

/// The one extrapolation every clock reader shares: paused or buffering
/// accrues no elapsed; known durations cap it so a stopped stream never
/// reports past EOF, unknown durations keep the protocol bound.
pub fn playback_position(playback: &Playback, received: Instant, now: Instant) -> f64 {
    let elapsed = if playback.paused || playback.buffering {
        0.0
    } else {
        now.duration_since(received).as_secs_f64() * 1000.0 * playback.rate
    };
    let limit = if playback.dur_ms > 0 {
        playback.dur_ms as f64
    } else {
        super::protocol::MAX_POSITION as f64
    };
    (playback.pos_ms as f64 + elapsed).min(limit)
}

impl Clock {
    pub fn position(&self, now: Instant) -> f64 {
        playback_position(&self.playback, self.received, now)
    }

    pub fn token(&self) -> String {
        use sha2::{Digest, Sha256};
        format!(
            "{:x}",
            Sha256::digest(format!("{}:{}", self.actor, self.control))
        )
    }
}

/// Player OSD events; names are self-asserted member display names.
#[derive(Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Notice {
    Synced,
    Paused { by: String },
    Resumed { by: String },
    Jumped { by: String, to_ms: u64 },
    SpeedLimited,
    SourcesDiffer,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Correction {
    pub token: String,
    pub seek_ms: Option<u64>,
    pub paused: Option<bool>,
    pub rate: Option<f64>,
    pub notices: Vec<Notice>,
}

pub fn correction(clock: &Clock, local: &Playback, now: Instant, fresh: bool) -> Correction {
    let target = clock.position(now).clamp(0.0, local.dur_ms as f64);
    let drift = target - local.pos_ms as f64;
    let base_rate = clock.playback.rate;
    let seekable = local.dur_ms > 0;
    // A stalled authority freezes the shared clock; followers wait with it
    // instead of playing ahead into repeated catch-up seeks.
    let held = clock.playback.paused || clock.playback.buffering;
    let rate =
        if !held && seekable && !local.buffering && drift.abs() >= 250.0 && drift.abs() <= 2000.0 {
            (base_rate * if drift > 0.0 { 1.02 } else { 0.98 }).clamp(0.5, 2.0)
        } else {
            base_rate
        };
    Correction {
        token: clock.token(),
        seek_ms: (seekable && (fresh || (!local.buffering && drift.abs() > 2000.0)))
            .then_some(target.round() as u64),
        paused: (local.paused != held).then_some(held),
        rate: ((local.rate - rate).abs() > 0.001).then_some(rate),
        notices: Vec::new(),
    }
}

pub fn sources_differ(clock: &Clock, local: &Playback) -> bool {
    clock.playback.dur_ms > 0
        && local.dur_ms > 0
        && local.dur_ms.abs_diff(clock.playback.dur_ms) > 2000
}

/// Attribution for a correction caused by a new remote control. A pause that
/// only holds for the authority's buffering is not announced as "paused".
pub fn control_notice(
    correction: &Correction,
    remote_paused: bool,
    from_ms: u64,
    first: bool,
    by: String,
) -> Option<Notice> {
    if correction.seek_ms.is_none() && correction.paused.is_none() {
        return None;
    }
    if first {
        return Some(Notice::Synced);
    }
    let jump = correction
        .seek_ms
        .filter(|to_ms| to_ms.abs_diff(from_ms) >= ANNOUNCED_JUMP_MS);
    match (correction.paused, jump) {
        (Some(true), _) if remote_paused => Some(Notice::Paused { by }),
        (_, Some(to_ms)) => Some(Notice::Jumped { by, to_ms }),
        (Some(false), None) => Some(Notice::Resumed { by }),
        _ => None,
    }
}
