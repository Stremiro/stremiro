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
} from 'lucide-react';
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
  'h-9 px-3 gap-1.5 text-[11px] font-semibold rounded-md bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.07] text-zinc-400 hover:text-white shrink-0 inline-flex items-center';

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
  sort,
  onSortChange,
  viewMode,
  onViewModeChange,
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
  sort: LibrarySort;
  onSortChange: (sort: LibrarySort) => void;
  viewMode: 'grid' | 'list';
  onViewModeChange: (mode: 'grid' | 'list') => void;
}) {
  const activeSortOption = LIBRARY_SORT_OPTIONS[sort];
  const ActiveSortIcon = activeSortOption.icon;

  return (
    <div className='flex items-center gap-2 flex-wrap rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5'>
      <div className='flex items-center gap-0.5 p-1 rounded-lg bg-white/[0.04] border border-white/[0.07] shrink-0'>
        {(['all', 'movie', 'series'] as const).map((t) => (
          <button
            key={t}
            type='button'
            aria-pressed={typeFilter === t}
            onClick={() => onTypeFilterChange(t)}
            style={typeFilter === t ? { backgroundColor: 'var(--accent-nav)' } : undefined}
            className={cn(
              'px-3 py-1.5 rounded-md text-[12px] font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25',
              typeFilter === t
                ? 'text-(--on-accent-nav) shadow-xs'
                : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.06]',
            )}
          >
            {t === 'all' ? 'All' : t === 'movie' ? 'Movies' : 'Shows'}
          </button>
        ))}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant='outline' size='sm' className={FILTER_MENU_BUTTON_CLASS}>
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

      <SearchInput
        placeholder='Search library…'
        value={search}
        onValueChange={onSearchChange}
        clearLabel='Clear library search'
        wrapperClassName='flex-1 min-w-[140px]'
        className='h-9 text-sm bg-white/[0.03] border-white/[0.06] text-white placeholder:text-zinc-600 focus-visible:ring-white/10 rounded-lg'
      />

      <span className='text-[11px] tabular-nums text-zinc-600 shrink-0'>
        {filteredCount} of {libraryCount}
      </span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant='outline' size='sm' className={FILTER_MENU_BUTTON_CLASS}>
            {ActiveSortIcon ? <ActiveSortIcon className='w-3 h-3' /> : null}
            <span>{activeSortOption.label}</span>
            <ChevronDown className='w-3 h-3 opacity-50' />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end' className='w-36 bg-zinc-950/98 border-white/10'>
          {LIBRARY_SORT_KEYS.map((key) => {
            const { label, icon: ItemIcon } = LIBRARY_SORT_OPTIONS[key];
            return (
              <FilterMenuItem key={key} checked={sort === key} onSelect={() => onSortChange(key)}>
                {ItemIcon ? <ItemIcon className='w-3.5 h-3.5' /> : null}
                {label}
              </FilterMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      <ViewToggle viewMode={viewMode} onChange={onViewModeChange} />
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
      onClick={onSelect}
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
    <div className='flex items-center gap-0.5 p-0.5 rounded-md bg-white/[0.04] border border-white/[0.07] shrink-0'>
      {VIEW_MODES.map(({ mode, label, icon: Icon }) => (
        <button
          key={mode}
          type='button'
          title={label}
          aria-label={label}
          aria-pressed={viewMode === mode}
          onClick={() => onChange(mode)}
          className={cn(
            'p-1.5 rounded-md transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-white/30',
            viewMode === mode ? 'accent-active' : 'text-zinc-600 hover:text-zinc-300',
          )}
        >
          <Icon className='w-3.5 h-3.5' />
        </button>
      ))}
    </div>
  );
}
