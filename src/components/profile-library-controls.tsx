import {
  ArrowDownAZ,
  ArrowUpAZ,
  CalendarArrowDown,
  CalendarArrowUp,
  Check,
  ChevronDown,
  LayoutGrid,
  List,
  type LucideIcon,
  RotateCcw,
} from 'lucide-react';
import type { RefObject } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SearchInput } from '@/components/ui/search-input';
import {
  WATCH_STATUS_COLORS,
  WATCH_STATUS_LABELS,
  WATCH_STATUSES,
  type WatchStatus,
} from '@/lib/api';
import { cn } from '@/lib/utils';
export type LibrarySort = 'default' | 'title-asc' | 'title-desc' | 'year-desc' | 'year-asc';

const LIBRARY_SORT_OPTIONS: Record<LibrarySort, { label: string; icon: LucideIcon | null }> = {
  default: { label: 'Default', icon: null },
  'title-asc': { label: 'A → Z', icon: ArrowUpAZ },
  'title-desc': { label: 'Z → A', icon: ArrowDownAZ },
  'year-desc': { label: 'Newest', icon: CalendarArrowDown },
  'year-asc': { label: 'Oldest', icon: CalendarArrowUp },
};

const LIBRARY_SORT_KEYS = Object.keys(LIBRARY_SORT_OPTIONS) as LibrarySort[];

const FILTER_MENU_BUTTON_CLASS =
  'h-9 px-3 gap-1.5 text-[12px] font-medium rounded-md bg-white/[0.02] border-white/[0.08] shadow-none hover:bg-white/[0.06] text-zinc-300 hover:text-white shrink-0 inline-flex items-center';

const VIEW_MODES: { mode: 'grid' | 'list'; label: string; icon: LucideIcon }[] = [
  { mode: 'grid', label: 'Grid view', icon: LayoutGrid },
  { mode: 'list', label: 'List view', icon: List },
];

export function LibraryToolbar({
  typeFilter,
  onTypeFilterChange,
  statusFilter,
  onStatusFilterChange,
  statusCounts,
  libraryCount,
  filteredCount,
  search,
  onSearchChange,
  searchInputRef,
  sort,
  onSortChange,
  viewMode,
  onViewModeChange,
  onReset,
}: {
  typeFilter: 'all' | 'movie' | 'series';
  onTypeFilterChange: (type: 'all' | 'movie' | 'series') => void;
  statusFilter: WatchStatus | 'all';
  onStatusFilterChange: (status: WatchStatus | 'all') => void;
  statusCounts: Record<WatchStatus, number>;
  libraryCount: number;
  filteredCount: number;
  search: string;
  onSearchChange: (value: string) => void;
  searchInputRef: RefObject<HTMLInputElement | null>;
  sort: LibrarySort;
  onSortChange: (sort: LibrarySort) => void;
  viewMode: 'grid' | 'list';
  onViewModeChange: (mode: 'grid' | 'list') => void;
  onReset: () => void;
}) {
  const activeSortOption = LIBRARY_SORT_OPTIONS[sort];
  const ActiveSortIcon = activeSortOption.icon;
  const hasFilters =
    typeFilter !== 'all' || statusFilter !== 'all' || search.length > 0 || sort !== 'default';

  return (
    <div className='space-y-3'>
      <div className='flex items-center gap-3'>
        <SearchInput
          inputRef={searchInputRef}
          placeholder='Search library…'
          value={search}
          onValueChange={onSearchChange}
          clearLabel='Clear library search'
          wrapperClassName='flex-1 min-w-0'
          className='h-10 text-[13px] bg-white/[0.03] border-white/[0.08] text-white placeholder:text-zinc-500 focus-visible:border-(--accent-nav) focus-visible:ring-(--accent-nav)/25 rounded-lg'
        />
        <span className='text-[12px] tabular-nums text-zinc-400 shrink-0' role='status'>
          {filteredCount === libraryCount
            ? `${libraryCount} ${libraryCount === 1 ? 'title' : 'titles'}`
            : `${filteredCount} of ${libraryCount}`}
        </span>
      </div>
      <div className='flex items-center gap-2 flex-wrap'>
        <div
          className='flex items-center gap-0.5 p-0.5 rounded-md bg-white/[0.03] border border-white/[0.07] shrink-0'
          role='group'
          aria-label='Library media type'
        >
          {(['all', 'movie', 'series'] as const).map((t) => (
            <button
              key={t}
              type='button'
              aria-pressed={typeFilter === t}
              onClick={() => onTypeFilterChange(t)}
              style={typeFilter === t ? { backgroundColor: 'var(--accent-nav)' } : undefined}
              className={cn(
                'h-8 px-3 rounded-sm text-[12px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25',
                typeFilter === t
                  ? 'text-(--on-accent-nav)'
                  : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.06]',
              )}
            >
              {t === 'all' ? 'All' : t === 'movie' ? 'Movies' : 'Shows'}
            </button>
          ))}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant='outline'
              size='sm'
              className={FILTER_MENU_BUTTON_CLASS}
              aria-label={`Library status: ${statusFilter === 'all' ? 'All statuses' : WATCH_STATUS_LABELS[statusFilter]}`}
            >
              {statusFilter !== 'all' && (
                <span
                  aria-hidden='true'
                  className={cn(
                    'h-1.5 w-1.5 rounded-full bg-current',
                    WATCH_STATUS_COLORS[statusFilter].text,
                  )}
                />
              )}
              <span>
                {statusFilter === 'all' ? 'All statuses' : WATCH_STATUS_LABELS[statusFilter]}
              </span>
              <ChevronDown className='w-3 h-3 opacity-50' />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align='start' className='w-44 bg-zinc-950/98 border-white/10'>
            <FilterMenuItem
              checked={statusFilter === 'all'}
              onSelect={() => onStatusFilterChange('all')}
            >
              All statuses
              <span className='ml-auto text-[11px] tabular-nums text-zinc-600'>{libraryCount}</span>
            </FilterMenuItem>
            {WATCH_STATUSES.map((s) => {
              const colors = WATCH_STATUS_COLORS[s];
              return (
                <FilterMenuItem
                  key={s}
                  checked={statusFilter === s}
                  onSelect={() => onStatusFilterChange(s)}
                >
                  <span
                    aria-hidden='true'
                    className={cn('h-1.5 w-1.5 rounded-full bg-current', colors.text)}
                  />
                  {WATCH_STATUS_LABELS[s]}
                  <span className='ml-auto text-[11px] tabular-nums text-zinc-600'>
                    {statusCounts[s] ?? 0}
                  </span>
                </FilterMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant='ghost'
          size='sm'
          aria-disabled={!hasFilters || undefined}
          onClick={() => {
            if (hasFilters) onReset();
          }}
          className='h-9 gap-1.5 px-2 text-[12px] text-zinc-400 hover:text-white aria-disabled:opacity-40 aria-disabled:cursor-default'
        >
          <RotateCcw className='h-3.5 w-3.5' />
          Reset
        </Button>
        <div className='ml-auto flex items-center gap-2'>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant='outline'
                size='sm'
                className={FILTER_MENU_BUTTON_CLASS}
                aria-label={`Sort library: ${activeSortOption.label}`}
              >
                {ActiveSortIcon ? <ActiveSortIcon className='w-3 h-3' /> : null}
                <span>{activeSortOption.label}</span>
                <ChevronDown className='w-3 h-3 opacity-50' />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end' className='w-36 bg-zinc-950/98 border-white/10'>
              {LIBRARY_SORT_KEYS.map((key) => {
                const { label, icon: ItemIcon } = LIBRARY_SORT_OPTIONS[key];
                return (
                  <FilterMenuItem
                    key={key}
                    checked={sort === key}
                    onSelect={() => onSortChange(key)}
                  >
                    {ItemIcon ? <ItemIcon className='w-3.5 h-3.5' /> : null}
                    {label}
                  </FilterMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>

          <ViewToggle viewMode={viewMode} onChange={onViewModeChange} />
        </div>
      </div>
    </div>
  );
}

function FilterMenuItem({
  checked,
  onSelect,
  children,
}: {
  checked: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenuItem
      role='menuitemradio'
      aria-checked={checked}
      onSelect={onSelect}
      className='gap-2 text-[12px] rounded-md cursor-pointer py-1.5'
    >
      {checked ? (
        <Check className='w-3.5 h-3.5 opacity-70 shrink-0' />
      ) : (
        <div className='w-3.5 shrink-0' />
      )}
      {children}
    </DropdownMenuItem>
  );
}

export function ViewToggle({
  viewMode,
  onChange,
}: {
  viewMode: 'grid' | 'list';
  onChange: (v: 'grid' | 'list') => void;
}) {
  return (
    <div
      className='flex items-center gap-0.5 p-0.5 rounded-md bg-white/[0.03] border border-white/[0.07] shrink-0'
      role='group'
      aria-label='Collection view'
    >
      {VIEW_MODES.map(({ mode, label, icon: Icon }) => (
        <button
          key={mode}
          type='button'
          title={label}
          aria-label={label}
          aria-pressed={viewMode === mode}
          onClick={() => {
            if (mode !== viewMode) onChange(mode);
          }}
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-sm transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-white/30',
            viewMode === mode ? 'accent-active' : 'text-zinc-400 hover:text-zinc-200',
          )}
        >
          <Icon className='w-3.5 h-3.5' />
        </button>
      ))}
    </div>
  );
}
