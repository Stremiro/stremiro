import {
  Calendar,
  Home,
  Loader2,
  type LucideIcon,
  Popcorn,
  Search,
  Settings,
  User,
} from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { ProfileAvatar } from '@/components/profile-avatar';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useAppUpdater } from '@/hooks/use-app-updater';
import { useProfileAvatar } from '@/hooks/use-local-profile';
import { describePartyStatus, useParty } from '@/lib/party-session';
import { routeChunks } from '@/lib/route-chunks';
import { cn } from '@/lib/utils';

interface SidebarProps {
  className?: string;
  playerMode?: boolean;
}

interface SidebarNavItem {
  href: string;
  icon: LucideIcon;
  label: string;
  /** Defaults to an exact pathname match on `href`. */
  matches?: (pathname: string) => boolean;
}

const SETTINGS_HREF = '/settings';
const PROFILE_HREF = '/profile';
const PARTY_HREF = '/party';

const PRIMARY_NAV_ITEMS: SidebarNavItem[] = [
  { icon: Home, label: 'Home', href: '/' },
  { icon: Search, label: 'Search', href: '/search' },
  { icon: Popcorn, label: 'Watch Together (Beta)', href: PARTY_HREF },
  { icon: Calendar, label: 'Calendar', href: '/calendar' },
];

const SECONDARY_NAV_ITEMS: SidebarNavItem[] = [
  { icon: Settings, label: 'Settings', href: SETTINGS_HREF },
  {
    icon: User,
    label: 'Profile',
    href: PROFILE_HREF,
    matches: (pathname) => pathname === PROFILE_HREF || pathname === '/library',
  },
];

// Warm the target page's lazy chunk on hover/focus so the click paints
// instantly instead of waiting on a Suspense fallback. Loaders are shared
// with App's lazy() routes via routeChunks so they hit the same chunks.
const ROUTE_CHUNK_WARMERS: Record<string, () => Promise<unknown>> = {
  '/search': routeChunks.search,
  '/calendar': routeChunks.calendar,
  [PARTY_HREF]: routeChunks.party,
  [SETTINGS_HREF]: routeChunks.settings,
  [PROFILE_HREF]: routeChunks.profile,
};

function warmRouteChunk(href: string): void {
  void ROUTE_CHUNK_WARMERS[href]?.().catch(() => undefined);
}

export const Sidebar = memo(function Sidebar({ className, playerMode }: SidebarProps) {
  const { pathname } = useLocation();
  const { isUpdateAvailable, pendingUpdate } = useAppUpdater();
  const identity = useProfileAvatar();
  const { room, busy, unread, panelOpen, setPanelOpen } = useParty();
  const updateTooltip = pendingUpdate?.version
    ? `Update ${pendingUpdate.version} available`
    : 'Update available';
  const partyStatus = room.active
    ? describePartyStatus(room.members.length, unread)
    : busy
      ? 'Connecting to room'
      : undefined;

  const renderItem = (item: SidebarNavItem) => {
    const showUpdate = item.href === SETTINGS_HREF && isUpdateAvailable;
    const avatar = item.href === PROFILE_HREF ? identity?.avatar : undefined;
    const status = item.href === PARTY_HREF ? partyStatus : undefined;
    const opensParty = playerMode && room.active && item.href === PARTY_HREF;
    return (
      <SidebarNavButton
        key={item.href}
        item={item}
        isActive={opensParty ? panelOpen : (item.matches?.(pathname) ?? pathname === item.href)}
        onOpen={opensParty ? () => setPanelOpen(!panelOpen) : undefined}
        playerMode={playerMode}
        updateAvailable={showUpdate}
        status={status}
        badge={
          item.href === PARTY_HREF && room.active && (!playerMode || unread > 0) ? (
            <PartyNavBadge unread={unread} />
          ) : undefined
        }
        tooltip={showUpdate ? updateTooltip : undefined}
        icon={
          item.href === PARTY_HREF && busy && !room.active ? (
            <Loader2 aria-hidden='true' className='animate-spin motion-reduce:animate-none' />
          ) : avatar && identity ? (
            <ProfileAvatar
              name={identity.username}
              avatar={avatar}
              className='h-[26px] w-[26px] ring-1 ring-white/15'
              fallbackClassName='bg-zinc-800 text-[11px] font-bold'
            />
          ) : undefined
        }
      />
    );
  };

  const logo = (
    <img
      src='/stremiro.ico'
      alt=''
      aria-hidden='true'
      loading='eager'
      decoding='async'
      className={playerMode ? 'h-6 w-6 opacity-50' : 'h-7 w-7'}
    />
  );

  return (
    <TooltipProvider delayDuration={0}>
      <div
        className={cn(
          'w-[60px] h-screen shrink-0 cursor-auto flex flex-col items-center pt-8 pb-4 z-50 pointer-events-none transition-colors duration-300',
          playerMode && 'backdrop-blur-[2px]',
          className,
        )}
      >
        <div className='w-full px-2 pb-5 pointer-events-auto'>
          {playerMode ? (
            <div className='flex h-10 w-full items-center justify-center'>{logo}</div>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  to='/'
                  aria-label='Open Stremiro home'
                  className='group flex h-11 w-full items-center justify-center transition-all duration-200 hover:scale-105 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30'
                >
                  {logo}
                </Link>
              </TooltipTrigger>
              <TooltipContent side='right'>Stremiro</TooltipContent>
            </Tooltip>
          )}
        </div>

        <nav
          aria-label='Primary'
          className='flex-1 flex flex-col gap-2.5 w-full px-2 pointer-events-auto'
        >
          {PRIMARY_NAV_ITEMS.map(renderItem)}
        </nav>

        <div className='flex flex-col gap-2.5 mt-auto w-full px-2 pb-4 pointer-events-auto'>
          {SECONDARY_NAV_ITEMS.map(renderItem)}
        </div>
      </div>
    </TooltipProvider>
  );
});

const NAV_DOT_CLASS = 'absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-emerald-400';

// Live room: a quiet dot; unread chat: an accent count the user can act on.
function PartyNavBadge({ unread }: { unread: number }) {
  if (unread === 0) return <span aria-hidden='true' className={NAV_DOT_CLASS} />;
  return (
    <span
      aria-hidden='true'
      className='absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-(--accent-act) px-1 text-[10px] font-bold leading-none tabular-nums text-(--on-accent-act) ring-2 ring-zinc-950'
    >
      {unread > 9 ? '9+' : unread}
    </span>
  );
}

interface SidebarNavButtonProps {
  badge?: ReactNode;
  icon?: ReactNode;
  isActive: boolean;
  item: SidebarNavItem;
  onOpen?: () => void;
  playerMode?: boolean;
  /** Live state appended to the label for the tooltip and accessible name. */
  status?: string;
  tooltip?: string;
  updateAvailable?: boolean;
}

function SidebarNavButton({
  badge,
  icon,
  isActive,
  item,
  onOpen,
  playerMode,
  status,
  tooltip,
  updateAvailable,
}: SidebarNavButtonProps) {
  const content = (
    <>
      {icon ?? <item.icon strokeWidth={1.75} />}
      {updateAvailable ? <span className={NAV_DOT_CLASS} /> : badge}
    </>
  );
  // Dialog mode names the action (parity with the player party badge);
  // nav links keep the destination name.
  const label = onOpen
    ? `Open watch party${status ? `, ${status}` : ''}`
    : status
      ? `${item.label}, ${status}`
      : item.label;
  return (
    <div className='relative flex w-full justify-center'>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            asChild
            variant='ghost'
            size='icon'
            data-party-entry={item.href === PARTY_HREF ? '' : undefined}
            style={
              isActive
                ? { backgroundColor: 'var(--accent-nav)', color: 'var(--on-accent-nav)' }
                : undefined
            }
            className={cn(
              'relative h-11 w-full overflow-hidden rounded-lg transition-colors duration-150 group [&_svg]:size-[22px]',
              !isActive &&
                (updateAvailable
                  ? 'bg-emerald-500/[0.06] text-emerald-200/80 hover:bg-emerald-500/[0.10] hover:text-emerald-200'
                  : playerMode
                    ? 'text-white/60 hover:bg-white/[0.08] hover:text-white/90'
                    : 'text-white/50 hover:bg-white/[0.08] hover:text-white/90'),
            )}
          >
            {onOpen ? (
              <button
                type='button'
                aria-label={label}
                aria-haspopup='dialog'
                aria-expanded={isActive}
                onClick={onOpen}
              >
                {content}
              </button>
            ) : (
              <Link
                to={item.href}
                aria-label={label}
                aria-current={isActive ? 'page' : undefined}
                onPointerEnter={() => warmRouteChunk(item.href)}
                onFocus={() => warmRouteChunk(item.href)}
              >
                {content}
              </Link>
            )}
          </Button>
        </TooltipTrigger>
        {!onOpen && (
          <TooltipContent side='right'>
            {tooltip ?? (status ? `${item.label} · ${status}` : item.label)}
          </TooltipContent>
        )}
      </Tooltip>
    </div>
  );
}
