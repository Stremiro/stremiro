// Player-surface DOM utilities: interactive-region hit-testing plus the
// document-level cursor/background mutations the player applies while
// expanded. Kept in lib so the page component stays declarative.

import type { MouseEvent } from 'react';

import { RADIX_POPPER_CONTENT_SELECTOR } from '@/lib/dom';

const PLAYER_INTERACTIVE_TARGET_SELECTOR = `[data-player-interactive], ${RADIX_POPPER_CONTENT_SELECTOR}`;

export function isPlayerInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest(PLAYER_INTERACTIVE_TARGET_SELECTOR);
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

// body, documentElement, and #root all need the color — a partial write
// leaves the page background bleeding through mpv's transparent frame.
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
