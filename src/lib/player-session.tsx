import { Loader2 } from 'lucide-react';
import {
  createContext,
  lazy,
  type RefObject,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLocation, useMatch, useParams } from 'react-router';
import { DesktopTitlebar } from '@/components/desktop-titlebar';
import { RemoteImage } from '@/components/remote-image';
import { Sidebar } from '@/components/sidebar';
import { type PlayerRouteState, sanitizePlayerRouteState } from '@/lib/player-navigation';
import { routeChunks } from '@/lib/route-chunks';
import { isHttpUrl } from '@/lib/utils';

/** Playback is a root-level session, not a route — leaving /player flips to `mini` instead of tearing mpv down. */

type PlayerPresentation = 'expanded' | 'mini';

export interface MiniPlayerPosition {
  x: number;
  y: number;
}

interface PlayerSessionLaunch {
  type?: string;
  id?: string;
  season?: string;
  episode?: string;
  /** Raw location.state captured at launch — re-applied when expanding again. */
  state: unknown;
  /** The /player pathname to navigate back to when expanding the mini player. */
  playerPath: string;
}

interface PlayerSession extends PlayerSessionLaunch {
  /** Any coordinate change is a new session (remount key). */
  key: string;
}

interface PlayerSessionContextValue {
  session: PlayerSession | null;
  /** Null when no session exists; otherwise derived from the current route. */
  presentation: PlayerPresentation | null;
  launch: (launch: PlayerSessionLaunch) => void;
  close: () => void;
  /** Survives remounts and close — a user-docked corner never jumps back to the default. */
  miniPositionRef: RefObject<MiniPlayerPosition | null>;
}

const PlayerSessionContext = createContext<PlayerSessionContextValue | null>(null);

// Structural tuple — addon ids carry `:` (kitsu:1), so a joined string could alias episodes and skip the remount.
function buildSessionKey(launch: PlayerSessionLaunch): string {
  return JSON.stringify([
    launch.type ?? null,
    launch.id ?? null,
    launch.season ?? null,
    launch.episode ?? null,
  ]);
}

export function PlayerSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<PlayerSession | null>(null);
  const miniPositionRef = useRef<MiniPlayerPosition | null>(null);
  const onPlayerRoute = useMatch('/player/*') !== null;

  const launch = useCallback((next: PlayerSessionLaunch) => {
    const key = buildSessionKey(next);
    setSession((previous) => {
      // Same key: refresh state/path in place so the mounted player does not remount.
      if (previous && previous.key === key) {
        return { ...previous, state: next.state, playerPath: next.playerPath };
      }
      return { ...next, key };
    });
  }, []);

  const close = useCallback(() => {
    setSession(null);
    // miniPositionRef survives — a new session lands where the last was docked.
  }, []);

  const presentation: PlayerPresentation | null = session
    ? onPlayerRoute
      ? 'expanded'
      : 'mini'
    : null;

  const value = useMemo<PlayerSessionContextValue>(
    () => ({ session, presentation, launch, close, miniPositionRef }),
    [session, presentation, launch, close],
  );

  return <PlayerSessionContext.Provider value={value}>{children}</PlayerSessionContext.Provider>;
}

export function usePlayerSession(): PlayerSessionContextValue {
  const context = useContext(PlayerSessionContext);
  if (!context) {
    throw new Error('usePlayerSession must be used within PlayerSessionProvider');
  }
  return context;
}

/** Route element for /player/* — writes the launch into the session; the root-level host renders it. */
export function PlayerRouteRegistrar() {
  const { type, id, season, episode } = useParams();
  const location = useLocation();
  const { launch } = usePlayerSession();

  // Layout effect — the session must land before paint so PlayerHost never renders a "no session" frame.
  useLayoutEffect(() => {
    launch({ type, id, season, episode, state: location.state, playerPath: location.pathname });
  }, [launch, type, id, season, episode, location.state, location.pathname]);

  return null;
}

const LazyPlayer = lazy(() => routeChunks.player().then((m) => ({ default: m.Player })));

/** Kick the player chunk fetch early so launch is an instant Suspense hit. */
export function warmPlayerChunk() {
  void routeChunks.player().catch(() => undefined);
}

function PlayerRouteLoader({ state }: { state: unknown }) {
  const { backdrop } = sanitizePlayerRouteState(state as PlayerRouteState | null);
  return (
    <div className='fixed inset-0 z-60 bg-black'>
      {isHttpUrl(backdrop) && (
        <>
          <RemoteImage
            src={backdrop}
            alt=''
            className='h-full w-full object-cover opacity-50'
            loading='eager'
          />
          <div className='absolute inset-0 bg-black/50 backdrop-blur-xs' />
        </>
      )}
      {/* Same 350ms debounce as the player's loading card — a warm chunk never flashes a spinner. */}
      <div className='absolute inset-0 flex items-center justify-center animate-in fade-in duration-200 fill-mode-backwards [animation-delay:350ms] motion-reduce:[animation-delay:0ms]'>
        <Loader2 className='h-8 w-8 animate-spin text-white/50' />
      </div>
      {/* Same rail the player mounts, so the sidebar never blinks out while the chunk loads. */}
      <Sidebar className='fixed left-0 top-0 z-70 flex' />
      <DesktopTitlebar className='bg-linear-to-b from-black/70 via-black/35 to-transparent' />
    </div>
  );
}

/** Root-level mount outside the routed outlet — leaving /player minimizes instead of unmounting. */
export function PlayerHost() {
  const { session, presentation } = usePlayerSession();
  if (!session) return null;
  return (
    <Suspense
      fallback={presentation === 'expanded' ? <PlayerRouteLoader state={session.state} /> : null}
    >
      <LazyPlayer />
    </Suspense>
  );
}
