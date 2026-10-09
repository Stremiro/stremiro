import * as DialogPrimitive from '@radix-ui/react-dialog';
import { MessageCircle, X } from 'lucide-react';
import { useRef } from 'react';
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PartyPanel } from '@/components/party-panel';
import {
  CHROME_CLOSE_BUTTON_CLASS,
  CHROME_ICON_BUTTON_CLASS,
  CHROME_POPOVER_CLASS,
} from '@/components/player-chrome-styles';
import { describePartyStatus, useParty } from '@/lib/party-session';
import { cn } from '@/lib/utils';

const MINI_BADGE_CLASS =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-white/75 transition-colors hover:bg-white/15 hover:text-white focus-visible:bg-white/15 focus-visible:text-white focus-visible:outline-none';

/** Player entry into the room sidebar; `compact` matches the mini player's chrome. */
export function PartyBadge({ compact = false }: { compact?: boolean }) {
  const { room, unread, panelOpen, setPanelOpen } = useParty();
  if (!room.active) return null;
  return (
    <button
      type='button'
      data-player-interactive
      aria-label={`Open watch party, ${describePartyStatus(room.members.length, unread)}`}
      aria-haspopup='dialog'
      aria-expanded={panelOpen}
      title='Party chat'
      onClick={(event) => {
        event.stopPropagation();
        setPanelOpen(!panelOpen);
      }}
      className={cn(
        'pointer-events-auto relative',
        compact ? MINI_BADGE_CLASS : CHROME_ICON_BUTTON_CLASS,
      )}
    >
      <MessageCircle className={compact ? 'h-3.5 w-3.5' : 'h-5 w-5'} strokeWidth={1.75} />
      {unread > 0 && (
        <span
          aria-hidden='true'
          className='absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-(--accent-act) ring-2 ring-black/70'
        />
      )}
    </button>
  );
}

export function PartySidebar() {
  const { room, panelOpen, setPanelOpen } = useParty();
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  if (!room.active) return null;
  return (
    <Dialog open={panelOpen} onOpenChange={setPanelOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className='fixed inset-0 z-[89] bg-black/5 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:animate-none' />
        <DialogPrimitive.Content
          ref={panel}
          data-player-interactive
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            opener.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
            panel.current?.querySelector('textarea')?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = opener.current?.isConnected
              ? opener.current
              : document.querySelector<HTMLElement>('[data-party-entry]');
            target?.focus({ preventScroll: true });
          }}
          className={cn(
            CHROME_POPOVER_CLASS,
            'fixed bottom-3 right-3 top-11 z-[90] flex w-[calc(100%-1.5rem)] max-w-[380px] cursor-auto flex-col overflow-hidden rounded-2xl border text-white duration-200 data-[state=open]:animate-in data-[state=open]:slide-in-from-right-4 data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right-4 data-[state=closed]:fade-out-0 motion-reduce:animate-none',
          )}
        >
          <DialogHeader className='shrink-0 flex-row items-center gap-3 space-y-0 px-5 pb-2 pt-4 text-left'>
            <div className='min-w-0 flex-1'>
              <DialogTitle className='text-sm font-medium'>Watch Together</DialogTitle>
              <DialogDescription className='mt-0.5 text-[11px] text-white/40'>
                {room.members.length} {room.members.length === 1 ? 'person' : 'people'} in the room
                {room.locked ? ' · Locked' : ''}
              </DialogDescription>
            </div>
            <DialogPrimitive.Close
              aria-label='Close watch party sidebar'
              className={CHROME_CLOSE_BUTTON_CLASS}
            >
              <X className='h-4 w-4' />
            </DialogPrimitive.Close>
          </DialogHeader>
          <PartyPanel key={room.session} className='min-h-0 flex-1 px-5 pb-5 pt-1' />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </Dialog>
  );
}
