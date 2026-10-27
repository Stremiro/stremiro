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
  type ReactNode,
  lazy,
  Suspense,
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
import { usePlayerKeymap } from '@/hooks/use-app-ui-preferences';
import { SLIDING_ACCENT_BAR_CLASS, useSlidingIndicator } from '@/hooks/use-sliding-indicator';
import { ariaKeyShortcuts, formatBindingKey, PLAYER_ACTIONS } from '@/lib/player-keybindings';
import {
  SUBTITLE_COLOR_OPTIONS,
  SUBTITLE_EDGE_OPTIONS,
  SUBTITLE_FONT_OPTIONS,
} from '@/lib/player-track-utils';
import { cn, pluralize, scrollBehavior } from '@/lib/utils';
import { AppearanceSettings, TINT_TARGETS } from './appearance';
import { settingsControlId, SettingsBody, SettingsGroup } from './chrome';
import { DataSection } from './data';
import { GeneralSettings, START_PAGES } from './general';
import { PlaybackSettings } from './playback';
import { FIXED_SHORTCUT_SECTIONS, ShortcutsSection } from './shortcuts';
import { UpdatesSection } from './updates';

const loadAddonSettings = () =>
  import('./streaming').then((module) => ({ default: module.AddonSettings }));
const AddonSettings = lazy(loadAddonSettings);

interface SearchControl {
  label: string;
  keywords?: string;
  target?: string;
}

interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  description: string;
  controls: readonly SearchControl[];
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
      {
        label: 'Start page',
        keywords: `Where Stremiro opens. ${START_PAGES.map((page) => page.label).join(' ')}`,
      },
      { label: 'Launch at login', keywords: 'Open Stremiro when you sign in. Startup autostart' },
      {
        label: 'Start minimized',
        keywords: 'Login launches start in the system tray. Manual launches stay visible.',
      },
      { label: 'Close to tray', keywords: 'Keep running in the tray when the window closes.' },
      {
        label: 'Minimize to tray',
        keywords: 'Hide to the tray instead of the taskbar. Hide to tray now',
      },
    ],
  },
  {
    id: 'addons',
    component: AddonSettings,
    label: 'Addons',
    icon: Zap,
    description: 'Install, enable and reorder addons.',
    controls: [
      {
        label: 'Addon manifest URL',
        keywords: 'Add addon Paste an addon manifest.json or stremiro:// URL to add an addon.',
      },
      {
        label: 'Manage addons',
        keywords:
          'Enable disable reorder remove copy addon link Configure configuration options account Cinemeta OpenSubtitles pinned defaults drag stream priority',
        target: 'setting-addon-list',
      },
    ],
  },
  {
    id: 'playback',
    component: PlaybackSettings,
    label: 'Playback',
    icon: Settings2,
    description: 'Languages, audio, spoilers, auto-play and auto-skip.',
    controls: [
      {
        label: 'Audio',
        keywords:
          "Languages preferred language Auto reuses this title's remembered choice, or lets the player choose.",
      },
      {
        label: 'Subtitles',
        keywords:
          "Languages Off preferred language captions Auto reuses this title's remembered choice, or lets the player choose.",
      },
      {
        label: 'Audio sync',
        keywords:
          'Delay offset seconds saved for all videos. Positive plays audio later; negative plays it earlier. Set to 0 to reset.',
      },
      {
        label: 'Night mode',
        keywords:
          'Boost quiet audio and smooth volume changes for late-night watching. Saved for all videos; off keeps the original sound. volume normalization loud jumps listening',
      },
      {
        label: 'Subtitle appearance',
        keywords: `Plain-text subtitles saved for all videos. Styled ASS subtitles keep their own look. Reset font color edge bold italic captions ${[
          ...SUBTITLE_FONT_OPTIONS,
          ...SUBTITLE_COLOR_OPTIONS,
          ...SUBTITLE_EDGE_OPTIONS,
        ]
          .map((option) => option.label)
          .join(' ')}`,
      },
      {
        label: 'Load addon subtitles automatically',
        keywords:
          'When a stream has no subtitles in your preferred language, load a matching one from your addons. auto captions language',
      },
      {
        label: 'Spoiler protection',
        keywords: 'Blur unwatched episode thumbnails and descriptions.',
      },
      { label: 'Trailer previews', keywords: 'Play a muted trailer when hovering a title card.' },
      {
        label: 'Auto-play next episode',
        keywords: 'Count down and start the next episode automatically.',
      },
      { label: 'Next episode countdown', keywords: 'Seconds 5 8 10 15 30 auto-play timer' },
      {
        label: 'Hide controls after keyboard input',
        keywords: 'Player controls overlay timeout Seconds 2 3 5 8 delay mouse inactivity',
      },
      {
        label: 'Auto-skip intros & recaps',
        keywords: 'Skip detected intros and recaps. Outros stay manual.',
      },
    ],
  },
  {
    id: 'appearance',
    component: AppearanceSettings,
    label: 'Appearance',
    icon: Palette,
    description: 'Accent color, glow and tint targets.',
    controls: [
      {
        label: 'Accent',
        keywords: `Reset Soft Vivid Custom accent color hex Pick a custom color ${ACCENT_PRESET_LABELS.join(' ')}`,
        target: 'setting-appearance-accent',
      },
      { label: 'Glow', keywords: 'Background glow intensity', target: 'setting-appearance-glow' },
      ...TINT_TARGETS.map((target) => ({
        label: target.label,
        keywords: `Tint targets Off areas stay neutral ${target.description}`,
      })),
    ],
  },
  {
    id: 'shortcuts',
    component: ShortcutsSection,
    label: 'Shortcuts',
    icon: Keyboard,
    description: 'Player, browse and Calendar keys.',
    controls: [
      {
        label: 'Player shortcuts',
        keywords:
          'Customize keybindings Rebind key Reset all Click a key to rebind it, up to 2 per action. Esc cancels, Backspace removes.',
        target: 'setting-player-shortcuts',
      },
      ...PLAYER_ACTIONS.map((action) => ({
        label: action.label,
        keywords: `Player shortcuts ${action.group}`,
        target: `setting-shortcut-${action.id}`,
      })),
      ...FIXED_SHORTCUT_SECTIONS.flatMap(([group, rows]) =>
        rows.map((row, index) => ({
          label: row.label,
          keywords: `${group} fixed shortcuts ${row.keys.join(' ')}`,
          target: `setting-fixed-${group}-${index}`,
        })),
      ),
    ],
  },
  {
    id: 'updates',
    component: UpdatesSection,
    label: 'Updates',
    icon: RefreshCw,
    description: 'Check for and install app updates.',
    controls: [
      {
        label: 'Check for updates automatically',
        keywords: 'After launch and every six hours. You choose when to install.',
      },
      {
        label: 'Check for updates',
        keywords: 'Check again Update & restart install Last checked',
        target: 'setting-update-actions',
      },
      {
        label: 'Changelog',
        keywords: "Release notes What's new Installed New View on GitHub",
        target: 'setting-changelog',
      },
    ],
  },
  {
    id: 'data',
    component: DataSection,
    label: 'Data',
    icon: Database,
    description: 'Backups, storage and clearing local records.',
    controls: [
      {
        label: 'Export',
        keywords:
          'Backup & restore Export your data to a JSON file. Backups can contain addon keys, so keep them private.',
      },
      {
        label: 'Import',
        keywords:
          'Backup & restore merge Records addons and per-title language picks merge with your existing data. Preferences, profile and appearance are replaced by the backup.',
      },
      {
        label: 'Watch history',
        keywords:
          'Clear local records permanently Cancel Watched titles, resume progress and per-title track and source picks.',
      },
      {
        label: 'Library',
        keywords:
          'Clear local records permanently Cancel Saved movies and shows, with their watch statuses.',
      },
      {
        label: 'Custom lists',
        keywords: 'Clear local records permanently Cancel Every custom list and its contents.',
      },
      {
        label: 'Watch statuses',
        keywords:
          'Clear local records permanently Cancel Watching, Watched, Plan to Watch and Dropped labels.',
      },
      {
        label: 'Recent searches',
        keywords:
          'Clear local records permanently Cancel search history Queries offered when the search field is empty.',
      },
    ],
  },
] as const satisfies readonly NavItem[];

function searchItem(
  section: (typeof NAV_ITEMS)[number],
  label: string,
  keywords: string,
  target?: string,
) {
  return {
    section,
    label,
    target,
    labelText: label.toLowerCase(),
    text: `${section.label} ${label} ${keywords}`.toLowerCase(),
  };
}

const SEARCH_ITEMS = NAV_ITEMS.flatMap((section) => [
  searchItem(section, section.label, section.description),
  ...section.controls.map((control: SearchControl) =>
    searchItem(
      section,
      control.label,
      control.keywords ?? '',
      control.target ?? settingsControlId(control.label),
    ),
  ),
]);

type SectionId = (typeof NAV_ITEMS)[number]['id'];
const DEFAULT_SECTION: SectionId = NAV_ITEMS[0].id;
const SETTINGS_SECTION_QUERY_PARAM = 'section';
const ARROW_STEPS = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

function resolveSection(value: string | null) {
  const id = value === 'streaming' ? 'addons' : value;
  return NAV_ITEMS.find((item) => item.id === id) ?? NAV_ITEMS[0];
}

interface SearchTarget {
  sectionId: SectionId;
  id: string;
}

const SEARCH_HIGHLIGHT_MS = 2400;

function SettingsSectionContent({
  children,
  searchTarget,
}: {
  children: ReactNode;
  searchTarget?: SearchTarget;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!searchTarget) return;
    const target = document.getElementById(searchTarget.id);
    if (!target || !contentRef.current?.contains(target)) {
      contentRef.current?.focus({ preventScroll: true });
      return;
    }
    const addedTabIndex = target.tabIndex < 0 && !target.hasAttribute('tabindex');
    if (addedTabIndex) target.tabIndex = -1;
    target.dataset.settingHighlighted = '';
    target.focus({ preventScroll: true });
    if (document.activeElement !== target) contentRef.current.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
    const clearHighlight = () => delete target.dataset.settingHighlighted;
    const timer = window.setTimeout(clearHighlight, SEARCH_HIGHLIGHT_MS);
    return () => {
      window.clearTimeout(timer);
      clearHighlight();
      if (addedTabIndex) target.removeAttribute('tabindex');
    };
  }, [searchTarget]);
  return (
    <div
      ref={contentRef}
      tabIndex={-1}
      className='outline-none [&_[id^=setting-]]:scroll-mt-48 lg:[&_[id^=setting-]]:scroll-mt-6 [&_[data-setting-highlighted]]:rounded-lg [&_[data-setting-highlighted]]:bg-(--accent-nav)/10 [&_[data-setting-highlighted]]:outline-2 [&_[data-setting-highlighted]]:outline-offset-4 [&_[data-setting-highlighted]]:outline-(--accent-nav)/60'
    >
      {children}
    </div>
  );
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
  const [searchTarget, setSearchTarget] = useState<SearchTarget | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sectionRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const navButtons = useRef(new Map<SectionId, HTMLButtonElement>());
  const indicator = useSlidingIndicator(active, navRef, navButtons);
  const keymap = usePlayerKeymap();
  // Rebindable actions are also found by their current keys ("space", "m", "left").
  const boundKeyText = new Map(
    PLAYER_ACTIONS.map((action) => [
      `setting-shortcut-${action.id}`,
      `${keymap.keys[action.id].map(formatBindingKey).join(' ')} ${ariaKeyShortcuts(keymap, action.id) ?? ''}`.toLowerCase(),
    ]),
  );
  const searchText = query.trim().toLowerCase();
  const searchWords = searchText.split(/\s+/).filter(Boolean);
  const matches = searchWords.length
    ? SEARCH_ITEMS.filter((item) => {
        const text = `${item.text} ${(item.target && boundKeyText.get(item.target)) ?? ''}`;
        return searchWords.every((word) => text.includes(word));
      }).toSorted(
        (a, b) =>
          Number(b.labelText.includes(searchText)) - Number(a.labelText.includes(searchText)),
      )
    : [];
  useDocumentTitle('Settings');
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || !indicator) return;
    // Recentering an already visible item pans labels under the pointer while the pill travels.
    const visible =
      indicator.left >= nav.scrollLeft &&
      indicator.left + indicator.width <= nav.scrollLeft + nav.clientWidth &&
      indicator.top >= nav.scrollTop &&
      indicator.top + indicator.height <= nav.scrollTop + nav.clientHeight;
    if (visible) return;
    nav.scrollTo({
      left: Math.max(0, indicator.left - (nav.clientWidth - indicator.width) / 2),
      top: Math.max(0, indicator.top - (nav.clientHeight - indicator.height) / 2),
      behavior: scrollBehavior(),
    });
  }, [indicator]);

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

  const handleSectionChange = (sectionId: SectionId) => {
    if (sectionId === active && !query && !searchTarget) return;
    setQuery('');
    setSearchTarget(null);
    // Same-path replaces are skipped by the route scroll manager — land at top.
    sectionRef.current?.scrollTo({ top: 0 });
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
  };

  const handleNavKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const step = (ARROW_STEPS as Record<string, number | undefined>)[event.key];
    const index = NAV_ITEMS.findIndex((item) => navButtons.current.get(item.id) === event.target);
    if (!step || index < 0) return;
    event.preventDefault();
    const next = NAV_ITEMS[(index + step + NAV_ITEMS.length) % NAV_ITEMS.length];
    if (next) navButtons.current.get(next.id)?.focus();
  };

  const openSearchResult = (result: (typeof SEARCH_ITEMS)[number]) => {
    handleSectionChange(result.section.id);
    if (result.target) setSearchTarget({ sectionId: result.section.id, id: result.target });
    else window.requestAnimationFrame(() => sectionRef.current?.focus({ preventScroll: true }));
  };

  return (
    // Desktop pins the shell to the viewport: the nav never moves on scroll or
    // section swaps, and only the section column scrolls.
    <div className='pl-[60px] lg:h-[calc(100dvh-2rem)] lg:overflow-hidden'>
      <div className='mx-auto w-full max-w-[1480px] px-4 pb-12 pt-5 sm:px-6 lg:h-full lg:pt-7 xl:px-8'>
        <div className='space-y-5 lg:grid lg:h-full lg:grid-cols-[180px_minmax(0,1fr)] lg:gap-7 lg:space-y-0 xl:gap-9'>
          <div className='sticky top-8 z-30 -mx-4 min-w-0 space-y-3 border-b border-white/[0.07] bg-zinc-950/95 px-4 py-3 backdrop-blur-xl sm:-mx-6 sm:px-6 lg:static lg:mx-0 lg:flex lg:h-full lg:min-h-0 lg:flex-col lg:gap-5 lg:space-y-0 lg:border-0 lg:bg-transparent lg:px-0 lg:py-1 lg:backdrop-blur-none'>
            <header className='flex shrink-0 items-baseline justify-between gap-3'>
              <h1 className='text-[22px] font-semibold leading-none tracking-[-0.03em] text-white'>
                Settings
              </h1>
              {currentVersion ? (
                <span
                  data-selectable='true'
                  className='shrink-0 font-mono text-[11px] tabular-nums text-zinc-500 lg:hidden'
                >
                  v{currentVersion}
                </span>
              ) : null}
            </header>
            <SearchInput
              value={query}
              onValueChange={(value) => {
                setQuery(value);
                sectionRef.current?.scrollTo({ top: 0 });
                if (window.scrollY > 0) window.scrollTo(0, 0);
              }}
              inputRef={searchInputRef}
              onSubmit={() => {
                const [first] = matches;
                if (first) openSearchResult(first);
              }}
              placeholder='Find a setting…'
              aria-label='Search settings'
              clearLabel='Clear settings search'
              wrapperClassName='w-full shrink-0'
              className='h-9 rounded-lg border-white/[0.08] bg-white/[0.03] text-[13px] text-white shadow-none placeholder:text-zinc-500 focus-visible:border-(--accent-nav)/35 focus-visible:ring-(--accent-nav)/25'
            />

            <nav
              ref={navRef}
              aria-label='Settings sections'
              className='relative isolate scrollbar-hide -mx-1 flex gap-1 overflow-x-auto overscroll-x-contain px-1 py-1 lg:mx-0 lg:min-h-0 lg:flex-1 lg:flex-col lg:overflow-x-clip lg:overflow-y-auto lg:overscroll-contain lg:px-0'
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
                    onPointerEnter={
                      item.id === 'addons' ? () => void loadAddonSettings() : undefined
                    }
                    onFocus={item.id === 'addons' ? () => void loadAddonSettings() : undefined}
                    onKeyDown={handleNavKeyDown}
                    aria-current={isActive ? 'page' : undefined}
                    aria-label={
                      item.id === 'updates' && isUpdateAvailable
                        ? 'Updates, update available'
                        : undefined
                    }
                    className={cn(
                      'nav-switch-item group relative flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--accent-nav)/35 lg:w-full',
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
            {currentVersion ? (
              <span
                data-selectable='true'
                className='hidden shrink-0 font-mono text-[11px] tabular-nums text-zinc-600 lg:block'
              >
                v{currentVersion}
              </span>
            ) : null}
          </div>

          {/* No enter animation: opacity fades strip subpixel AA from text in
              WebView2, reading as a blur on every tab swap. */}
          <div
            ref={sectionRef}
            tabIndex={-1}
            aria-label={searchWords.length ? 'Settings search results' : `${active} settings`}
            role='region'
            className='w-full min-w-0 scroll-mt-48 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-nav)/25 lg:scroll-mt-16 lg:min-h-0 lg:h-full lg:overflow-y-auto lg:overscroll-contain'
          >
            {!searchWords.length && (
              <header className='mb-5 px-0.5'>
                <h2 className='text-[20px] font-semibold leading-tight tracking-tight text-white'>
                  {shownSection.label}
                </h2>
                <p className='mt-1.5 text-[13px] leading-relaxed text-zinc-400'>
                  {shownSection.description}
                </p>
              </header>
            )}
            {searchWords.length ? (
              <div className='space-y-3'>
                <output className='block text-[12px] text-zinc-500'>
                  {pluralize(matches.length, 'setting')} found
                  {matches.length > 0 ? ' · Enter opens the first' : ''}
                </output>
                {matches.map((item) => (
                  <SettingsGroup
                    key={`${item.section.id}-${item.target ?? 'section'}`}
                    className='focus-within:border-white/[0.14]'
                  >
                    <button
                      type='button'
                      onClick={() => openSearchResult(item)}
                      className='group flex w-full items-center gap-3.5 rounded-xl px-5 py-4 text-left transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--accent-nav)/40 motion-reduce:transition-none'
                    >
                      <span className='flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.03]'>
                        <item.section.icon
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
                          {item.section.label} · {item.section.description}
                        </span>
                      </span>
                      <ChevronRight
                        aria-hidden='true'
                        className='h-3.5 w-3.5 shrink-0 text-zinc-500 group-hover:text-zinc-300'
                      />
                    </button>
                  </SettingsGroup>
                ))}
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
                <SettingsSectionContent
                  key={shownSection.id}
                  searchTarget={
                    searchTarget?.sectionId === shownSection.id ? searchTarget : undefined
                  }
                >
                  <ActiveSection />
                </SettingsSectionContent>
              </Suspense>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
