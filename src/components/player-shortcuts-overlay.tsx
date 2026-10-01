import { X } from 'lucide-react';
import { memo, useEffect, useRef } from 'react';
import { CHROME_CLOSE_BUTTON_CLASS } from '@/components/player-chrome-styles';
import { ShortcutTable } from '@/components/shortcut-table';
import { PLAYER_SHORTCUTS } from '@/lib/shortcuts';

interface PlayerShortcutsOverlayProps {
  onClose: () => void;
}

// `?` toggles this from the hotkey layer; the Escape chain in
// usePlayerHotkeys closes it before panels, fullscreen, or back-nav.
export const PlayerShortcutsOverlay = memo(function PlayerShortcutsOverlay({
  onClose,
}: PlayerShortcutsOverlayProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

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
      className='absolute inset-0 z-90 flex items-center justify-center p-6'
    >
      {/* Click-anywhere dismiss — the surface under it stays put. */}
      <button
        type='button'
        tabIndex={-1}
        aria-label='Close shortcuts'
        onClick={onClose}
        className='absolute inset-0 cursor-default bg-black/60 backdrop-blur-sm animate-in fade-in duration-200'
      />
      {/* The close button is the dialog's only tabbable control, so pinning
          Tab to it is the whole focus trap. */}
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
          closeButtonRef.current?.focus();
        }}
        className='relative w-full max-w-2xl overflow-hidden rounded-2xl border border-white/[0.08] bg-zinc-950/95 shadow-2xl shadow-black/70 backdrop-blur-2xl animate-in fade-in zoom-in-95 duration-200 outline-hidden'
      >
        <div className='flex items-center justify-between gap-3 border-b border-white/[0.07] px-5 pb-3 pt-4'>
          <h2 className='text-[15px] font-semibold tracking-tight text-white'>
            Keyboard shortcuts
          </h2>
          <button
            ref={closeButtonRef}
            type='button'
            onClick={onClose}
            aria-label='Close shortcuts'
            title='Close (Esc)'
            className={CHROME_CLOSE_BUTTON_CLASS}
          >
            <X className='w-4 h-4' strokeWidth={2.25} />
          </button>
        </div>
        <div className='max-h-[70vh] overflow-y-auto p-4'>
          <ShortcutTable shortcuts={PLAYER_SHORTCUTS} />
        </div>
      </div>
    </div>
  );
});
