// Player-surface DOM utilities: hit-testing plus document-level cursor/background mutations while expanded.

import type { MouseEvent } from 'react';

import { RADIX_POPPER_CONTENT_SELECTOR } from '@/lib/dom';

const PLAYER_INTERACTIVE_TARGET_SELECTOR = `[data-player-interactive], ${RADIX_POPPER_CONTENT_SELECTOR}`;

export function createWheelSeekAccumulator() {
  let accumulatedPixels = 0;
  let lastEventAt = 0;
  return ({ deltaY, deltaMode }: Pick<WheelEvent, 'deltaY' | 'deltaMode'>): number => {
    if (deltaY === 0) return 0;
    const now = performance.now();
    if (now - lastEventAt > 200 || Math.sign(deltaY) !== Math.sign(accumulatedPixels)) {
      accumulatedPixels = 0;
    }
    lastEventAt = now;
    accumulatedPixels += deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? window.innerHeight : 1);
    const steps = Math.trunc(accumulatedPixels / 100);
    accumulatedPixels -= steps * 100;
    return -steps * 5;
  };
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

// All three need the color — a partial write leaves the page background bleeding through mpv's transparent frame.
function setSurfaceBackground(value: string): void {
  document.body.style.backgroundColor = value;
  document.documentElement.style.backgroundColor = value;
  const root = document.getElementById('root');
  if (root) root.style.backgroundColor = value;
}

export function setPlayerDocumentBackground(transparent: boolean): void {
  setSurfaceBackground(transparent ? 'transparent' : 'black');
}

export function restorePlayerBackground(): void {
  setSurfaceBackground('');
}

export function restorePlayerCursor(container: HTMLElement | null): void {
  if (container) container.style.cursor = '';
  document.body.style.cursor = '';
  document.documentElement.style.cursor = '';
}
