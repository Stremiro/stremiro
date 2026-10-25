import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { toast } from 'sonner';

import { usePlaybackLanguagePreferences } from '@/hooks/use-playback-language-preferences';
import { api, type AddonSubtitle, type PlaybackLanguagePreferences } from '@/lib/api';
import { notifyAction } from '@/lib/notify';
import {
  addSubtitleTrack,
  cycleMpvTrack,
  readPlayerTrackCount,
  readPlayerTrackList,
  readSelectedTrackId,
  setMpvProperty,
} from '@/lib/player-mpv';
import {
  areTrackListsEqual,
  buildTrackAutoApplyFingerprint,
  buildTrackLanguageCandidateFingerprint,
  doesTrackSelectionMatch,
  findExternalSubtitleTrack,
  toTrackLanguageCandidate,
  type Track,
} from '@/lib/player-track-utils';
import { isLocalMediaId, sleep } from '@/lib/utils';

const TRACK_SWITCH_VERIFY_ATTEMPTS = 8;
const TRACK_SWITCH_VERIFY_DELAY_MS = 150;
// External subtitle tracks appear only after mpv fetches their URL.
const ADDON_SUB_TRACK_VERIFY_ATTEMPTS = 14;
const MAX_AUTO_APPLY_ATTEMPTS_PER_FINGERPRINT = 2;
// Wait for the observed selection before falling back to polling.
const TRACK_SWITCH_EVENT_TIMEOUT_MS = 800;

type TrackSwitchingState = { audio: boolean; sub: boolean };
type TrackType = 'audio' | 'sub';
type TrackChangeOptions = { silent?: boolean; persistPreference?: boolean };
type TrackChangeHandler = (
  type: TrackType,
  id: number | 'no',
  options?: TrackChangeOptions,
) => Promise<boolean>;

// Stable stand-in while the effective query has no data.
const EMPTY_PLAYBACK_LANGUAGE_PREFERENCES: PlaybackLanguagePreferences = {};

interface TrackAutoApplyAttemptState {
  fingerprint: string | null;
  count: number;
}

interface ManualTrackPreference {
  id: number | 'no';
  generation: number;
  language: string | null;
  pending: boolean;
}

interface SelectionWaiter {
  target: number | 'no';
  timer: number;
  resolve: (matched: boolean) => void;
}

interface UsePlayerTrackControllerArgs {
  mediaId?: string;
  mediaType?: 'movie' | 'series' | 'anime';
  activeStreamUrl?: string;
  hasPlaybackStarted: boolean;
  isLoading: boolean;
  isResolving: boolean;
  resetKey: string;
}

export function usePlayerTrackController({
  mediaId,
  mediaType,
  activeStreamUrl,
  hasPlaybackStarted,
  isLoading,
  isResolving,
  resetKey,
}: UsePlayerTrackControllerArgs) {
  const [audioTracks, setAudioTracks] = useState<Track[]>([]);
  const [subTracks, setSubTracks] = useState<Track[]>([]);
  const [trackSwitching, setTrackSwitching] = useState<TrackSwitchingState>({
    audio: false,
    sub: false,
  });
  const trackSwitchingRef = useRef<TrackSwitchingState>({
    audio: false,
    sub: false,
  });
  const cycleRefreshPendingRef = useRef<TrackSwitchingState>({
    audio: false,
    sub: false,
  });
  const trackListRef = useRef<Track[]>([]);
  const trackRefreshInFlightRef = useRef<Promise<Track[]> | null>(null);
  const trackRefreshQueuedRef = useRef<Promise<Track[]> | null>(null);
  const trackRefreshGenerationRef = useRef(0);
  // Undefined means unobserved; null means no selected track.
  const observedTrackIdsRef = useRef<{
    audio: number | null | undefined;
    sub: number | null | undefined;
  }>({ audio: undefined, sub: undefined });
  const selectionWaitersRef = useRef<Record<TrackType, Set<SelectionWaiter>>>({
    audio: new Set(),
    sub: new Set(),
  });
  const autoAppliedTrackPrefsRef = useRef<Record<TrackType, string | null>>({
    audio: null,
    sub: null,
  });
  const autoApplyingTrackPrefsRef = useRef<{ audio: boolean; sub: boolean }>({
    audio: false,
    sub: false,
  });
  const autoApplyAttemptStateRef = useRef<Record<TrackType, TrackAutoApplyAttemptState>>({
    audio: { fingerprint: null, count: 0 },
    sub: { fingerprint: null, count: 0 },
  });
  const previousPreferencesRef = useRef<Record<TrackType, string> | null>(null);
  const manualTrackSelectionEpochRef = useRef({ audio: 0, sub: 0 });
  const manualTrackPreferencesRef = useRef<Record<TrackType, ManualTrackPreference | null>>({
    audio: null,
    sub: null,
  });
  const [preferenceSaveEpoch, setPreferenceSaveEpoch] = useState({ audio: 0, sub: 0 });
  const [autoApplySettlementRevision, setAutoApplySettlementRevision] = useState(0);
  const autoApplySettlementRevisionRef = useRef(0);
  const lastRecordedTrackOutcomeRef = useRef<string | null>(null);
  // Preferred subtitle language no embedded track satisfies, until a manual pick or the next load.
  // Tagged with the load it was computed for — a stream swap within the same episode
  // commits before the reset effect runs, so the raw state can briefly be stale.
  const [addonSubtitleLanguage, setAddonSubtitleLanguage] = useState<{
    key: string;
    language: string;
  } | null>(null);

  const resetTrackSelectionObservations = useCallback(() => {
    observedTrackIdsRef.current = { audio: undefined, sub: undefined };
    cycleRefreshPendingRef.current = { audio: false, sub: false };
    for (const type of ['audio', 'sub'] as TrackType[]) {
      const waiters = selectionWaitersRef.current[type];
      for (const waiter of waiters) {
        window.clearTimeout(waiter.timer);
        waiter.resolve(false);
      }
      waiters.clear();
    }
  }, []);

  const resetTrackListState = useEffectEvent(() => {
    trackListRef.current = [];
    setAudioTracks([]);
    setSubTracks([]);
  });

  const activeAudioTrack = audioTracks.find((track) => !!track.selected) ?? null;
  const activeSubTrack = subTracks.find((track) => !!track.selected) ?? null;
  const subtitlesOff = subTracks.length > 0 && !activeSubTrack;

  const applyTrackList = useCallback((nextTracks: Track[]) => {
    if (areTrackListsEqual(trackListRef.current, nextTracks)) {
      return trackListRef.current;
    }

    trackListRef.current = nextTracks;
    const nextAudioTracks = nextTracks.filter((track) => track.type === 'audio');
    const nextSubTracks = nextTracks.filter((track) => track.type === 'sub');

    setAudioTracks((previousTracks) =>
      areTrackListsEqual(previousTracks, nextAudioTracks) ? previousTracks : nextAudioTracks,
    );
    setSubTracks((previousTracks) =>
      areTrackListsEqual(previousTracks, nextSubTracks) ? previousTracks : nextSubTracks,
    );

    return nextTracks;
  }, []);

  const refreshTracksImmediate = useCallback(async () => {
    const generation = trackRefreshGenerationRef.current;
    const observedIds = observedTrackIdsRef.current;
    const selection =
      observedIds.audio !== undefined && observedIds.sub !== undefined
        ? { audio: observedIds.audio, sub: observedIds.sub }
        : undefined;
    return (async () => {
      const nextTracks = await readPlayerTrackList(selection);
      if (generation !== trackRefreshGenerationRef.current) {
        return trackListRef.current;
      }
      return applyTrackList(nextTracks);
    })().catch(() => {
      return trackListRef.current;
    });
  }, [applyTrackList]);

  const startTrackRefresh = useCallback(() => {
    const run = refreshTracksImmediate().finally(() => {
      if (trackRefreshInFlightRef.current === run) {
        trackRefreshInFlightRef.current = null;
      }
    });
    trackRefreshInFlightRef.current = run;
    return run;
  }, [refreshTracksImmediate]);

  const refreshTracks = useCallback(() => {
    // Coalesce overlapping reads with one trailing snapshot for changes during the read.
    const inFlight = trackRefreshInFlightRef.current;
    if (!inFlight) {
      return startTrackRefresh();
    }
    if (!trackRefreshQueuedRef.current) {
      const generation = trackRefreshGenerationRef.current;
      const queued = inFlight.then(() => {
        if (trackRefreshQueuedRef.current === queued) trackRefreshQueuedRef.current = null;
        if (generation !== trackRefreshGenerationRef.current) return trackListRef.current;
        return startTrackRefresh();
      });
      trackRefreshQueuedRef.current = queued;
    }
    return trackRefreshQueuedRef.current;
  }, [startTrackRefresh]);

  // The selection event may precede write completion; check the observed cache first.
  const waitForTrackSelection = useCallback(
    (type: TrackType, target: number | 'no'): Promise<boolean> => {
      const observed = observedTrackIdsRef.current[type];
      if (target === 'no' ? observed === null : observed === target) {
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        const waiters = selectionWaitersRef.current[type];
        const waiter: SelectionWaiter = {
          target,
          resolve,
          timer: window.setTimeout(() => {
            waiters.delete(waiter);
            resolve(false);
          }, TRACK_SWITCH_EVENT_TIMEOUT_MS),
        };
        waiters.add(waiter);
      });
    },
    [],
  );

  const notifyObservedTrackSelection = (type: TrackType, id: number | null) => {
    observedTrackIdsRef.current[type] = id;
    const waiters = selectionWaitersRef.current[type];
    let resolvedSelection = false;
    for (const waiter of waiters) {
      if (waiter.target === 'no' ? id === null : id === waiter.target) {
        window.clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(true);
        resolvedSelection = true;
      }
    }
    return resolvedSelection || cycleRefreshPendingRef.current[type];
  };

  // Capture generation before the write so resets during IPC remain detectable.
  const confirmTrackSwitch = useCallback(
    async (type: TrackType, id: number | 'no', generation: number) => {
      if (generation !== trackRefreshGenerationRef.current) return false;
      // Empty list matches 'no' vacuously; require a loaded list for the fast path.
      if (
        trackListRef.current.length > 0 &&
        doesTrackSelectionMatch(trackListRef.current, type, id)
      ) {
        return true;
      }

      if (await waitForTrackSelection(type, id)) {
        if (generation !== trackRefreshGenerationRef.current) {
          return false;
        }
        const fresh = await refreshTracks();
        return (
          generation === trackRefreshGenerationRef.current &&
          doesTrackSelectionMatch(fresh, type, id)
        );
      }
      // Probe only the selected id until it lands, then refresh the full list.
      /* eslint-disable no-await-in-loop */
      for (let attempt = 0; attempt < TRACK_SWITCH_VERIFY_ATTEMPTS; attempt += 1) {
        if (generation !== trackRefreshGenerationRef.current) {
          return false;
        }
        const selectedId = await readSelectedTrackId(type).catch(() => undefined);
        if (generation !== trackRefreshGenerationRef.current) return false;
        if (selectedId !== undefined) {
          const matched = id === 'no' ? selectedId === null : selectedId === id;
          if (matched) {
            observedTrackIdsRef.current[type] = selectedId;
            const fresh = await refreshTracks();
            return (
              generation === trackRefreshGenerationRef.current &&
              doesTrackSelectionMatch(fresh, type, id)
            );
          }
        }

        if (attempt < TRACK_SWITCH_VERIFY_ATTEMPTS - 1) {
          await sleep(TRACK_SWITCH_VERIFY_DELAY_MS);
        }
      }
      /* eslint-enable no-await-in-loop */

      const latestTracks = await refreshTracks();
      return (
        generation === trackRefreshGenerationRef.current &&
        doesTrackSelectionMatch(latestTracks, type, id)
      );
    },
    [refreshTracks, waitForTrackSelection],
  );

  const setTrackSwitchingFlag = useCallback((type: TrackType, value: boolean) => {
    if (trackSwitchingRef.current[type] === value) return;
    const next = {
      ...trackSwitchingRef.current,
      [type]: value,
    };
    trackSwitchingRef.current = next;
    setTrackSwitching(next);
  }, []);

  const { effectivePlaybackLanguagePreferences, saveGlobalPlaybackLanguagePreferenceSelection } =
    usePlaybackLanguagePreferences({ mediaId, mediaType });

  // The save response writes the effective cache before its queue resolves — read it directly rather than folding global over it.
  const playbackLanguagePreferences =
    effectivePlaybackLanguagePreferences ?? EMPTY_PLAYBACK_LANGUAGE_PREFERENCES;

  const resetAutoApplyState = useCallback((type: TrackType) => {
    autoAppliedTrackPrefsRef.current[type] = null;
    autoApplyingTrackPrefsRef.current[type] = false;
    autoApplyAttemptStateRef.current[type] = { fingerprint: null, count: 0 };
  }, []);

  const markApplied = useCallback((type: TrackType, fingerprint: string) => {
    autoAppliedTrackPrefsRef.current[type] = fingerprint;
  }, []);

  const persistTrackSelection = useCallback(
    (type: TrackType, id: number | 'no', explicitTrack?: Track) => {
      manualTrackSelectionEpochRef.current[type] += 1;
      if (type === 'sub') setAddonSubtitleLanguage(null);
      const selectedTrack =
        explicitTrack ??
        trackListRef.current.find((track) => track.type === type && track.id === id);
      const manual: ManualTrackPreference = {
        id,
        generation: trackRefreshGenerationRef.current,
        language: null,
        pending: true,
      };
      manualTrackPreferencesRef.current[type] = manual;
      const storedPreference =
        (type === 'audio'
          ? playbackLanguagePreferences.preferredAudioLanguage
          : playbackLanguagePreferences.preferredSubtitleLanguage) ?? '';
      markApplied(
        type,
        buildTrackAutoApplyFingerprint(
          storedPreference,
          trackListRef.current.filter((track) => track.type === type),
        ),
      );
      void saveGlobalPlaybackLanguagePreferenceSelection(
        type,
        selectedTrack ? toTrackLanguageCandidate(selectedTrack) : undefined,
        { subtitlesOff: type === 'sub' && id === 'no' },
      )
        .then((saved) => {
          if (
            manual.generation !== trackRefreshGenerationRef.current ||
            manualTrackPreferencesRef.current[type] !== manual
          )
            return;
          // Use Rust's canonical token from the acknowledgement, including inferred/aliased track languages.
          manual.language =
            (type === 'audio' ? saved.preferredAudioLanguage : saved.preferredSubtitleLanguage) ??
            '';
        })
        .catch(() => {
          if (
            manual.generation === trackRefreshGenerationRef.current &&
            manualTrackPreferencesRef.current[type] === manual
          ) {
            manualTrackPreferencesRef.current[type] = null;
            notifyAction("Couldn't remember this track choice", { tone: 'error' });
          }
        })
        .finally(() => {
          manual.pending = false;
          if (
            manual.generation === trackRefreshGenerationRef.current &&
            (manualTrackPreferencesRef.current[type] === manual ||
              manualTrackPreferencesRef.current[type] === null)
          )
            setPreferenceSaveEpoch((epoch) => ({ ...epoch, [type]: epoch[type] + 1 }));
        });
    },
    [markApplied, saveGlobalPlaybackLanguagePreferenceSelection, playbackLanguagePreferences],
  );

  // Single switch path: write → confirm → persist; failures toast unless `silent`.
  // Callers hold `trackSwitching[type]` for their whole span — the addon path's add+verify must also block auto-apply.
  const requestTrackSwitch = useCallback(
    async (
      type: TrackType,
      id: number | 'no',
      { persistPreference, silent }: TrackChangeOptions = {},
    ): Promise<boolean> => {
      const generation = trackRefreshGenerationRef.current;
      const failed = () => {
        if (!silent && generation === trackRefreshGenerationRef.current) {
          toast.error('Failed to switch track');
        }
        return false;
      };
      return (async () => {
        await setMpvProperty(type === 'audio' ? 'aid' : 'sid', id === 'no' ? 'no' : id);

        const switched = await confirmTrackSwitch(type, id, generation);
        if (!switched) {
          return failed();
        }

        if (generation !== trackRefreshGenerationRef.current) {
          return false;
        }

        if (persistPreference) {
          persistTrackSelection(type, id);
        }

        return true;
      })().catch(() => {
        return failed();
      });
    },
    [confirmTrackSwitch, persistTrackSelection],
  );

  const setTrack = useCallback<TrackChangeHandler>(
    async (type, id, options) => {
      if (type === 'audio' && id === 'no') {
        return false;
      }

      if (trackSwitchingRef.current[type]) {
        return false;
      }

      const alreadySelected =
        type === 'audio'
          ? activeAudioTrack?.id === id
          : id === 'no'
            ? subtitlesOff
            : activeSubTrack?.id === id;
      const persistPreference = options?.persistPreference ?? false;

      if (alreadySelected) {
        if (persistPreference) {
          persistTrackSelection(type, id);
        }
        return true;
      }

      const generation = trackRefreshGenerationRef.current;
      setTrackSwitchingFlag(type, true);
      return requestTrackSwitch(type, id, {
        persistPreference,
        silent: options?.silent,
      }).finally(() => {
        if (generation === trackRefreshGenerationRef.current) setTrackSwitchingFlag(type, false);
      });
    },
    [
      activeAudioTrack?.id,
      activeSubTrack?.id,
      persistTrackSelection,
      requestTrackSwitch,
      setTrackSwitchingFlag,
      subtitlesOff,
    ],
  );

  // Hold the switch gate through cycle, refresh and persist to prevent auto-apply reverting it.
  const cycleTrack = async (type: TrackType): Promise<number | 'no' | null> => {
    if (trackSwitchingRef.current[type]) {
      return null;
    }

    const generation = trackRefreshGenerationRef.current;
    setTrackSwitchingFlag(type, true);
    cycleRefreshPendingRef.current[type] = true;
    return (async () => {
      await cycleMpvTrack(type);
      if (generation !== trackRefreshGenerationRef.current) return null;
      const selectedId = await readSelectedTrackId(type).catch(() => undefined);
      if (generation !== trackRefreshGenerationRef.current) return null;
      if (selectedId !== undefined) observedTrackIdsRef.current[type] = selectedId;
      // Refresh before persisting the selection's track-list fingerprint.
      // Only claim events before this snapshot; later changes need their own refresh.
      cycleRefreshPendingRef.current[type] = false;
      const fresh = await refreshTracks();
      if (generation !== trackRefreshGenerationRef.current) return null;
      const landedId =
        selectedId !== undefined
          ? (selectedId ?? 'no')
          : (fresh.find((track) => track.type === type && track.selected)?.id ?? 'no');
      persistTrackSelection(
        type,
        landedId,
        fresh.find((track) => track.type === type && track.id === landedId),
      );
      return landedId;
    })()
      .catch(async () => {
        if (
          generation === trackRefreshGenerationRef.current &&
          cycleRefreshPendingRef.current[type]
        ) {
          cycleRefreshPendingRef.current[type] = false;
          await refreshTracks();
        }
        return null;
      })
      .finally(() => {
        if (generation === trackRefreshGenerationRef.current) {
          cycleRefreshPendingRef.current[type] = false;
          setTrackSwitchingFlag(type, false);
        }
      });
  };

  // Automatic selections have no failure toast and no remembered preference.
  const selectAddonSubtitle = async (
    subtitle: AddonSubtitle,
    { automatic }: { automatic?: boolean } = {},
  ): Promise<boolean> => {
    if (trackSwitchingRef.current.sub) {
      return false;
    }

    const existing = findExternalSubtitleTrack(trackListRef.current, subtitle);
    if (existing) {
      return setTrack('sub', existing.id, { silent: true, persistPreference: !automatic });
    }

    const generation = trackRefreshGenerationRef.current;
    setTrackSwitchingFlag('sub', true);
    return (async () => {
      // Read the native baseline before adding; the local list can lag file-load.
      const baseTrackCount = (await readPlayerTrackCount()) ?? trackListRef.current.length;
      if (generation !== trackRefreshGenerationRef.current) return false;
      await addSubtitleTrack(subtitle.url, subtitle.mpvTitle, subtitle.lang);
      if (generation !== trackRefreshGenerationRef.current) return false;

      let addedTrack = findExternalSubtitleTrack(trackListRef.current, subtitle) ?? null;
      /* eslint-disable no-await-in-loop -- sequential verify-poll */
      for (
        let attempt = 0;
        !addedTrack && attempt < ADDON_SUB_TRACK_VERIFY_ATTEMPTS;
        attempt += 1
      ) {
        if (generation !== trackRefreshGenerationRef.current) {
          return false;
        }
        // Avoid full-list reads until the native track count grows.
        const trackCount = await readPlayerTrackCount();
        if (generation !== trackRefreshGenerationRef.current) return false;
        if (trackCount !== null && trackCount > baseTrackCount) {
          const fresh = await refreshTracks();
          addedTrack = findExternalSubtitleTrack(fresh, subtitle) ?? null;
        }
        if (!addedTrack) {
          await sleep(TRACK_SWITCH_VERIFY_DELAY_MS);
        }
      }
      /* eslint-enable no-await-in-loop */

      if (generation !== trackRefreshGenerationRef.current) return false;
      // A reused native slot may land without increasing the count.
      if (!addedTrack) {
        const fresh = await refreshTracks();
        addedTrack = findExternalSubtitleTrack(fresh, subtitle) ?? null;
      }
      if (generation !== trackRefreshGenerationRef.current) return false;
      if (!addedTrack) return false;

      if (!addedTrack.selected) {
        const switched = await requestTrackSwitch('sub', addedTrack.id, { silent: true });
        if (!switched) return false;
      }

      if (generation !== trackRefreshGenerationRef.current) {
        return false;
      }

      if (!automatic) persistTrackSelection('sub', addedTrack.id, addedTrack);
      return true;
    })()
      .catch(() => {
        return false;
      })
      .finally(() => {
        if (generation === trackRefreshGenerationRef.current) setTrackSwitchingFlag('sub', false);
      });
  };

  useEffect(() => {
    resetAutoApplyState('audio');
    resetAutoApplyState('sub');
    previousPreferencesRef.current = null;
    manualTrackPreferencesRef.current = { audio: null, sub: null };
    setAddonSubtitleLanguage(null);
  }, [resetKey, resetAutoApplyState]);

  useEffect(() => {
    const nextPreferences = {
      audio: playbackLanguagePreferences.preferredAudioLanguage ?? '',
      sub: playbackLanguagePreferences.preferredSubtitleLanguage ?? '',
    };
    const previous = previousPreferencesRef.current;
    if (previous === null) {
      previousPreferencesRef.current = nextPreferences;
      return;
    }
    for (const type of ['audio', 'sub'] as const) {
      const manual = manualTrackPreferencesRef.current[type];
      // Cache publication precedes save settlement; defer this type until its canonical acknowledgement arrives.
      if (manual?.language === null) continue;
      if (
        manual?.language === nextPreferences[type] &&
        doesTrackSelectionMatch(trackListRef.current, type, manual.id)
      ) {
        markApplied(
          type,
          buildTrackAutoApplyFingerprint(
            nextPreferences[type],
            trackListRef.current.filter((track) => track.type === type),
          ),
        );
      } else if (previous[type] !== nextPreferences[type]) {
        manualTrackPreferencesRef.current[type] = null;
        resetAutoApplyState(type);
      }
      previous[type] = nextPreferences[type];
    }
  }, [
    playbackLanguagePreferences.preferredAudioLanguage,
    playbackLanguagePreferences.preferredSubtitleLanguage,
    preferenceSaveEpoch.audio,
    preferenceSaveEpoch.sub,
    markApplied,
    resetAutoApplyState,
  ]);

  const applyPreferredTrack = useCallback(
    async (
      kind: TrackType,
      tracks: Track[],
      preferredLanguage: string,
      activeTrackId: number | undefined,
      fingerprint: string,
      isCancelled: () => boolean,
    ) => {
      const manualSelectionEpoch = manualTrackSelectionEpochRef.current[kind];
      const resolution = await api
        .resolvePreferredTrackSelection(
          tracks.map(toTrackLanguageCandidate),
          preferredLanguage,
          activeTrackId,
        )
        .catch(() => null);
      if (!resolution) return;

      if (isCancelled() || manualSelectionEpoch !== manualTrackSelectionEpochRef.current[kind])
        return;

      if (resolution.selectedMatches) {
        markApplied(kind, fingerprint);
        return;
      }
      if (typeof resolution.matchedTrackId !== 'number') {
        if (kind === 'sub')
          setAddonSubtitleLanguage({ key: resetKey, language: preferredLanguage });
        return;
      }

      const switched = await setTrack(kind, resolution.matchedTrackId, { silent: true });
      if (
        !isCancelled() &&
        manualSelectionEpoch === manualTrackSelectionEpochRef.current[kind] &&
        switched
      ) {
        markApplied(kind, fingerprint);
      }
    },
    [markApplied, resetKey, setTrack],
  );

  const launchPreferredTrackAutoApply = useCallback(
    (kind: TrackType, fingerprint: string, task: (isCancelled: () => boolean) => Promise<void>) => {
      let cancelled = false;
      const generation = trackRefreshGenerationRef.current;
      autoApplyingTrackPrefsRef.current[kind] = true;
      const state = autoApplyAttemptStateRef.current[kind];
      autoApplyAttemptStateRef.current[kind] = {
        fingerprint,
        count: state.fingerprint === fingerprint ? state.count + 1 : 1,
      };

      void task(() => cancelled).finally(() => {
        if (generation !== trackRefreshGenerationRef.current) return;
        if (!cancelled) {
          autoApplyingTrackPrefsRef.current[kind] = false;
        }
        autoApplySettlementRevisionRef.current += 1;
        setAutoApplySettlementRevision(autoApplySettlementRevisionRef.current);
      });

      return () => {
        cancelled = true;
        autoApplyingTrackPrefsRef.current[kind] = false;
      };
    },
    [],
  );

  const isAutoApplyHandled = useCallback((kind: TrackType, fingerprint: string) => {
    const state = autoApplyAttemptStateRef.current[kind];
    return (
      manualTrackPreferencesRef.current[kind]?.language === null ||
      autoAppliedTrackPrefsRef.current[kind] === fingerprint ||
      autoApplyingTrackPrefsRef.current[kind] ||
      (state.fingerprint === fingerprint && state.count >= MAX_AUTO_APPLY_ATTEMPTS_PER_FINGERPRINT)
    );
  }, []);

  useEffect(() => {
    const preferredAudioLanguage = playbackLanguagePreferences.preferredAudioLanguage ?? '';
    if (isLoading || !hasPlaybackStarted || !preferredAudioLanguage) return;
    if (trackSwitching.audio || audioTracks.length === 0) return;

    const fingerprint = buildTrackAutoApplyFingerprint(preferredAudioLanguage, audioTracks);
    if (isAutoApplyHandled('audio', fingerprint)) return;

    return launchPreferredTrackAutoApply('audio', fingerprint, (isCancelled) =>
      applyPreferredTrack(
        'audio',
        audioTracks,
        preferredAudioLanguage,
        activeAudioTrack?.id,
        fingerprint,
        isCancelled,
      ),
    );
  }, [
    activeAudioTrack?.id,
    applyPreferredTrack,
    audioTracks,
    hasPlaybackStarted,
    isAutoApplyHandled,
    isLoading,
    launchPreferredTrackAutoApply,
    playbackLanguagePreferences.preferredAudioLanguage,
    preferenceSaveEpoch.audio,
    trackSwitching.audio,
  ]);

  useEffect(() => {
    const preferredSubtitleLanguage = playbackLanguagePreferences.preferredSubtitleLanguage ?? '';
    if (isLoading || !hasPlaybackStarted || !preferredSubtitleLanguage) return;
    if (trackSwitching.sub) return;

    const fingerprint = buildTrackAutoApplyFingerprint(preferredSubtitleLanguage, subTracks);
    if (isAutoApplyHandled('sub', fingerprint)) return;

    if (preferredSubtitleLanguage === 'off') {
      const hasSelectedSubtitle = subTracks.some((track) => !!track.selected);
      if (!hasSelectedSubtitle) {
        markApplied('sub', fingerprint);
        return;
      }

      return launchPreferredTrackAutoApply('sub', fingerprint, async (isCancelled) => {
        const switched = await setTrack('sub', 'no', { silent: true });
        if (!isCancelled() && switched) {
          markApplied('sub', fingerprint);
        }
      });
    }

    // An empty subtitle list still resolves once the track list has loaded, so addons can fill the gap.
    if (subTracks.length === 0 && audioTracks.length === 0) return;

    return launchPreferredTrackAutoApply('sub', fingerprint, (isCancelled) =>
      applyPreferredTrack(
        'sub',
        subTracks,
        preferredSubtitleLanguage,
        activeSubTrack?.id,
        fingerprint,
        isCancelled,
      ),
    );
  }, [
    activeSubTrack?.id,
    applyPreferredTrack,
    audioTracks.length,
    hasPlaybackStarted,
    isAutoApplyHandled,
    isLoading,
    launchPreferredTrackAutoApply,
    markApplied,
    playbackLanguagePreferences.preferredSubtitleLanguage,
    preferenceSaveEpoch.sub,
    setTrack,
    subTracks,
    trackSwitching.sub,
  ]);

  useEffect(() => {
    if (
      effectivePlaybackLanguagePreferences === undefined ||
      !hasPlaybackStarted ||
      isLoading ||
      isResolving ||
      !mediaId ||
      isLocalMediaId(mediaId)
    ) {
      return;
    }
    // Duration can mark playback ready before the first track read — an empty outcome would delete this title's learned languages.
    if (audioTracks.length === 0 && subTracks.length === 0) {
      return;
    }

    const isTrackSelectionPending = () =>
      trackSwitchingRef.current.audio ||
      trackSwitchingRef.current.sub ||
      autoApplyingTrackPrefsRef.current.audio ||
      autoApplyingTrackPrefsRef.current.sub ||
      manualTrackPreferencesRef.current.audio?.pending ||
      manualTrackPreferencesRef.current.sub?.pending;
    if (isTrackSelectionPending()) return;

    const fingerprint = JSON.stringify([
      activeStreamUrl ?? '',
      buildTrackLanguageCandidateFingerprint(activeAudioTrack),
      subtitlesOff ? 'sub:off' : buildTrackLanguageCandidateFingerprint(activeSubTrack),
    ]);

    if (lastRecordedTrackOutcomeRef.current === fingerprint) {
      return;
    }

    const generation = trackRefreshGenerationRef.current;
    const settlementRevision = autoApplySettlementRevision;
    let cancelled = false;
    queueMicrotask(() => {
      if (
        cancelled ||
        generation !== trackRefreshGenerationRef.current ||
        settlementRevision !== autoApplySettlementRevisionRef.current ||
        isTrackSelectionPending()
      )
        return;

      lastRecordedTrackOutcomeRef.current = fingerprint;
      void api
        .savePlaybackLanguagePreferenceOutcomeFromTracks(
          mediaId,
          mediaType ?? 'series',
          activeAudioTrack ? toTrackLanguageCandidate(activeAudioTrack) : undefined,
          subtitlesOff || !activeSubTrack ? undefined : toTrackLanguageCandidate(activeSubTrack),
          subtitlesOff,
        )
        .catch(() => {
          // Title-scoped playback preference memory is best-effort only.
        });
    });
    return () => {
      cancelled = true;
    };
  }, [
    activeAudioTrack,
    activeStreamUrl,
    activeSubTrack,
    audioTracks.length,
    autoApplySettlementRevision,
    effectivePlaybackLanguagePreferences,
    hasPlaybackStarted,
    isLoading,
    isResolving,
    mediaId,
    mediaType,
    preferenceSaveEpoch.audio,
    preferenceSaveEpoch.sub,
    subTracks.length,
    subtitlesOff,
    trackSwitching.audio,
    trackSwitching.sub,
  ]);

  useEffect(() => {
    resetTrackListState();
    lastRecordedTrackOutcomeRef.current = null;
    trackSwitchingRef.current = { audio: false, sub: false };
    // Drop stale bursts and selection observations from the previous session.
    trackRefreshGenerationRef.current += 1;
    trackRefreshInFlightRef.current = null;
    trackRefreshQueuedRef.current = null;
    resetTrackSelectionObservations();
    setTrackSwitching((currentState) =>
      currentState.audio || currentState.sub ? { audio: false, sub: false } : currentState,
    );
    return () => {
      trackRefreshGenerationRef.current += 1;
      resetTrackSelectionObservations();
    };
    // `resetKey` already carries the stream URL — it subsumes activeStreamUrl.
  }, [resetKey, resetTrackSelectionObservations]);

  return {
    addonSubtitleLanguage:
      addonSubtitleLanguage?.key === resetKey &&
      !!addonSubtitleLanguage.language &&
      addonSubtitleLanguage.language !== 'off' &&
      addonSubtitleLanguage.language === playbackLanguagePreferences.preferredSubtitleLanguage
        ? addonSubtitleLanguage.language
        : null,
    audioTracks,
    cycleTrack,
    notifyObservedTrackSelection,
    playbackLanguagePreferences,
    refreshTracks,
    selectAddonSubtitle,
    setTrack,
    subTracks,
    trackSwitching,
  };
}
