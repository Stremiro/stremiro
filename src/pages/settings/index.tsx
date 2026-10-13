import {
  ChevronRight,
  Database,
  Keyboard,
  type LucideIcon,
  Palette,
  RefreshCw,
  Settings2,
  Zap,
} from 'lucide-react';
import { type ComponentType, useCallback, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { SearchInput } from '@/components/ui/search-input';
import { useAppUpdater } from '@/hooks/use-app-updater';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { cn } from '@/lib/utils';
import { AppearanceSettings } from './appearance';
import { DataSection } from './data';
import { PlaybackSettings } from './playback';
import { ShortcutsSection } from './shortcuts';
import { StreamingSources } from './streaming';
import { UpdatesSection } from './updates';

interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  description: string;
  component: ComponentType;
}

const NAV_ITEMS = [
  {
    id: 'addons',
    component: StreamingSources,
    label: 'Addons',
    icon: Zap,
    description: 'Install, enable and reorder addons for streaming sources.',
  },
  {
    id: 'playback',
    component: PlaybackSettings,
    label: 'Playback',
    icon: Settings2,
    description:
      'Audio languages and subtitles, spoiler protection, trailer previews, auto-play next episode and auto-skip intros & recaps.',
  },
  {
    id: 'appearance',
    component: AppearanceSettings,
    label: 'Appearance',
    icon: Palette,
    description:
      'Accent color, glow intensity and tint targets for navigation, buttons, progress bars and artwork.',
  },
  {
    id: 'shortcuts',
    component: ShortcutsSection,
    label: 'Shortcuts',
    icon: Keyboard,
    description: 'Keyboard controls for the player, browsing and Calendar.',
  },
  {
    id: 'updates',
    component: UpdatesSection,
    label: 'Updates',
    icon: RefreshCw,
    description: 'Check for updates, download and install app releases.',
  },
  {
    id: 'data',
    component: DataSection,
    label: 'Data',
    icon: Database,
    description:
      'Export and import backups, storage, and clear library, lists, watch statuses and history.',
  },
] as const satisfies readonly NavItem[];

type SectionId = (typeof NAV_ITEMS)[number]['id'];
const DEFAULT_SECTION: SectionId = NAV_ITEMS[0].id;
const SETTINGS_SECTION_QUERY_PARAM = 'section';

function resolveSection(value: string | null) {
  const id = value === 'streaming' ? DEFAULT_SECTION : value;
  return NAV_ITEMS.find((item) => item.id === id) ?? NAV_ITEMS[0];
}

export function Settings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { currentVersion, isUpdateAvailable } = useAppUpdater();
  const activeSection = resolveSection(searchParams.get(SETTINGS_SECTION_QUERY_PARAM));
  const active = activeSection.id;
  const ActiveSection = activeSection.component;
  const [query, setQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sectionRef = useRef<HTMLDivElement>(null);
  const searchWords = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = NAV_ITEMS.filter((item) =>
    searchWords.every((word) => `${item.label} ${item.description}`.toLowerCase().includes(word)),
  );
  useDocumentTitle('Settings');

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

  return (
    // Window scroll, not an inner scroller — a toggling gutter would nudge the
    // centered column on every section swap.
    <div className='page-enter pl-[60px]'>
      <div className='mx-auto w-full max-w-6xl px-5 pb-16 pt-6 sm:px-8'>
        <header className='flex items-end justify-between gap-4 border-b border-white/[0.06] pb-5'>
          <div>
            <h1 className='text-[22px] font-semibold leading-none tracking-[-0.03em] text-white'>
              Settings
            </h1>
            <p className='mt-2 max-w-xl text-[13.5px] leading-relaxed text-zinc-500'>
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

        <div className='mt-6 grid gap-6 lg:grid-cols-[208px_minmax(0,1fr)] lg:gap-8'>
          <div className='min-w-0 space-y-5 lg:sticky lg:top-14 lg:self-start'>
            <SearchInput
              value={query}
              onValueChange={setQuery}
              inputRef={searchInputRef}
              placeholder='Find a setting…'
              aria-label='Search settings'
              clearLabel='Clear settings search'
              wrapperClassName='w-52 max-w-full'
              className='h-9 rounded-lg border-white/[0.08] bg-white/[0.03] text-[13px] text-white shadow-none placeholder:text-zinc-500 focus-visible:border-(--accent-nav)/35 focus-visible:ring-(--accent-nav)/25'
            />

            <nav
              aria-label='Settings sections'
              className='scrollbar-hide -mx-1 flex gap-2 overflow-x-auto px-1 py-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0'
            >
              {NAV_ITEMS.map((item) => {
                const isActive = active === item.id;
                return (
                  <button
                    key={item.id}
                    type='button'
                    onClick={() => handleSectionChange(item.id)}
                    aria-current={isActive ? 'page' : undefined}
                    aria-label={
                      item.id === 'updates' && isUpdateAvailable
                        ? 'Updates, update available'
                        : undefined
                    }
                    style={
                      isActive
                        ? { backgroundColor: 'rgb(var(--accent-nav-rgb) / 0.09)' }
                        : undefined
                    }
                    className={cn(
                      'group relative flex min-h-11 shrink-0 items-center gap-3 rounded-lg px-3.5 py-3 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-nav)/35 lg:w-full',
                      isActive
                        ? 'text-white'
                        : 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200 focus-visible:bg-white/[0.05] focus-visible:text-zinc-200',
                    )}
                  >
                    <item.icon
                      className={cn(
                        'h-[17px] w-[17px] shrink-0 transition-colors duration-150',
                        isActive
                          ? 'text-(--accent-nav)'
                          : 'text-zinc-500 group-hover:text-zinc-300 group-focus-visible:text-zinc-300',
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
            className='min-w-0 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-nav)/25'
          >
            {searchWords.length ? (
              <div className='space-y-3'>
                <output className='block text-[12px] text-zinc-500'>
                  {matches.length} {matches.length === 1 ? 'section' : 'sections'} found
                </output>
                {matches.map((item) => (
                  <button
                    key={item.id}
                    type='button'
                    onClick={() => {
                      handleSectionChange(item.id);
                      window.requestAnimationFrame(() =>
                        sectionRef.current?.focus({ preventScroll: true }),
                      );
                    }}
                    className='group flex w-full items-center gap-3.5 rounded-xl border border-white/[0.08] bg-zinc-950/45 px-4 py-3.5 text-left transition-colors hover:border-white/[0.14] hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-nav)/40'
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
                      <span className='mt-1 block text-[12.5px] leading-relaxed text-zinc-400'>
                        {item.description}
                      </span>
                    </span>
                    <ChevronRight
                      aria-hidden='true'
                      className='h-3.5 w-3.5 shrink-0 text-zinc-600 group-hover:text-zinc-400'
                    />
                  </button>
                ))}
                {matches.length === 0 && (
                  <div className='rounded-lg border border-white/[0.07] bg-white/[0.015] px-5 py-8 text-center'>
                    <p className='text-[14px] font-medium text-zinc-200'>No matching settings</p>
                    <p className='mt-2 text-[13px] text-zinc-500'>
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
                  </div>
                )}
              </div>
            ) : (
              <ActiveSection key={active} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
