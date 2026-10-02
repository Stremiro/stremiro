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

/**
 * Playback is a root-level session, not a route: /player registers *what* to
 * play; leaving it flips the session to `mini` instead of tearing mpv down.
 */

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
  /** Mirrors the historic InnerPlayer remount key: any coordinate change is a new session. */
  key: string;
}

interface PlayerSessionContextValue {
  session: PlayerSession | null;
  /** Null when no session exists; otherwise derived from the current route. */
  presentation: PlayerPresentation | null;
  launch: (launch: PlayerSessionLaunch) => void;
  close: () => void;
  /** Survives remounts, expand/mini flips, and close — a user-docked corner
      never jumps back to the default. */
  miniPositionRef: RefObject<MiniPlayerPosition | null>;
}

const PlayerSessionContext = createContext<PlayerSessionContextValue | null>(null);

// Structural tuple: addon ids carry `:` (`kitsu:1`, `tt1:2:3`), so a joined
// string could alias two episodes onto one key and skip the remount.
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
    // miniPositionRef deliberately survives — the docked corner is user
    // preference, so a new session lands where the last was left.
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

/** Route element for /player/*: writes the launch into the session; the
    root-level host renders the player so it survives route changes. */
export function PlayerRouteRegistrar() {
  const { type, id, season, episode } = useParams();
  const location = useLocation();
  const { launch } = usePlayerSession();

  // Layout effect: the session must be written before paint so PlayerHost
  // never renders a "no session" frame.
  useLayoutEffect(() => {
    launch({ type, id, season, episode, state: location.state, playerPath: location.pathname });
  }, [launch, type, id, season, episode, location.state, location.pathname]);

  return null;
}

const loadPlayerChunk = () => import('@/pages/player').then((m) => ({ default: m.Player }));

const LazyPlayer = lazy(loadPlayerChunk);

/**
 * Kick the player chunk fetch early — stream resolution, resume clicks, and
 * selector opens all predict a mount, so launch is an instant Suspense hit.
 */
export function warmPlayerChunk() {
  void loadPlayerChunk().catch(() => undefined);
}

function PlayerRouteLoader() {
  return (
    <div className='fixed inset-0 z-60 flex h-screen w-screen items-center justify-center bg-black'>
      <Loader2 className='h-8 w-8 animate-spin text-white/50' />
    </div>
  );
}

/** Root-level mount for the active session — lives outside the routed outlet
    so leaving /player minimizes instead of unmounting. */
export function PlayerHost() {
  const { session, presentation } = usePlayerSession();
  if (!session) return null;
  return (
    <Suspense fallback={presentation === 'expanded' ? <PlayerRouteLoader /> : null}>
      <LazyPlayer />
    </Suspense>
  );
}
