import { useQueryClient } from '@tanstack/react-query';
import { type RefObject, useCallback, useEffect, useRef } from 'react';
import type { PlayerStreamSession } from '@/hooks/use-player-stream-session';
import { api, type WatchProgressSave } from '@/lib/api';
import { getWatchProgressEpoch } from '@/lib/api-cache';
import { registerPendingAppWriteFlusher, trackPendingAppWrite } from '@/lib/pending-app-writes';
import {
  invalidateQuery,
  RESUME_RAIL_QUERY_KEY,
  titleWatchProgressQueryKey,
  TOTAL_WATCH_TIME_QUERY_KEY,
  WATCH_HISTORY_QUERY_KEY,
} from '@/lib/query-invalidation';
import { isLocalMediaId } from '@/lib/utils';

interface UsePlaybackProgressPersistenceArgs {
  mediaId?: string;
  mediaType?: string;
  title: string;
  poster?: string;
  backdrop?: string;
  absoluteSeason?: number;
  absoluteEpisode?: number;
  streamSeason?: number;
  streamEpisode?: number;
  isPlaying: boolean;
  observedPositionRef: RefObject<number | null>;
  durationRef: RefObject<number>;
  activeStreamLoadKey: string;
  stream: PlayerStreamSession;
}

export function usePlaybackProgressPersistence({
  mediaId,
  mediaType,
  title,
  poster,
  backdrop,
  absoluteSeason,
  absoluteEpisode,
  streamSeason,
  streamEpisode,
  isPlaying,
  observedPositionRef,
  durationRef,
  activeStreamLoadKey,
  stream,
}: UsePlaybackProgressPersistenceArgs) {
  const queryClient = useQueryClient();
  const {
    activeStreamSourceIdRef,
    activeStreamSourceNameRef,
    activeStreamFamilyRef,
    streamLookupIdRef,
    selectedStreamKeyRef,
  } = stream;
  const lastPlayingStateRef = useRef(isPlaying);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingSaveRef = useRef<{
    fingerprint: string;
    operation: Promise<void>;
    refreshRail: boolean;
  } | null>(null);
  const lastSavedFingerprintRef = useRef<string | null>(null);
  const completedRef = useRef(false);
  const lastPlaybackSnapshotRef = useRef<{
    position: number | null;
    completed: boolean;
    lastWatched: number;
  } | null>(null);
  const streamIdentityRef = useRef<
    Pick<WatchProgressSave, 'last_stream_key' | 'source_name' | 'source_id' | 'stream_family'>
  >({});

  useEffect(() => {
    completedRef.current = false;
    lastPlaybackSnapshotRef.current = null;
    // Outgoing lifecycle cleanup saves before the replacement load binds its identity.
    streamIdentityRef.current = {
      last_stream_key: selectedStreamKeyRef.current,
      source_name: activeStreamSourceNameRef.current,
      source_id: activeStreamSourceIdRef.current,
      stream_family: activeStreamFamilyRef.current,
    };
  }, [
    activeStreamLoadKey,
    selectedStreamKeyRef,
    activeStreamSourceNameRef,
    activeStreamSourceIdRef,
    activeStreamFamilyRef,
  ]);

  useEffect(() => {
    if (isPlaying) completedRef.current = false;
  }, [isPlaying]);

  // Returns the raw op so lifecycle callers (native close, updater, backup) observe a failed
  // final save; the queue swallows so saves serialize. Rust owns the stub gate/coalescing (should_skip_watch_progress_save).
  const persistProgress = useCallback(
    (skipUnchanged = false): Promise<void> => {
      const position = observedPositionRef.current;
      const completed = completedRef.current;
      if ((position === null && !completed) || !mediaType || !mediaId || isLocalMediaId(mediaId))
        return saveQueueRef.current;

      let playback = lastPlaybackSnapshotRef.current;
      if (!playback || playback.position !== position || playback.completed !== completed) {
        playback = { position, completed, lastWatched: Date.now() };
        lastPlaybackSnapshotRef.current = playback;
      }
      const payload: WatchProgressSave = {
        id: mediaId,
        type_: mediaType,
        season: absoluteSeason,
        episode: absoluteEpisode,
        absolute_season: absoluteSeason,
        absolute_episode: absoluteEpisode,
        stream_season: streamSeason,
        stream_episode: streamEpisode,
        position: position ?? 0,
        duration: durationRef.current,
        completed: completed || undefined,
        last_watched: playback.lastWatched,
        title,
        poster,
        backdrop,
        // URLs never persist; resume uses lookup/key/source identities.
        last_stream_lookup_id: streamLookupIdRef.current,
        ...streamIdentityRef.current,
      };

      // Epoch snapshot fences deletes: a remove/clear queued after this write must not
      // resurrect the row (the backend generation guard only covers in-flight saves).
      const enqueuedEpoch = getWatchProgressEpoch();
      // Excludes last_watched so overlapping exit saves share one op; a changed snapshot must still save.
      const fingerprint = JSON.stringify([
        stream.activeStreamUrl,
        enqueuedEpoch,
        { ...payload, last_watched: undefined },
      ]);
      if (skipUnchanged && lastSavedFingerprintRef.current === fingerprint) {
        return saveQueueRef.current;
      }
      if (pendingSaveRef.current?.fingerprint === fingerprint) {
        if (!skipUnchanged) pendingSaveRef.current.refreshRail = true;
        return pendingSaveRef.current.operation;
      }
      const operation = saveQueueRef.current.then(async () => {
        if (getWatchProgressEpoch() !== enqueuedEpoch) return;
        await api.saveWatchProgress(payload);
        // Cancel pre-save reads. Periodic saves restart only first-load observers; lifecycle
        // saves (pause, exit) also refresh mounted views such as details under the mini player.
        const queryKey = titleWatchProgressQueryKey(payload.id);
        await queryClient.cancelQueries({ queryKey });
        await queryClient.invalidateQueries({
          queryKey,
          refetchType: 'none',
        });
        void queryClient.refetchQueries({
          queryKey,
          type: 'active',
          predicate: (query) => pendingSave.refreshRail || query.state.data === undefined,
        });
        lastSavedFingerprintRef.current = fingerprint;
        clearPendingSave();
        if (pendingSave.refreshRail) {
          void invalidateQuery(queryClient, [RESUME_RAIL_QUERY_KEY]);
          // A docked player outlives Profile's History view; exact skips the recommendation seed.
          void queryClient.invalidateQueries({ queryKey: WATCH_HISTORY_QUERY_KEY, exact: true });
          void queryClient.invalidateQueries({ queryKey: TOTAL_WATCH_TIME_QUERY_KEY });
        }
      });
      const pendingSave = { fingerprint, operation, refreshRail: !skipUnchanged };
      pendingSaveRef.current = pendingSave;
      const clearPendingSave = () => {
        if (pendingSaveRef.current?.operation === operation) pendingSaveRef.current = null;
      };
      void operation.then(clearPendingSave, clearPendingSave);
      saveQueueRef.current = operation.catch(() => {
        if (import.meta.env.DEV) console.warn('[player] watch progress persist failed');
      });
      // Global tracking covers the op after player unmount — the hook flusher only runs while registered.
      return trackPendingAppWrite(operation);
    },
    [
      mediaType,
      mediaId,
      absoluteSeason,
      absoluteEpisode,
      streamSeason,
      streamEpisode,
      observedPositionRef,
      durationRef,
      title,
      poster,
      backdrop,
      streamLookupIdRef,
      queryClient,
      stream.activeStreamUrl,
    ],
  );

  // Never rejects, so every fire-and-forget trigger keeps its old contract.
  const saveProgress = useCallback(
    (intent?: Pick<WatchProgressSave, 'completed'>) => {
      if (intent?.completed !== undefined) {
        completedRef.current = intent.completed;
        if (!intent.completed) return saveQueueRef.current;
      }
      return persistProgress().catch(() => undefined);
    },
    [persistProgress],
  );

  // Strict flush: close/update/backup sees the raw op; fire-and-forget callers stay swallowing.
  useEffect(() => registerPendingAppWriteFlusher(persistProgress), [persistProgress]);

  useEffect(() => {
    if (!isPlaying) return;
    // Stalled ticks do not need another IPC save.
    const interval = window.setInterval(() => {
      void persistProgress(true).catch(() => undefined);
    }, 15_000);

    return () => {
      window.clearInterval(interval);
    };
  }, [isPlaying, persistProgress]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        void saveProgress();
      }
    };
    const handlePageHide = () => {
      void saveProgress();
    };

    window.addEventListener('beforeunload', handlePageHide);
    window.addEventListener('pagehide', handlePageHide);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('beforeunload', handlePageHide);
      window.removeEventListener('pagehide', handlePageHide);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [saveProgress]);

  useEffect(() => {
    const wasPlaying = lastPlayingStateRef.current;
    lastPlayingStateRef.current = isPlaying;

    if (wasPlaying && !isPlaying) {
      void saveProgress();
    }
  }, [saveProgress, isPlaying]);

  // Exit flushes live in the session boundary — an unmount effect here would re-fire on every identity change.
  return {
    saveProgress,
  };
}
