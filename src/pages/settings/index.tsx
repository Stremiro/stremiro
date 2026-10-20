import {
  ChevronRight,
  Database,
  Keyboard,
  type LucideIcon,
  Palette,
  RefreshCw,
  Settings2,
  SlidersHorizontal,
  Zap,
} from 'lucide-react';
import {
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useSearchParams } from 'react-router';
import { ACCENT_PRESET_LABELS } from '@/components/accent-controls';
import { SearchInput } from '@/components/ui/search-input';
import { Skeleton } from '@/components/ui/skeleton';
import { useAppUpdater } from '@/hooks/use-app-updater';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { SLIDING_ACCENT_BAR_CLASS, useSlidingIndicator } from '@/hooks/use-sliding-indicator';
import { FIXED_PLAYER_SHORTCUTS, PLAYER_ACTIONS } from '@/lib/player-keybindings';
import { BROWSE_SHORTCUTS, CALENDAR_SHORTCUTS } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { AppearanceSettings, TINT_TARGETS } from './appearance';
import { SettingsBody, SettingsGroup } from './chrome';
import { DataSection } from './data';
import { GeneralSettings, START_PAGES } from './general';
import { PlaybackSettings } from './playback';
import { ShortcutsSection } from './shortcuts';
import { UpdatesSection } from './updates';

const StreamingSources = lazy(() =>
  import('./streaming').then((module) => ({ default: module.StreamingSources })),
);

interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  description: string;
  controls: readonly string[];
  component: ComponentType;
}

const NAV_ITEMS = [
  {
    id: 'general',
    component: GeneralSettings,
    label: 'General',
    icon: SlidersHorizontal,
    description: 'Start page, launch at login and tray behavior.',
    controls: [
      'Start page',
      ...START_PAGES.map((page) => page.label),
      'Launch at login',
      'Start minimized',
      'Close to tray',
      'Minimize to tray',
      'mouse back',
      'mouse forward',
      'titlebar',
      'hide to tray',
    ],
  },
  {
    id: 'addons',
    component: StreamingSources,
    label: 'Addons',
    icon: Zap,
    description: 'Install, enable and reorder addons.',
    controls: [
      'Addon manifest URL',
      'Add addon',
      'Copy addon link',
      'Remove',
      'Cinemeta',
      'OpenSubtitles',
    ],
  },
  {
    id: 'playback',
    component: PlaybackSettings,
    label: 'Playback',
    icon: Settings2,
    description: 'Languages, spoilers, trailers, auto-play and auto-skip.',
    controls: [
      'Audio',
      'Subtitles',
      'Auto',
      'Off',
      'Spoiler protection',
      'Trailer previews',
      'Auto-play next episode',
      'Next episode countdown',
      'Hide player controls after',
      'Auto-skip intros & recaps',
    ],
  },
  {
    id: 'appearance',
    component: AppearanceSettings,
    label: 'Appearance',
    icon: Palette,
    description: 'Accent color, glow and tint targets.',
    controls: [
      'Accent',
      'Reset',
      ...ACCENT_PRESET_LABELS,
      'Soft',
      'Vivid',
      'Custom accent color hex',
      'Pick a custom color',
      'Glow',
      'Background glow intensity',
      'Tint targets',
      ...TINT_TARGETS.map((target) => target.label),
    ],
  },
  {
    id: 'shortcuts',
    component: ShortcutsSection,
    label: 'Shortcuts',
    icon: Keyboard,
    description: 'Player, browse and Calendar keys.',
    controls: [
      'Customize keybindings',
      'Rebind key',
      'Reset all',
      ...PLAYER_ACTIONS.map((action) => action.label),
      ...FIXED_PLAYER_SHORTCUTS.map((row) => row.label),
      ...BROWSE_SHORTCUTS.map((row) => row.label),
      ...CALENDAR_SHORTCUTS.map((row) => row.label),
    ],
  },
  {
    id: 'updates',
    component: UpdatesSection,
    label: 'Updates',
    icon: RefreshCw,
    description: 'Check for and install app updates.',
    controls: [
      'Check for updates',
      'Check for updates automatically',
      'Last checked',
      'Check again',
      'Update & restart',
      'View on GitHub',
    ],
  },
  {
    id: 'data',
    component: DataSection,
    label: 'Data',
    icon: Database,
    description: 'Backups, storage and clearing local records.',
    controls: [
      'Backup & restore',
      'Export',
      'Import',
      'Clear local records',
      'Watch history',
      'Library',
      'Custom lists',
      'Watch statuses',
      'Clear',
      'Cancel',
      'Clear permanently',
    ],
  },
] as const satisfies readonly NavItem[];

type SectionId = (typeof NAV_ITEMS)[number]['id'];
const DEFAULT_SECTION: SectionId = NAV_ITEMS[0].id;
const SETTINGS_SECTION_QUERY_PARAM = 'section';
const ARROW_STEPS = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

function resolveSection(value: string | null) {
  const id = value === 'streaming' ? 'addons' : value;
  return NAV_ITEMS.find((item) => item.id === id) ?? NAV_ITEMS[0];
}

export function Settings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { currentVersion, isUpdateAvailable } = useAppUpdater({ includeCurrentVersion: true });
  const activeSection = resolveSection(searchParams.get(SETTINGS_SECTION_QUERY_PARAM));
  const active = activeSection.id;
  // The nav and its indicator update first; the heavier section renders behind them.
  const shownSection = useDeferredValue(activeSection);
  const ActiveSection = shownSection.component;
  const [query, setQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sectionRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const navButtons = useRef(new Map<SectionId, HTMLButtonElement>());
  const indicator = useSlidingIndicator(active, navRef, navButtons);
  const searchWords = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = NAV_ITEMS.filter((item) => {
    const searchText = `${item.label} ${item.description} ${item.controls.join(' ')}`.toLowerCase();
    return searchWords.every((word) => searchText.includes(word));
  });
  useDocumentTitle('Settings');

  // Ctrl/Cmd+F finds a setting instead of opening the WebView find bar.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== 'f' ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey ||
        event.defaultPrevented
      ) {
        return;
      }
      event.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleSectionChange = useCallback(
    (sectionId: SectionId) => {
      setQuery('');
      // Same-path replaces are skipped by the route scroll manager — land at top.
      if (window.scrollY > 0) window.scrollTo(0, 0);
      setSearchParams(
        (currentParams) => {
          const nextParams = new URLSearchParams(currentParams);

          if (sectionId === DEFAULT_SECTION) {
            nextParams.delete(SETTINGS_SECTION_QUERY_PARAM);
          } else {
            nextParams.set(SETTINGS_SECTION_QUERY_PARAM, sectionId);
          }

          return nextParams;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const handleNavKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const step = (ARROW_STEPS as Record<string, number | undefined>)[event.key];
    const index = NAV_ITEMS.findIndex((item) => navButtons.current.get(item.id) === event.target);
    if (!step || index < 0) return;
    event.preventDefault();
    const next = NAV_ITEMS[(index + step + NAV_ITEMS.length) % NAV_ITEMS.length];
    if (next) navButtons.current.get(next.id)?.focus();
  };

  const openSearchResult = (sectionId: SectionId) => {
    handleSectionChange(sectionId);
    window.requestAnimationFrame(() => sectionRef.current?.focus({ preventScroll: true }));
  };

  return (
    // Window scroll, not an inner scroller — a toggling gutter would nudge the
    // centered column on every section swap.
    <div className='page-enter pl-[60px]'>
      <div className='mx-auto w-full max-w-[1060px] px-5 pb-16 pt-7 sm:px-8'>
        <header className='flex items-end justify-between gap-4 border-b border-white/[0.06] pb-5'>
          <div>
            <h1 className='text-[22px] font-semibold leading-none tracking-[-0.03em] text-white'>
              Settings
            </h1>
            <p className='mt-2 max-w-xl text-[13px] leading-relaxed text-zinc-400'>
              Playback, sources, and data for this device.
            </p>
          </div>
          {currentVersion ? (
            <span
              data-selectable='true'
              className='mb-0.5 shrink-0 font-mono text-[11px] tabular-nums text-zinc-500'
            >
              v{currentVersion}
            </span>
          ) : null}
        </header>

        <div className='mt-6 grid gap-6 lg:grid-cols-[192px_minmax(0,1fr)] lg:gap-8'>
          <div className='min-w-0 space-y-5 lg:sticky lg:top-14 lg:self-start'>
            <SearchInput
              value={query}
              onValueChange={setQuery}
              inputRef={searchInputRef}
              onSubmit={() => {
                const [first] = matches;
                if (searchWords.length && first) openSearchResult(first.id);
              }}
              placeholder='Find a setting…'
              aria-label='Search settings'
              clearLabel='Clear settings search'
              wrapperClassName='w-full max-w-64 lg:max-w-none'
              className='h-9 rounded-lg border-white/[0.08] bg-white/[0.03] text-[13px] text-white shadow-none placeholder:text-zinc-500 focus-visible:border-(--accent-nav)/35 focus-visible:ring-(--accent-nav)/25'
            />

            <nav
              ref={navRef}
              aria-label='Settings sections'
              className='relative isolate scrollbar-hide -mx-1 flex gap-1 overflow-x-auto px-1 py-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0'
            >
              {indicator && (
                <>
                  <span
                    aria-hidden='true'
                    className='nav-sliding-pill pointer-events-none absolute left-0 top-0 rounded-lg bg-white/[0.07] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]'
                    style={{
                      width: indicator.width,
                      height: indicator.height,
                      transform: `translate3d(${indicator.left}px, ${indicator.top}px, 0)`,
                    }}
                  />
                  <span
                    aria-hidden='true'
                    className={SLIDING_ACCENT_BAR_CLASS}
                    style={{
                      height: indicator.height - 20,
                      transform: `translate3d(${indicator.left}px, ${indicator.top + 10}px, 0)`,
                    }}
                  />
                </>
              )}
              {NAV_ITEMS.map((item) => {
                const isActive = active === item.id;
                return (
                  <button
                    key={item.id}
                    ref={(node) => {
                      if (node) navButtons.current.set(item.id, node);
                      else navButtons.current.delete(item.id);
                    }}
                    type='button'
                    onClick={() => handleSectionChange(item.id)}
                    onKeyDown={handleNavKeyDown}
                    aria-current={isActive ? 'page' : undefined}
                    aria-label={
                      item.id === 'updates' && isUpdateAvailable
                        ? 'Updates, update available'
                        : undefined
                    }
                    className={cn(
                      'nav-switch-item group relative flex h-10 shrink-0 items-center gap-2.5 rounded-lg px-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-nav)/35 lg:w-full',
                      isActive ? 'text-white' : 'text-zinc-400 hover:text-zinc-100',
                    )}
                  >
                    <item.icon
                      aria-hidden='true'
                      className={cn(
                        'h-[17px] w-[17px] shrink-0 transition-colors duration-150 motion-reduce:transition-none',
                        isActive
                          ? 'text-(--accent-nav)'
                          : 'text-zinc-500 group-hover:text-zinc-300',
                      )}
                      strokeWidth={1.75}
                    />
                    <span className='text-[13.5px] font-medium leading-none'>{item.label}</span>
                    {item.id === 'updates' && isUpdateAvailable ? (
                      <span
                        aria-hidden='true'
                        className='ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400'
                      />
                    ) : null}
                  </button>
                );
              })}
            </nav>
          </div>

          {/* No enter animation: opacity fades strip subpixel AA from text in
              WebView2, reading as a blur on every tab swap. */}
          <div
            ref={sectionRef}
            tabIndex={-1}
            aria-label={searchWords.length ? 'Settings search results' : `${active} settings`}
            role='region'
            className='w-full min-w-0 max-w-[760px] rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-nav)/25'
          >
            {searchWords.length ? (
              <div className='space-y-3'>
                <output className='block text-[12px] text-zinc-500'>
                  {matches.length} {matches.length === 1 ? 'section' : 'sections'} found
                  {matches.length > 0 ? ' · Enter opens the first' : ''}
                </output>
                {matches.map((item) => {
                  const matchedControls = item.controls
                    .filter((control) =>
                      searchWords.some((word) => control.toLowerCase().includes(word)),
                    )
                    .slice(0, 3);
                  return (
                    <SettingsGroup key={item.id} className='focus-within:border-white/[0.14]'>
                      <button
                        type='button'
                        onClick={() => openSearchResult(item.id)}
                        className='group flex w-full items-center gap-3.5 rounded-xl px-5 py-4 text-left transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--accent-nav)/40 motion-reduce:transition-none'
                      >
                        <span className='flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.03]'>
                          <item.icon
                            aria-hidden='true'
                            className='h-4 w-4 text-(--accent-nav)'
                            strokeWidth={1.75}
                          />
                        </span>
                        <span className='min-w-0 flex-1'>
                          <span className='block text-[14px] font-medium text-zinc-100'>
                            {item.label}
                          </span>
                          <span className='mt-1 block text-[13px] leading-relaxed text-zinc-400'>
                            {item.description}
                          </span>
                          {matchedControls.length > 0 && (
                            <span className='mt-1.5 block text-xs leading-relaxed text-zinc-400'>
                              {matchedControls.join(' · ')}
                            </span>
                          )}
                        </span>
                        <ChevronRight
                          aria-hidden='true'
                          className='h-3.5 w-3.5 shrink-0 text-zinc-500 group-hover:text-zinc-300'
                        />
                      </button>
                    </SettingsGroup>
                  );
                })}
                {matches.length === 0 && (
                  <SettingsGroup>
                    <SettingsBody className='py-8 text-center'>
                      <p className='text-[14px] font-medium text-zinc-200'>No matching settings</p>
                      <p className='mt-2 text-[13px] leading-relaxed text-zinc-400'>
                        Try a section name or a term like subtitles, accent or backup.
                      </p>
                      <button
                        type='button'
                        className='mt-4 rounded-md px-3 py-1.5 text-[12px] text-zinc-300 hover:bg-white/[0.05] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-nav)/40'
                        onClick={() => {
                          setQuery('');
                          searchInputRef.current?.focus({ preventScroll: true });
                        }}
                      >
                        Clear search
                      </button>
                    </SettingsBody>
                  </SettingsGroup>
                )}
              </div>
            ) : (
              <Suspense
                fallback={
                  <Skeleton
                    role='status'
                    aria-label='Loading settings'
                    className='h-72 rounded-xl'
                  />
                }
              >
                <ActiveSection key={shownSection.id} />
              </Suspense>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
