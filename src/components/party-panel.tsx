import {
  ArrowDown,
  ArrowRight,
  Check,
  Copy,
  Loader2,
  Lock,
  LockOpen,
  LogOut,
  MessageCircle,
  Play,
  SendHorizontal,
  Share2,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, memo, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ProfileAvatar } from '@/components/profile-avatar';
import { CHROME_POPOVER_CLASS } from '@/components/player-chrome-styles';
import { RemoteImage } from '@/components/remote-image';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { useProfileAvatar } from '@/hooks/use-local-profile';
import { useMountedRef } from '@/hooks/use-mounted-ref';
import { api, getErrorMessage } from '@/lib/api';
import { partyApi, partyMemberStyle, type PartyMember, type PartySnapshot } from '@/lib/party-api';
import {
  detailsCardQueryKey,
  DETAILS_STALE_TIME_MS,
  DETAILS_GC_TIME_MS,
} from '@/lib/query-invalidation';
import { playerMatchesMedia, useParty } from '@/lib/party-session';
import { usePlayerSession } from '@/lib/player-session';
import { cn, formatSeasonEpisode } from '@/lib/utils';

const CHAT_MAX_LENGTH = 500;
const CHAT_COUNTER_FROM = 400;

function playbackStatus(room: PartySnapshot, leader: PartyMember | undefined): string {
  const paused = room.playback?.paused ?? false;
  if (!leader) return paused ? 'Paused' : 'Playing';
  if (paused) return `Paused by ${leader.you ? 'you' : leader.name}`;
  return leader.you ? 'Playing' : `Playing with ${leader.name}`;
}

const PartyChatMessages = memo(function PartyChatMessages({
  chat,
  selfId,
  initialChat,
}: {
  chat: PartySnapshot['chat'];
  selfId: string | undefined;
  initialChat: string | undefined;
}) {
  const newestChat = chat.at(-1)?.id;
  return (
    <div
      className='flex min-h-full flex-col px-1 py-5'
      role='log'
      aria-label='Party chat'
      aria-live='polite'
      aria-relevant='additions text'
    >
      {chat.map((message, index) => {
        const continued = chat[index - 1]?.memberId === message.memberId;
        const groupEnd = chat[index + 1]?.memberId !== message.memberId;
        const mine = message.memberId === selfId;
        return (
          <div
            key={message.id}
            className={cn(
              'flex',
              mine ? 'justify-end pl-6' : 'items-end gap-2 pr-6',
              index === 0 ? '' : continued ? 'mt-1' : 'mt-5',
              message.id === newestChat &&
                message.id !== initialChat &&
                'animate-in fade-in-0 slide-in-from-bottom-1 duration-200 motion-reduce:animate-none',
            )}
          >
            {!mine &&
              (groupEnd ? (
                <ProfileAvatar
                  name={message.name}
                  className='h-6 w-6 shrink-0'
                  fallbackClassName='text-[9px] font-medium text-white/85'
                  fallbackStyle={partyMemberStyle(message.memberId)}
                />
              ) : (
                <span aria-hidden='true' className='w-6 shrink-0' />
              ))}
            <div className={cn('flex min-w-0 flex-col', mine ? 'items-end' : 'items-start')}>
              {!continued && (
                <p
                  className='mb-1.5 max-w-full truncate px-1 text-[11px] font-medium text-white/45'
                  dir='auto'
                  title={`${message.name} · ${message.memberId.slice(0, 6)}`}
                >
                  {mine ? 'You' : message.name}
                </p>
              )}
              <p
                className={cn(
                  'max-w-full rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere]',
                  mine
                    ? 'rounded-br-md bg-[rgb(var(--accent-act-rgb)/0.12)] text-white/95'
                    : 'rounded-bl-md bg-white/[0.055] text-white/85',
                )}
                data-selectable='true'
                dir='auto'
              >
                {message.text}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
});

export function PartyPanel({ className }: { className?: string }) {
  const { room, watching, watch, share, leave, setPanelOpen } = useParty();
  const { session: player, presentation } = usePlayerSession();
  const identity = useProfileAvatar();
  const chatHintId = useId();
  const leaveConfirmationId = useId();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const chatForm = useRef<HTMLFormElement>(null);
  const [newMessages, setNewMessages] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mountedRef = useMountedRef(() => clearTimeout(copyTimer.current));
  const stayButton = useRef<HTMLButtonElement>(null);
  const leaveButton = useRef<HTMLButtonElement>(null);
  const chatViewport = useRef<HTMLDivElement>(null);
  const followChat = useRef(true);
  const newestChat = room.chat.at(-1)?.id;
  const initialChat = useRef(newestChat);
  const media = room.playback?.media;
  const { data: details, isError: detailsFailed } = useQuery({
    queryKey: detailsCardQueryKey(media?.mediaType, media?.mediaId),
    queryFn: () => api.getMediaCardDetails(media!.mediaType, media!.mediaId),
    enabled: room.active && !!media,
    staleTime: DETAILS_STALE_TIME_MS,
    gcTime: DETAILS_GC_TIME_MS,
  });
  useLayoutEffect(() => {
    const viewport = chatViewport.current;
    if (viewport && followChat.current) viewport.scrollTop = viewport.scrollHeight;
    else if (newestChat) setNewMessages(true);
  }, [newestChat]);
  useEffect(() => {
    const viewport = chatViewport.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => {
      if (followChat.current) viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (confirmLeave) stayButton.current?.focus();
  }, [confirmLeave]);
  const run = async (operation: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await operation();
    } catch (error) {
      if (mountedRef.current) toast.error(getErrorMessage(error));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };
  if (!room.active) return null;

  const self = room.members.find((member) => member.you);
  const leader = room.members.find((member) => member.id === room.playbackBy);
  const othersPresent = room.members.length > 1;
  const playingRoomMedia = playerMatchesMedia(player, media);
  const followingRoom = room.syncing && playingRoomMedia;
  const canShare = !!player && !(room.playbackIsLocal && playingRoomMedia);

  const copyInvite = () =>
    void run(async () => {
      const invite = await partyApi.invite(room.session);
      if (!mountedRef.current) return;
      try {
        await navigator.clipboard.writeText(invite);
      } catch {
        throw new Error('Could not copy the invite. Try again.');
      }
      if (!mountedRef.current) return;
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    });

  const sendChat = (event?: FormEvent) => {
    event?.preventDefault();
    const draft = text;
    const message = text.trim();
    if (!message || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    followChat.current = true;
    setNewMessages(false);
    partyApi
      .chat(room.session, message)
      .then(() => {
        if (!mountedRef.current) return;
        setText((current) => (current === draft ? '' : current));
        if (chatForm.current?.contains(document.activeElement))
          composer.current?.focus({ preventScroll: true });
      })
      .catch((error: unknown) => {
        if (mountedRef.current) toast.error(getErrorMessage(error));
      })
      .finally(() => {
        sendingRef.current = false;
        if (mountedRef.current) setSending(false);
      });
  };

  return (
    <section
      className={cn('flex min-h-0 flex-col overflow-hidden text-white', className)}
      aria-label='Watch party'
    >
      <div className='max-h-[45%] shrink-0 overflow-y-auto'>
        <div className='flex flex-wrap items-center justify-between gap-3 pb-4'>
          <div className='flex min-w-0 items-center gap-2'>
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type='button'
                  aria-label={`People in this room, ${room.members.length}`}
                  title='People in this room'
                  className='flex items-center -space-x-1.5 rounded-full p-1 pr-0.5 transition-colors hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30'
                >
                  {room.members.slice(0, 3).map((member) => (
                    <ProfileAvatar
                      key={member.id}
                      name={member.name}
                      avatar={member.you ? identity?.avatar : undefined}
                      className='h-7 w-7 ring-2 ring-zinc-950'
                      fallbackClassName='text-[10px] font-medium text-white/85'
                      fallbackStyle={partyMemberStyle(member.id)}
                    />
                  ))}
                  {room.members.length > 3 && (
                    <span className='flex h-7 w-7 items-center justify-center rounded-full bg-zinc-800 text-[10px] text-white/65 ring-2 ring-zinc-950'>
                      +{room.members.length - 3}
                    </span>
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent
                align='start'
                sideOffset={8}
                className={cn(
                  CHROME_POPOVER_CLASS,
                  'z-[110] w-64 p-3 text-white motion-reduce:animate-none',
                )}
              >
                <h3 className='mb-2 px-1 text-xs font-medium text-white/45'>
                  People · {room.members.length}
                </h3>
                <ul className='max-h-60 space-y-1 overflow-y-auto' aria-label='Room members'>
                  {room.members.map((member) => (
                    <li
                      key={member.id}
                      className='flex items-center gap-3 rounded-lg px-1 py-2'
                      title={`${member.name} · ${member.id.slice(0, 6)}`}
                    >
                      <ProfileAvatar
                        name={member.name}
                        avatar={member.you ? identity?.avatar : undefined}
                        className='h-8 w-8 shrink-0'
                        fallbackClassName='text-xs font-medium text-white/85'
                        fallbackStyle={partyMemberStyle(member.id)}
                      />
                      <div className='min-w-0 flex-1'>
                        <p className='truncate text-sm'>
                          {member.name}
                          {member.you && <span className='ml-1.5 text-xs text-white/35'>you</span>}
                        </p>
                        {(member.creator || member.buffering) && (
                          <p className='mt-0.5 text-[11px] text-white/40'>
                            {[member.creator && 'Host', member.buffering && 'Buffering']
                              .filter(Boolean)
                              .join(' · ')}
                          </p>
                        )}
                      </div>
                      <span className='shrink-0 font-mono text-[10px] text-white/30'>
                        {member.id.slice(0, 6)}
                      </span>
                    </li>
                  ))}
                </ul>
                {room.locked && (
                  <p className='mt-2 border-t border-white/[0.06] pt-2 text-xs text-white/40'>
                    This room is locked to new guests.
                  </p>
                )}
              </PopoverContent>
            </Popover>
            <span className='pl-1 text-xs font-medium tabular-nums text-white/45'>
              {room.members.length}
            </span>
            {room.locked && (
              <span
                title='The host locked the room to new guests'
                className='flex items-center gap-1 rounded-full bg-white/[0.05] px-2 py-1 text-[10px] font-medium text-white/45'
              >
                <Lock className='h-2.5 w-2.5' />
                Locked
              </span>
            )}
          </div>
          <div className='flex items-center gap-1'>
            <Button
              variant='ghost'
              size='sm'
              aria-label={copied ? 'Invite copied' : 'Copy invite'}
              className='h-8 rounded-lg text-xs text-white/65 hover:bg-white/[0.06]'
              disabled={busy || room.locked}
              title={
                room.locked
                  ? room.creator
                    ? 'Unlock the room to invite people'
                    : 'The host locked the room to new guests'
                  : 'Copy invite'
              }
              onClick={copyInvite}
            >
              {copied ? <Check /> : <Copy />}
              {copied ? 'Copied' : 'Invite'}
            </Button>
            {room.creator && (
              <Button
                variant='ghost'
                size='icon'
                disabled={busy}
                aria-label={room.locked ? 'Unlock room to new guests' : 'Lock room to new guests'}
                aria-pressed={room.locked}
                title={
                  room.locked
                    ? 'Unlock — anyone with the invite can join'
                    : 'Lock — stop new guests'
                }
                className={cn(
                  'h-8 w-8 rounded-lg',
                  room.locked
                    ? 'bg-[rgb(var(--accent-act-rgb)/0.14)] text-(--accent-act) hover:bg-[rgb(var(--accent-act-rgb)/0.22)]'
                    : 'text-white/45 hover:bg-white/[0.06] hover:text-white',
                )}
                onClick={() => void run(() => partyApi.lock(room.session, !room.locked))}
              >
                {room.locked ? <Lock /> : <LockOpen />}
              </Button>
            )}
            <Button
              ref={leaveButton}
              variant='ghost'
              size='icon'
              disabled={busy}
              aria-label={room.creator ? 'Close room for everyone' : 'Leave room'}
              aria-expanded={confirmLeave}
              aria-controls={confirmLeave ? leaveConfirmationId : undefined}
              title={room.creator ? 'Close room for everyone' : 'Leave room'}
              className='h-8 w-8 rounded-lg text-white/45 hover:bg-red-500/15 hover:text-red-300'
              onClick={() => (othersPresent ? setConfirmLeave(true) : void run(leave))}
            >
              <LogOut />
            </Button>
          </div>
        </div>

        {confirmLeave && (
          <div
            id={leaveConfirmationId}
            role='group'
            aria-label={room.creator ? 'Confirm closing the room' : 'Confirm leaving the room'}
            className='mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3'
          >
            <p className='min-w-0 flex-1 text-sm text-white/80'>
              {room.creator
                ? 'Close the room for everyone? Playback will continue.'
                : 'Leave this room? Playback will continue.'}
            </p>
            <div className='flex gap-2'>
              <Button
                ref={stayButton}
                variant='ghost'
                size='sm'
                onClick={() => {
                  setConfirmLeave(false);
                  leaveButton.current?.focus({ preventScroll: true });
                }}
              >
                Stay
              </Button>
              <Button
                size='sm'
                disabled={busy}
                className='bg-red-500/85 text-white hover:bg-red-500'
                onClick={() => void run(leave)}
              >
                {room.creator ? 'Close room' : 'Leave'}
              </Button>
            </div>
          </div>
        )}

        <div className='flex gap-3 border-b border-white/[0.07] pb-4'>
          {room.playback && (
            <div className='h-16 w-11 shrink-0 overflow-hidden rounded-md bg-white/[0.04]'>
              {details?.poster && (
                <RemoteImage src={details.poster} alt='' className='h-full w-full object-cover' />
              )}
            </div>
          )}
          <div className='min-w-0 flex-1'>
            {room.playback ? (
              <>
                <p className='mb-1 text-[11px] text-white/40'>Now playing</p>
                <div className='text-sm font-medium'>
                  {details?.title ? (
                    <span className='line-clamp-2 break-words'>{details.title}</span>
                  ) : detailsFailed ? (
                    <span className='text-white/60' title={room.playback.media.mediaId}>
                      Title unavailable
                    </span>
                  ) : (
                    <Skeleton className='h-4 w-40 bg-white/10' />
                  )}
                  {room.playback.media.season !== null && (
                    <span className='mt-0.5 block text-xs font-normal text-white/50'>
                      {formatSeasonEpisode(
                        room.playback.media.season,
                        room.playback.media.episode ?? 0,
                      )}
                    </span>
                  )}
                </div>
                <p className='mt-1 text-xs text-white/45'>{playbackStatus(room, leader)}</p>
                {!room.creator && !room.syncing && (
                  <p className='mt-2 text-xs leading-relaxed text-white/45'>
                    Choose Watch together to join playback through your own addons.
                  </p>
                )}
              </>
            ) : (
              <div className='mt-1.5'>
                <p className='text-sm text-white/55'>Nothing playing yet.</p>
                <p className='mt-1 text-xs leading-relaxed text-white/35'>
                  {room.creator
                    ? 'Press play on any title to share it with the room.'
                    : 'Wait for someone to play a title, or browse and share your playback.'}
                </p>
                <Link
                  to='/'
                  onClick={() => setPanelOpen(false)}
                  className='mt-2.5 inline-flex items-center gap-1 rounded-md text-xs font-medium text-(--accent-act) transition-colors hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30'
                >
                  Browse titles
                  <ArrowRight className='h-3 w-3' aria-hidden='true' />
                </Link>
              </div>
            )}
            <div className='mt-2 flex flex-wrap items-center gap-2'>
              {followingRoom && (
                <span className='flex items-center gap-1.5 text-xs text-white/45'>
                  <Check aria-hidden='true' className='h-3.5 w-3.5' />
                  Watching together
                </span>
              )}
              {room.playback && (!followingRoom || presentation === 'mini') && (
                <Button
                  variant='accent'
                  size='sm'
                  disabled={watching || busy}
                  aria-busy={watching}
                  onClick={() => void run(watch)}
                >
                  {watching ? <Loader2 className='animate-spin' /> : <Play />}
                  {watching ? 'Opening…' : followingRoom ? 'Return to player' : 'Watch together'}
                </Button>
              )}
              {canShare && (
                <Button
                  variant='ghost'
                  size='sm'
                  disabled={busy}
                  title='Everyone watching with the room jumps to your title and position'
                  onClick={() => void run(share)}
                >
                  <Share2 />
                  Share what I’m watching
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className='flex min-h-0 flex-1 flex-col'>
        <h2 className='sr-only'>Room chat</h2>
        <div className='relative flex min-h-0 flex-1 flex-col'>
          {!room.chat.length && (
            <div className='pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2.5 px-6 text-center'>
              <span className='mb-0.5 flex h-11 w-11 items-center justify-center rounded-2xl bg-white/[0.05]'>
                <MessageCircle className='h-5 w-5 text-white/30' strokeWidth={1.75} />
              </span>
              <p className='text-sm font-medium text-white/55'>No messages yet</p>
              <p className='max-w-56 text-[11.5px] leading-relaxed text-white/30'>
                Say hi — chat is encrypted and only this room can read it.
              </p>
            </div>
          )}
          <ScrollArea
            viewportRef={chatViewport}
            className='min-h-16 flex-1'
            onScrollCapture={(event) => {
              const viewport = chatViewport.current;
              if (viewport && event.target === viewport) {
                followChat.current =
                  viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 48;
                if (followChat.current) setNewMessages(false);
              }
            }}
          >
            <PartyChatMessages
              chat={room.chat}
              selfId={self?.id}
              initialChat={initialChat.current}
            />
          </ScrollArea>
          {newMessages && (
            <button
              type='button'
              className='absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full border border-white/15 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-white shadow-lg transition-colors hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30'
              onClick={() => {
                followChat.current = true;
                setNewMessages(false);
                const viewport = chatViewport.current;
                if (viewport) viewport.scrollTop = viewport.scrollHeight;
              }}
            >
              <ArrowDown className='h-3 w-3' />
              New messages
            </button>
          )}
        </div>
        <form ref={chatForm} className='shrink-0' onSubmit={sendChat}>
          <div className='flex items-end gap-2 rounded-2xl border border-white/[0.08] bg-white/[0.03] p-1.5 transition-colors focus-within:border-[rgb(var(--accent-act-rgb)/0.45)] focus-within:bg-white/[0.05]'>
            <div className='relative min-w-0 flex-1'>
              <textarea
                ref={composer}
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing)
                    return;
                  event.preventDefault();
                  if (!event.repeat) sendChat();
                }}
                maxLength={CHAT_MAX_LENGTH}
                rows={1}
                aria-label='Chat message'
                aria-describedby={chatHintId}
                placeholder='Message the room…'
                className='block max-h-28 min-h-9 w-full resize-none bg-transparent px-2 py-2 text-[13px] leading-5 text-white/90 placeholder:text-white/30 outline-none [field-sizing:content]'
              />
              {text.length >= CHAT_COUNTER_FROM && (
                <span
                  aria-live='polite'
                  className='pointer-events-none absolute bottom-0 right-1 rounded bg-zinc-950/90 px-1 text-[10px] tabular-nums text-white/40'
                >
                  {CHAT_MAX_LENGTH - text.length}
                </span>
              )}
            </div>
            <Button
              variant='accent'
              type='submit'
              size='icon'
              className='h-9 w-9 shrink-0 rounded-full shadow-none transition-transform hover:scale-105 active:scale-95 motion-reduce:transform-none disabled:opacity-40'
              disabled={sending || !text.trim()}
              aria-label='Send chat message'
              onMouseDown={(event) => event.preventDefault()}
            >
              {sending ? (
                <Loader2 className='h-4 w-4 animate-spin' />
              ) : (
                <SendHorizontal className='h-4 w-4' />
              )}
            </Button>
          </div>
          <p id={chatHintId} className='sr-only'>
            Enter to send · Shift + Enter for a new line
          </p>
        </form>
      </div>
    </section>
  );
}
