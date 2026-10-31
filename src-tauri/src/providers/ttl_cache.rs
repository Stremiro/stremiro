use super::{lock_or_recover, FETCH_ATTEMPTS, FETCH_RETRY_BACKOFF};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Hash a possibly credential-bearing URL into a key segment: secrets never reach cache keys or logs.
pub(crate) fn hash_segment(value: &(impl Hash + ?Sized)) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

struct TtlEntry<V> {
    value: V,
    inserted_at: Instant,
    expires_at: Instant,
}

/// Bounded TTL map shared by the stream transport and the resource client.
/// Eviction: expire-on-read/insert, then soonest-expiring victims (the entry that triggered the fetch stays).
pub(crate) struct TtlCache<V> {
    entries: Mutex<HashMap<String, TtlEntry<V>>>,
    max_entries: usize,
    ttl: Duration,
    empty_ttl: Duration,
}

impl<V: Clone> TtlCache<V> {
    pub(crate) fn new(max_entries: usize, ttl: Duration, empty_ttl: Duration) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            max_entries,
            ttl,
            empty_ttl,
        }
    }

    pub(crate) fn get(&self, key: &str) -> Option<V> {
        self.get_fresh(key, None)
    }

    fn get_fresh(&self, key: &str, not_before: Option<Instant>) -> Option<V> {
        let mut entries = lock_or_recover(&self.entries);
        let entry = entries.get(key)?;
        if entry.expires_at > Instant::now() {
            if not_before.is_some_and(|not_before| entry.inserted_at < not_before) {
                None
            } else {
                Some(entry.value.clone())
            }
        } else {
            entries.remove(key);
            None
        }
    }

    /// `is_empty` picks the shorter TTL (empty answers still cache so a
    /// stream-less title doesn't re-fan-out per request); `still_fresh` runs
    /// under the entries lock so a superseded write is dropped, not stored.
    pub(crate) fn put(&self, key: &str, value: V, is_empty: bool, still_fresh: impl Fn() -> bool) {
        let mut entries = lock_or_recover(&self.entries);
        if !still_fresh() {
            return;
        }
        // A cache below its capacity can still retain large, expired payloads.
        let now = Instant::now();
        Self::retain_fresh(&mut entries, now);
        let ttl = if is_empty { self.empty_ttl } else { self.ttl };
        let entry = TtlEntry {
            value,
            inserted_at: now,
            expires_at: now + ttl,
        };
        if let Some(existing) = entries.get_mut(key) {
            *existing = entry;
        } else {
            entries.insert(key.to_string(), entry);
        }
        // Enforce the bound without evicting the entry just stored.
        while entries.len() > self.max_entries {
            let Some(victim) = entries
                .iter()
                .filter(|(candidate, _)| *candidate != key)
                .min_by_key(|(_, entry)| entry.expires_at)
                .map(|(candidate, _)| candidate.clone())
            else {
                break;
            };
            entries.remove(&victim);
        }
    }

    pub(crate) fn purge_expired(&self) {
        Self::retain_fresh(&mut lock_or_recover(&self.entries), Instant::now());
    }

    fn retain_fresh(entries: &mut HashMap<String, TtlEntry<V>>, now: Instant) {
        entries.retain(|_, entry| entry.expires_at > now);
    }

    pub(crate) fn clear(&self) {
        lock_or_recover(&self.entries).clear();
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        lock_or_recover(&self.entries).len()
    }
}

/// Single-flight registry keyed like the sibling cache: callers for one key
/// wait on the leader and re-read the cache. Orphans (dropped fetch futures)
/// sweep on insert past `sweep_at`.
pub(crate) struct InFlight {
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    sweep_at: usize,
}

impl InFlight {
    pub(crate) fn new(sweep_at: usize) -> Self {
        Self {
            locks: Mutex::new(HashMap::new()),
            sweep_at,
        }
    }

    pub(crate) fn claim(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = lock_or_recover(&self.locks);
        if locks.len() >= self.sweep_at {
            locks.retain(|_, lock| Arc::strong_count(lock) > 1);
        }
        // Get-first: `entry` would allocate the key String even on repeat hits.
        if let Some(lock) = locks.get(key) {
            return lock.clone();
        }
        locks.entry(key.to_string()).or_default().clone()
    }

    /// Removes the key only while this caller is provably the last holder —
    /// under the map mutex, so no waiter slips in and no stale release evicts
    /// a replacement lock.
    pub(crate) fn release(&self, key: &str, key_lock: &Arc<tokio::sync::Mutex<()>>) {
        let mut locks = lock_or_recover(&self.locks);
        let last_holder = matches!(locks.get(key), Some(mapped) if Arc::ptr_eq(mapped, key_lock))
            && Arc::strong_count(key_lock) == 2;
        if last_holder {
            locks.remove(key);
        }
    }
}

/// Min gap between liveness probes on a marked host — bounds an outage to
/// ~one transport attempt per gap, not one per caller.
const COOLDOWN_PROBE_GAP: Duration = Duration::from_secs(10);
const COOLDOWN_CAPACITY: usize = 64;

struct CooldownMark {
    /// Fast-fail deadline for the mark.
    until: Instant,
    /// The next instant a liveness probe may ride through the mark.
    next_probe_at: Instant,
    /// A probe claimed the mark and has not finished.
    probing: bool,
    /// Monotonic claim id: a stale probe guard cannot release a newer claim.
    probe_id: u64,
}

#[derive(Default)]
struct CooldownTable {
    marks: HashMap<String, CooldownMark>,
    probe_seq: u64,
}

/// `Open` fetches normally; `Probe` carries the single liveness-probe guard; `Cooldown` fast-fails.
pub(crate) enum CooldownGate<'a> {
    Open,
    Probe(CooldownProbe<'a>),
    Cooldown,
}

/// RAII release for a probe claim — a cancelled probe must clear `probing` or the key never probes again.
pub(crate) struct CooldownProbe<'a> {
    cooldown: &'a FetchFailureCooldown,
    key: String,
    probe_id: u64,
}

impl Drop for CooldownProbe<'_> {
    fn drop(&mut self) {
        self.cooldown.release_probe(&self.key, self.probe_id);
    }
}

/// Session-local cooldown with one liveness probe per marked addon.
/// Responses lift the mark; failed probes re-arm it. Generation checks run under the table lock.
pub(crate) struct FetchFailureCooldown {
    table: Mutex<CooldownTable>,
    ttl: Duration,
}

impl FetchFailureCooldown {
    pub(crate) fn new(ttl: Duration) -> Self {
        Self {
            table: Mutex::new(CooldownTable::default()),
            ttl,
        }
    }

    /// True while `key` holds an unexpired mark, regardless of probe state. Expired entries drop on read.
    pub(crate) fn cooling_down(&self, key: &str) -> bool {
        let mut table = lock_or_recover(&self.table);
        match table.marks.get(key) {
            Some(mark) if mark.until > Instant::now() => true,
            Some(_) => {
                table.marks.remove(key);
                false
            }
            None => false,
        }
    }

    /// `Open` when unmarked/expired; on a marked key the first caller past the
    /// probe window claims `Probe`, the rest get `Cooldown`.
    pub(crate) fn gate(&self, key: &str) -> CooldownGate<'_> {
        let mut table = lock_or_recover(&self.table);
        let now = Instant::now();
        match table.marks.get(key) {
            Some(mark) if mark.until > now => {
                if mark.probing || mark.next_probe_at > now {
                    return CooldownGate::Cooldown;
                }
            }
            Some(_) => {
                table.marks.remove(key);
                return CooldownGate::Open;
            }
            None => return CooldownGate::Open,
        }
        table.probe_seq += 1;
        let probe_id = table.probe_seq;
        let mark = table
            .marks
            .get_mut(key)
            .expect("mark checked present above");
        mark.probing = true;
        mark.probe_id = probe_id;
        CooldownGate::Probe(CooldownProbe {
            cooldown: self,
            key: key.to_string(),
            probe_id,
        })
    }

    /// Record a retry-exhausted or timed-out fetch failure for `key` —
    /// deterministic status/size/parse errors belong to the per-key
    /// negative cache. The first probe may ride through immediately.
    pub(crate) fn note(&self, key: &str, generation: &AtomicU64, expected: u64) {
        let mut table = lock_or_recover(&self.table);
        if generation.load(Ordering::SeqCst) != expected {
            return;
        }
        let now = Instant::now();
        table
            .marks
            .entry(key.to_string())
            .and_modify(|mark| {
                mark.until = now + self.ttl;
                if !mark.probing {
                    mark.next_probe_at = mark.next_probe_at.max(now + COOLDOWN_PROBE_GAP);
                }
            })
            .or_insert_with(|| CooldownMark {
                until: now + self.ttl,
                next_probe_at: now,
                probing: false,
                probe_id: 0,
            });
        if table.marks.len() > COOLDOWN_CAPACITY {
            table
                .marks
                .retain(|_, mark| mark.probing || mark.until > now);
        }
        if table.marks.len() > COOLDOWN_CAPACITY {
            let victim = table
                .marks
                .iter()
                .filter(|(_, mark)| !mark.probing)
                .min_by_key(|(_, mark)| mark.until)
                .map(|(key, _)| key.clone());
            if let Some(victim) = victim {
                table.marks.remove(&victim);
            }
        }
    }

    /// Re-arm the mark after a failed probe: deadline refreshes, next probe
    /// waits `COOLDOWN_PROBE_GAP`. A mark lifted meanwhile (sibling success) is
    /// not reinstalled — the host already proved reachable.
    fn note_probe_failure(&self, key: &str, probe_id: u64, generation: &AtomicU64, expected: u64) {
        let mut table = lock_or_recover(&self.table);
        if generation.load(Ordering::SeqCst) != expected {
            return;
        }
        let Some(mark) = table
            .marks
            .get_mut(key)
            .filter(|mark| mark.probe_id == probe_id)
        else {
            return;
        };
        let now = Instant::now();
        mark.until = now + self.ttl;
        mark.next_probe_at = now + COOLDOWN_PROBE_GAP;
        mark.probing = false;
        mark.probe_id = 0;
    }

    /// Release the probe slot only while the claim id still matches — a stale
    /// guard cannot unlock a newer probe parked at the same key.
    fn release_probe(&self, key: &str, probe_id: u64) {
        let mut table = lock_or_recover(&self.table);
        if let Some(mark) = table.marks.get_mut(key) {
            if mark.probe_id == probe_id {
                mark.probing = false;
            }
        }
    }

    /// Drop `key`'s mark after a fetch got a response (host proved reachable),
    /// unless a `clear_cache` landed meanwhile.
    pub(crate) fn clear_for_success(&self, key: &str, generation: &AtomicU64, expected: u64) {
        let mut table = lock_or_recover(&self.table);
        if generation.load(Ordering::SeqCst) == expected {
            table.marks.remove(key);
        }
    }

    /// `clear_cache` wipe — a config change may fix the dead host.
    pub(crate) fn clear(&self) {
        lock_or_recover(&self.table).marks.clear();
    }
}

/// Transport failures retry and cool down the addon; deterministic failures only cache this request.
pub(crate) enum FetchFailure {
    Retryable(String),
    Fatal(String),
}

impl FetchFailure {
    pub(crate) fn from_send_error(error: &reqwest::Error, message: String) -> Self {
        if error.is_redirect() || error.is_builder() {
            Self::Fatal(message)
        } else {
            Self::Retryable(message)
        }
    }

    pub(crate) fn from_http_status(status: reqwest::StatusCode, message: String) -> Self {
        match status.as_u16() {
            408 | 500 | 502 | 503 | 504 => Self::Retryable(message),
            _ => Self::Fatal(message),
        }
    }
}

/// Single-flight fetch with bounded retry, negative caching and generation-checked writeback.
pub(crate) struct FetchContract<'a> {
    pub failure_cache: &'a TtlCache<String>,
    pub fetch_failures: &'a FetchFailureCooldown,
    pub in_flight: &'a InFlight,
    pub generation: &'a AtomicU64,
    pub request_timeout: Duration,
    pub cooldown_message: &'a str,
}

impl FetchContract<'_> {
    /// Negative-cache write with the same generation guard as the value
    /// caches. `run` owns failure writes; sibling-provider tests reach this.
    pub(super) fn cache_failure(&self, key: &str, error: &str, generation: u64) {
        let still_fresh = || self.generation.load(Ordering::SeqCst) == generation;
        self.failure_cache
            .put(key, error.to_string(), true, still_fresh);
    }

    pub(crate) async fn run<T, Fetch, Fut>(
        &self,
        cache: &TtlCache<T>,
        key: &str,
        addon_key: &str,
        is_empty: impl Fn(&T) -> bool,
        fetch: Fetch,
    ) -> Result<T, String>
    where
        T: Clone,
        Fetch: Fn() -> Fut,
        Fut: std::future::Future<Output = Result<T, FetchFailure>>,
    {
        self.run_fresh(cache, key, addon_key, None, is_empty, fetch)
            .await
    }

    pub(crate) async fn run_fresh<T, Fetch, Fut>(
        &self,
        cache: &TtlCache<T>,
        key: &str,
        addon_key: &str,
        not_before: Option<Instant>,
        is_empty: impl Fn(&T) -> bool,
        fetch: Fetch,
    ) -> Result<T, String>
    where
        T: Clone,
        Fetch: Fn() -> Fut,
        Fut: std::future::Future<Output = Result<T, FetchFailure>>,
    {
        // A clear also revokes callers queued behind the single-flight leader.
        let generation = self.generation.load(Ordering::SeqCst);
        if let Some(cached) = cache.get_fresh(key, not_before) {
            return Ok(cached);
        }
        if let Some(error) = self.failure_cache.get(key) {
            return Err(error);
        }
        // Inside the window a single probe rides through; the rest fast-fail.
        let mut probe_guard = match self.fetch_failures.gate(addon_key) {
            CooldownGate::Cooldown => return Err(self.cooldown_message.to_string()),
            CooldownGate::Open => None,
            CooldownGate::Probe(guard) => Some(guard),
        };

        // Single-flight: wait on the leader, then re-read its cached result.
        let key_lock = self.in_flight.claim(key);
        let result = async {
            let _fetch_permit = key_lock.lock().await;
            if self.generation.load(Ordering::SeqCst) != generation {
                return Err("Addon request was superseded. Please try again.".to_string());
            }
            if let Some(cached) = cache.get_fresh(key, not_before) {
                return Ok(cached);
            }
            if let Some(error) = self.failure_cache.get(key) {
                return Err(error);
            }
            // The leader may have marked the addon while this caller waited.
            if probe_guard.is_none() {
                match self.fetch_failures.gate(addon_key) {
                    CooldownGate::Cooldown => return Err(self.cooldown_message.to_string()),
                    CooldownGate::Open => {}
                    CooldownGate::Probe(guard) => probe_guard = Some(guard),
                }
            }
            let mut attempt = 0u8;
            loop {
                if attempt > 0 {
                    tokio::time::sleep(FETCH_RETRY_BACKOFF).await;
                    if self.generation.load(Ordering::SeqCst) != generation {
                        return Err("Addon request was superseded. Please try again.".to_string());
                    }
                }
                let started_at = Instant::now();
                match fetch().await {
                    Ok(value) => {
                        self.fetch_failures.clear_for_success(
                            addon_key,
                            self.generation,
                            generation,
                        );
                        cache.put(key, value.clone(), is_empty(&value), || {
                            self.generation.load(Ordering::SeqCst) == generation
                        });
                        return Ok(value);
                    }
                    Err(FetchFailure::Fatal(error)) => {
                        self.cache_failure(key, &error, generation);
                        self.fetch_failures.clear_for_success(
                            addon_key,
                            self.generation,
                            generation,
                        );
                        return Err(error);
                    }
                    Err(FetchFailure::Retryable(error)) => {
                        attempt += 1;
                        if attempt >= FETCH_ATTEMPTS || started_at.elapsed() >= self.request_timeout
                        {
                            if let Some(probe) = &probe_guard {
                                self.fetch_failures.note_probe_failure(
                                    addon_key,
                                    probe.probe_id,
                                    self.generation,
                                    generation,
                                );
                            } else {
                                self.fetch_failures
                                    .note(addon_key, self.generation, generation);
                            }
                            return Err(error);
                        }
                    }
                }
            }
        }
        .await;
        self.in_flight.release(key, &key_lock);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_roundtrips_stays_bounded_and_clears() {
        let cache = TtlCache::new(4, Duration::from_secs(60), Duration::from_secs(30));
        for index in 0..4 {
            cache.put(&format!("key-{index}"), index, false, || true);
        }
        assert_eq!(cache.get("key-0"), Some(0));
        assert_eq!(cache.get("key-3"), Some(3));
        cache.put("key-4", 4, false, || true);
        assert_eq!(cache.len(), 4);
        assert_eq!(cache.get("key-4"), Some(4));
        cache.clear();
        assert_eq!(cache.len(), 0);
        for index in 0..5 {
            assert_eq!(cache.get(&format!("key-{index}")), None);
        }
    }

    #[test]
    fn transient_http_statuses_retry_without_changing_rate_limit_policy() {
        for status in [408, 500, 502, 503, 504] {
            let failure = FetchFailure::from_http_status(
                reqwest::StatusCode::from_u16(status).unwrap(),
                status.to_string(),
            );
            assert!(
                matches!(failure, FetchFailure::Retryable(message) if message == status.to_string())
            );
        }
        for status in [400, 401, 403, 404, 409, 422, 429, 501, 505] {
            let failure = FetchFailure::from_http_status(
                reqwest::StatusCode::from_u16(status).unwrap(),
                status.to_string(),
            );
            assert!(
                matches!(failure, FetchFailure::Fatal(message) if message == status.to_string())
            );
        }
    }

    #[test]
    fn freshness_reads_skip_older_values_without_changing_ordinary_reads() {
        let cache = TtlCache::new(8, Duration::from_secs(60), Duration::from_secs(30));
        cache.put("populated", vec![1], false, || true);
        cache.put("empty", Vec::new(), true, || true);
        let not_before = lock_or_recover(&cache.entries)
            .values()
            .map(|entry| entry.inserted_at)
            .max()
            .unwrap()
            + Duration::from_nanos(1);

        assert_eq!(cache.get_fresh("populated", Some(not_before)), None);
        assert_eq!(cache.get_fresh("empty", Some(not_before)), None);
        assert_eq!(cache.get("populated"), Some(vec![1]));
        assert_eq!(cache.get("empty"), Some(Vec::new()));

        let not_before = Instant::now();
        cache.put("populated", vec![2], false, || true);
        cache.put("empty", Vec::new(), true, || true);
        assert_eq!(
            cache.get_fresh("populated", Some(not_before)),
            Some(vec![2])
        );
        assert_eq!(cache.get_fresh("empty", Some(not_before)), Some(Vec::new()));
        let inserted_at = lock_or_recover(&cache.entries)["populated"].inserted_at;
        assert_eq!(
            cache.get_fresh("populated", Some(inserted_at)),
            Some(vec![2])
        );
    }

    #[test]
    fn expired_reads_and_inserts_release_payloads_below_capacity() {
        let cache = TtlCache::new(8, Duration::ZERO, Duration::from_secs(60));
        let expired = Arc::new(vec![0_u8; 1024]);
        let retained = Arc::downgrade(&expired);
        cache.put("read-expired", expired, false, || true);
        assert!(retained.upgrade().is_some());
        assert!(cache.get("read-expired").is_none());
        assert!(
            retained.upgrade().is_none(),
            "expired read must free the payload"
        );

        let expired = Arc::new(vec![0_u8; 1024]);
        let retained = Arc::downgrade(&expired);
        cache.put("insert-expired", expired, false, || true);
        cache.put("fresh", Arc::new(vec![1]), true, || true);
        assert!(
            retained.upgrade().is_none(),
            "insert must sweep expired payloads"
        );
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.get("fresh").as_deref(), Some(&vec![1]));
    }

    // Observation helpers must not clone the stored Arc — an extra strong
    // ref would masquerade as a live claimant to `release`'s count check.
    fn has_entry(inflight: &InFlight, key: &str) -> bool {
        lock_or_recover(&inflight.locks).contains_key(key)
    }

    fn mapped_is(inflight: &InFlight, key: &str, lock: &Arc<tokio::sync::Mutex<()>>) -> bool {
        matches!(lock_or_recover(&inflight.locks).get(key), Some(mapped) if Arc::ptr_eq(mapped, lock))
    }

    #[test]
    fn release_keeps_entry_while_a_waiter_still_holds_the_lock() {
        let inflight = InFlight::new(8);
        let leader = inflight.claim("k");
        let waiter = inflight.claim("k");
        assert!(Arc::ptr_eq(&leader, &waiter));

        // First release belongs to one of two live claimants: the entry must
        // stay so the remaining holder still owns single-flight for the key.
        inflight.release("k", &leader);
        assert!(mapped_is(&inflight, "k", &waiter));

        // Callers drop their claim Arc after release returns; with the
        // leader's clone gone the waiter's release is the last holder's.
        drop(leader);
        inflight.release("k", &waiter);
        assert!(!has_entry(&inflight, "k"));

        let fresh = inflight.claim("k");
        assert!(!Arc::ptr_eq(&fresh, &waiter));
    }

    #[test]
    fn stale_release_cannot_evict_a_replacement_lock() {
        let inflight = InFlight::new(8);
        let stale = inflight.claim("k");
        inflight.release("k", &stale);

        // A later claim parks a different Arc at the same key.
        let replacement = inflight.claim("k");
        assert!(!Arc::ptr_eq(&replacement, &stale));

        // The dropped fetch's late release must not remove the replacement.
        inflight.release("k", &stale);
        assert!(mapped_is(&inflight, "k", &replacement));
    }

    #[test]
    fn gate_admits_one_probe_through_the_mark_and_fast_fails_the_rest() {
        let cooldown = FetchFailureCooldown::new(Duration::from_secs(60));
        let generation = AtomicU64::new(0);
        assert!(matches!(cooldown.gate("k"), CooldownGate::Open));

        cooldown.note("k", &generation, 0);
        assert!(cooldown.cooling_down("k"));

        // The first caller past the mark claims the liveness slot; every
        // other caller keeps failing fast while it probes.
        let gate = cooldown.gate("k");
        assert!(matches!(gate, CooldownGate::Probe(_)));
        assert!(matches!(cooldown.gate("k"), CooldownGate::Cooldown));

        // Dropping the probe guard frees the slot for the next claim.
        drop(gate);
        assert!(matches!(cooldown.gate("k"), CooldownGate::Probe(_)));
    }

    #[test]
    fn cancelled_probe_timeout_re_arms_with_a_gap_before_the_next_probe() {
        let cooldown = FetchFailureCooldown::new(Duration::from_secs(60));
        let generation = AtomicU64::new(0);
        cooldown.note("k", &generation, 0);
        let gate = cooldown.gate("k");
        assert!(matches!(gate, CooldownGate::Probe(_)));

        drop(gate);
        cooldown.note("k", &generation, 0);

        assert!(cooldown.cooling_down("k"));
        assert!(matches!(cooldown.gate("k"), CooldownGate::Cooldown));
    }

    #[test]
    fn late_ordinary_failure_preserves_the_active_probe_claim() {
        let cooldown = FetchFailureCooldown::new(Duration::from_secs(60));
        let generation = AtomicU64::new(0);
        cooldown.note("k", &generation, 0);
        let gate = cooldown.gate("k");
        assert!(matches!(gate, CooldownGate::Probe(_)));

        cooldown.note("k", &generation, 0);
        assert!(matches!(cooldown.gate("k"), CooldownGate::Cooldown));
        drop(gate);
        assert!(matches!(cooldown.gate("k"), CooldownGate::Probe(_)));
    }

    #[test]
    fn failed_probe_re_arms_with_a_gap_before_the_next_probe() {
        let cooldown = FetchFailureCooldown::new(Duration::from_secs(60));
        let generation = AtomicU64::new(0);
        cooldown.note("k", &generation, 0);

        let CooldownGate::Probe(gate) = cooldown.gate("k") else {
            panic!("probe expected");
        };
        cooldown.note_probe_failure("k", gate.probe_id, &generation, 0);
        drop(gate);

        // The mark re-armed with `COOLDOWN_PROBE_GAP` ahead: probing is
        // free but the window has not elapsed, so callers still fast-fail.
        assert!(cooldown.cooling_down("k"));
        assert!(matches!(cooldown.gate("k"), CooldownGate::Cooldown));
    }

    #[test]
    fn failed_probe_does_not_reinstall_a_lifted_mark() {
        let cooldown = FetchFailureCooldown::new(Duration::from_secs(60));
        let generation = AtomicU64::new(0);
        cooldown.note("k", &generation, 0);

        let CooldownGate::Probe(gate) = cooldown.gate("k") else {
            panic!("probe expected");
        };
        // A sibling's response lifted the mark while this probe flew: the
        // late failure must not re-mark a proven-reachable host.
        cooldown.clear_for_success("k", &generation, 0);
        cooldown.note_probe_failure("k", gate.probe_id, &generation, 0);
        drop(gate);

        assert!(!cooldown.cooling_down("k"));
        assert!(matches!(cooldown.gate("k"), CooldownGate::Open));
    }

    #[test]
    fn stale_probe_guard_cannot_release_a_newer_claim() {
        let cooldown = FetchFailureCooldown::new(Duration::from_secs(60));
        let generation = AtomicU64::new(0);
        cooldown.note("k", &generation, 0);

        let CooldownGate::Probe(stale) = cooldown.gate("k") else {
            panic!("probe expected");
        };
        // The stale claim's mark was replaced (e.g. a clear + fresh note):
        // its late release must not unlock the newer probe below.
        cooldown.clear();
        cooldown.note("k", &generation, 0);

        let fresh = cooldown.gate("k");
        assert!(matches!(fresh, CooldownGate::Probe(_)));
        cooldown.note_probe_failure("k", stale.probe_id, &generation, 0);
        drop(stale);
        // The new claim is still held — a stale release would have freed it.
        assert!(matches!(cooldown.gate("k"), CooldownGate::Cooldown));
        drop(fresh);
        assert!(matches!(cooldown.gate("k"), CooldownGate::Probe(_)));
    }

    #[tokio::test]
    async fn probe_success_lifts_the_mark_early_for_the_next_caller() {
        let cache = TtlCache::new(8, Duration::from_secs(60), Duration::from_secs(30));
        let failures = TtlCache::new(8, Duration::from_secs(30), Duration::from_secs(30));
        let cooldown = FetchFailureCooldown::new(Duration::from_secs(60));
        let in_flight = InFlight::new(8);
        let generation = AtomicU64::new(0);
        let contract = FetchContract {
            failure_cache: &failures,
            fetch_failures: &cooldown,
            in_flight: &in_flight,
            generation: &generation,
            request_timeout: Duration::from_secs(20),
            cooldown_message: "cooling",
        };

        let attempts = AtomicU64::new(0);
        let outcome: Result<u32, String> = contract
            .run(
                &cache,
                "k",
                "addon",
                |_| false,
                || {
                    attempts.fetch_add(1, Ordering::SeqCst);
                    async {
                        Err(FetchFailure::from_http_status(
                            reqwest::StatusCode::SERVICE_UNAVAILABLE,
                            "down".into(),
                        ))
                    }
                },
            )
            .await;
        assert!(outcome.is_err());
        assert_eq!(attempts.load(Ordering::SeqCst), FETCH_ATTEMPTS as u64);
        assert_eq!(failures.get("k"), None);
        assert!(cooldown.cooling_down("addon"));

        // The first retryable failure marked the addon; the next call rides
        // through as the liveness probe — and its success lifts the mark.
        let recovered: Result<u32, String> = contract
            .run(&cache, "k", "addon", |_| false, || async { Ok(7u32) })
            .await;
        assert_eq!(recovered, Ok(7));
        assert!(!cooldown.cooling_down("addon"));

        // Mark lifted: callers fetch normally again.
        let after: Result<u32, String> = contract
            .run(&cache, "k3", "addon", |_| false, || async { Ok(9u32) })
            .await;
        assert_eq!(after, Ok(9));
    }

    #[tokio::test]
    async fn fatal_response_during_probe_lifts_the_transport_mark() {
        let cache = TtlCache::new(8, Duration::from_secs(60), Duration::from_secs(30));
        let failures = TtlCache::new(8, Duration::from_secs(30), Duration::from_secs(30));
        let cooldown = FetchFailureCooldown::new(Duration::from_secs(60));
        let in_flight = InFlight::new(8);
        let generation = AtomicU64::new(0);
        let contract = FetchContract {
            failure_cache: &failures,
            fetch_failures: &cooldown,
            in_flight: &in_flight,
            generation: &generation,
            request_timeout: Duration::from_secs(20),
            cooldown_message: "cooling",
        };
        cooldown.note("addon", &generation, 0);

        // A status/parse failure is still a response — the host answered,
        // so the transport mark is wrong and must lift.
        let outcome: Result<u32, String> = contract
            .run(
                &cache,
                "k",
                "addon",
                |_| false,
                || async { Err(FetchFailure::Fatal("404".into())) },
            )
            .await;
        assert!(outcome.is_err());
        assert!(!cooldown.cooling_down("addon"));
    }

    #[tokio::test(start_paused = true)]
    async fn cleared_fetches_cannot_retry_or_repopulate_caches_and_cooldowns() {
        for outcome in 0..4 {
            let cache = TtlCache::new(8, Duration::from_secs(60), Duration::from_secs(30));
            let failures = TtlCache::new(8, Duration::from_secs(30), Duration::from_secs(30));
            let cooldown = FetchFailureCooldown::new(Duration::from_secs(60));
            let in_flight = InFlight::new(8);
            let generation = AtomicU64::new(0);
            let contract = FetchContract {
                failure_cache: &failures,
                fetch_failures: &cooldown,
                in_flight: &in_flight,
                generation: &generation,
                request_timeout: Duration::from_secs(if outcome == 3 { 20 } else { 0 }),
                cooldown_message: "cooling",
            };
            let finish_leader = tokio::sync::Notify::new();
            let leader_loads = AtomicU64::new(0);
            let obsolete_loads = AtomicU64::new(0);
            let fresh_loads = AtomicU64::new(0);
            let mut leader = std::pin::pin!(contract.run(
                &cache,
                "k",
                "addon",
                |_| false,
                || async {
                    if leader_loads.fetch_add(1, Ordering::SeqCst) == 0 {
                        finish_leader.notified().await;
                    }
                    match outcome {
                        0 => Ok(1u32),
                        1 => Err(FetchFailure::Fatal("invalid".into())),
                        _ => Err(FetchFailure::Retryable("down".into())),
                    }
                },
            ));
            let mut follower = std::pin::pin!(contract.run(
                &cache,
                "k",
                "addon",
                |_| false,
                || {
                    obsolete_loads.fetch_add(1, Ordering::SeqCst);
                    std::future::pending::<Result<u32, FetchFailure>>()
                },
            ));
            assert!(futures_util::poll!(leader.as_mut()).is_pending());
            assert!(futures_util::poll!(follower.as_mut()).is_pending());

            if outcome == 3 {
                finish_leader.notify_one();
                assert!(futures_util::poll!(leader.as_mut()).is_pending());
            }
            generation.fetch_add(1, Ordering::SeqCst);
            cache.clear();
            failures.clear();
            cooldown.clear();
            let mut fresh = std::pin::pin!(contract.run(
                &cache,
                "k",
                "addon",
                |_| false,
                || {
                    fresh_loads.fetch_add(1, Ordering::SeqCst);
                    async { Ok(3u32) }
                },
            ));
            assert!(futures_util::poll!(fresh.as_mut()).is_pending());
            finish_leader.notify_one();
            let expected = match outcome {
                0 => Ok(1),
                1 => Err("invalid".to_string()),
                2 => Err("down".to_string()),
                _ => Err("Addon request was superseded. Please try again.".to_string()),
            };
            assert_eq!(leader.await, expected);
            assert_eq!(leader_loads.load(Ordering::SeqCst), 1);
            assert_eq!(cache.get("k"), None);
            assert_eq!(failures.get("k"), None);
            assert!(!cooldown.cooling_down("addon"));
            assert!(futures_util::poll!(fresh.as_mut()).is_pending());
            assert_eq!(fresh_loads.load(Ordering::SeqCst), 0);
            assert_eq!(
                futures_util::poll!(follower.as_mut()),
                std::task::Poll::Ready(Err(
                    "Addon request was superseded. Please try again.".to_string()
                ))
            );
            assert_eq!(obsolete_loads.load(Ordering::SeqCst), 0);
            assert_eq!(
                futures_util::poll!(fresh.as_mut()),
                std::task::Poll::Ready(Ok(3))
            );
            assert_eq!(fresh_loads.load(Ordering::SeqCst), 1);
            assert_eq!(cache.get("k"), Some(3));
            assert_eq!(failures.get("k"), None);
            assert!(!cooldown.cooling_down("addon"));
            assert!(!has_entry(&in_flight, "k"));
        }
    }
}
