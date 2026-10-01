import { type RefObject, useCallback, useEffect, useRef } from 'react';
import type { PlayerStreamSession } from '@/hooks/use-player-stream-session';
import { api, type WatchProgress } from '@/lib/api';
import { getWatchProgressEpoch } from '@/lib/api-cache';
import { MIN_RESUME_POSITION_SECS } from '@/lib/history-playback';
import { registerPendingAppWriteFlusher, trackPendingAppWrite } from '@/lib/pending-app-writes';
import type { PlaybackClock } from '@/lib/player-clock';

const NEAR_COMPLETION_MIN_DURATION_SECS = 60;
const NEAR_COMPLETION_REMAINING_SECS = 30;
const NEAR_COMPLETION_PROGRESS_RATIO = 0.97;

function buildWatchProgressFingerprint(progress: WatchProgress): string {
  // Identity plus 1s-rounded position only: URLs never persist; title/artwork
  // must not force writes.
  return JSON.stringify([
    progress.id,
    progress.type_,
    progress.absolute_season ?? '',
    progress.absolute_episode ?? '',
    progress.stream_season ?? '',
    progress.stream_episode ?? '',
    progress.last_stream_format ?? '',
    progress.last_stream_lookup_id ?? '',
    progress.last_stream_key ?? '',
    progress.source_id ?? '',
    progress.source_name ?? '',
    progress.stream_family ?? '',
    Math.round(progress.position),
    Math.round(progress.duration),
  ]);
}

function hasPersistableProgress(currentTime: number): boolean {
  return Number.isFinite(currentTime) && currentTime >= MIN_RESUME_POSITION_SECS;
}

function shouldFlushNearCompletion(currentTime: number, duration: number): boolean {
  if (!Number.isFinite(currentTime) || !Number.isFinite(duration)) return false;
  if (duration < NEAR_COMPLETION_MIN_DURATION_SECS || currentTime <= 0) return false;

  const remaining = Math.max(0, duration - currentTime);
  const progressRatio = currentTime / duration;

  return (
    remaining <= NEAR_COMPLETION_REMAINING_SECS || progressRatio >= NEAR_COMPLETION_PROGRESS_RATIO
  );
}

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
  duration: number;
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
  duration,
  clock,
  durationRef,
  stream,
}: UsePlaybackProgressPersistenceArgs) {
  const {
    activeStreamUrl,
    activeStreamFormatRef,
    activeStreamSourceIdRef,
    activeStreamSourceNameRef,
    activeStreamFamilyRef,
    streamLookupIdRef,
    selectedStreamKeyRef,
  } = stream;
  const lastPlayingStateRef = useRef(isPlaying);
  const nearCompletionSavedRef = useRef(false);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const lastPersistedFingerprintRef = useRef<string | null>(null);
  const currentTimeRef = clock.ref;

  const buildWatchProgressPayload = useCallback((): WatchProgress | null => {
    if (!mediaType || !mediaId || mediaId === 'local') return null;
    // Drop startup stubs so continue-watching never regresses to ~0.
    if (!hasPersistableProgress(currentTimeRef.current)) return null;

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
  // write coalescing (`should_skip_watch_progress_save`).
  const persistProgress = useCallback((): Promise<void> => {
    const payload = buildWatchProgressPayload();
    // Nothing new to write — still hand back the tail so a close waits on
    // whatever an earlier trigger already queued.
    if (!payload) return saveQueueRef.current;

    const fingerprint = buildWatchProgressFingerprint(payload);
    // The queue serializes saves, so the fingerprint check inside it drops the
    // duplicates overlapping triggers (pause, exit, stream swap) enqueue. The
    // epoch snapshot fences deletes: a remove/clear issued while this write is
    // queued must not let it resurrect the row — the backend generation guard
    // only covers saves already in flight.
    const enqueuedEpoch = getWatchProgressEpoch();
    const operation = saveQueueRef.current.then(async () => {
      if (getWatchProgressEpoch() !== enqueuedEpoch) return;
      if (lastPersistedFingerprintRef.current === fingerprint) return;
      await api.saveWatchProgress(payload);
      lastPersistedFingerprintRef.current = fingerprint;
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
    // 15s matches the backend coalescing window.
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

  useEffect(() => {
    nearCompletionSavedRef.current = false;
  }, [activeStreamUrl, mediaId, absoluteSeason, absoluteEpisode]);

  useEffect(() => {
    if (!isPlaying || nearCompletionSavedRef.current) return;
    // Subscribed to the clock instead of per-tick props: the check runs on
    // each published position without re-rendering the player tree.
    const flushIfNearCompletion = () => {
      if (nearCompletionSavedRef.current) return;
      if (!shouldFlushNearCompletion(clock.getSnapshot(), duration)) return;

      nearCompletionSavedRef.current = true;
      void saveProgress();
    };
    flushIfNearCompletion();
    return clock.subscribe(flushIfNearCompletion);
  }, [clock, duration, saveProgress, isPlaying]);

  // Exit flushes are owned by the session boundary (reads the latest save via
  // ref) — an unmount effect here would re-fire on every identity change.
  return {
    saveProgress,
  };
}
