import { type RefObject, useCallback, useEffect, useRef } from 'react';
import type { PlayerStreamSession } from '@/hooks/use-player-stream-session';
import { api, type WatchProgress } from '@/lib/api';
import { getWatchProgressEpoch } from '@/lib/api-cache';
import { registerPendingAppWriteFlusher, trackPendingAppWrite } from '@/lib/pending-app-writes';
import type { PlaybackClock } from '@/lib/player-clock';

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
  clock: PlaybackClock;
  durationRef: RefObject<number>;
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
  clock,
  durationRef,
  stream,
}: UsePlaybackProgressPersistenceArgs) {
  const {
    activeStreamFormatRef,
    activeStreamSourceIdRef,
    activeStreamSourceNameRef,
    activeStreamFamilyRef,
    streamLookupIdRef,
    selectedStreamKeyRef,
  } = stream;
  const lastPlayingStateRef = useRef(isPlaying);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const currentTimeRef = clock.ref;

  const buildWatchProgressPayload = useCallback((): WatchProgress | null => {
    if (!mediaType || !mediaId || mediaId === 'local') return null;

    return {
      id: mediaId,
      type_: mediaType,
      season: absoluteSeason,
      episode: absoluteEpisode,
      absolute_season: absoluteSeason,
      absolute_episode: absoluteEpisode,
      stream_season: streamSeason,
      stream_episode: streamEpisode,
      position: currentTimeRef.current,
      duration: durationRef.current,
      last_watched: Date.now(),
      title: title || 'Unknown',
      poster,
      backdrop,
      // URLs never persist; resume uses lookup/key/source identities.
      last_stream_format: activeStreamFormatRef.current,
      last_stream_lookup_id: streamLookupIdRef.current,
      last_stream_key: selectedStreamKeyRef.current,
      source_name: activeStreamSourceNameRef.current,
      source_id: activeStreamSourceIdRef.current,
      stream_family: activeStreamFamilyRef.current,
    };
  }, [
    mediaType,
    mediaId,
    absoluteSeason,
    absoluteEpisode,
    streamSeason,
    streamEpisode,
    currentTimeRef,
    durationRef,
    title,
    poster,
    backdrop,
    activeStreamFormatRef,
    activeStreamSourceIdRef,
    activeStreamSourceNameRef,
    activeStreamFamilyRef,
    streamLookupIdRef,
    selectedStreamKeyRef,
  ]);

  // Returns the raw chained operation so lifecycle callers (native close,
  // updater install, backup) can observe a failed final save; the queue
  // itself still swallows so later saves keep serializing. The backend owns
  // the startup-stub gate and write coalescing (`should_skip_watch_progress_save`).
  const persistProgress = useCallback((): Promise<void> => {
    const payload = buildWatchProgressPayload();
    // Nothing to write — still hand back the tail so a close waits on
    // whatever an earlier trigger already queued.
    if (!payload) return saveQueueRef.current;

    // The epoch snapshot fences deletes: a remove/clear issued while this
    // write is queued must not let it resurrect the row — the backend
    // generation guard only covers saves already in flight.
    const enqueuedEpoch = getWatchProgressEpoch();
    const operation = saveQueueRef.current.then(async () => {
      if (getWatchProgressEpoch() !== enqueuedEpoch) return;
      await api.saveWatchProgress(payload);
    });
    saveQueueRef.current = operation.catch(() => {
      if (import.meta.env.DEV) console.warn('[player] watch progress persist failed');
    });
    // Global tracking covers this final operation after the player unmounts:
    // the hook's own flusher only runs while it is still registered.
    return trackPendingAppWrite(operation);
  }, [buildWatchProgressPayload]);

  // Never rejects, so every fire-and-forget trigger keeps its old contract.
  const saveProgress = useCallback(
    () => persistProgress().catch(() => undefined),
    [persistProgress],
  );

  // Register the strict flush: a close/update/backup sees the raw
  // operation, while the fire-and-forget callers above stay swallowing.
  useEffect(() => registerPendingAppWriteFlusher(persistProgress), [persistProgress]);

  useEffect(() => {
    if (!isPlaying) return;
    // A playing tick moves the position well past Rust's coalescing delta,
    // so every interval save lands; stalled ticks coalesce in Rust.
    const interval = window.setInterval(() => {
      void saveProgress();
    }, 15_000);

    return () => {
      window.clearInterval(interval);
    };
  }, [isPlaying, saveProgress]);

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

  // Exit flushes are owned by the session boundary (reads the latest save via
  // ref) — an unmount effect here would re-fire on every identity change.
  return {
    saveProgress,
  };
}
