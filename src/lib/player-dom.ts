// Player-surface DOM utilities: hit-testing plus document-level background mutations while expanded.

import type { MouseEvent } from 'react';

import { RADIX_POPPER_CONTENT_SELECTOR } from '@/lib/dom';

const PLAYER_INTERACTIVE_TARGET_SELECTOR = `[data-player-interactive], ${RADIX_POPPER_CONTENT_SELECTOR}`;

/** Wheel delta in pixels: line mode scales by `linePx`, page mode by `pagePx`. */
export function wheelDeltaPixels(
  { deltaY, deltaMode }: Pick<WheelEvent, 'deltaY' | 'deltaMode'>,
  linePx: number,
  pagePx: number,
): number {
  return deltaY * (deltaMode === 1 ? linePx : deltaMode === 2 ? pagePx : 1);
}

/** Accumulates wheel pixels into discrete steps; sign flips and stale bursts reset the count. */
export function createWheelStepAccumulator({
  windowMs,
  pxPerStep,
}: {
  windowMs: number;
  pxPerStep: number;
}) {
  let accumulatedPixels = 0;
  let lastEventAt = 0;
  return {
    add(pixels: number): number {
      if (pixels === 0) return 0;
      const now = performance.now();
      if (now - lastEventAt > windowMs || Math.sign(pixels) !== Math.sign(accumulatedPixels)) {
        accumulatedPixels = 0;
      }
      lastEventAt = now;
      accumulatedPixels += pixels;
      const steps = Math.trunc(accumulatedPixels / pxPerStep);
      accumulatedPixels -= steps * pxPerStep;
      return steps;
    },
    reset() {
      accumulatedPixels = 0;
    },
  };
}

export function createWheelSeekAccumulator() {
  const accumulator = createWheelStepAccumulator({ windowMs: 200, pxPerStep: 100 });
  return (event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>): number =>
    -accumulator.add(wheelDeltaPixels(event, 16, window.innerHeight)) * 5;
}

export function isPlayerInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(PLAYER_INTERACTIVE_TARGET_SELECTOR);
}

export function shouldIgnorePlayerSurfaceInteraction(event: MouseEvent<HTMLElement>): boolean {
  return (
    !event.currentTarget.contains(event.target as Node) || isPlayerInteractiveTarget(event.target)
  );
}

export function blurActivePlayerControl(): void {
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement) {
    activeElement.blur();
  }
}

export function hasOpenPlayerPopover(): boolean {
  return document.querySelector('[data-player-popover][data-state="open"]') !== null;
}

export function preserveOpenPlayerMenuFocus(event: Event): void {
  if (hasOpenPlayerPopover()) event.preventDefault();
}

// All three need the color — a partial write leaves the page background bleeding through mpv's transparent frame.
function setSurfaceBackground(value: string): void {
  document.body.style.backgroundColor = value;
  document.documentElement.style.backgroundColor = value;
  const root = document.getElementById('root');
  if (root) root.style.backgroundColor = value;
}

export function setPlayerDocumentBackground(transparent: boolean): void {
  document.getElementById('root')?.classList.remove('player-background-restoring');
  setSurfaceBackground(transparent ? 'transparent' : 'black');
}

export function restorePlayerBackground(): void {
  document.getElementById('root')?.classList.add('player-background-restoring');
  setSurfaceBackground('');
}
