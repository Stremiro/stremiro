import { X } from 'lucide-react';
import { memo, useEffect, useRef } from 'react';
import { CHROME_CLOSE_BUTTON_CLASS, CHROME_ICON_STROKE } from '@/components/player-chrome-styles';
import { ShortcutTable } from '@/components/shortcut-table';
import { buildPlayerShortcutRows, type PlayerKeymap } from '@/lib/player-keybindings';

interface PlayerShortcutsOverlayProps {
  keymap: PlayerKeymap;
  onClose: () => void;
}

// The shortcuts binding toggles this from the hotkey layer; the Escape chain in
// usePlayerHotkeys closes it before panels, fullscreen, or back-nav.
export const PlayerShortcutsOverlay = memo(function PlayerShortcutsOverlay({
  keymap,
  onClose,
}: PlayerShortcutsOverlayProps) {
  const rows = buildPlayerShortcutRows(keymap);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  // `aria-modal` must be honest: grab focus on open so Tab starts inside the
  // dialog instead of reaching the chrome under it, and hand focus back to
  // whatever had it (the player chrome) when the overlay closes.
  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => previouslyFocused?.focus();
  }, []);

  return (
    <div
      data-player-interactive
      className='absolute inset-0 z-90 flex items-center justify-center px-6'
    >
      {/* Click-anywhere dismiss — the surface under it stays put. */}
      <button
        type='button'
        tabIndex={-1}
        aria-label='Close shortcuts'
        onClick={onClose}
        className='absolute inset-0 cursor-default bg-black/60 animate-in fade-in duration-200 motion-reduce:animate-none'
      />
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={dialogRef}
        role='dialog'
        aria-modal='true'
        aria-label='Keyboard shortcuts'
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          event.preventDefault();
          const target =
            document.activeElement === closeButtonRef.current ||
            (document.activeElement === dialogRef.current && event.shiftKey)
              ? viewportRef.current
              : closeButtonRef.current;
          target?.focus();
        }}
        className='relative flex min-h-0 max-h-[calc(100%-3rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-zinc-950/95 shadow-2xl shadow-black/70 animate-in fade-in zoom-in-95 duration-200 outline-hidden motion-reduce:animate-none'
      >
        <div className='flex shrink-0 items-center justify-between gap-3 border-b border-white/[0.07] px-5 pb-3 pt-4'>
          <h2 className='text-[15px] font-semibold tracking-tight text-white'>
            Keyboard shortcuts
          </h2>
          <button
            ref={closeButtonRef}
            type='button'
            onClick={onClose}
            aria-label='Close shortcuts'
            aria-keyshortcuts='Escape'
            title='Close (Esc)'
            className={CHROME_CLOSE_BUTTON_CLASS}
          >
            <X aria-hidden='true' className='h-4 w-4' strokeWidth={CHROME_ICON_STROKE} />
          </button>
        </div>
        {/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Keyboard-scrollable viewport. */}
        <div
          ref={viewportRef}
          role='region'
          aria-label='Player shortcuts'
          tabIndex={0}
          className='min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/40'
        >
          <ShortcutTable shortcuts={rows} />
        </div>
        {/* eslint-enable jsx-a11y/no-noninteractive-tabindex */}
        <p className='shrink-0 border-t border-white/[0.07] px-5 py-3 text-[12px] text-zinc-500'>
          Change these keys in Settings → Shortcuts.
        </p>
      </div>
    </div>
  );
});
