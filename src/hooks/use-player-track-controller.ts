import { replaceEqualDeep } from '@tanstack/react-query';
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { toast } from 'sonner';

import { usePlaybackLanguagePreferences } from '@/hooks/use-playback-language-preferences';
import { api, type AddonSubtitle, type PlaybackLanguagePreferences } from '@/lib/api';
import { notifyAction } from '@/lib/notify';
import { addSubtitleTrack, changePlayerTrack, readPlayerTrackList } from '@/lib/player-mpv';
import {
  buildTrackAutoApplyFingerprint,
  buildTrackLanguageCandidateFingerprint,
  doesTrackSelectionMatch,
  findExternalSubtitleTrack,
  isExternalSubtitleTrack,
  toTrackLanguageCandidate,
  type Track,
} from '@/lib/player-track-utils';
import { isLocalMediaId } from '@/lib/utils';

const MAX_AUTO_APPLY_ATTEMPTS_PER_FINGERPRINT = 2;

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
  const trackListRef = useRef<Track[]>([]);
  const trackRefreshInFlightRef = useRef<Promise<Track[]> | null>(null);
  const trackRefreshQueuedRef = useRef<Promise<Track[]> | null>(null);
  const trackRefreshGenerationRef = useRef(0);
  const confirmedTrackRevisionRef = useRef(0);
  // Undefined means unobserved; null means no selected track.
  const observedTrackIdsRef = useRef<{
    audio: number | null | undefined;
    sub: number | null | undefined;
  }>({ audio: undefined, sub: undefined });
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

  const resetTrackListState = useEffectEvent(() => {
    trackListRef.current = [];
    setAudioTracks([]);
    setSubTracks([]);
  });

  const activeAudioTrack = audioTracks.find((track) => !!track.selected) ?? null;
  const activeSubTrack = subTracks.find((track) => !!track.selected) ?? null;
  const subtitlesOff = subTracks.length > 0 && !activeSubTrack;

  const applyTrackList = useCallback((nextTracks: Track[]) => {
    const tracks = replaceEqualDeep(trackListRef.current, nextTracks);
    if (tracks === trackListRef.current) {
      return tracks;
    }

    trackListRef.current = tracks;
    const nextAudioTracks = tracks.filter((track) => track.type === 'audio');
    const nextSubTracks = tracks.filter((track) => track.type === 'sub');

    setAudioTracks((previousTracks) => replaceEqualDeep(previousTracks, nextAudioTracks));
    setSubTracks((previousTracks) => replaceEqualDeep(previousTracks, nextSubTracks));

    return tracks;
  }, []);

  const refreshTracksImmediate = useCallback(async () => {
    const generation = trackRefreshGenerationRef.current;
    const confirmedRevision = confirmedTrackRevisionRef.current;
    const observedIds = observedTrackIdsRef.current;
    const selection =
      observedIds.audio !== undefined && observedIds.sub !== undefined
        ? { audio: observedIds.audio, sub: observedIds.sub }
        : undefined;
    return (async () => {
      const nextTracks = await readPlayerTrackList(selection);
      if (
        generation !== trackRefreshGenerationRef.current ||
        confirmedRevision !== confirmedTrackRevisionRef.current
      ) {
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

  const notifyObservedTrackSelection = (type: TrackType, id: number | null) => {
    observedTrackIdsRef.current[type] = id;
    return trackSwitchingRef.current[type];
  };

  const applyConfirmedTracks = useCallback(
    (type: TrackType, tracks: Track[], revision: number) => {
      if (revision !== confirmedTrackRevisionRef.current) {
        tracks = [
          ...tracks.filter((track) => track.type === type),
          ...trackListRef.current.filter((track) => track.type !== type),
        ];
      }
      confirmedTrackRevisionRef.current += 1;
      observedTrackIdsRef.current[type] =
        tracks.find((track) => track.type === type && track.selected)?.id ?? null;
      return applyTrackList(tracks);
    },
    [applyTrackList],
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
      autoAppliedTrackPrefsRef.current[type] = buildTrackAutoApplyFingerprint(
        storedPreference,
        trackListRef.current.filter((track) => track.type === type),
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
    [saveGlobalPlaybackLanguagePreferenceSelection, playbackLanguagePreferences],
  );

  const setTrack = useCallback<TrackChangeHandler>(
    async (type, id, { persistPreference = false, silent } = {}) => {
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

      if (alreadySelected && doesTrackSelectionMatch(trackListRef.current, type, id)) {
        if (persistPreference) {
          persistTrackSelection(type, id);
        }
        return true;
      }

      const generation = trackRefreshGenerationRef.current;
      setTrackSwitchingFlag(type, true);
      return (async () => {
        const revision = confirmedTrackRevisionRef.current;
        const tracks = await changePlayerTrack(type, id);
        if (generation !== trackRefreshGenerationRef.current) return false;
        applyConfirmedTracks(type, tracks, revision);
        if (persistPreference) persistTrackSelection(type, id);
        return true;
      })()
        .catch(() => {
          if (!silent && generation === trackRefreshGenerationRef.current) {
            toast.error('Failed to switch track');
          }
          return false;
        })
        .finally(() => {
          if (generation === trackRefreshGenerationRef.current) setTrackSwitchingFlag(type, false);
        });
    },
    [
      activeAudioTrack?.id,
      activeSubTrack?.id,
      applyConfirmedTracks,
      persistTrackSelection,
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
    return (async () => {
      const revision = confirmedTrackRevisionRef.current;
      const tracks = await changePlayerTrack(type, 'cycle');
      if (generation !== trackRefreshGenerationRef.current) return null;
      const fresh = applyConfirmedTracks(type, tracks, revision);
      const landedId = fresh.find((track) => track.type === type && track.selected)?.id ?? 'no';
      persistTrackSelection(
        type,
        landedId,
        fresh.find((track) => track.type === type && track.id === landedId),
      );
      return landedId;
    })()
      .catch(() => null)
      .finally(() => {
        if (generation === trackRefreshGenerationRef.current) {
          setTrackSwitchingFlag(type, false);
        }
      });
  };

  // Automatic selections have no failure toast and no remembered preference.
  const selectAddonSubtitle = async (
    subtitle: AddonSubtitle,
    { automatic }: { automatic?: boolean } = {},
  ): Promise<boolean> => {
    // Manual choices win before their preference update reaches the next render.
    if (
      trackSwitchingRef.current.sub ||
      (automatic && manualTrackPreferencesRef.current.sub !== null)
    ) {
      return false;
    }

    const existing = findExternalSubtitleTrack(trackListRef.current, subtitle);
    if (existing) {
      return setTrack('sub', existing.id, { silent: true, persistPreference: !automatic });
    }

    const generation = trackRefreshGenerationRef.current;
    setTrackSwitchingFlag('sub', true);
    return (async () => {
      const revision = confirmedTrackRevisionRef.current;
      const fresh = await addSubtitleTrack(subtitle.url, subtitle.mpvTitle, subtitle.lang);
      if (generation !== trackRefreshGenerationRef.current) return false;
      const addedTrack = applyConfirmedTracks('sub', fresh, revision).find(
        (track) => track.selected && isExternalSubtitleTrack(track, subtitle),
      );
      if (!addedTrack) return false;

      if (!automatic) persistTrackSelection('sub', addedTrack.id, addedTrack);
      return true;
    })().finally(() => {
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
        autoAppliedTrackPrefsRef.current[type] = buildTrackAutoApplyFingerprint(
          nextPreferences[type],
          trackListRef.current.filter((track) => track.type === type),
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
        autoAppliedTrackPrefsRef.current[kind] = fingerprint;
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
        autoAppliedTrackPrefsRef.current[kind] = buildTrackAutoApplyFingerprint(
          preferredLanguage,
          trackListRef.current.filter((track) => track.type === kind),
        );
      }
    },
    [resetKey, setTrack],
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
        autoAppliedTrackPrefsRef.current.sub = fingerprint;
        return;
      }

      return launchPreferredTrackAutoApply('sub', fingerprint, async (isCancelled) => {
        const switched = await setTrack('sub', 'no', { silent: true });
        if (!isCancelled() && switched) {
          autoAppliedTrackPrefsRef.current.sub = fingerprint;
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
    observedTrackIdsRef.current = { audio: undefined, sub: undefined };
    setTrackSwitching((currentState) =>
      currentState.audio || currentState.sub ? { audio: false, sub: false } : currentState,
    );
    return () => {
      trackRefreshGenerationRef.current += 1;
      observedTrackIdsRef.current = { audio: undefined, sub: undefined };
    };
    // `resetKey` already carries the stream URL — it subsumes activeStreamUrl.
  }, [resetKey]);

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
