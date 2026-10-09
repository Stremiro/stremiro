import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { CHROME_POPOVER_CLASS } from '@/components/player-chrome-styles';
import { ProfileAvatar } from '@/components/profile-avatar';
import { partyMemberStyle } from '@/lib/party-api';
import { useParty } from '@/lib/party-session';
import { cn } from '@/lib/utils';

const TOAST_MS = 5200;
const LEAVE_MS = 200;
const MAX_TOASTS = 3;

interface ChatToast {
  id: string;
  memberId: string;
  name: string;
  text: string;
  leaving?: boolean;
}

export function PartyChatToasts() {
  const { room, panelOpen, setPanelOpen } = useParty();
  const { pathname } = useLocation();
  const [toasts, setToasts] = useState<ChatToast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>[]>());
  const seen = useRef(room.chat.at(-1)?.id);
  const viewing = panelOpen || pathname === '/party';

  const rebaseSeen = useEffectEvent(() => {
    seen.current = room.chat.at(-1)?.id;
  });
  useEffect(() => {
    const map = timers.current;
    const clear = () => {
      map.forEach((pair) => pair.forEach(clearTimeout));
      map.clear();
    };
    clear();
    setToasts((current) => (current.length ? [] : current));
    rebaseSeen();
    return clear;
  }, [room.session, room.active, viewing]);

  const newestId = room.chat.at(-1)?.id;
  const enqueueNewMessages = useEffectEvent(() => {
    const newest = room.chat.at(-1);
    if (!room.active || !newest || newest.id === seen.current) return;
    const seenIndex = room.chat.findIndex((message) => message.id === seen.current);
    seen.current = newest.id;
    if (viewing) return;
    const selfId = room.members.find((member) => member.you)?.id;
    const messages = room.chat
      .slice(seenIndex + 1)
      .filter((message) => message.memberId !== selfId)
      .slice(-MAX_TOASTS);
    if (messages.length) setToasts((current) => [...current, ...messages].slice(-MAX_TOASTS));
    for (const { id } of messages) {
      timers.current.set(id, [
        setTimeout(() => {
          setToasts((current) =>
            current.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast)),
          );
        }, TOAST_MS - LEAVE_MS),
        setTimeout(() => {
          timers.current.delete(id);
          setToasts((current) => current.filter((toast) => toast.id !== id));
        }, TOAST_MS),
      ]);
      if (timers.current.size > MAX_TOASTS) {
        const oldest = timers.current.keys().next().value;
        if (oldest) {
          timers.current.get(oldest)?.forEach(clearTimeout);
          timers.current.delete(oldest);
        }
      }
    }
  });
  useEffect(() => {
    enqueueNewMessages();
  }, [newestId]);

  if (!room.active || !toasts.length) return null;
  return (
    <div
      aria-live='polite'
      className='pointer-events-none fixed right-4 top-14 z-[95] flex w-72 max-w-[calc(100vw-2rem)] flex-col items-end gap-2'
    >
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type='button'
          data-player-interactive
          aria-label={`Open party chat — ${toast.name} wrote: ${toast.text}`}
          onClick={() => setPanelOpen(true)}
          className={cn(
            CHROME_POPOVER_CLASS,
            'pointer-events-auto flex w-full cursor-pointer items-start gap-2.5 rounded-2xl border px-3.5 py-3 text-left duration-200 motion-reduce:animate-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30',
            toast.leaving
              ? 'animate-out fill-mode-forwards fade-out-0 slide-out-to-right-4'
              : 'animate-in fade-in-0 slide-in-from-right-4',
          )}
        >
          <ProfileAvatar
            name={toast.name}
            className='h-7 w-7 shrink-0'
            fallbackClassName='text-[10px] font-medium text-white/85'
            fallbackStyle={partyMemberStyle(toast.memberId)}
          />
          <span className='min-w-0 flex-1'>
            <span className='block truncate text-[11px] font-medium text-white/45' dir='auto'>
              {toast.name}
            </span>
            <span
              className='mt-0.5 block line-clamp-2 break-words text-[13px] leading-snug text-white/90 [overflow-wrap:anywhere]'
              dir='auto'
            >
              {toast.text}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
