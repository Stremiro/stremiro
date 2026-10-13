import { type RefObject, useEffect, useEffectEvent } from 'react';

import { isEditableTarget, OPEN_DIALOG_SELECTOR, RADIX_POPPER_CONTENT_SELECTOR } from '@/lib/dom';

const PLAYER_SHORTCUT_CONTROL_SELECTOR =
  'button, a, [role="button"], [role="menu"], [role="menuitem"], [data-player-interactive]';

// Discrete actions ignore auto-repeat (arrows/volume/speed etc. keep ramping).
// Digits are one-shot percent seeks — a held digit would storm identical seeks.
const NON_REPEAT_KEYS = new Set([
  ' ',
  'k',
  'f',
  'm',
  'n',
  'c',
  'e',
  'i',
  's',
  'a',
  'q',
  '?',
  '\\',
  'enter',
  'escape',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
]);

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
  /** `a` — cycle the audio track (mpv's convention); OSD names the landing track. */
  cycleAudioTrack: () => Promise<void>;
  cycleSubtitles: () => Promise<void>;
  durationRef: RefObject<number>;
  frameStep: (direction: 1 | -1) => Promise<void>;
  /** Arrow-up/down volume steps — reads the live volume ref internally. */
  stepVolume: (delta: number) => Promise<void>;
  hasEpisodes: boolean;
  isExpanded: boolean;
  isFullscreen: boolean;
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
  /** Active skip-segment/intro CTA — `S`/`Enter` trigger its `onSkip`. */
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
    frameStep,
    stepVolume,
    hasEpisodes,
    isExpanded,
    isFullscreen,
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

    if (e.repeat && NON_REPEAT_KEYS.has(normalizedKey)) {
      e.preventDefault();
      return;
    }

    // Escape works even with focus inside panels; Radix popper layers own theirs.
    if (normalizedKey === 'escape') {
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
        e.preventDefault();
        void toggleFullscreen().catch(() => undefined);
        return;
      }
      // Nothing left to close: Esc is player-level Back.
      e.preventDefault();
      void navigateBack().catch(() => undefined);
      return;
    }

    // `e` must also close the panel from inside, so it intercepts ahead of the open gate.
    if (normalizedKey === 'e' && hasEpisodes && !showStreamSelector && !showShortcuts) {
      e.preventDefault();
      toggleEpisodes();
      return;
    }

    // `?` toggles help — closes from anywhere, never opens over the modal selector.
    if (normalizedKey === '?' && !showStreamSelector) {
      e.preventDefault();
      toggleShortcuts();
      return;
    }

    // Choosing a stream or reading help takes input priority.
    if (showStreamSelector || showEpisodes || showShortcuts) {
      return;
    }

    // 0–9: percent seeks, matching mpv/YouTube convention.
    if (/^[0-9]$/.test(normalizedKey) && durationRef.current > 0) {
      e.preventDefault();
      void seek((durationRef.current * Number(normalizedKey)) / 10).catch(() => undefined);
      return;
    }

    switch (normalizedKey) {
      case ' ':
      case 'k':
        e.preventDefault();
        void togglePlay().catch(() => undefined);
        break;
      // Shift halves the step for fine scrubbing, matching Shift+wheel.
      case 'arrowright':
      case 'l':
        e.preventDefault();
        void seekRelative(e.shiftKey ? 5 : 10).catch(() => undefined);
        break;
      case 'arrowleft':
      case 'j':
        e.preventDefault();
        void seekRelative(e.shiftKey ? -5 : -10).catch(() => undefined);
        break;
      case 'arrowup':
        e.preventDefault();
        void stepVolume(5).catch(() => undefined);
        break;
      case 'arrowdown':
        e.preventDefault();
        void stepVolume(-5).catch(() => undefined);
        break;
      case 'f':
        e.preventDefault();
        void toggleFullscreen().catch(() => undefined);
        break;
      case 'm':
        e.preventDefault();
        void toggleMute().catch(() => undefined);
        break;
      case 'n':
        e.preventDefault();
        playNextEpisode();
        break;
      case 'c':
        e.preventDefault();
        void cycleSubtitles().catch(() => undefined);
        break;
      case 'a':
        e.preventDefault();
        void cycleAudioTrack().catch(() => undefined);
        break;
      case 'q':
        if (openStreamSelector) {
          e.preventDefault();
          openStreamSelector();
        }
        break;
      case 'i':
        // Dock to the mini player — same destination as Back on a healthy session.
        e.preventDefault();
        void navigateBack().catch(() => undefined);
        break;
      case '.':
        e.preventDefault();
        void frameStep(1).catch(() => undefined);
        break;
      case ',':
        e.preventDefault();
        void frameStep(-1).catch(() => undefined);
        break;
      case '[':
        e.preventDefault();
        stepSpeed(-1);
        break;
      case ']':
        e.preventDefault();
        stepSpeed(1);
        break;
      case '\\':
        e.preventDefault();
        resetSpeed();
        break;
      case 'z':
        e.preventDefault();
        nudgeSubtitleDelay(-1);
        break;
      case 'x':
        e.preventDefault();
        nudgeSubtitleDelay(1);
        break;
      case 's':
      case 'enter':
        // Only hijack Enter while a segment is active — otherwise a focused surface keeps native behavior.
        if (skipAction) {
          e.preventDefault();
          skipAction.onSkip();
        }
        break;
    }
  });

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // Effect event — listener binds once for the player's lifetime.
  }, []);
}
