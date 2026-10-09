use super::{lock_or_recover, FETCH_ATTEMPTS, FETCH_RETRY_BACKOFF};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Hash a possibly credential-bearing URL into a stable key segment, so
/// secrets never appear in cache keys or logs.
pub(crate) fn hash_segment(value: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

struct TtlEntry<V> {
    value: V,
    expires_at: Instant,
}

/// Bounded TTL map shared by the stream transport and the resource client.
/// Eviction: expire-on-read/insert, then soonest-expiring victims so the
/// entry that triggered the fetch stays.
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
        let mut entries = lock_or_recover(&self.entries);
        let entry = entries.get(key)?;
        if entry.expires_at > Instant::now() {
            Some(entry.value.clone())
        } else {
            entries.remove(key);
            None
        }
    }

    /// `is_empty` picks the shorter TTL: empty answers are still cached (a
    /// stream-less title must not re-fan-out per request) but newly indexed
    /// content surfaces fast. `still_fresh` runs under the entries lock so a
    /// superseded write (post-`clear_cache`) is dropped, not stored.
    pub(crate) fn put(&self, key: &str, value: V, is_empty: bool, still_fresh: impl Fn() -> bool) {
        let mut entries = lock_or_recover(&self.entries);
        if !still_fresh() {
            return;
        }
        // A cache below its capacity can still retain large, expired payloads.
        let now = Instant::now();
        entries.retain(|_, entry| entry.expires_at > now);
        let ttl = if is_empty { self.empty_ttl } else { self.ttl };
        entries.insert(
            key.to_string(),
            TtlEntry {
                value,
                expires_at: Instant::now() + ttl,
            },
        );
        // Enforce the hard bound without evicting the entry just stored so
        // the content that triggered this fetch stays cacheable.
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

    pub(crate) fn clear(&self) {
        lock_or_recover(&self.entries).clear();
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        lock_or_recover(&self.entries).len()
    }
}

/// Single-flight registry keyed identically to its sibling cache: callers
/// for one key wait on the leader and re-read the cache. Orphaned entries
/// (dropped fetch futures) sweep on insert past the hygiene bound;
/// `release` removes the key once the caller is provably the last holder.
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
        // Get-first: `entry` would allocate the key String on every claim,
        // including repeat hits for an in-flight key.
        if let Some(lock) = locks.get(key) {
            return lock.clone();
        }
        locks.entry(key.to_string()).or_default().clone()
    }

    /// Removes the key only while this caller is provably the last holder —
    /// all under the map mutex, so a `claim` can't slip a waiter in between
    /// and a stale releaser can't evict a replacement lock.
    pub(crate) fn release(&self, key: &str, key_lock: &Arc<tokio::sync::Mutex<()>>) {
        let mut locks = lock_or_recover(&self.locks);
        let last_holder = matches!(locks.get(key), Some(mapped) if Arc::ptr_eq(mapped, key_lock))
            && Arc::strong_count(key_lock) == 2;
        if last_holder {
            locks.remove(key);
        }
    }
}

/// Per-addon transport-failure cooldown shared by the stream transport and
/// the resource client: a host that exhausted its retries is presumed down,
/// so sibling fetches fail fast for `ttl`. Session-local — a dead host is
/// not a persisted condition. Writes are generation-checked so a fetch
/// started before a `clear_cache` can neither reinstall a wiped cooldown
/// nor wipe one recorded in the new generation; the failures mutex is taken
/// before the generation read so ordering vs. the clear's bump is unambiguous.
pub(crate) struct FetchFailureCooldown {
    failures: Mutex<HashMap<String, Instant>>,
    ttl: Duration,
    sweep_at: usize,
}

impl FetchFailureCooldown {
    /// `sweep_at` bounds map growth like the in-flight map: expired entries
    /// drop on read, and a full sweep runs on insert past the bound.
    pub(crate) fn new(ttl: Duration, sweep_at: usize) -> Self {
        Self {
            failures: Mutex::new(HashMap::new()),
            ttl,
            sweep_at,
        }
    }

    /// True while `key` is inside its cooldown window; expired entries drop
    /// on read.
    pub(crate) fn cooling_down(&self, key: &str) -> bool {
        let mut failures = lock_or_recover(&self.failures);
        match failures.get(key) {
            Some(until) if *until > Instant::now() => true,
            Some(_) => {
                failures.remove(key);
                false
            }
            None => false,
        }
    }

    /// Record a transport-exhaustion failure for `key`. Only retry-exhausted
    /// or timed-out fetches reach this — status/size/parse errors are
    /// content-scoped and belong to the per-key negative cache.
    pub(crate) fn note(&self, key: &str, generation: &AtomicU64, expected: u64) {
        let mut failures = lock_or_recover(&self.failures);
        if generation.load(Ordering::SeqCst) != expected {
            return;
        }
        failures.insert(key.to_string(), Instant::now() + self.ttl);
        if failures.len() > self.sweep_at {
            let now = Instant::now();
            failures.retain(|_, until| *until > now);
        }
    }

    /// Drop `key`'s cooldown after a successful fetch (the host proved
    /// reachable), unless a `clear_cache` landed meanwhile.
    pub(crate) fn clear_for_success(&self, key: &str, generation: &AtomicU64, expected: u64) {
        let mut failures = lock_or_recover(&self.failures);
        if generation.load(Ordering::SeqCst) == expected {
            failures.remove(key);
        }
    }

    /// `clear_cache` wipe — a config change may fix the dead host.
    pub(crate) fn clear(&self) {
        lock_or_recover(&self.failures).clear();
    }
}

/// How one addon fetch attempt ended: `Retryable` is a transient transport
/// error (send/connect/timeout/mid-stream read) that earns the shared
/// back-off retry and, on exhaustion, the per-addon cooldown; `Fatal` is
/// deterministic per request (status, size cap, decode, absent meta) and
/// lands in the short-TTL negative cache — a content-level failure must not
/// mark the whole addon dead.
pub(crate) enum FetchFailure {
    Retryable(String),
    Fatal(String),
}

/// The fetch contract the stream transport and resource client both run:
/// cache hit → negative-cache hit → per-addon cooldown → claim the key's
/// in-flight lock → re-check all three under it (the leader may have stored
/// while this caller waited) → `fetch`, retrying `Retryable` outcomes with
/// the shared back-off. Every writeback is generation-checked, so a
/// `clear_cache` landing mid-fetch revokes it. `request_timeout` feeds the
/// burned-timeout check (an attempt that ate the whole budget skips its
/// retry); `cooldown_message` is the fast-fail text served in the window.
pub(crate) struct FetchContract<'a> {
    pub failure_cache: &'a TtlCache<String>,
    pub fetch_failures: &'a FetchFailureCooldown,
    pub in_flight: &'a InFlight,
    pub generation: &'a AtomicU64,
    pub request_timeout: Duration,
    pub cooldown_message: &'a str,
}

impl FetchContract<'_> {
    /// Deterministic per-request failure write with the same generation
    /// guard as the value caches: a `clear_cache` mid-fetch revokes it.
    /// `run` owns failure writes; sibling-provider tests reach it directly.
    pub(super) fn cache_failure(&self, key: &str, error: &str, generation: u64) {
        let still_fresh = || self.generation.load(Ordering::SeqCst) == generation;
        if !still_fresh() {
            return;
        }
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
        if let Some(cached) = cache.get(key) {
            return Ok(cached);
        }
        if let Some(error) = self.failure_cache.get(key) {
            return Err(error);
        }
        // Inside the failure window the fetch would only re-pay
        // connect/timeout to fail again.
        if self.fetch_failures.cooling_down(addon_key) {
            return Err(self.cooldown_message.to_string());
        }

        // Single-flight: a concurrent call may already be fetching this key.
        // Wait, then re-read the leader's cached result instead of
        // duplicating the request.
        let key_lock = self.in_flight.claim(key);
        let result = {
            let _fetch_permit = key_lock.lock().await;
            // The leader stored while this caller waited — take its result,
            // or fail fast on the failure it just recorded instead of
            // re-running the same doomed fetch.
            if let Some(cached) = cache.get(key) {
                Ok(cached)
            } else if let Some(error) = self.failure_cache.get(key) {
                Err(error)
            } else if self.fetch_failures.cooling_down(addon_key) {
                Err(self.cooldown_message.to_string())
            } else {
                // A `clear_cache` after this point revokes this fetch's
                // right to write back (all writebacks below are
                // generation-checked).
                let generation = self.generation.load(Ordering::SeqCst);
                let mut attempt = 0u8;
                loop {
                    if attempt > 0 {
                        tokio::time::sleep(FETCH_RETRY_BACKOFF).await;
                    }
                    let started_at = Instant::now();
                    match fetch().await {
                        Ok(value) => {
                            // A success proves the host reachable — drop a
                            // cooldown a concurrent same-addon fetch recorded.
                            self.fetch_failures.clear_for_success(
                                addon_key,
                                self.generation,
                                generation,
                            );
                            // A clear_cache between fetch start and store
                            // drops the write under the entries lock, so
                            // post-change callers never read pre-change data.
                            cache.put(key, value.clone(), is_empty(&value), || {
                                self.generation.load(Ordering::SeqCst) == generation
                            });
                            break Ok(value);
                        }
                        Err(FetchFailure::Fatal(error)) => {
                            self.cache_failure(key, &error, generation);
                            break Err(error);
                        }
                        Err(FetchFailure::Retryable(error)) => {
                            attempt += 1;
                            let burned_timeout = started_at.elapsed() >= self.request_timeout;
                            if attempt >= FETCH_ATTEMPTS || burned_timeout {
                                // Retries exhausted: cool the addon down so
                                // the next open fails fast (generation-
                                // checked like the cache writes above).
                                self.fetch_failures
                                    .note(addon_key, self.generation, generation);
                                break Err(error);
                            }
                        }
                    }
                }
            }
        };
        self.in_flight.release(key, &key_lock);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
