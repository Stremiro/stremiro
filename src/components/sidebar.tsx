import { Calendar, Home, type LucideIcon, Search, Settings, User } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { ProfileAvatar } from '@/components/profile-avatar';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useAppUpdater } from '@/hooks/use-app-updater';
import { useProfileAvatar } from '@/hooks/use-local-profile';
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

const PRIMARY_NAV_ITEMS: SidebarNavItem[] = [
  { icon: Home, label: 'Home', href: '/' },
  { icon: Search, label: 'Search', href: '/search' },
  { icon: Calendar, label: 'Calendar', href: '/calendar' },
];

const SETTINGS_HREF = '/settings';
const PROFILE_HREF = '/profile';

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
  const updateTooltip = pendingUpdate?.version
    ? `Update ${pendingUpdate.version} available`
    : 'Update available';

  const renderItem = (item: SidebarNavItem) => {
    const showUpdate = item.href === SETTINGS_HREF && isUpdateAvailable;
    const avatar = item.href === PROFILE_HREF ? identity?.avatar : undefined;
    return (
      <SidebarNavButton
        key={item.href}
        item={item}
        isActive={item.matches?.(pathname) ?? pathname === item.href}
        playerMode={playerMode}
        updateAvailable={showUpdate}
        tooltip={showUpdate ? updateTooltip : undefined}
        icon={
          avatar && identity ? (
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
          'w-[60px] h-screen shrink-0 flex flex-col items-center pt-8 pb-4 z-50 pointer-events-none transition-colors duration-300',
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

interface SidebarNavButtonProps {
  icon?: ReactNode;
  isActive: boolean;
  item: SidebarNavItem;
  playerMode?: boolean;
  tooltip?: string;
  updateAvailable?: boolean;
}

function SidebarNavButton({
  icon,
  isActive,
  item,
  playerMode,
  tooltip,
  updateAvailable,
}: SidebarNavButtonProps) {
  return (
    <div className='relative flex w-full justify-center'>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            asChild
            variant='ghost'
            size='icon'
            style={
              isActive
                ? { backgroundColor: 'var(--accent-nav)', color: 'var(--on-accent-nav)' }
                : undefined
            }
            className={cn(
              'relative h-11 w-full overflow-hidden rounded-xl transition-colors duration-150 group [&_svg]:size-[22px]',
              isActive
                ? 'shadow-xs'
                : updateAvailable
                  ? 'bg-emerald-500/[0.06] text-emerald-200/80 hover:bg-emerald-500/[0.10] hover:text-emerald-200'
                  : playerMode
                    ? 'text-white/60 hover:bg-white/[0.08] hover:text-white/90'
                    : 'text-white/50 hover:bg-white/[0.08] hover:text-white/90',
            )}
          >
            <Link
              to={item.href}
              aria-label={item.label}
              aria-current={isActive ? 'page' : undefined}
              onPointerEnter={() => warmRouteChunk(item.href)}
              onFocus={() => warmRouteChunk(item.href)}
            >
              {icon ?? <item.icon strokeWidth={1.75} />}
              {updateAvailable ? (
                <span className='absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]' />
              ) : null}
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent side='right'>{tooltip ?? item.label}</TooltipContent>
      </Tooltip>
    </div>
  );
}
