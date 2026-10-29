import {
  ArrowDownAZ,
  ArrowUp,
  CalendarArrowDown,
  CalendarArrowUp,
  Check,
  CheckSquare,
  ChevronDown,
  LayoutGrid,
  List,
  ListPlus,
  type LucideIcon,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { type RefObject, useCallback, useEffect, useId, useRef, useState } from 'react';
import { CreateListDialog, warmListEditorDialog } from '@/components/list/list-editor-dialog';
import { ListIconTile } from '@/components/list/list-icons';
import { RetryBanner } from '@/components/retry-banner';
import { WatchStatusIcon } from '@/components/watch-status-icon';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SearchInput } from '@/components/ui/search-input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { useListSummaries } from '@/hooks/use-media-library';
import { useScrolledPastTitlebar } from '@/hooks/use-scroll-edge-indicators';
import {
  type LibraryFilters,
  WATCH_STATUS_LABELS,
  WATCH_STATUSES,
  type WatchStatus,
} from '@/lib/api';
import { cn, pluralize, SIDEBAR_PAGE_COLUMN_INSETS } from '@/lib/utils';
import {
  handleRadioGroupKeyDown,
  isEditableTarget,
  OPEN_DIALOG_SELECTOR,
  RADIX_POPPER_CONTENT_SELECTOR,
} from '@/lib/dom';
type LibrarySort = Exclude<NonNullable<LibraryFilters['sort']>, 'title-asc'>;
type LibraryStatusFilter = WatchStatus | 'all' | 'none';

const LIBRARY_SORT_OPTIONS: Record<LibrarySort, { label: string; icon: LucideIcon | null }> = {
  default: { label: 'Default', icon: null },
  'title-desc': { label: 'Z → A', icon: ArrowDownAZ },
  'year-desc': { label: 'Newest', icon: CalendarArrowDown },
  'year-asc': { label: 'Oldest', icon: CalendarArrowUp },
};

const LIBRARY_SORT_KEYS = Object.keys(LIBRARY_SORT_OPTIONS) as LibrarySort[];

export function isLibrarySort(value: string | null): value is LibrarySort {
  return LIBRARY_SORT_KEYS.some((key) => key === value);
}

const LIBRARY_FOCUS_RING_CLASS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30';
const FILTER_MENU_BUTTON_CLASS = cn(
  'h-9 px-3 gap-1.5 text-[12px] bg-white/[0.02] border-white/[0.08] shadow-none hover:bg-white/[0.06] text-zinc-300 hover:text-white shrink-0',
  LIBRARY_FOCUS_RING_CLASS,
);

const VIEW_MODES: { value: 'grid' | 'list'; label: string; icon: LucideIcon }[] = [
  { value: 'grid', label: 'Grid view', icon: LayoutGrid },
  { value: 'list', label: 'List view', icon: List },
];

export const TYPE_OPTIONS: { value: 'all' | 'movie' | 'series'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'movie', label: 'Movies' },
  { value: 'series', label: 'Series' },
];

interface LibraryToolbarProps {
  typeFilter: 'all' | 'movie' | 'series';
  onTypeFilterChange: (type: 'all' | 'movie' | 'series') => void;
  statusFilter: LibraryStatusFilter;
  onStatusFilterChange: (status: LibraryStatusFilter) => void;
  statusCounts: Record<WatchStatus | 'none', number>;
  statusesAvailable: boolean;
  libraryCount: number;
  filteredCount: number;
  search: string;
  searchPending: boolean;
  onSearchChange: (value: string) => void;
  searchInputRef: RefObject<HTMLInputElement | null>;
  sort: LibrarySort;
  onSortChange: (sort: LibrarySort) => void;
  viewMode: 'grid' | 'list';
  onViewModeChange: (mode: 'grid' | 'list') => void;
  onReset: () => void;
  selectionMode: boolean;
  selectionTriggerRef: RefObject<HTMLButtonElement | null>;
  onToggleSelectionMode: () => void;
}

export function LibraryToolbar({
  typeFilter,
  onTypeFilterChange,
  statusFilter,
  onStatusFilterChange,
  statusCounts,
  statusesAvailable,
  libraryCount,
  filteredCount,
  search,
  searchPending,
  onSearchChange,
  searchInputRef,
  sort,
  onSortChange,
  viewMode,
  onViewModeChange,
  onReset,
  selectionMode,
  selectionTriggerRef,
  onToggleSelectionMode,
}: LibraryToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const compactToolbarRef = useRef<HTMLDivElement>(null);
  const toolbarPassed = useScrolledPastTitlebar(toolbarRef, compactToolbarRef, searchInputRef);

  const activeSortOption = LIBRARY_SORT_OPTIONS[sort];
  const ActiveSortIcon = activeSortOption.icon;
  const hasFilters =
    typeFilter !== 'all' || statusFilter !== 'all' || search.length > 0 || sort !== 'default';
  const statusLabel =
    statusFilter === 'all'
      ? 'All statuses'
      : statusFilter === 'none'
        ? 'No status'
        : WATCH_STATUS_LABELS[statusFilter];
  const filterSummary = [
    typeFilter === 'movie' ? 'Movies' : typeFilter === 'series' ? 'Series' : null,
    statusFilter !== 'all' ? statusLabel : null,
    sort !== 'default' ? activeSortOption.label : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const countLabel =
    filteredCount === libraryCount
      ? pluralize(libraryCount, 'title')
      : `${filteredCount} of ${libraryCount}`;
  const showCompactToolbar = toolbarPassed && !selectionMode;
  const returnToFilters = () => {
    toolbarRef.current?.scrollIntoView({ block: 'start' });
    searchInputRef.current?.focus({ preventScroll: true });
  };

  return (
    <div ref={toolbarRef} className='scroll-mt-12 space-y-3'>
      <div className='flex items-center gap-3'>
        <SearchInput
          inputRef={searchInputRef}
          placeholder='Search library…'
          value={search}
          pending={searchPending}
          onValueChange={onSearchChange}
          clearLabel='Clear library search'
          wrapperClassName='flex-1 min-w-0'
          className='h-10 text-[13px] bg-white/[0.03] border-white/[0.08] text-white placeholder:text-zinc-500 focus-visible:border-(--accent-nav) focus-visible:ring-(--accent-nav)/25 rounded-lg'
        />
        <span className='text-[12px] tabular-nums text-zinc-400 shrink-0' role='status'>
          {countLabel}
        </span>
      </div>
      <div className='flex items-center gap-2 flex-wrap'>
        <SegmentedControl
          label='Library media type'
          value={typeFilter}
          options={TYPE_OPTIONS}
          onChange={onTypeFilterChange}
        />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant='outline'
              size='sm'
              className={FILTER_MENU_BUTTON_CLASS}
              aria-label={`Library status: ${statusLabel}`}
            >
              {statusFilter !== 'all' && statusFilter !== 'none' && (
                <WatchStatusIcon status={statusFilter} className='size-3.5' strokeWidth={2.1} />
              )}
              <span>{statusLabel}</span>
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
              return (
                <FilterMenuItem
                  key={s}
                  checked={statusFilter === s}
                  onSelect={() => onStatusFilterChange(s)}
                >
                  <WatchStatusIcon status={s} className='size-3.5' strokeWidth={2.1} />
                  {WATCH_STATUS_LABELS[s]}
                  <span className='ml-auto text-[11px] tabular-nums text-zinc-600'>
                    {statusesAvailable ? (statusCounts[s] ?? 0) : '—'}
                  </span>
                </FilterMenuItem>
              );
            })}
            <FilterMenuItem
              checked={statusFilter === 'none'}
              onSelect={() => onStatusFilterChange('none')}
            >
              No status
              <span className='ml-auto text-[11px] tabular-nums text-zinc-600'>
                {statusesAvailable ? (statusCounts.none ?? 0) : '—'}
              </span>
            </FilterMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant='ghost'
          size='sm'
          aria-disabled={!hasFilters || undefined}
          onClick={() => {
            if (hasFilters) onReset();
          }}
          className={cn(
            'h-9 gap-1.5 px-2 text-[12px] text-zinc-400 hover:text-white aria-disabled:pointer-events-none aria-disabled:opacity-40 aria-disabled:cursor-default',
            LIBRARY_FOCUS_RING_CLASS,
          )}
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
          <Button
            ref={selectionTriggerRef}
            variant='outline'
            size='sm'
            aria-pressed={selectionMode}
            onClick={onToggleSelectionMode}
            className={cn(
              FILTER_MENU_BUTTON_CLASS,
              selectionMode && 'border-white/[0.18] bg-white/[0.1] text-white',
            )}
          >
            <CheckSquare className='h-3.5 w-3.5' />
            Select
          </Button>
        </div>
      </div>
      <div
        ref={compactToolbarRef}
        role='region'
        aria-label='Library controls'
        aria-hidden={!showCompactToolbar || undefined}
        inert={!showCompactToolbar}
        className={cn(
          'pointer-events-none fixed inset-x-0 top-8 z-40 transition-[opacity,translate] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          showCompactToolbar ? 'translate-y-0 opacity-100' : '-translate-y-1.5 opacity-0',
        )}
      >
        <div className={`mx-auto w-full max-w-7xl pt-2 ${SIDEBAR_PAGE_COLUMN_INSETS}`}>
          <div
            className={cn(
              'flex h-11 items-center gap-2 rounded-lg border border-white/[0.09] bg-zinc-950/85 p-1 shadow-[0_12px_32px_-14px_rgb(0_0_0/0.9),inset_0_1px_0_rgb(255_255_255/0.05)] backdrop-blur-md',
              showCompactToolbar && 'pointer-events-auto',
            )}
          >
            <button
              type='button'
              onClick={returnToFilters}
              title='Back to library filters'
              className={cn(
                'flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 text-left text-[13px] text-zinc-300 transition-colors duration-150 hover:bg-white/[0.05] hover:text-white motion-reduce:transition-none',
                LIBRARY_FOCUS_RING_CLASS,
              )}
            >
              <Search aria-hidden='true' className='h-3.5 w-3.5 shrink-0 text-zinc-500' />
              <span className='truncate'>{search || 'Library filters'}</span>
              <ArrowUp aria-hidden='true' className='h-3 w-3 shrink-0 text-zinc-500' />
            </button>
            {filterSummary && (
              <span
                title={filterSummary}
                className='accent-lattice-soft hidden max-w-[40%] truncate rounded-md border px-2 py-1 text-[11px] sm:inline'
              >
                {filterSummary}
              </span>
            )}
            <span className='shrink-0 text-[11px] tabular-nums text-zinc-400'>{countLabel}</span>
            {hasFilters && (
              <Button
                size='icon'
                variant='ghost'
                aria-label='Reset library filters'
                title='Reset library filters'
                onClick={() => {
                  returnToFilters();
                  onReset();
                }}
                className={cn(
                  'h-8 w-8 shrink-0 text-zinc-400 hover:text-white',
                  LIBRARY_FOCUS_RING_CLASS,
                )}
              >
                <RotateCcw aria-hidden='true' className='h-3.5 w-3.5' />
              </Button>
            )}
            <ViewToggle viewMode={viewMode} onChange={onViewModeChange} />
          </div>
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

export function SegmentPill({
  index,
  count,
  inset,
  className,
}: {
  index: number;
  count: number;
  inset: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden='true'
      className={cn(
        'nav-sliding-pill pointer-events-none absolute rounded-sm bg-(--accent-nav)',
        className,
      )}
      style={{
        top: inset,
        bottom: inset,
        left: inset,
        width: `calc((100% - ${inset * 2}px) / ${count})`,
        transform: `translateX(${index * 100}%)`,
      }}
    />
  );
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; icon?: LucideIcon }[];
  onChange: (value: T) => void;
}) {
  return (
    <div
      role='radiogroup'
      aria-label={label}
      className='relative isolate grid auto-cols-fr grid-flow-col p-0.5 rounded-md bg-white/[0.03] border border-white/[0.07] shrink-0'
    >
      <SegmentPill
        index={options.findIndex((option) => option.value === value)}
        count={options.length}
        inset={2}
      />
      {options.map((option) => {
        const Icon = option.icon;
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type='button'
            role='radio'
            aria-checked={selected}
            aria-label={Icon ? option.label : undefined}
            title={Icon ? option.label : undefined}
            tabIndex={selected ? 0 : -1}
            onKeyDown={handleRadioGroupKeyDown}
            onClick={() => {
              if (!selected) onChange(option.value);
            }}
            className={cn(
              'nav-switch-item relative z-10 flex h-8 items-center justify-center rounded-sm text-[12px] font-medium',
              Icon ? 'w-8' : 'px-3',
              LIBRARY_FOCUS_RING_CLASS,
              selected ? 'text-(--on-accent-nav)' : 'text-zinc-400 hover:text-zinc-100',
            )}
          >
            {Icon ? <Icon className='w-3.5 h-3.5' /> : option.label}
          </button>
        );
      })}
    </div>
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
    <SegmentedControl
      label='Collection view'
      value={viewMode}
      options={VIEW_MODES}
      onChange={onChange}
    />
  );
}

export function useCollectionSelection(
  ids: string[],
  visibleIds: string[],
  active: boolean,
  busy: boolean,
  dialogOpen = false,
  fallbackFocusRef?: RefObject<HTMLElement | null>,
  selectAllDisabled = false,
) {
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const triggerRef = useRef<HTMLButtonElement>(null);
  const anchorRef = useRef<string | null>(null);
  const clear = useCallback(() => {
    setSelectedIds(new Set());
    anchorRef.current = null;
  }, []);
  const selectAll = useCallback(
    (selected: string[]) => {
      if (!busy && !selectAllDisabled)
        setSelectedIds((current) => new Set([...current, ...selected]));
    },
    [busy, selectAllDisabled],
  );
  const exit = useCallback(() => {
    setSelectionMode(false);
    clear();
    requestAnimationFrame(() => {
      const trigger = triggerRef.current;
      (trigger && !trigger.disabled ? trigger : fallbackFocusRef?.current)?.focus({
        preventScroll: true,
      });
    });
  }, [clear, fallbackFocusRef]);
  useEffect(() => {
    if (!selectionMode || busy) return;
    if (!active) {
      setSelectionMode(false);
      clear();
      return;
    }
    if (ids.length === 0) {
      exit();
      return;
    }
    const available = new Set(ids);
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => available.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [ids, active, busy, selectionMode, clear, exit]);
  useEffect(() => {
    if (!selectionMode || busy || dialogOpen) return;
    const handleKey = (event: KeyboardEvent) => {
      const focusedCollection = document.activeElement?.closest('[data-collection-selection]');
      const selectsAll =
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'a';
      if (
        (event.key !== 'Escape' && !selectsAll) ||
        event.defaultPrevented ||
        (focusedCollection &&
          triggerRef.current &&
          !focusedCollection.contains(triggerRef.current)) ||
        isEditableTarget(document.activeElement, RADIX_POPPER_CONTENT_SELECTOR) ||
        document.querySelector(`${RADIX_POPPER_CONTENT_SELECTOR}, ${OPEN_DIALOG_SELECTOR}`)
      )
        return;
      event.preventDefault();
      if (selectsAll) selectAll(visibleIds);
      else exit();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [selectionMode, busy, dialogOpen, exit, visibleIds, selectAll]);
  const toggle = useCallback(
    (id: string, shiftKey = false) => {
      if (busy) return;
      const anchor =
        shiftKey && anchorRef.current !== null ? visibleIds.indexOf(anchorRef.current) : -1;
      const target = anchor !== -1 ? visibleIds.indexOf(id) : -1;
      if (anchor === -1 || target === -1) anchorRef.current = id;
      setSelectedIds((current) => {
        const next = new Set(current);
        if (anchor !== -1 && target !== -1) {
          for (let index = Math.min(anchor, target); index <= Math.max(anchor, target); index++)
            next.add(visibleIds[index]);
        } else if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [busy, visibleIds],
  );
  return {
    selectionMode,
    selectedIds,
    triggerRef,
    exit,
    toggle,
    begin: () => setSelectionMode(true),
    clear,
    selectAll,
  };
}

export function CollectionBulkActionBar({
  selectedCount,
  filteredCount,
  allFilteredSelected,
  selectAllDisabled,
  isBusy,
  onSelectAll,
  onClear,
  onDone,
  onRemove,
  removeLabel,
  children,
}: {
  selectedCount: number;
  filteredCount: number;
  allFilteredSelected: boolean;
  selectAllDisabled: boolean;
  isBusy: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  onDone: () => void;
  onRemove: () => void;
  removeLabel: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      role='region'
      aria-label='Selection actions'
      aria-busy={isBusy}
      className='sticky top-10 z-30 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/[0.12] bg-zinc-950/95 px-3 py-2 shadow-[0_12px_32px_-14px_rgb(0_0_0/0.9),inset_0_1px_0_rgb(255_255_255/0.05)]'
    >
      <div className='flex flex-wrap items-center gap-1.5'>
        <span
          role='status'
          aria-atomic='true'
          className='mr-1.5 text-[13px] font-semibold text-white tabular-nums'
        >
          {selectedCount} selected
        </span>
        <button
          type='button'
          aria-disabled={
            filteredCount === 0 || isBusy || selectAllDisabled || allFilteredSelected || undefined
          }
          onClick={() => {
            if (filteredCount > 0 && !isBusy && !selectAllDisabled && !allFilteredSelected)
              onSelectAll();
          }}
          className={cn(
            'h-8 rounded-md px-2 text-xs font-medium text-zinc-300 not-aria-disabled:hover:bg-white/[0.06] not-aria-disabled:hover:text-white aria-disabled:opacity-40 aria-disabled:cursor-default',
            LIBRARY_FOCUS_RING_CLASS,
          )}
        >
          Select all ({filteredCount})
        </button>
        <button
          type='button'
          aria-disabled={selectedCount === 0 || isBusy || undefined}
          onClick={() => {
            if (selectedCount > 0 && !isBusy) onClear();
          }}
          className={cn(
            'h-8 rounded-md px-2 text-xs font-medium text-zinc-400 not-aria-disabled:hover:bg-white/[0.06] not-aria-disabled:hover:text-white aria-disabled:opacity-40 aria-disabled:cursor-default',
            LIBRARY_FOCUS_RING_CLASS,
          )}
        >
          Clear
        </button>
      </div>
      <div className='flex flex-wrap items-center gap-1.5'>
        {children}
        <Button
          size='sm'
          variant='outline'
          disabled={selectedCount === 0 || isBusy}
          onClick={onRemove}
          className={cn(
            'h-8 gap-1.5 rounded-lg border-rose-500/25 bg-rose-500/10 px-2.5 text-xs text-rose-300 hover:bg-rose-500/20 hover:text-rose-200',
            LIBRARY_FOCUS_RING_CLASS,
          )}
        >
          <Trash2 className='h-3.5 w-3.5' />
          {removeLabel}
        </Button>
        <Button
          size='sm'
          variant='ghost'
          disabled={isBusy}
          onClick={onDone}
          className={cn(
            'h-8 gap-1.5 rounded-lg px-2.5 text-xs text-zinc-400 hover:text-white',
            LIBRARY_FOCUS_RING_CLASS,
          )}
        >
          <X className='h-3.5 w-3.5' />
          Done
          <kbd aria-hidden='true' className='ml-0.5 hidden text-[10px] text-zinc-500 sm:inline'>
            Esc
          </kbd>
        </Button>
      </div>
    </div>
  );
}

interface LibraryBulkActionBarProps {
  selectedIds: string[];
  filteredCount: number;
  selectAllDisabled?: boolean;
  allFilteredSelected: boolean;
  onSelectAllFiltered: () => void;
  onClearSelection: () => void;
  onExitSelectionMode: () => void;
  onBulkSetStatus: (status: WatchStatus | null) => void;
  onBulkAddToList: (listId: string, listName: string, itemIds: string[]) => Promise<void>;
  onBulkRemove: () => void;
  isBusy?: boolean;
}

const BULK_BUTTON_CLASS = cn(
  'h-8 gap-1.5 rounded-lg border-white/[0.1] bg-white/[0.03] px-2.5 text-xs text-zinc-300 hover:bg-white/[0.08] hover:text-white aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-white/[0.03] aria-disabled:hover:text-zinc-300',
  LIBRARY_FOCUS_RING_CLASS,
);
const BULK_MENU_ITEM_CLASS = cn(
  'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-zinc-300 transition-colors hover:bg-white/[0.08] hover:text-white focus-visible:ring-inset disabled:opacity-50',
  LIBRARY_FOCUS_RING_CLASS,
);
const BULK_STATUS_OPTIONS: { status: WatchStatus | null; label: string }[] = [
  ...WATCH_STATUSES.map((status) => ({ status, label: WATCH_STATUS_LABELS[status] })),
  { status: null, label: 'Clear status' },
];

export function LibraryBulkActionBar({
  selectedIds,
  filteredCount,
  selectAllDisabled = false,
  allFilteredSelected,
  onSelectAllFiltered,
  onClearSelection,
  onExitSelectionMode,
  onBulkSetStatus,
  onBulkAddToList,
  onBulkRemove,
  isBusy = false,
}: LibraryBulkActionBarProps) {
  const [statusOpen, setStatusOpen] = useState(false);
  const [listsOpen, setListsOpen] = useState(false);
  const [createListOpen, setCreateListOpen] = useState(false);
  const [createListItemIds, setCreateListItemIds] = useState<string[]>([]);
  const addToListTriggerRef = useRef<HTMLButtonElement>(null);
  const statusHeadingId = useId();
  const listsHeadingId = useId();
  const {
    data: allLists = [],
    isPending: listsLoading,
    isError: listsError,
    isFetching: listsFetching,
    refetch: refetchLists,
  } = useListSummaries(undefined, { enabled: listsOpen });
  const customLists = allLists.filter((list) => !list.is_smart);
  const selectedCount = selectedIds.length;
  const actionsDisabled = selectedCount === 0 || isBusy;

  return (
    <CollectionBulkActionBar
      selectedCount={selectedCount}
      filteredCount={filteredCount}
      allFilteredSelected={allFilteredSelected}
      selectAllDisabled={selectAllDisabled}
      isBusy={isBusy}
      onSelectAll={onSelectAllFiltered}
      onClear={onClearSelection}
      onDone={onExitSelectionMode}
      onRemove={onBulkRemove}
      removeLabel='Remove'
    >
      <Popover
        open={statusOpen}
        onOpenChange={(open) => {
          if (!open || !actionsDisabled) setStatusOpen(open);
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant='outline'
            size='sm'
            aria-disabled={actionsDisabled || undefined}
            onClick={(event) => {
              if (actionsDisabled) event.preventDefault();
            }}
            className={BULK_BUTTON_CLASS}
          >
            <CheckSquare className='h-3.5 w-3.5' />
            Set Status
            <ChevronDown className='h-3 w-3 opacity-60' />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align='end'
          aria-labelledby={statusHeadingId}
          className='w-44 rounded-xl border-white/10 bg-zinc-950/98 p-1.5 shadow-xl'
        >
          <p id={statusHeadingId} className='px-2.5 py-1.5 text-[11px] font-medium text-zinc-500'>
            Set watch status
          </p>
          {BULK_STATUS_OPTIONS.map(({ status, label }) => (
            <button
              key={status ?? 'clear'}
              type='button'
              disabled={actionsDisabled}
              className={BULK_MENU_ITEM_CLASS}
              onClick={() => {
                setStatusOpen(false);
                onBulkSetStatus(status);
              }}
            >
              {status === null ? (
                <X
                  aria-hidden='true'
                  className='size-3.5 shrink-0 text-zinc-500'
                  strokeWidth={2.1}
                />
              ) : (
                <WatchStatusIcon status={status} className='size-3.5' strokeWidth={2.1} />
              )}
              {label}
            </button>
          ))}
        </PopoverContent>
      </Popover>
      <Popover
        open={listsOpen}
        onOpenChange={(open) => {
          if (!open || !actionsDisabled) setListsOpen(open);
        }}
      >
        <PopoverTrigger asChild>
          <Button
            ref={addToListTriggerRef}
            variant='outline'
            size='sm'
            aria-disabled={actionsDisabled || undefined}
            onClick={(event) => {
              if (actionsDisabled) event.preventDefault();
            }}
            className={BULK_BUTTON_CLASS}
          >
            <ListPlus className='h-3.5 w-3.5' />
            Add to List
            <ChevronDown className='h-3 w-3 opacity-60' />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align='end'
          aria-labelledby={listsHeadingId}
          className='w-72 rounded-xl border-white/10 bg-zinc-950/95 backdrop-blur-xl p-1.5 shadow-2xl'
        >
          <p id={listsHeadingId} className='px-2.5 py-1.5 text-[11px] font-medium text-zinc-500'>
            Add selected titles
          </p>
          {listsError && (
            <RetryBanner
              className='px-2.5 py-2'
              message="Couldn't load lists."
              onRetry={() => void refetchLists()}
              isRetrying={listsFetching}
            />
          )}
          <div className='max-h-64 overflow-y-auto'>
            {listsLoading && (
              <div aria-label='Loading lists' role='status' className='space-y-1.5 p-2.5'>
                <Skeleton className='h-9 rounded-lg bg-white/[0.06]' />
                <Skeleton className='h-9 rounded-lg bg-white/[0.06]' />
                <Skeleton className='h-9 rounded-lg bg-white/[0.06]' />
              </div>
            )}
            {!listsLoading && !listsError && customLists.length === 0 && (
              <p className='px-2.5 py-2 text-xs text-zinc-500'>
                No manual lists yet — create one to group titles.
                {allLists.length > 0 && (
                  <span className='mt-1 block'>
                    Smart lists fill automatically from their rules.
                  </span>
                )}
              </p>
            )}
            {customLists.map((list) => (
              <button
                key={list.id}
                type='button'
                disabled={actionsDisabled}
                className={BULK_MENU_ITEM_CLASS}
                title={list.name}
                onClick={() => {
                  setListsOpen(false);
                  void onBulkAddToList(list.id, list.name, selectedIds);
                }}
              >
                <ListIconTile iconId={list.icon} size='sm' />
                <span className='min-w-0 flex-1 truncate' dir='auto'>
                  {list.name}
                </span>
                <span className='text-[11px] tabular-nums text-zinc-500'>
                  {pluralize(list.item_count, 'title')}
                </span>
              </button>
            ))}
          </div>
          <button
            type='button'
            disabled={actionsDisabled}
            className={cn(BULK_MENU_ITEM_CLASS, 'mt-1 border-t border-white/[0.06]')}
            onPointerEnter={warmListEditorDialog}
            onFocus={warmListEditorDialog}
            onClick={() => {
              setListsOpen(false);
              setCreateListItemIds(selectedIds);
              setCreateListOpen(true);
            }}
          >
            <Plus className='h-3.5 w-3.5' />
            New list…
          </button>
        </PopoverContent>
      </Popover>
      <CreateListDialog
        open={createListOpen}
        onOpenChange={setCreateListOpen}
        onCreated={(list) => onBulkAddToList(list.id, list.name, createListItemIds)}
        returnFocusRef={addToListTriggerRef}
      />
    </CollectionBulkActionBar>
  );
}
