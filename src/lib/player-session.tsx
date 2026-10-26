import {
  createContext,
  lazy,
  type ReactNode,
  type RefObject,
  Suspense,
  use,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useMatch, useParams } from 'react-router';
import { DesktopTitlebar } from '@/components/desktop-titlebar';
import { PlayerLoadingOverlay } from '@/components/player-state-overlays';
import { RemoteImage } from '@/components/remote-image';
import { Sidebar } from '@/components/sidebar';
import { api } from '@/lib/api';
import { formatPlaybackLanding } from '@/lib/history-playback';
import { resolvePlayerLaunch } from '@/lib/player-navigation';
import { routeChunks } from '@/lib/route-chunks';
import { createSubscribableStore, type SubscribableStore } from '@/lib/subscribable-store';
import { cn, isHttpUrl } from '@/lib/utils';

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
  launch: (launch: PlayerSessionLaunch, preserveTrayPause?: boolean) => void;
  close: () => void;
  trayPause: SubscribableStore<boolean>;
  /** Survives remounts and close — a user-docked corner never jumps back to the default. Read at mount only. */
  getMiniPosition: () => MiniPlayerPosition | null;
  setMiniPosition: (position: MiniPlayerPosition) => void;
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
  const [trayPause] = useState(() => createSubscribableStore(false));
  const miniPositionRef = useRef<MiniPlayerPosition | null>(null);
  const onPlayerRoute = useMatch('/player/*') !== null;

  const launch = useCallback(
    (next: PlayerSessionLaunch, preserveTrayPause = false) => {
      if (!preserveTrayPause) trayPause.publish(false);
      const key = buildSessionKey(next);
      if (pendingLoadingAction?.sessionKey !== key) pendingLoadingAction = null;
      setSession((previous) => {
        // Same key: refresh state/path in place so the mounted player does not remount.
        if (previous && previous.key === key) {
          return { ...previous, state: next.state, playerPath: next.playerPath };
        }
        return { ...next, key };
      });
    },
    [trayPause],
  );

  const close = useCallback(() => {
    pendingLoadingAction = null;
    setSession(null);
  }, []);

  const getMiniPosition = useCallback(() => miniPositionRef.current, []);
  const setMiniPosition = useCallback((position: MiniPlayerPosition) => {
    miniPositionRef.current = position;
  }, []);

  const presentation: PlayerPresentation | null = session
    ? onPlayerRoute
      ? 'expanded'
      : 'mini'
    : null;

  const value = useMemo<PlayerSessionContextValue>(
    () => ({
      session,
      presentation,
      launch,
      close,
      getMiniPosition,
      setMiniPosition,
      trayPause,
    }),
    [session, presentation, launch, close, getMiniPosition, setMiniPosition, trayPause],
  );

  return <PlayerSessionContext value={value}>{children}</PlayerSessionContext>;
}

/** Route state for expanding a docked session, with an updated Back destination. */
export function expandedSessionState(session: PlayerSessionLaunch, from: string) {
  const state = typeof session.state === 'object' && session.state !== null ? session.state : {};
  return { ...state, from };
}

export function usePlayerSession(): PlayerSessionContextValue {
  const context = use(PlayerSessionContext);
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
    launch(
      { type, id, season, episode, state: location.state, playerPath: location.pathname },
      location.state?.preserveTrayPause === true,
    );
  }, [launch, type, id, season, episode, location.state, location.pathname]);

  return null;
}

const LazyPlayer = lazy(() => routeChunks.player().then((m) => ({ default: m.Player })));

export interface PlayerLoadingActions {
  chooseStream: () => void;
  back: () => void;
}

/** The mounted player's live loading state; the host renders the one loading screen from it. */
interface PlayerLoadingView {
  sessionKey: string;
  backdropMounted: boolean;
  backdropExiting: boolean;
  cardMounted: boolean;
  cardExiting: boolean;
  headline: string;
  detail: string | undefined;
  stageIndex: number;
  context: string | undefined;
  actions: RefObject<PlayerLoadingActions | null>;
}

const playerLoadingStore = createSubscribableStore<PlayerLoadingView | null>(null);
let pendingLoadingAction: { sessionKey: string; action: keyof PlayerLoadingActions } | null = null;

function runPlayerLoadingAction(sessionKey: string, action: keyof PlayerLoadingActions) {
  const view = playerLoadingStore.getSnapshot();
  const actions = view?.sessionKey === sessionKey ? view.actions.current : null;
  if (actions) actions[action]();
  // Clicked before the player chunk mounted: replayed once the player publishes.
  else pendingLoadingAction = { sessionKey, action };
}

/** Called after every player commit; unchanged views skip the host re-render. */
export function publishPlayerLoading(view: PlayerLoadingView) {
  const previous = playerLoadingStore.getSnapshot();
  const keys = Object.keys(view) as (keyof PlayerLoadingView)[];
  if (!previous || keys.some((key) => previous[key] !== view[key])) {
    playerLoadingStore.publish(view);
  }
  const pending = pendingLoadingAction;
  if (pending?.sessionKey !== view.sessionKey) return;
  pendingLoadingAction = null;
  // A click meant for the card is dropped if the card is gone on arrival (mini, PiP, error).
  if (view.cardMounted)
    window.setTimeout(() => {
      const current = playerLoadingStore.getSnapshot();
      if (
        current?.sessionKey === pending.sessionKey &&
        current.actions === view.actions &&
        current.cardMounted
      ) {
        current.actions.current?.[pending.action]();
      }
    }, 0);
}

export function clearPlayerLoading(sessionKey: string) {
  if (playerLoadingStore.getSnapshot()?.sessionKey === sessionKey) playerLoadingStore.publish(null);
}

/** Root-level mount outside the routed outlet — leaving /player minimizes instead of unmounting. */
export function PlayerHost() {
  const { session, presentation } = usePlayerSession();
  const published = useSyncExternalStore(
    playerLoadingStore.subscribe,
    playerLoadingStore.getSnapshot,
  );
  const launch = session ? resolvePlayerLaunch(session) : null;
  // Shares the player's details entry, so the fetch overlaps the chunk load and every launch path brands the card with the logo.
  const { data: details, isLoading: isLoadingDetails } = useQuery({
    ...api.detailsQueryOptions(launch?.effectiveResolveMediaType ?? 'movie', launch?.id),
    enabled: !!launch?.type && !!launch.id,
  });
  if (!session || !launch) return null;
  const expanded = presentation === 'expanded';
  const live = published?.sessionKey === session.key ? published : null;
  // Before the player chunk mounts, the same screen runs from the launch route at the starting stage.
  const logo = launch.logo || details?.logo;
  const backdropMounted = live ? live.backdropMounted : true;
  const cardMounted = live ? live.cardMounted : true;
  return (
    <>
      {/* Ahead of the player so every player overlay still paints above the artwork. */}
      {expanded && backdropMounted && (
        <div
          className={cn(
            // Quick in so a stream swap lands on artwork, not mpv's blank frame; slow out so the first frame dissolves in.
            'fixed inset-0 z-0 transition-opacity motion-reduce:transition-none motion-reduce:animate-none',
            !live && 'bg-black',
            live?.backdropExiting
              ? 'opacity-0 duration-500 pointer-events-none'
              : 'opacity-100 duration-150 animate-in fade-in',
          )}
        >
          {isHttpUrl(launch.backdrop) && (
            <>
              <RemoteImage
                src={launch.backdrop}
                className='w-full h-full object-cover opacity-50'
                alt=''
                loading='eager'
              />
              <div className='absolute inset-0 bg-black/50 backdrop-blur-xs' />
            </>
          )}
        </div>
      )}
      <Suspense
        fallback={
          expanded && (
            // Same rail the player mounts, so the sidebar never blinks out while the chunk loads.
            <>
              <Sidebar className='fixed left-0 top-0 z-70 flex' />
              <DesktopTitlebar className='bg-linear-to-b from-black/70 via-black/35 to-transparent' />
            </>
          )
        }
      >
        <LazyPlayer key={session.key} />
      </Suspense>
      {expanded && cardMounted && (
        <PlayerLoadingOverlay
          headline={live ? live.headline : 'Preparing playback'}
          detail={live?.detail}
          stageIndex={live ? live.stageIndex : 0}
          logo={logo}
          logoPending={!logo && isLoadingDetails}
          title={launch.title}
          context={
            live
              ? live.context
              : formatPlaybackLanding(
                  launch.routeAbsoluteSeason,
                  launch.routeAbsoluteEpisode,
                  launch.startTime,
                )
          }
          exiting={live?.cardExiting}
          onChooseStream={() => runPlayerLoadingAction(session.key, 'chooseStream')}
          onBack={() => runPlayerLoadingAction(session.key, 'back')}
        />
      )}
    </>
  );
}
