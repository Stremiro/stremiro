import { type RefObject, useEffect, useEffectEvent } from 'react';

import { isEditableTarget, OPEN_DIALOG_SELECTOR, RADIX_POPPER_CONTENT_SELECTOR } from '@/lib/dom';
import { isRepeatablePlayerAction, type PlayerKeymap } from '@/lib/player-keybindings';

const PLAYER_SHORTCUT_CONTROL_SELECTOR =
  'button, a, [role="button"], [role="menu"], [role="menuitem"], [data-player-interactive]';

// A focused control owns only its activation keys; everything else stays a media hotkey. Sliders self-consume theirs.
function shouldIgnorePlayerHotkeyTarget(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  // Text inputs and mounted popper layers own every key, not just theirs.
  if (isEditableTarget(target, RADIX_POPPER_CONTENT_SELECTOR)) {
    return true;
  }

  if (target.closest('[role="slider"]')) {
    return false;
  }

  const control = target.closest(PLAYER_SHORTCUT_CONTROL_SELECTOR);
  if (!control) {
    return false;
  }

  return key === ' ' || key === 'enter';
}

interface UsePlayerHotkeysOptions {
  closeEpisodesPanel: () => void;
  closeStreamSelector: () => void;
  /** Cycle the audio track (mpv's convention); OSD names the landing track. */
  cycleAudioTrack: () => Promise<void>;
  cycleSubtitles: () => Promise<void>;
  durationRef: RefObject<number>;
  /** Volume steps — reads the live volume ref internally. */
  stepVolume: (delta: number) => Promise<void>;
  hasEpisodes: boolean;
  isExpanded: boolean;
  isFullscreen: boolean;
  keymap: PlayerKeymap;
  mountedRef: RefObject<boolean>;
  navigateBack: () => Promise<void>;
  nudgeSubtitleDelay: (direction: 1 | -1) => void;
  openStreamSelector: (() => void) | null;
  playNextEpisode: () => void;
  seek: (seconds: number) => Promise<void>;
  seekRelative: (seconds: number) => Promise<void>;
  showEpisodes: boolean;
  showShortcuts: boolean;
  showStreamSelector: boolean;
  /** Active skip-segment/intro CTA — the skip binding triggers its `onSkip`. */
  skipAction: { onSkip: () => void } | null;
  stepSpeed: (direction: 1 | -1) => void;
  resetSpeed: () => void;
  closeShortcuts: () => void;
  toggleEpisodes: () => void;
  toggleShortcuts: () => void;
  toggleFullscreen: () => Promise<void>;
  toggleMute: () => Promise<void>;
  togglePlay: () => Promise<void>;
}

export function usePlayerHotkeys(options: UsePlayerHotkeysOptions) {
  const {
    closeEpisodesPanel,
    closeStreamSelector,
    cycleAudioTrack,
    cycleSubtitles,
    durationRef,
    stepVolume,
    hasEpisodes,
    isExpanded,
    isFullscreen,
    keymap,
    mountedRef,
    navigateBack,
    nudgeSubtitleDelay,
    openStreamSelector,
    playNextEpisode,
    seek,
    seekRelative,
    showEpisodes,
    showShortcuts,
    showStreamSelector,
    skipAction,
    stepSpeed,
    resetSpeed,
    closeShortcuts,
    toggleEpisodes,
    toggleShortcuts,
    toggleFullscreen,
    toggleMute,
    togglePlay,
  } = options;

  // Effect event: one permanent listener reading latest options.
  const handleKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (!mountedRef.current) return;
    // Docked: the page owns keys — space/arrows must not control video.
    if (!isExpanded) return;
    if (document.querySelector(OPEN_DIALOG_SELECTOR)) return;
    // Child-handled keys, IME composition, and modifier chords are never
    // media shortcuts.
    if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return;

    const normalizedKey = e.key.toLowerCase();

    // Check ownership before suppressing repeats — typing keys and control activation keys belong to controls.
    if (normalizedKey === 'escape') {
      if (e.target instanceof HTMLElement && e.target.closest(RADIX_POPPER_CONTENT_SELECTOR)) {
        return;
      }
    } else if (shouldIgnorePlayerHotkeyTarget(e.target, normalizedKey)) {
      return;
    }

    const action = keymap.byKey.get(normalizedKey);
    const isDigit = /^[0-9]$/.test(normalizedKey);

    // Discrete actions ignore auto-repeat (seek/volume/speed etc. keep ramping).
    // Digits are one-shot percent seeks — a held digit would storm identical seeks.
    if (
      e.repeat &&
      (normalizedKey === 'escape' || isDigit || (action && !isRepeatablePlayerAction(action)))
    ) {
      e.preventDefault();
      return;
    }

    // Escape works even with focus inside panels; Radix popper layers own theirs.
    if (normalizedKey === 'escape') {
      e.preventDefault();
      // Topmost first: shortcuts overlay, then selector, episodes, fullscreen, then Back.
      if (showShortcuts) {
        closeShortcuts();
        return;
      }
      if (showStreamSelector) {
        closeStreamSelector();
        return;
      }
      if (showEpisodes) {
        closeEpisodesPanel();
        return;
      }
      if (isFullscreen) {
        void toggleFullscreen().catch(() => undefined);
        return;
      }
      // Nothing left to close: Esc is player-level Back.
      void navigateBack().catch(() => undefined);
      return;
    }

    // The episodes key must also close the panel from inside, so it intercepts ahead of the open gate.
    if (action === 'episodes' && hasEpisodes && !showStreamSelector && !showShortcuts) {
      e.preventDefault();
      toggleEpisodes();
      return;
    }

    // Help closes from anywhere, never opens over the modal selector.
    if (action === 'shortcuts' && !showStreamSelector) {
      e.preventDefault();
      toggleShortcuts();
      return;
    }

    // Choosing a stream or reading help takes input priority.
    if (showStreamSelector || showEpisodes || showShortcuts) {
      return;
    }

    // 0–9: percent seeks, matching mpv/YouTube convention.
    if (isDigit && durationRef.current > 0) {
      e.preventDefault();
      void seek((durationRef.current * Number(normalizedKey)) / 10).catch(() => undefined);
      return;
    }

    if (!action) return;
    // Shift halves the seek step for fine scrubbing, matching Shift+wheel.
    const seekStep = e.shiftKey ? 5 : 10;
    const run = (effect: () => unknown) => {
      e.preventDefault();
      effect();
    };

    switch (action) {
      case 'togglePlay':
        return run(() => void togglePlay().catch(() => undefined));
      case 'seekForward':
        return run(() => void seekRelative(seekStep).catch(() => undefined));
      case 'seekBackward':
        return run(() => void seekRelative(-seekStep).catch(() => undefined));
      case 'volumeUp':
        return run(() => void stepVolume(5).catch(() => undefined));
      case 'volumeDown':
        return run(() => void stepVolume(-5).catch(() => undefined));
      case 'toggleFullscreen':
        return run(() => void toggleFullscreen().catch(() => undefined));
      case 'toggleMute':
        return run(() => void toggleMute().catch(() => undefined));
      case 'nextEpisode':
        return run(playNextEpisode);
      case 'cycleSubtitles':
        return run(() => void cycleSubtitles().catch(() => undefined));
      case 'cycleAudio':
        return run(() => void cycleAudioTrack().catch(() => undefined));
      case 'streamSelector':
        if (openStreamSelector) run(openStreamSelector);
        return;
      case 'dock':
        // Dock to the mini player — same destination as Back on a healthy session.
        return run(() => void navigateBack().catch(() => undefined));
      case 'speedDown':
        return run(() => stepSpeed(-1));
      case 'speedUp':
        return run(() => stepSpeed(1));
      case 'speedReset':
        return run(resetSpeed);
      case 'subtitleEarlier':
        return run(() => nudgeSubtitleDelay(-1));
      case 'subtitleLater':
        return run(() => nudgeSubtitleDelay(1));
      case 'skipSegment':
        // Only hijack the key while a segment is active — otherwise a focused surface keeps native behavior.
        if (skipAction) run(skipAction.onSkip);
        return;
      case 'episodes':
      case 'shortcuts':
        return;
    }
  });

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // Effect event — listener binds once for the player's lifetime.
  }, []);
}
