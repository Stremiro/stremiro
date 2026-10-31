import { useQueryClient } from '@tanstack/react-query';
import { Calendar, Home, type LucideIcon, Search, Settings, User } from 'lucide-react';
import { memo, type MouseEvent, type ReactNode, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router';
import { ProfileAvatar } from '@/components/profile-avatar';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useAppUpdater } from '@/hooks/use-app-updater';
import { useProfileAvatar } from '@/hooks/use-local-profile';
import {
  playbackLanguagePreferencesQueryOptions,
  supportedLanguagesQueryOptions,
} from '@/hooks/use-playback-language-preferences';
import { SLIDING_ACCENT_BAR_CLASS, useSlidingIndicator } from '@/hooks/use-sliding-indicator';
import { api } from '@/lib/api';
import { focusSearchInput } from '@/lib/dom';
import { currentPathWithSearch } from '@/lib/navigation';
import { routeChunks } from '@/lib/route-chunks';
import { prefetchSearchCatalog } from '@/lib/search-catalog';
import { lastSearchFacets, lastSearchPath } from '@/lib/search-page-state';
import { cn, scrollBehavior } from '@/lib/utils';

interface SidebarProps {
  className?: string;
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
const SEARCH_HREF = '/search';
const NAV_ACTIVE_SURFACE_CLASS = 'bg-white/[0.06] shadow-[inset_0_1px_0_rgb(255_255_255/0.08)]';

const PRIMARY_NAV_ITEMS: SidebarNavItem[] = [
  { icon: Home, label: 'Home', href: '/' },
  { icon: Search, label: 'Search', href: SEARCH_HREF },
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

// Warm the target's lazy chunk on hover/focus; loaders are shared with App's
// lazy() routes via routeChunks so they hit the same chunks.
const ROUTE_CHUNK_WARMERS: Record<string, () => Promise<unknown>> = {
  [SEARCH_HREF]: routeChunks.search,
  '/calendar': routeChunks.calendar,
  [SETTINGS_HREF]: routeChunks.settings,
  [PROFILE_HREF]: routeChunks.profile,
};

function warmRouteChunk(href: string): void {
  void ROUTE_CHUNK_WARMERS[href]?.().catch(() => undefined);
}

function isNavItemActive(item: SidebarNavItem, pathname: string) {
  const normalizedPathname = pathname.replace(/\/+$/, '') || '/';
  return item.matches?.(normalizedPathname) ?? normalizedPathname === item.href;
}

function useNavIndicator(items: SidebarNavItem[], pathname: string) {
  const navRef = useRef<HTMLElement>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const activeHref = items.find((item) => isNavItemActive(item, pathname))?.href;
  const indicator = useSlidingIndicator(activeHref, navRef, itemRefs);

  return { navRef, itemRefs, activeHref, indicator };
}

function SidebarNavIndicator({
  indicator,
  activeHref,
}: Omit<ReturnType<typeof useNavIndicator>, 'navRef'>) {
  if (!indicator) return null;
  return (
    <>
      <span
        aria-hidden='true'
        className={cn(
          'nav-sliding-pill pointer-events-none absolute left-0 top-0 rounded-lg',
          NAV_ACTIVE_SURFACE_CLASS,
        )}
        style={{
          width: indicator.width,
          height: indicator.height,
          transform: `translate3d(${indicator.left}px, ${indicator.top}px, 0)`,
          opacity: activeHref ? 1 : 0,
        }}
      />
      <span
        aria-hidden='true'
        className={SLIDING_ACCENT_BAR_CLASS}
        style={{
          height: indicator.height - 20,
          transform: `translate3d(0, ${indicator.top + 10}px, 0)`,
          opacity: activeHref ? 1 : 0,
        }}
      />
    </>
  );
}

// One rendering for browse and player — the player mounts its own copy, so any
// visual difference reads as the rail jumping when playback opens.
export const Sidebar = memo(function Sidebar({ className }: SidebarProps) {
  const { pathname } = useLocation();
  const queryClient = useQueryClient();
  const { isUpdateAvailable, pendingUpdate } = useAppUpdater();
  const identity = useProfileAvatar();
  const updateTooltip = pendingUpdate?.version
    ? `Update v${pendingUpdate.version} available`
    : 'Update available';
  const { navRef: primaryNavRef, ...primaryNav } = useNavIndicator(PRIMARY_NAV_ITEMS, pathname);
  const { navRef: secondaryNavRef, ...secondaryNav } = useNavIndicator(
    SECONDARY_NAV_ITEMS,
    pathname,
  );
  // Discover is the usual second stop: warm its chunk once launch work goes idle.
  useEffect(() => {
    if (!('requestIdleCallback' in window)) return;
    const handle = window.requestIdleCallback(() => warmRouteChunk(SEARCH_HREF), {
      timeout: 5_000,
    });
    return () => window.cancelIdleCallback(handle);
  }, []);

  const renderItem = (
    item: SidebarNavItem,
    group: Omit<ReturnType<typeof useNavIndicator>, 'navRef'>,
  ) => {
    const showUpdate = item.href === SETTINGS_HREF && isUpdateAvailable;
    const avatar = item.href === PROFILE_HREF ? identity?.avatar : undefined;
    const isActive = group.activeHref === item.href;
    const isSearch = item.href === SEARCH_HREF;
    return (
      <SidebarNavButton
        key={item.href}
        item={item}
        // Search reopens the last URL; other items keep their static href.
        to={isSearch ? lastSearchPath() : item.href}
        isActive={isActive}
        sharedIndicator={group.indicator !== null}
        itemRef={(node) => {
          if (node) group.itemRefs.current.set(item.href, node);
          else group.itemRefs.current.delete(item.href);
        }}
        updateAvailable={showUpdate}
        tooltip={showUpdate ? updateTooltip : undefined}
        onIntent={() => {
          warmRouteChunk(item.href);
          if (item.href === SETTINGS_HREF) {
            void queryClient.prefetchQuery(api.launchAtLoginQueryOptions());
            void queryClient.prefetchQuery(api.addonConfigsQueryOptions());
            void queryClient.prefetchQuery(playbackLanguagePreferencesQueryOptions);
            void queryClient.prefetchQuery(supportedLanguagesQueryOptions);
          }
          if (isSearch && navigator.onLine) {
            void prefetchSearchCatalog(queryClient, lastSearchFacets());
          }
        }}
        onClick={
          // Already there: Search re-focuses its box; other pages scroll to top. Anything with
          // filters or sections in the URL still navigates, which resets them.
          isActive
            ? (event) => {
                if (isSearch) {
                  event.preventDefault();
                  focusSearchInput();
                } else if (currentPathWithSearch() === item.href) {
                  event.preventDefault();
                  window.scrollTo({ top: 0, behavior: scrollBehavior() });
                }
              }
            : undefined
        }
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

  return (
    <TooltipProvider delayDuration={200} skipDelayDuration={300}>
      <div
        className={cn(
          'w-[60px] h-screen shrink-0 cursor-auto flex flex-col items-center pt-8 pb-4 z-50 pointer-events-none',
          className,
        )}
      >
        <div className='w-full px-2 pb-5 pointer-events-auto'>
          <div className='flex h-11 w-full items-center justify-center'>
            <img
              src='/stremiro.png'
              alt='Stremiro'
              loading='eager'
              decoding='async'
              draggable={false}
              className='h-7 w-7'
            />
          </div>
        </div>

        <nav
          ref={primaryNavRef}
          aria-label='Primary'
          className='relative isolate flex-1 flex flex-col gap-2.5 w-full px-2 pointer-events-auto'
        >
          <SidebarNavIndicator {...primaryNav} />
          {PRIMARY_NAV_ITEMS.map((item) => renderItem(item, primaryNav))}
        </nav>

        <nav
          ref={secondaryNavRef}
          aria-label='Secondary'
          className='relative isolate flex flex-col gap-2.5 mt-auto w-full px-2 pb-4 pointer-events-auto'
        >
          <SidebarNavIndicator {...secondaryNav} />
          {SECONDARY_NAV_ITEMS.map((item) => renderItem(item, secondaryNav))}
        </nav>
      </div>
    </TooltipProvider>
  );
});

const NAV_DOT_CLASS =
  'absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-emerald-400 ring-2 ring-black';

interface SidebarNavButtonProps {
  icon?: ReactNode;
  isActive: boolean;
  item: SidebarNavItem;
  itemRef?: (node: HTMLDivElement | null) => void;
  onClick?: (event: MouseEvent) => void;
  onIntent: () => void;
  sharedIndicator?: boolean;
  to: string;
  tooltip?: string;
  updateAvailable?: boolean;
}

function SidebarNavButton({
  icon,
  isActive,
  item,
  itemRef,
  onClick,
  onIntent,
  sharedIndicator,
  to,
  tooltip,
  updateAvailable,
}: SidebarNavButtonProps) {
  return (
    <div ref={itemRef} className='relative flex w-full justify-center'>
      <span
        aria-hidden='true'
        className='pointer-events-none absolute -left-2 top-[10px] h-6 w-[3px] rounded-r-full bg-(--accent-nav) transition-opacity duration-150'
        style={{ opacity: isActive && !sharedIndicator ? 1 : 0 }}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            asChild
            variant='ghost'
            size='icon'
            className={cn(
              'nav-switch-item relative h-11 w-full overflow-hidden rounded-lg [&_svg]:size-[22px]',
              isActive && 'text-(--accent-nav) hover:bg-transparent hover:text-(--accent-nav)',
              isActive && !sharedIndicator && NAV_ACTIVE_SURFACE_CLASS,
              !isActive &&
                'text-white/45 hover:bg-white/[0.04] hover:text-white/85 focus-visible:bg-white/[0.04] focus-visible:text-white/90',
            )}
          >
            <Link
              to={to}
              aria-label={item.label}
              aria-current={isActive ? 'page' : undefined}
              onPointerEnter={onIntent}
              onFocus={onIntent}
              onClick={onClick}
            >
              {icon ?? <item.icon aria-hidden='true' strokeWidth={isActive ? 2 : 1.75} />}
              {updateAvailable && <span className={NAV_DOT_CLASS} />}
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent side='right'>{tooltip ?? item.label}</TooltipContent>
      </Tooltip>
    </div>
  );
}
