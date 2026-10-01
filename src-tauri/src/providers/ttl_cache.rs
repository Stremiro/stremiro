use super::lock_or_recover;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Single owner for "hash a possibly credential-bearing URL into a stable
/// key segment": callers format it with their own prefix, so secrets never
/// appear in cache keys or logs.
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
/// Hits clone the stored value — cheap next to the network round-trip they
/// replace. Eviction: expire-on-read and insert, then soonest-expiring
/// victims so the entry that triggered the fetch stays.
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

    /// `is_empty` picks the shorter TTL: successful-but-empty answers are
    /// still cached (a stream-less title must not re-fan-out per request),
    /// but newly indexed content surfaces within seconds, not minutes.
    /// `still_fresh` runs under the entries lock: a `clear_cache` between
    /// fetch start and store bumps the generation, so a superseded write
    /// drops here instead of repopulating cleared state.
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

/// Single-flight registry keyed identically to its sibling cache:
/// concurrent callers for one key wait on the leader's lock and re-read the
/// cache instead of duplicating the request. Orphaned entries (a dropped
/// fetch future holds only the map's Arc) sweep on insert once past the
/// hygiene bound; `release` removes the key once no waiter can still join —
/// the map's Arc plus the caller's means the last holder always cleans up.
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

    /// Removes the key only while this caller is provably the last holder:
    /// the map lookup, the identity check, and the removal all happen under
    /// the map mutex, so a `claim` cannot slip a new waiter in between, and
    /// a stale releaser can't evict a replacement lock parked at its old key.
    pub(crate) fn release(&self, key: &str, key_lock: &Arc<tokio::sync::Mutex<()>>) {
        let mut locks = lock_or_recover(&self.locks);
        let last_holder = matches!(locks.get(key), Some(mapped) if Arc::ptr_eq(mapped, key_lock))
            && Arc::strong_count(key_lock) == 2;
        if last_holder {
            locks.remove(key);
        }
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
