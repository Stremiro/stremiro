import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  Clock,
  EyeOff,
  Loader2,
  Lock,
  LogIn,
  Plus,
  Puzzle,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { PartyPanel } from '@/components/party-panel';
import { ProfileAvatar } from '@/components/profile-avatar';
import { RemoteImage } from '@/components/remote-image';
import { Button } from '@/components/ui/button';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { useProfileAvatar } from '@/hooks/use-local-profile';
import { api, getErrorMessage } from '@/lib/api';
import { isTauriDesktopRuntime } from '@/lib/app-updater';
import { PARTY_INVITE_PREFIX } from '@/lib/party-api';
import { useParty } from '@/lib/party-session';
import { MEDIA_ROW_STALE_TIME_MS, trendingRowQueryKey } from '@/lib/query-invalidation';

const ABOUT_ITEMS: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: Lock,
    title: 'Private chat',
    text: 'Messages are encrypted — only people in the room can read them, not the relay.',
  },
  {
    icon: EyeOff,
    title: 'Hidden IP',
    text: 'Room members never see your IP address; only the relay connecting the room does.',
  },
  {
    icon: Puzzle,
    title: 'Your own addons',
    text: 'Everyone plays from their own addons and sources — different setups still stay in sync.',
  },
  {
    icon: Clock,
    title: 'Temporary rooms',
    text: 'Rooms and chat are temporary. The host can lock new joins; closing the room ends the invite.',
  },
];

const WALL_POSTER_COUNT = 30;

/** Decorative poster backdrop — shares the Home rows' catalog queries, so it
    costs nothing after a Home visit and silently renders nothing offline. */
function PartyPosterWall() {
  const { data: movies } = useQuery({
    queryKey: trendingRowQueryKey('movies', 'All'),
    queryFn: () => api.querySearchCatalogPage({ mediaType: 'movie' }).then((page) => page.items),
    staleTime: MEDIA_ROW_STALE_TIME_MS,
  });
  const { data: series } = useQuery({
    queryKey: trendingRowQueryKey('series', 'All'),
    queryFn: () => api.querySearchCatalogPage({ mediaType: 'series' }).then((page) => page.items),
    staleTime: MEDIA_ROW_STALE_TIME_MS,
  });
  const posters = useMemo(() => {
    const picked = new Set<string>();
    const lists = [movies ?? [], series ?? []];
    for (
      let index = 0;
      index < Math.max(lists[0].length, lists[1].length) && picked.size < WALL_POSTER_COUNT;
      index++
    ) {
      for (const list of lists) {
        const poster = list[index]?.poster;
        if (poster) picked.add(poster);
        if (picked.size >= WALL_POSTER_COUNT) break;
      }
    }
    return [...picked];
  }, [movies, series]);
  if (!posters.length) return null;
  return (
    <div
      aria-hidden='true'
      className='pointer-events-none fixed inset-0 -z-10 select-none overflow-hidden'
    >
      <div
        className='grid h-full auto-rows-fr grid-cols-4 gap-4 px-10 opacity-[0.13] saturate-50 sm:grid-cols-6'
        style={{
          transform: 'rotate(-2deg) scale(1.15)',
          maskImage: 'radial-gradient(75% 65% at 50% 45%, transparent 12%, black 60%)',
          WebkitMaskImage: 'radial-gradient(75% 65% at 50% 45%, transparent 12%, black 60%)',
        }}
      >
        {posters.map((src) => (
          <RemoteImage
            key={src}
            src={src}
            alt=''
            loading='lazy'
            className='h-full w-full rounded-lg bg-white/[0.04] object-cover'
          />
        ))}
      </div>
    </div>
  );
}

export function Party() {
  useDocumentTitle('Watch Together');
  const { room, busy, connectionError, create, confirmJoin } = useParty();
  const identity = useProfileAvatar();
  const [invite, setInvite] = useState('');
  const [validating, setValidating] = useState(false);
  const validatingRef = useRef(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const supported = isTauriDesktopRuntime();
  const inviteTrimmed = invite.trim();
  useEffect(() => {
    if (room.active) setInvite('');
  }, [room.active]);
  const review = (value: string) => {
    if (!supported || busy || validatingRef.current || !value.trim()) return;
    validatingRef.current = true;
    setValidating(true);
    setInviteError(null);
    void confirmJoin(value)
      .catch((error: unknown) => setInviteError(getErrorMessage(error)))
      .finally(() => {
        validatingRef.current = false;
        setValidating(false);
      });
  };
  return (
    <>
      {!room.active && <PartyPosterWall />}
      <div className='mx-auto flex min-h-[calc(100dvh-4rem)] w-full max-w-3xl flex-col px-6 pb-8 pt-12 page-enter'>
        <div className='mb-7 flex flex-wrap items-center justify-between gap-4'>
          <div>
            <h1 className='flex items-center gap-2.5 text-2xl font-medium tracking-tight'>
              Watch Together
              <span className='rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-white/50 ring-1 ring-white/[0.08]'>
                Beta
              </span>
            </h1>
            {!room.active && (
              <p className='mt-2 text-sm text-white/40'>
                Watch in sync and chat with friends — no account needed.
              </p>
            )}
          </div>
          {!room.active && (
            <Link
              to='/profile'
              aria-label={`Edit your profile, joining as ${identity?.username ?? 'Guest'}`}
              title='Edit profile'
              className='flex max-w-48 items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-white/50 transition-colors hover:bg-white/[0.04] hover:text-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30'
            >
              <ProfileAvatar
                name={identity?.username ?? 'Guest'}
                avatar={identity?.avatar}
                className='h-6 w-6 shrink-0'
                fallbackClassName='bg-zinc-800 text-[10px] font-medium'
              />
              <span className='truncate'>Joining as {identity?.username ?? 'Guest'}</span>
            </Link>
          )}
        </div>
        {room.active ? (
          <PartyPanel
            key={room.session}
            className='h-[min(760px,calc(100dvh-156px))] min-h-[360px] rounded-2xl border border-white/[0.07] bg-zinc-950/40 p-5'
          />
        ) : (
          <div className='my-auto w-full'>
            {(connectionError || room.error) && (
              <p
                role='alert'
                className='mb-5 rounded-lg border border-white/[0.08] bg-zinc-950/70 px-4 py-3 text-sm leading-relaxed text-amber-200/80'
              >
                {connectionError || room.error}
              </p>
            )}
            {!supported && (
              <p className='mb-5 text-center text-xs text-white/45'>
                Open the desktop app to start or join a room.
              </p>
            )}
            <div className='grid overflow-hidden rounded-xl border border-white/[0.08] bg-zinc-950/60 backdrop-blur-xl md:grid-cols-2'>
              <section className='flex flex-col p-7'>
                <div className='mb-5 flex h-10 w-10 items-center justify-center rounded-lg bg-[rgb(var(--accent-act-rgb)/0.13)] text-(--accent-act) ring-1 ring-[rgb(var(--accent-act-rgb)/0.28)]'>
                  <Plus className='h-5 w-5' strokeWidth={2.25} />
                </div>
                <h2 className='text-base font-medium tracking-tight'>Create a room</h2>
                <p className='mt-2 flex-1 text-[13px] leading-relaxed text-white/50'>
                  Start a room and send friends the invite link. Then browse to any title and press
                  play. Friends choose Watch together to start syncing.
                </p>
                <Button
                  variant='accent'
                  className='mt-7 self-start rounded-lg px-5'
                  disabled={!supported || busy}
                  onClick={() => void create()}
                >
                  {busy ? <Loader2 className='animate-spin' /> : <Plus />}Create room
                </Button>
                <p className='mt-3.5 text-[11px] leading-relaxed text-white/30'>
                  You host the room — keep Stremiro open while you watch.
                </p>
              </section>
              <section className='flex flex-col border-t border-white/[0.06] p-7 md:border-l md:border-t-0'>
                <div className='mb-5 flex h-10 w-10 items-center justify-center rounded-lg bg-white/[0.05] text-white/70 ring-1 ring-white/[0.08]'>
                  <LogIn className='h-5 w-5' strokeWidth={2} />
                </div>
                <h2 className='text-base font-medium tracking-tight'>Join a room</h2>
                <p className='mt-2 flex-1 text-[13px] leading-relaxed text-white/50'>
                  Paste a friend's invite link, then choose Watch together in the room to play
                  through your own addons.
                </p>
                <form
                  className='mt-7 flex items-center gap-2'
                  onSubmit={(event) => {
                    event.preventDefault();
                    review(invite);
                  }}
                >
                  <label className='sr-only' htmlFor='party-invite'>
                    Party invite
                  </label>
                  <input
                    id='party-invite'
                    value={invite}
                    onChange={(event) => {
                      setInvite(event.target.value);
                      setInviteError(null);
                    }}
                    onPaste={(event) => {
                      const pasted = event.clipboardData.getData('text').trim();
                      if (!supported || busy || !pasted.startsWith(PARTY_INVITE_PREFIX)) return;
                      event.preventDefault();
                      setInvite(pasted);
                      review(pasted);
                    }}
                    disabled={!supported || busy || validating}
                    maxLength={2048}
                    autoComplete='off'
                    spellCheck={false}
                    placeholder='stremiro://party/…'
                    aria-invalid={!!inviteError}
                    aria-describedby='party-invite-hint'
                    className='h-11 min-w-0 flex-1 rounded-lg border border-white/[0.08] bg-black/25 px-3.5 text-[13px] text-white/85 shadow-[inset_0_1px_2px_rgba(0,0,0,0.35)] placeholder:text-white/30 outline-none transition-colors focus-visible:border-white/25 focus-visible:ring-2 focus-visible:ring-white/15 disabled:opacity-50'
                  />
                  <Button
                    variant='secondary'
                    size='icon'
                    type='submit'
                    className='h-11 w-11 shrink-0 rounded-lg bg-white/[0.07] ring-1 ring-white/[0.06] transition-all hover:bg-white/10 hover:ring-white/15 disabled:opacity-50'
                    aria-label='Review invite'
                    title='Review invite'
                    disabled={!supported || busy || validating || !inviteTrimmed}
                  >
                    {validating ? <Loader2 className='animate-spin' /> : <ArrowRight />}
                  </Button>
                </form>
                <p
                  id='party-invite-hint'
                  aria-live='polite'
                  className={`mt-3.5 text-[11px] leading-relaxed ${inviteError ? 'text-amber-200/70' : 'text-white/30'}`}
                >
                  {inviteError ?? 'Paste an invite link or token. You review it before connecting.'}
                </p>
              </section>
            </div>
            <div className='mt-4 rounded-xl border border-white/[0.06] bg-zinc-950/40 px-7 py-6'>
              <h2 className='text-[11px] font-medium uppercase tracking-[0.14em] text-white/40'>
                Private by design
              </h2>
              <ul className='mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4'>
                {ABOUT_ITEMS.map((item) => (
                  <li key={item.title} className='flex items-start gap-3'>
                    <span className='mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/[0.05] text-white/55 ring-1 ring-white/[0.06]'>
                      <item.icon className='h-3.5 w-3.5' strokeWidth={2} />
                    </span>
                    <span className='min-w-0'>
                      <span className='block text-xs font-medium text-white/75'>{item.title}</span>
                      <span className='mt-1 block text-[11px] leading-relaxed text-white/40'>
                        {item.text}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
