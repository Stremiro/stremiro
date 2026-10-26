import { useEffect, useEffectEvent } from 'react';

import type { PlaybackClock } from '@/lib/player-clock';
import { clamp } from '@/lib/utils';

const DEFAULT_SEEK_OFFSET_SECS = 10;
const POSITION_PUBLISH_INTERVAL_MS = 1_000;

interface UseMediaSessionOptions {
  /** No metadata is published until a stream exists (empty string keeps it off). */
  title: string;
  /** Subtitle line — season/episode label for series playback. */
  artist?: string;
  artworkSrcs?: readonly (string | undefined)[];
  duration: number;
  isPlaying: boolean;
  playbackSpeed: number;
  /** Browsers extrapolate between coarse position updates. */
  clock: PlaybackClock;
  onPlay: () => void;
  onPause: () => void;
  onPreviousTrack: () => void;
  onNextTrack?: () => void;
  onSeekTo: (seconds: number) => void;
  onSeekBy: (seconds: number) => void;
}

/** OS media controls remain active while playback is docked. */
export function useMediaSession({
  title,
  artist,
  artworkSrcs,
  duration,
  isPlaying,
  playbackSpeed,
  clock,
  onPlay,
  onPause,
  onPreviousTrack,
  onNextTrack,
  onSeekTo,
  onSeekBy,
}: UseMediaSessionOptions) {
  const supported = typeof navigator !== 'undefined' && 'mediaSession' in navigator;
  // Leave Next unbound when there is no next episode.
  const hasNextTrack = onNextTrack !== undefined;
  const artworkKey = JSON.stringify(artworkSrcs ?? []);

  useEffect(() => {
    if (!supported || typeof MediaMetadata === 'undefined' || !title) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist: artist ?? '',
      album: 'Stremiro',
      artwork: (JSON.parse(artworkKey) as (string | null)[])
        .filter((src): src is string => !!src)
        .map((src) => ({ src })),
    });
    return () => {
      navigator.mediaSession.metadata = null;
    };
  }, [supported, title, artist, artworkKey]);

  useEffect(() => {
    if (!supported) return;
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  }, [supported, isPlaying]);

  useEffect(() => {
    if (!supported) return;
    return () => {
      navigator.mediaSession.playbackState = 'none';
      if (typeof navigator.mediaSession.setPositionState !== 'function') return;
      try {
        navigator.mediaSession.setPositionState();
      } catch {
        // Some WebView builds expose an unsupported position API.
      }
    };
  }, [supported]);

  // Stable action handlers read the latest callbacks.
  const getActionHandlers = useEffectEvent(() => ({
    play: () => onPlay(),
    pause: () => onPause(),
    previoustrack: () => onPreviousTrack(),
    nexttrack: () => onNextTrack?.(),
    seekto: (details: MediaSessionActionDetails) => {
      if (details.seekTime !== undefined) onSeekTo(details.seekTime);
    },
    seekbackward: (details: MediaSessionActionDetails) =>
      onSeekBy(-(details.seekOffset ?? DEFAULT_SEEK_OFFSET_SECS)),
    seekforward: (details: MediaSessionActionDetails) =>
      onSeekBy(details.seekOffset ?? DEFAULT_SEEK_OFFSET_SECS),
  }));

  useEffect(() => {
    if (!supported) return;
    const actions = Object.keys(getActionHandlers()) as (keyof ReturnType<
      typeof getActionHandlers
    >)[];
    for (const action of actions) {
      if (action === 'nexttrack' && !hasNextTrack) continue;
      try {
        navigator.mediaSession.setActionHandler(action, (details) =>
          getActionHandlers()[action](details),
        );
      } catch {
        // Individual actions can be unsupported — skip, keep the rest.
      }
    }
    return () => {
      for (const action of actions) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {
          // Clearing an unsupported action can throw — nothing to clean up.
        }
      }
    };
  }, [supported, hasNextTrack]);

  useEffect(() => {
    if (!supported || typeof navigator.mediaSession.setPositionState !== 'function') return;
    if (!title || !Number.isFinite(duration) || duration <= 0) {
      try {
        navigator.mediaSession.setPositionState();
      } catch {
        // Some WebView builds expose an unsupported position API.
      }
      return;
    }
    let lastPosition: number | null = null;
    let lastPublishedAt = 0;
    const publishPosition = () => {
      const position = clamp(clock.ref.current, 0, duration);
      if (!Number.isFinite(position)) return;
      const now = performance.now();
      const elapsed = now - lastPublishedAt;
      const expectedPosition =
        lastPosition === null
          ? position
          : clamp(lastPosition + (isPlaying ? (elapsed / 1000) * playbackSpeed : 0), 0, duration);
      if (
        lastPosition !== null &&
        elapsed < POSITION_PUBLISH_INTERVAL_MS &&
        Math.abs(position - expectedPosition) < 0.5
      )
        return;
      try {
        navigator.mediaSession.setPositionState({
          duration,
          position,
          playbackRate: playbackSpeed,
        });
        lastPosition = position;
        lastPublishedAt = now;
      } catch {
        // Retry on the next clock tick if the native API rejected the update.
      }
    };
    publishPosition();
    return clock.subscribe(publishPosition);
  }, [supported, clock, duration, playbackSpeed, isPlaying, title]);
}
