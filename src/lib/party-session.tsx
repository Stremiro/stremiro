import { listen } from '@tauri-apps/api/event';
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { replaceEqualDeep } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { PartyChatToasts } from '@/components/party-chat-toasts';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useProfileAvatar } from '@/hooks/use-local-profile';
import { api, getErrorMessage } from '@/lib/api';
import { isTauriDesktopRuntime } from '@/lib/app-updater';
import { buildEpisodeStreamTarget, findEpisodeByCoordinates } from '@/lib/episode-stream-target';
import {
  PARTY_INVITE_PREFIX,
  partyApi,
  partyMediaKey,
  type PartyMedia,
  type PartySnapshot,
} from '@/lib/party-api';
import { launchResolvedStream, resolvePlayerRouteMediaType } from '@/lib/player-navigation';
import { usePlayerSession } from '@/lib/player-session';
import { resolvePlayerStream, type PlayerStreamRequest } from '@/lib/resolve-player-stream';

const EMPTY: PartySnapshot = {
  session: '',
  revision: 0,
  active: false,
  creator: false,
  locked: false,
  syncing: false,
  members: [],
  chat: [],
  playback: null,
  playbackIsLocal: false,
  playbackBy: null,
  error: null,
};
type PartyContextValue = {
  room: PartySnapshot;
  busy: boolean;
  connectionError: string | null;
  watching: boolean;
  panelOpen: boolean;
  /** Chat messages from others that arrived while the room was out of view. */
  unread: number;
  controlEpoch: RefObject<number>;
  isControlPending: () => boolean;
  beginControl: () => () => void;
  setPanelOpen: (open: boolean) => void;
  create: () => Promise<void>;
  confirmJoin: (invite: string) => Promise<void>;
  watch: () => Promise<void>;
  share: () => Promise<void>;
  leave: () => Promise<void>;
};
const PartyContext = createContext<PartyContextValue | null>(null);

type PlayerCoordinates = { type?: string; id?: string; season?: string; episode?: string };

const routeCoordinate = (value: string | undefined) => (value ? Number(value) : null);

/** Compares route params the way the player parses them (canonical type,
    numeric season/episode); the opaque id stays exact. */
export function playerMatchesMedia(
  player: PlayerCoordinates | null | undefined,
  media: PartyMedia | null | undefined,
): boolean {
  return (
    !!player &&
    !!media &&
    resolvePlayerRouteMediaType(player.type) === media.mediaType &&
    player.id === media.mediaId &&
    routeCoordinate(player.season) === media.season &&
    routeCoordinate(player.episode) === media.episode
  );
}

export function describePartyStatus(people: number, unread: number): string {
  const members = `${people} ${people === 1 ? 'person' : 'people'} in the room`;
  return unread > 0
    ? `${members}, ${unread} new ${unread === 1 ? 'message' : 'messages'}`
    : members;
}

export function PartyProvider({ children }: { children: ReactNode }) {
  const [room, setRoom] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [pendingInvite, setPendingInvite] = useState<string | null>(null);
  const identity = useProfileAvatar();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { session: playerSession } = usePlayerSession();
  const playerRef = useRef(playerSession);
  playerRef.current = playerSession;
  const roomRef = useRef(room);
  roomRef.current = room;
  const operationRef = useRef(false);
  const inviteEpoch = useRef(0);
  const watchEpoch = useRef(0);
  const controlEpoch = useRef(0);
  const pendingControls = useRef(0);
  const previousMedia = useRef('');
  const sentName = useRef('');
  const seenChat = useRef<string | undefined>(undefined);
  const inviteOpener = useRef<HTMLElement | null>(null);
  const displayName = Array.from(identity?.username ?? 'Guest')
    .slice(0, 32)
    .join('');
  const beginControl = useCallback(() => {
    controlEpoch.current += 1;
    pendingControls.current += 1;
    return () => {
      pendingControls.current -= 1;
    };
  }, []);
  const isControlPending = useCallback(() => pendingControls.current > 0, []);

  const viewing = panelOpen || pathname === '/party';
  if (viewing) seenChat.current = room.chat.at(-1)?.id;
  const selfId = room.members.find((member) => member.you)?.id;
  const seenIndex = room.chat.findIndex((message) => message.id === seenChat.current);
  const unread = viewing
    ? 0
    : room.chat.reduce(
        (count, message, index) => count + Number(index > seenIndex && message.memberId !== selfId),
        0,
      );
  const mediaKey = partyMediaKey(room.playback?.media);

  const adopt = useCallback((next: PartySnapshot) => {
    setRoom((current) =>
      next.revision <= current.revision ? current : replaceEqualDeep(current, next),
    );
  }, []);

  const confirmJoin = useCallback(async (invite: string, isCurrent: () => boolean = () => true) => {
    // A create/join is in flight — surface the drop instead of silently
    // swallowing the invite (deep links give no other feedback).
    if (operationRef.current) {
      toast.info('A room action is already in progress. Open the invite again in a moment.');
      return;
    }
    const epoch = ++inviteEpoch.current;
    const current = () => epoch === inviteEpoch.current && isCurrent() && !operationRef.current;
    try {
      await partyApi.inspect(invite);
    } catch (error) {
      if (current()) throw error;
      return;
    }
    if (current()) {
      setConnectionError(null);
      setPendingInvite(invite.trim());
    }
  }, []);
  const dismissInvite = () => {
    inviteEpoch.current += 1;
    setPendingInvite(null);
  };

  useEffect(() => {
    if (!isTauriDesktopRuntime()) return;
    let disposed = false;
    const disposers: (() => void)[] = [];
    const register = (dispose: () => void) => {
      if (disposed) dispose();
      else disposers.push(dispose);
    };
    const handleUrls = (urls: string[]) => {
      if (disposed) return;
      const invite = urls.find((url) => url.startsWith(PARTY_INVITE_PREFIX));
      if (invite)
        void confirmJoin(invite, () => !disposed).catch(() => {
          if (!disposed) toast.error('This party invite is invalid or unsupported.');
        });
    };
    void listen<PartySnapshot>('party://event', (event) => {
      if (!disposed) adopt(event.payload);
    })
      .then(async (dispose) => {
        register(dispose);
        const snapshot = await partyApi.snapshot();
        if (!disposed) adopt(snapshot);
      })
      .catch(() => {
        if (!disposed) toast.error('Watch Together could not connect to the app.');
      });
    void onOpenUrl(handleUrls)
      .then(async (dispose) => {
        register(dispose);
        const urls = await getCurrent();
        if (!disposed && urls) handleUrls(urls);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      inviteEpoch.current += 1;
      watchEpoch.current += 1;
      controlEpoch.current += 1;
      disposers.forEach((dispose) => dispose());
    };
  }, [adopt, confirmJoin]);

  const start = useCallback(
    async (invite?: string) => {
      if (operationRef.current) return;
      operationRef.current = true;
      inviteEpoch.current += 1;
      setBusy(true);
      setConnectionError(null);
      try {
        sentName.current = displayName;
        const next = invite
          ? await partyApi.join(displayName, invite)
          : await partyApi.create(displayName);
        adopt(next);
        setPendingInvite(null);
        navigate('/party');
        if (invite) {
          toast.success('Joined the watch party', {
            description: 'Choose Watch together to start playback.',
          });
        } else {
          try {
            await navigator.clipboard.writeText(await partyApi.invite(next.session));
            toast.success('Room created', {
              description: 'Invite copied — send it to friends, then press play on any title.',
            });
          } catch {
            toast.success('Room created', {
              description: 'Use the Invite button to bring friends in, then play any title.',
            });
          }
        }
      } catch (error) {
        setConnectionError(getErrorMessage(error));
      } finally {
        operationRef.current = false;
        setBusy(false);
      }
    },
    [adopt, displayName, navigate],
  );

  const leave = useCallback(async () => {
    const { session, creator } = roomRef.current;
    try {
      await partyApi.leave(session);
    } catch (error) {
      if (roomRef.current.active && roomRef.current.session === session) throw error;
      return;
    }
    toast.success(creator ? 'Room closed' : 'You left the room');
  }, []);

  const watch = useCallback(async () => {
    const current = roomRef.current;
    const playback = current.playback;
    if (!current.active || !playback) return;
    const targetMediaKey = partyMediaKey(playback.media);
    const epoch = ++watchEpoch.current;
    const currentPlayer = playerRef.current;
    setWatching(true);
    const isCurrent = () =>
      watchEpoch.current === epoch &&
      roomRef.current.active &&
      roomRef.current.session === current.session &&
      playerRef.current?.key === currentPlayer?.key &&
      partyMediaKey(roomRef.current.playback?.media) === targetMediaKey;
    try {
      const { media } = playback;
      if (currentPlayer && playerMatchesMedia(currentPlayer, media)) {
        await partyApi.follow(current.session, false);
        if (!isCurrent()) return;
        navigate(currentPlayer.playerPath, { state: currentPlayer.state });
        setPanelOpen(false);
        return;
      }
      const details = await api.getMediaDetails(media.mediaType, media.mediaId);
      if (!isCurrent()) return;
      const episode = findEpisodeByCoordinates(
        details.episodes ?? [],
        media.season ?? undefined,
        media.episode ?? undefined,
      );
      if (media.episode !== null && !episode)
        throw new Error('This episode is not available from your addons.');
      const request: PlayerStreamRequest = {
        mediaType: media.mediaType,
        mediaId: media.mediaId,
        title: details.title,
        streamLookupId: details.imdbId ?? media.mediaId,
        ...(episode ? buildEpisodeStreamTarget(details.imdbId ?? media.mediaId, episode) : {}),
      };
      let preferredKey: string | null = null;
      if (playback.matchable) {
        preferredKey = await partyApi.matchStream(current.session, request);
        if (!isCurrent()) return;
      }
      const resolved = await resolvePlayerStream({
        ...request,
        preferred: preferredKey ? { streamKey: preferredKey } : undefined,
      });
      if (!isCurrent()) return;
      const startMs = await partyApi.follow(current.session, false);
      if (!isCurrent()) return;
      launchResolvedStream(navigate, request, resolved, {
        from: '/party',
        poster: details.poster,
        backdrop: details.backdrop,
        logo: details.logo,
        // A positive start suppresses the history resume and lands near the
        // room clock; correction seeks need a known duration, so unknown-
        // duration streams rely on this start alone.
        startTime: Math.max(1, (startMs ?? 0) / 1000),
      });
      setPanelOpen(false);
    } catch (error) {
      if (isCurrent()) throw error;
    } finally {
      if (watchEpoch.current === epoch) setWatching(false);
    }
  }, [navigate]);

  const onMediaChange = useEffectEvent(() => {
    if (
      previousMedia.current &&
      previousMedia.current !== mediaKey &&
      room.active &&
      room.syncing &&
      !room.playbackIsLocal &&
      playerSession &&
      room.playback &&
      !playerMatchesMedia(playerSession, room.playback.media)
    ) {
      void watch().catch((error: unknown) => toast.error(getErrorMessage(error)));
    }
    previousMedia.current = mediaKey;
  });
  useEffect(() => {
    previousMedia.current = '';
    // Chat ids are per-room — a stale marker from an earlier session would
    // misalign the unread index on the new room's history.
    seenChat.current = undefined;
    if (!room.active) setPanelOpen(false);
  }, [room.session, room.active]);
  // The join/create hello already carries the start name; only send edits.
  useEffect(() => {
    if (!room.active || sentName.current === displayName) return;
    sentName.current = displayName;
    void partyApi.name(room.session, displayName).catch(() => undefined);
  }, [room.active, room.session, displayName]);
  useLayoutEffect(() => {
    watchEpoch.current += 1;
    controlEpoch.current += 1;
    setWatching(false);
  }, [room.session, room.active, mediaKey, playerSession?.key]);
  useEffect(() => {
    const timer = setTimeout(onMediaChange, 400);
    return () => clearTimeout(timer);
  }, [mediaKey]);
  useEffect(() => {
    if (room.error) toast.error(room.error);
  }, [room.error]);

  const value = useMemo<PartyContextValue>(
    () => ({
      room,
      busy,
      connectionError,
      watching,
      panelOpen,
      unread,
      controlEpoch,
      isControlPending,
      beginControl,
      setPanelOpen,
      create: () => start(),
      confirmJoin,
      watch,
      share: async () => {
        // An in-flight Watch would follow the room after this takeover.
        watchEpoch.current += 1;
        setWatching(false);
        const finishControl = beginControl();
        try {
          await partyApi.follow(room.session, true);
        } finally {
          finishControl();
        }
      },
      leave,
    }),
    [
      room,
      busy,
      connectionError,
      watching,
      panelOpen,
      unread,
      start,
      confirmJoin,
      watch,
      beginControl,
      isControlPending,
      leave,
    ],
  );

  return (
    <PartyContext.Provider value={value}>
      {children}
      <PartyChatToasts />
      <Dialog
        open={pendingInvite !== null}
        onOpenChange={(open) => {
          if (!open && !busy) dismissInvite();
        }}
      >
        <DialogContent
          className='z-[100] max-w-sm rounded-2xl border-white/[0.08] bg-zinc-950 p-6 text-white'
          overlayClassName='z-[99]'
          // Opened programmatically (paste, OS link), so there is no trigger
          // for Radix to restore focus to.
          onOpenAutoFocus={() => {
            inviteOpener.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            if (!inviteOpener.current?.isConnected) return;
            event.preventDefault();
            inviteOpener.current.focus({ preventScroll: true });
          }}
        >
          <DialogHeader>
            <DialogTitle className='font-medium'>Join watch party</DialogTitle>
            <DialogDescription className='text-white/50'>
              You’ll join as <span className='text-white/85'>{displayName}</span>. Then choose Watch
              together to play the room’s title through your own addons.
            </DialogDescription>
          </DialogHeader>
          {room.active ? (
            <p className='text-sm text-white/65'>Leave your current room before joining another.</p>
          ) : (
            <details className='text-xs text-white/40'>
              <summary className='w-fit cursor-pointer rounded-sm py-1 hover:text-white/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30'>
                Privacy details
              </summary>
              <p className='mt-2 leading-relaxed'>
                Chat is encrypted and only room members can read it. Members never see your IP
                address — only the relay that connects the room does. Anyone with this invite can
                join an unlocked room.
              </p>
            </details>
          )}
          {connectionError && (
            <p role='alert' className='text-sm leading-relaxed text-amber-200/80'>
              {connectionError}
            </p>
          )}
          <DialogFooter>
            <Button variant='ghost' disabled={busy} onClick={dismissInvite}>
              Cancel
            </Button>
            {room.active ? (
              <Button
                variant='accent'
                onClick={() => {
                  dismissInvite();
                  navigate('/party');
                }}
              >
                Go to current room
              </Button>
            ) : (
              <Button
                variant='accent'
                disabled={busy}
                onClick={() => void start(pendingInvite ?? undefined)}
              >
                {busy ? 'Joining…' : connectionError ? 'Try again' : 'Join room'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PartyContext.Provider>
  );
}

export function useParty() {
  const context = useContext(PartyContext);
  if (!context) throw new Error('useParty must be used within PartyProvider');
  return context;
}
