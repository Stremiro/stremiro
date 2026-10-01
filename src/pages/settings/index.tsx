import {
  Database,
  Keyboard,
  type LucideIcon,
  Palette,
  RefreshCw,
  Settings2,
  Zap,
} from 'lucide-react';
import { type ComponentType, useCallback } from 'react';
import { useSearchParams } from 'react-router';
import { useAppUpdater } from '@/hooks/use-app-updater';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { cn } from '@/lib/utils';
import { AppearanceSettings } from './appearance';
import { DataSection } from './data';
import { PlaybackSettings } from './playback';
import { ShortcutsSection } from './shortcuts';
import { StreamingSources } from './streaming';
import { UpdatesSection } from './updates';

type SectionId = 'addons' | 'playback' | 'appearance' | 'shortcuts' | 'updates' | 'data';

interface NavItem {
  id: SectionId;
  label: string;
  icon: LucideIcon;
}

const DEFAULT_SECTION: SectionId = 'addons';
const SETTINGS_SECTION_QUERY_PARAM = 'section';

const NAV_ITEMS: NavItem[] = [
  { id: 'addons', label: 'Addons', icon: Zap },
  { id: 'playback', label: 'Playback', icon: Settings2 },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
  { id: 'updates', label: 'Updates', icon: RefreshCw },
  { id: 'data', label: 'Data', icon: Database },
];

const SECTIONS: Record<SectionId, ComponentType> = {
  addons: StreamingSources,
  playback: PlaybackSettings,
  appearance: AppearanceSettings,
  shortcuts: ShortcutsSection,
  updates: UpdatesSection,
  data: DataSection,
};

function resolveSectionId(value: string | null): SectionId {
  if (value === 'streaming') return 'addons';
  // `hasOwn`, not `in`: `?section=constructor` must not resolve to a prototype key.
  return value && Object.hasOwn(SECTIONS, value) ? (value as SectionId) : DEFAULT_SECTION;
}

export function Settings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { currentVersion, isUpdateAvailable } = useAppUpdater();
  const active = resolveSectionId(searchParams.get(SETTINGS_SECTION_QUERY_PARAM));
  const ActiveSection = SECTIONS[active];
  useDocumentTitle('Settings');

  const handleSectionChange = useCallback(
    (sectionId: SectionId) => {
      // Section swaps replace the entry on the same path, which the route
      // scroll manager deliberately skips — land each section at its top.
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
    // Window scroll, not an inner scroller: the root scrollbar is hidden
    // app-wide, so tall and short sections can't toggle a gutter and nudge
    // the centered column sideways on every swap.
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
              className='mb-0.5 shrink-0 rounded-md border border-white/[0.07] bg-white/[0.03] px-2 py-1 font-mono text-[11px] tabular-nums text-zinc-500'
            >
              v{currentVersion}
            </span>
          ) : null}
        </header>

        <div className='mt-6 grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]'>
          <nav
            aria-label='Settings sections'
            className='scrollbar-hide -mx-1 flex gap-1 overflow-x-auto px-1 lg:mx-0 lg:flex-col lg:gap-0.5 lg:self-start lg:overflow-visible lg:px-0 lg:sticky lg:top-14'
          >
            {NAV_ITEMS.map((item) => {
              const isActive = active === item.id;
              return (
                <button
                  key={item.id}
                  type='button'
                  onClick={() => handleSectionChange(item.id)}
                  aria-current={isActive ? 'page' : undefined}
                  style={
                    isActive ? { backgroundColor: 'rgb(var(--accent-nav-rgb) / 0.09)' } : undefined
                  }
                  className={cn(
                    'group relative flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 lg:w-full',
                    isActive
                      ? 'text-white'
                      : 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200',
                  )}
                >
                  {isActive ? (
                    <span
                      aria-hidden='true'
                      className='absolute left-0 top-1/2 hidden h-4 w-[2.5px] -translate-y-1/2 rounded-full bg-(--accent-nav) lg:block'
                    />
                  ) : null}
                  <item.icon
                    className={cn(
                      'h-[17px] w-[17px] shrink-0 transition-colors duration-150',
                      isActive ? 'text-(--accent-nav)' : 'text-zinc-500 group-hover:text-zinc-300',
                    )}
                    strokeWidth={1.75}
                  />
                  <span className='text-[13.5px] font-medium leading-none'>{item.label}</span>
                  {item.id === 'updates' && isUpdateAvailable ? (
                    <span
                      aria-hidden='true'
                      className='ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]'
                    />
                  ) : null}
                </button>
              );
            })}
          </nav>

          {/* No enter animation here: opacity fades strip subpixel AA from
              text in WebView2, which reads as a blur on every tab swap.
              Instant swaps feel faster in a desktop app anyway. */}
          <div className='min-w-0'>
            <ActiveSection key={active} />
          </div>
        </div>
      </div>
    </div>
  );
}
