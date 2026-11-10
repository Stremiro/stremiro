import {
  closestCenter,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  pointerWithin,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  CheckSquare,
  GripVertical,
  ListPlus,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { InlineMenu } from '@/components/inline-menu';
import { useSearchParams } from 'react-router';
import {
  CreateListDialog,
  RenameListDialog,
  warmListEditorDialog,
} from '@/components/list/list-editor-dialog';
import { PosterThumb } from '@/components/poster-thumb';
import {
  CollectionBulkActionBar,
  useCollectionSelection,
} from '@/components/profile-library-controls';
import { ViewToggle } from '@/components/ui/segmented-control';
import { CollectionRowActions } from '@/components/collection-row-actions';
import { RetryBanner } from '@/components/retry-banner';
import { StatePanel } from '@/components/state-panel';
import { SelectionCheck } from '@/components/watch-status-icon';
import { useBulkRemoveFromList, useLists } from '@/hooks/use-media-library';
import { useTitleSearch } from '@/hooks/use-item-search';
import { useMountedRef } from '@/hooks/use-mounted-ref';
import { usePrefetchDetails } from '@/hooks/use-prefetch-details';
import { useInlineMenu } from '@/hooks/use-inline-menu';
import { useSortableSensors } from '@/hooks/use-sortable-sensors';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { SearchInput } from '@/components/ui/search-input';
import { api, type MediaItem, type UserList } from '@/lib/api';
import { navigateToDetails } from '@/lib/player-navigation';
import { notifyAction } from '@/lib/notify';
import { trackPendingAppWrite } from '@/lib/pending-app-writes';

import {
  invalidateListMetadataQueries,
  invalidateListQueries,
  LISTS_QUERY_KEY,
} from '@/lib/query-invalidation';
import { boundedMapSet, cn, orderByIds, pluralize } from '@/lib/utils';
import { AddTitlesDialog } from './add-titles-dialog';
import { ListIconTile } from './list-icons';

const LIST_ITEMS_PAGE_SIZE = 150;
const DELETE_LIST_MUTATION_KEY = ['delete-list'] as const;
const LIST_ORDER_MUTATION_KEY = ['list-order'] as const;
const listViewStates = new Map<
  string,
  { viewMode: 'grid' | 'list'; search: string; visibleLimit: number }
>();

// Skeleton rows mirror the last resolved list count instead of a fixed guess.
let lastResolvedListCount: number | undefined;
const LIST_SKELETON_CAP = 6;
const SORTABLE_TRANSITION = { duration: 200, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' };

// closestCenter flaps between variable-height rows; pointerWithin holds the row under the cursor.
// The closestCenter fallback covers keyboard drags (no pointer coordinates) and gaps between rows.
const sortableCollisionDetection: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length > 0 ? within : closestCenter(args);
};

function ListPosterStack({ items }: { items?: MediaItem[] }) {
  const posters = items?.slice(0, 3) ?? [];
  return (
    <span aria-hidden='true' className='hidden h-10 shrink-0 items-center -space-x-3 sm:flex'>
      {posters.length > 0 ? (
        posters.map((item) => (
          <PosterThumb
            key={item.id}
            poster={item.poster}
            mediaType={item.type}
            size='sm'
            className='bg-zinc-900 shadow-md ring-zinc-800'
          />
        ))
      ) : (
        <span className='flex h-10 w-7 items-center justify-center rounded-md border border-dashed border-white/10 text-zinc-600'>
          <Plus className='h-3 w-3' />
        </span>
      )}
    </span>
  );
}

interface SortableListCardProps {
  list: UserList;
  isExpanded: boolean;
  isDeleting: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onToggleExpand: (id: string) => void;
  onRename: (list: UserList) => void;
  onDelete: (list: UserList) => void;
  onMove: (delta: -1 | 1) => void;
}

function SortableListCard({
  list,
  isExpanded,
  isDeleting,
  canMoveUp,
  canMoveDown,
  onToggleExpand,
  onRename,
  onDelete,
  onMove,
}: SortableListCardProps) {
  const contentId = useId();
  const headerRef = useRef<HTMLDivElement>(null);
  const menu = useInlineMenu({
    rootRef: headerRef,
    returnFocus: () => headerRef.current?.querySelector('[aria-expanded]'),
  });
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: list.id,
    transition: SORTABLE_TRANSITION,
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      data-list-row={list.id}
      style={style}
      className={cn(
        'rounded-xl border transition-[background-color,border-color,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none!',
        isDragging
          ? 'relative z-10 border-white/20 bg-zinc-900 shadow-xl shadow-black/50'
          : isExpanded
            ? 'border-white/[0.12] bg-zinc-900/50'
            : 'border-white/[0.08] bg-zinc-900/40 hover:border-white/[0.12] hover:bg-zinc-900/60 focus-within:border-white/[0.12] focus-within:bg-zinc-900/60',
      )}
    >
      <div ref={headerRef} className='relative overflow-hidden' {...menu.rootProps}>
        <div
          className={cn(
            'flex items-center gap-3 px-4 py-3 transition-opacity duration-150 ease-out motion-reduce:transition-none',
            menu.presence.mounted && 'opacity-0 duration-0',
          )}
        >
          <button
            ref={setActivatorNodeRef}
            type='button'
            {...attributes}
            {...listeners}
            className='-ml-2 flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.05] transition-colors cursor-grab active:cursor-grabbing touch-none shrink-0 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/25'
            aria-label={`Reorder ${list.name}`}
          >
            <GripVertical className='w-4 h-4' />
          </button>

          <button
            type='button'
            onClick={() => onToggleExpand(list.id)}
            aria-expanded={isExpanded}
            aria-controls={isExpanded ? contentId : undefined}
            className='flex min-h-8 items-center gap-3 flex-1 min-w-0 rounded-md group focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/25'
          >
            <ListIconTile iconId={list.icon} />
            <div className='flex-1 min-w-0 text-left'>
              <span
                dir='auto'
                className='block truncate font-medium text-sm text-zinc-200 group-hover:text-white transition-colors'
              >
                {list.name}
              </span>
              <p className='mt-0.5 text-[11px] tabular-nums text-zinc-500'>
                {pluralize(list.item_ids.length, 'title')}
              </p>
            </div>
            <ListPosterStack items={list.items} />
            <div className='text-zinc-600 group-hover:text-zinc-400 transition-colors shrink-0 ml-2'>
              <ChevronRight
                aria-hidden='true'
                className={cn(
                  'w-4 h-4 transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                  isExpanded && 'rotate-90',
                )}
              />
            </div>
          </button>
        </div>
        <InlineMenu
          presence={menu.presence}
          orientation='horizontal'
          label={`Actions for ${list.name}`}
          className='rounded-lg bg-zinc-950/90 backdrop-blur-sm'
          onAction={menu.close}
          actions={[
            { key: 'back', label: 'Back', icon: ChevronLeft, muted: true, onSelect: menu.close },
            {
              key: 'rename',
              label: 'Edit',
              icon: Pencil,
              onWarm: warmListEditorDialog,
              onSelect: () => onRename(list),
            },
            {
              key: 'move-up',
              label: 'Move up',
              icon: ArrowUp,
              disabled: !canMoveUp,
              keepOpen: true,
              onSelect: () => onMove(-1),
            },
            {
              key: 'move-down',
              label: 'Move down',
              icon: ArrowDown,
              disabled: !canMoveDown,
              keepOpen: true,
              onSelect: () => onMove(1),
            },
            {
              key: 'delete',
              label: 'Delete',
              icon: Trash2,
              destructive: true,
              disabled: isDeleting,
              onSelect: () => onDelete(list),
            },
          ]}
        />
      </div>

      {isExpanded && (
        <div
          id={contentId}
          className='border-t border-white/[0.06] animate-surface-in motion-reduce:animate-none'
        >
          <ListItemsView key={list.id} list={list} />
        </div>
      )}
    </div>
  );
}

interface SortableItemRowProps {
  item: MediaItem;
  listId: string;
  viewMode: 'grid' | 'list';
  onRemove: (itemId: string, button: HTMLButtonElement | null) => void;
  selectionMode: boolean;
  isSelected: boolean;
  onToggleSelect: (id: string, shiftKey?: boolean) => void;
}

// The compiler memoizes rows on stable item props (structural sharing) — keystrokes re-render the view but skip unchanged rows.
function SortableItemRow({
  item,
  listId,
  viewMode,
  onRemove,
  selectionMode,
  isSelected,
  onToggleSelect,
}: SortableItemRowProps) {
  const removeButtonRef = useRef<HTMLButtonElement>(null);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `${listId}::${item.id}`,
    disabled: selectionMode,
    transition: SORTABLE_TRANSITION,
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  };

  const prefetchDetails = usePrefetchDetails(item.id, item.type);

  if (selectionMode) {
    return (
      <button
        type='button'
        aria-label={`${isSelected ? 'Deselect' : 'Select'} ${item.title}`}
        aria-pressed={isSelected}
        onClick={(event) => onToggleSelect(item.id, event.shiftKey)}
        className={cn(
          'relative group rounded-lg border text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/30',
          viewMode === 'grid' ? 'overflow-hidden' : 'flex w-full items-center gap-3 px-3 py-2',
          isSelected
            ? 'border-white/20 bg-white/[0.06]'
            : 'border-white/5 bg-white/[0.02] hover:bg-white/5',
        )}
      >
        <SelectionCheck
          selected={isSelected}
          className={cn(
            viewMode === 'grid' && 'absolute top-2 left-2 z-10',
            !isSelected && 'bg-black/60',
          )}
        />
        <PosterThumb
          poster={item.poster}
          title={item.title}
          mediaType={item.type}
          size={viewMode === 'list' ? 'sm' : undefined}
          className={
            viewMode === 'grid' ? 'aspect-2/3 h-auto w-full rounded-none ring-0' : undefined
          }
        />
        <span
          dir='auto'
          title={item.title}
          className={cn(
            'block font-medium',
            viewMode === 'grid'
              ? 'line-clamp-2 min-h-[2.5em] p-2 text-[13px] leading-tight tracking-[-0.01em] text-zinc-100 [overflow-wrap:anywhere]'
              : 'truncate text-sm text-zinc-200',
          )}
        >
          {item.title}
        </span>
      </button>
    );
  }

  if (viewMode === 'grid') {
    return (
      <div
        ref={setNodeRef}
        style={style}
        className={cn(
          'relative group rounded-lg overflow-hidden bg-zinc-900/60 transition-[background-color,opacity,box-shadow] duration-200 motion-reduce:transition-none!',
          isDragging
            ? 'z-20 shadow-xl shadow-black/50 ring-1 ring-white/20'
            : 'hover:ring-1 hover:ring-white/20',
        )}
      >
        <button
          ref={setActivatorNodeRef}
          type='button'
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${item.title}`}
          className='absolute top-2 left-2 z-20 flex h-8 w-8 items-center justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity duration-150 cursor-grab active:cursor-grabbing bg-black/60 rounded-md touch-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40 motion-reduce:transition-none'
        >
          <GripVertical className='w-3 h-3 text-white' />
        </button>

        <button
          ref={removeButtonRef}
          data-list-remove={item.id}
          type='button'
          onClick={(e) => {
            e.stopPropagation();
            onRemove(item.id, removeButtonRef.current);
          }}
          aria-label={`Remove ${item.title} from list`}
          className='absolute top-2 right-2 z-20 flex h-8 w-8 items-center justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-[opacity,background-color] duration-150 bg-black/60 rounded-md hover:bg-red-500/80 text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40 motion-reduce:transition-none'
        >
          <X className='w-3 h-3' />
        </button>

        <button
          type='button'
          aria-label={`Open details for ${item.title}`}
          className='aspect-2/3 w-full cursor-pointer focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/40'
          onPointerDown={prefetchDetails}
          onFocus={prefetchDetails}
          onClick={() => navigateToDetails(item.type, item.id)}
        >
          <PosterThumb
            poster={item.poster}
            title={item.title}
            mediaType={item.type}
            className='h-full w-full rounded-none bg-zinc-800 ring-0'
            imageClassName='group-hover:opacity-80 transition-opacity'
          />
        </button>
        <div className='p-2'>
          <p
            dir='auto'
            title={item.title}
            className='line-clamp-2 min-h-[2.5em] text-[13px] font-medium leading-tight tracking-[-0.01em] text-zinc-100 [overflow-wrap:anywhere]'
          >
            {item.title}
          </p>
          {item.displayYear && (
            <p className='mt-1 text-[11px] leading-none text-zinc-400'>{item.displayYear}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'flex items-center gap-3 px-3 py-2 rounded-lg group transition-[background-color,opacity] duration-150 motion-reduce:transition-none!',
        isDragging
          ? 'relative z-10 bg-zinc-800 shadow-lg shadow-black/50 ring-1 ring-white/15'
          : 'hover:bg-white/5',
      )}
    >
      <button
        ref={setActivatorNodeRef}
        type='button'
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${item.title}`}
        className='-ml-1 flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.05] transition-colors cursor-grab active:cursor-grabbing touch-none shrink-0 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/25'
      >
        <GripVertical className='w-3.5 h-3.5' />
      </button>

      <button
        type='button'
        aria-label={`Open details for ${item.title}`}
        className='flex flex-1 min-w-0 items-center gap-3 rounded-md cursor-pointer text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/25'
        onPointerDown={prefetchDetails}
        onFocus={prefetchDetails}
        onClick={() => navigateToDetails(item.type, item.id)}
      >
        <PosterThumb
          poster={item.poster}
          mediaType={item.type}
          size='sm'
          className='rounded bg-zinc-800 ring-0'
        />
        <span className='flex-1 min-w-0'>
          <span
            dir='auto'
            title={item.title}
            className='block text-sm font-medium text-zinc-200 group-hover:text-white transition-colors truncate'
          >
            {item.title}
          </span>
          <span className='flex items-center gap-1.5 mt-0.5'>
            <span className='text-[10px] text-zinc-500 capitalize'>{item.type}</span>
            {item.displayYear && (
              <>
                <span className='text-zinc-700 text-[10px]'>·</span>
                <span className='text-[10px] text-zinc-500'>{item.displayYear}</span>
              </>
            )}
          </span>
        </span>
      </button>

      <CollectionRowActions item={item} />
      <Button
        ref={removeButtonRef}
        data-list-remove={item.id}
        size='icon'
        variant='ghost'
        onClick={() => onRemove(item.id, removeButtonRef.current)}
        aria-label={`Remove ${item.title} from list`}
        className='h-8 w-8 rounded-md text-zinc-500 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-[color,background-color,opacity] duration-150 shrink-0 motion-reduce:transition-none'
      >
        <X className='w-3.5 h-3.5' />
      </Button>
    </div>
  );
}

function ListItemsView({ list }: { list: UserList }) {
  const queryClient = useQueryClient();
  const mountedRef = useMountedRef();

  const [orderedIds, setOrderedIds] = useState<string[] | null>(null);

  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(
    () => listViewStates.get(list.id)?.viewMode ?? 'list',
  );
  const [search, setSearch] = useState(() => listViewStates.get(list.id)?.search ?? '');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [visibleLimit, setVisibleLimit] = useState(
    () => listViewStates.get(list.id)?.visibleLimit ?? LIST_ITEMS_PAGE_SIZE,
  );
  useLayoutEffect(() => {
    boundedMapSet(listViewStates, list.id, { viewMode, search, visibleLimit }, 64);
  }, [list.id, viewMode, search, visibleLimit]);
  const [addTitlesOpen, setAddTitlesOpen] = useState(false);
  const itemsContainerRef = useRef<HTMLDivElement>(null);
  const addTitlesButtonRef = useRef<HTMLButtonElement>(null);
  const removalFocusRef = useRef<{ button: HTMLButtonElement; index: number } | null>(null);

  const orderedItems = useMemo(
    () => orderByIds(list.items ?? [], orderedIds),
    [orderedIds, list.items],
  );

  const bulkRemove = useBulkRemoveFromList();
  const removeMutate = bulkRemove.mutate;
  const handleRemove = (itemId: string, button: HTMLButtonElement | null) => {
    if (button && document.activeElement === button) {
      const buttons =
        itemsContainerRef.current?.querySelectorAll<HTMLButtonElement>('[data-list-remove]');
      if (buttons) removalFocusRef.current = { button, index: Array.from(buttons).indexOf(button) };
    }
    removeMutate({ listId: list.id, itemIds: [itemId] });
  };

  const sensors = useSortableSensors();

  // Only the latest drag may release its local order after the persisted items have refetched.
  const latestReorderIdsRef = useRef<string[] | null>(null);
  const reorderKey = ['list-item-order', list.id] as const;

  const reorderItems = useMutation({
    mutationKey: reorderKey,
    scope: { id: `list-item-order:${list.id}` },
    mutationFn: (newIds: string[]) => api.reorderListItems(list.id, newIds),
    onSettled: async (_data, error, newIds) => {
      if (error) notifyAction('Failed to save order', { tone: 'error' });
      if (
        latestReorderIdsRef.current !== newIds ||
        queryClient.isMutating({ mutationKey: reorderKey, exact: true }) > 1
      )
        return;
      await queryClient.invalidateQueries({ queryKey: LISTS_QUERY_KEY });
      if (latestReorderIdsRef.current === newIds) {
        latestReorderIdsRef.current = null;
        if (mountedRef.current) setOrderedIds(null);
      }
    },
  });

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    // Composite drag IDs are `${listId}::${itemId}` — strip the prefix.
    const prefixLength = list.id.length + 2;
    const activeItemId = String(active.id).slice(prefixLength);
    const overItemId = String(over.id).slice(prefixLength);

    // Compute outside the state updater — Strict Mode double-invokes updaters, which would double-fire the mutation.
    const current = orderedItems.map((item) => item.id);

    const oldIndex = current.indexOf(activeItemId);
    const newIndex = current.indexOf(overItemId);
    if (oldIndex === -1 || newIndex === -1) return;

    const next = arrayMove(current, oldIndex, newIndex);
    setOrderedIds(next);
    latestReorderIdsRef.current = next;
    void trackPendingAppWrite(reorderItems.mutateAsync(next)).catch(() => {});
  };

  const {
    effectiveSearch,
    filteredItems: filtered,
    isSearchPending,
    searchError,
    isSearchFetching,
    retrySearch,
  } = useTitleSearch(orderedItems, search);

  const visibleItems = filtered.slice(0, visibleLimit);
  const filteredIds = filtered.map((item) => item.id);
  const selectAllDisabled = isSearchPending || searchError;
  const { triggerRef: selectionTriggerRef, ...selection } = useCollectionSelection(
    list.item_ids,
    filteredIds,
    true,
    bulkRemove.isPending || reorderItems.isPending,
    false,
    addTitlesButtonRef,
    selectAllDisabled,
  );
  const removeSelected = async () => {
    if (bulkRemove.isPending || reorderItems.isPending || selection.selectedIds.size === 0) return;
    try {
      await bulkRemove.mutateAsync({ listId: list.id, itemIds: [...selection.selectedIds] });
      if (mountedRef.current) selection.exit();
    } catch {
      // The mutation owns rollback and error feedback.
    }
  };

  useLayoutEffect(() => {
    const pending = removalFocusRef.current;
    if (!pending) return;
    if (pending.button.isConnected) {
      if (document.activeElement !== pending.button) removalFocusRef.current = null;
      return;
    }
    if (document.activeElement !== document.body) {
      removalFocusRef.current = null;
      return;
    }
    const buttons =
      itemsContainerRef.current?.querySelectorAll<HTMLButtonElement>('[data-list-remove]');
    const target =
      buttons?.[Math.min(pending.index, buttons.length - 1)] ?? addTitlesButtonRef.current;
    // Add titles stays disabled until the removal settles; retry on that render.
    if (target?.disabled) return;
    removalFocusRef.current = null;
    target?.focus();
  });

  // SortableContext diffs off this array's identity — keep it stable across membership-equal renders.
  const sortableItemIds = useMemo(
    () => visibleItems.map((i) => `${list.id}::${i.id}`),
    [visibleItems, list.id],
  );

  return (
    <div
      className='p-3 space-y-3'
      data-collection-selection=''
      data-escape-capture={activeId !== null || selection.selectionMode ? '' : undefined}
    >
      {isSearchPending && (
        <span role='status' className='sr-only'>
          Searching list…
        </span>
      )}
      <div className='flex flex-wrap items-center gap-2'>
        {orderedItems.length > 0 ? (
          <>
            <SearchInput
              inputRef={searchInputRef}
              pending={isSearchPending}
              value={search}
              onValueChange={(value) => {
                setSearch(value);
                setVisibleLimit(LIST_ITEMS_PAGE_SIZE);
              }}
              placeholder='Search in list…'
              clearLabel='Clear list search'
              wrapperClassName='min-w-32 flex-1'
              className='h-9 pl-8 rounded-lg bg-white/[0.03] border-white/[0.07] text-[13px] text-white placeholder:text-zinc-500 focus-visible:ring-white/20'
            />
            <ViewToggle viewMode={viewMode} onChange={setViewMode} />
            <Button
              ref={selectionTriggerRef}
              size='sm'
              variant='outline'
              aria-pressed={selection.selectionMode}
              disabled={bulkRemove.isPending || reorderItems.isPending || activeId !== null}
              onClick={selection.selectionMode ? selection.exit : selection.begin}
              className='h-9 rounded-lg border-white/10 bg-white/[0.03] text-xs text-zinc-300'
            >
              <CheckSquare className='h-3.5 w-3.5' />
              Select
            </Button>
          </>
        ) : (
          <p className='flex-1 pl-1 text-xs font-medium text-zinc-500'>Your titles</p>
        )}
        <Button
          ref={addTitlesButtonRef}
          variant='outline'
          size='sm'
          onClick={() => setAddTitlesOpen(true)}
          disabled={bulkRemove.isPending}
          className='h-9 rounded-lg border-white/10 bg-white/[0.03] text-xs text-zinc-300 hover:bg-white/[0.06] hover:text-white'
        >
          <Plus className='h-3.5 w-3.5' />
          Add titles
        </Button>
      </div>

      {selection.selectionMode && (
        <CollectionBulkActionBar
          selectedCount={selection.selectedIds.size}
          filteredCount={filtered.length}
          allFilteredSelected={
            filtered.length > 0 && filtered.every((item) => selection.selectedIds.has(item.id))
          }
          selectAllDisabled={selectAllDisabled}
          isBusy={bulkRemove.isPending || reorderItems.isPending}
          onSelectAll={() => selection.selectAll(filteredIds)}
          onClear={selection.clear}
          onDone={selection.exit}
          onRemove={() => void removeSelected()}
          removeLabel='Remove from list'
        />
      )}

      {searchError && (
        <RetryBanner message='Search failed.' isRetrying={isSearchFetching} onRetry={retrySearch} />
      )}

      {orderedItems.length === 0 && (
        <div className='flex flex-col items-center gap-3 px-4 py-7 text-center'>
          <ListIconTile iconId={list.icon} size='lg' />
          <div>
            <p className='text-sm font-medium text-zinc-300'>Make this collection yours</p>
            <p className='mt-1 max-w-sm text-xs leading-relaxed text-zinc-500'>
              Use “Add titles” to pick titles, or the save button on a title's details page.
            </p>
          </div>
          <Button
            size='sm'
            onClick={() => setAddTitlesOpen(true)}
            className='bg-white text-black hover:bg-zinc-200'
          >
            <Plus className='h-3.5 w-3.5' />
            Add titles
          </Button>
        </div>
      )}

      <div
        aria-busy={isSearchPending}
        className={cn(
          'space-y-3 transition-opacity duration-150 motion-reduce:transition-none',
          isSearchPending && 'opacity-60 delay-200',
        )}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={sortableCollisionDetection}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveId(null)}
        >
          <SortableContext
            items={sortableItemIds}
            strategy={viewMode === 'grid' ? rectSortingStrategy : verticalListSortingStrategy}
          >
            <div
              ref={itemsContainerRef}
              className={
                viewMode === 'grid'
                  ? 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3'
                  : 'flex flex-col gap-0.5'
              }
            >
              {visibleItems.map((item) => (
                <SortableItemRow
                  key={item.id}
                  item={item}
                  listId={list.id}
                  viewMode={viewMode}
                  onRemove={handleRemove}
                  selectionMode={selection.selectionMode}
                  isSelected={selection.selectedIds.has(item.id)}
                  onToggleSelect={selection.toggle}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>

        {filtered.length > visibleItems.length && (
          <div className='space-y-2 px-3 py-3 text-center'>
            <p className='text-[11px] text-zinc-500'>
              Showing {visibleItems.length} of {filtered.length}
            </p>
            <Button
              variant='outline'
              size='sm'
              disabled={activeId !== null}
              onClick={() => setVisibleLimit((limit) => limit + LIST_ITEMS_PAGE_SIZE)}
            >
              Show more
            </Button>
          </div>
        )}

        {orderedItems.length > 0 && effectiveSearch && filtered.length === 0 && (
          <StatePanel
            icon={<Search aria-hidden='true' className='h-6 w-6 text-zinc-600' />}
            title='No results'
            description={<>Nothing in this list matches &ldquo;{effectiveSearch}&rdquo;.</>}
            descriptionClassName='text-[13px] text-zinc-500'
            className='rounded-lg border border-white/[0.06] bg-white/[0.015] px-6 py-12'
            action={
              <Button
                size='sm'
                variant='ghost'
                className='h-8 text-xs text-zinc-400'
                onClick={() => {
                  setSearch('');
                  setVisibleLimit(LIST_ITEMS_PAGE_SIZE);
                  searchInputRef.current?.focus({ preventScroll: true });
                }}
              >
                Clear search
              </Button>
            }
          />
        )}
      </div>
      {addTitlesOpen && (
        <AddTitlesDialog
          list={list}
          onOpenChange={setAddTitlesOpen}
          returnFocusRef={addTitlesButtonRef}
        />
      )}
    </div>
  );
}

export function ListsManager({ expectedCount }: { expectedCount?: number }) {
  const queryClient = useQueryClient();
  const mountedRef = useMountedRef();
  const [searchParams, setSearchParams] = useSearchParams();
  const expanded = new Set(searchParams.getAll('list'));
  const updateExpanded = (id: string, open?: boolean) => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        const ids = new Set(next.getAll('list'));
        if (open ?? !ids.has(id)) ids.add(id);
        else ids.delete(id);
        next.delete('list');
        for (const expandedId of ids) next.append('list', expandedId);
        return next;
      },
      { replace: true },
    );
  };
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<UserList | null>(null);
  const [activeListId, setActiveListId] = useState<UniqueIdentifier | null>(null);
  const [pendingListOrder, setPendingListOrder] = useState<string[] | null>(null);
  const latestListOrderRef = useRef<string[] | null>(null);
  const listsContainerRef = useRef<HTMLDivElement>(null);
  const newListButtonRef = useRef<HTMLButtonElement>(null);
  const deleteDialogRef = useRef<HTMLDivElement>(null);
  const listRemovalFocusRef = useRef<{
    row: HTMLElement;
    dialog: HTMLDivElement | null;
    index: number;
  } | null>(null);

  const restoreDeletedListFocus = (dialogClosed = false) => {
    const pending = listRemovalFocusRef.current;
    if (!pending || (pending.dialog?.isConnected && !dialogClosed)) return false;
    const activeElement = document.activeElement;
    if (
      activeElement &&
      activeElement !== document.body &&
      !pending.row.contains(activeElement) &&
      !pending.dialog?.contains(activeElement)
    ) {
      listRemovalFocusRef.current = null;
      return true;
    }
    if (pending.row.isConnected) return false;
    listRemovalFocusRef.current = null;
    const rows = listsContainerRef.current?.querySelectorAll<HTMLElement>('[data-list-row]');
    const target =
      rows?.[Math.min(pending.index, (rows.length || 1) - 1)]?.querySelector<HTMLElement>(
        '[aria-expanded]',
      );
    (target ?? newListButtonRef.current)?.focus();
    return true;
  };
  useLayoutEffect(() => {
    restoreDeletedListFocus();
  });

  const sensors = useSortableSensors();

  const { data: savedLists = [], isLoading, isError, isFetched, isFetching, refetch } = useLists();
  const lists = orderByIds(savedLists, pendingListOrder);
  useLayoutEffect(() => {
    if (isFetched) lastResolvedListCount = lists.length;
  }, [isFetched, lists.length]);
  const retryBanner = (
    <RetryBanner
      message={lists.length > 0 ? "Couldn't refresh your lists." : "Couldn't load your lists."}
      onRetry={() => void refetch()}
      isRetrying={isFetching}
    />
  );

  const setCachedOrder = (ids: string[]) =>
    queryClient.setQueryData<UserList[]>(LISTS_QUERY_KEY, (current) =>
      current ? orderByIds(current, ids) : current,
    );
  const reorderLists = useMutation({
    mutationKey: LIST_ORDER_MUTATION_KEY,
    scope: { id: LIST_ORDER_MUTATION_KEY[0] },
    mutationFn: (ids: string[]) => api.reorderLists(ids),
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: LISTS_QUERY_KEY });
      const previous = queryClient.getQueryData<UserList[]>(LISTS_QUERY_KEY);
      if (latestListOrderRef.current === next) {
        setCachedOrder(next);
      }
      return previous?.map((list) => list.id);
    },
    onSettled: async (_data, _error, next) => {
      if (
        latestListOrderRef.current === next &&
        queryClient.isMutating({ mutationKey: LIST_ORDER_MUTATION_KEY, exact: true }) === 1
      ) {
        await invalidateListMetadataQueries(queryClient);
        if (latestListOrderRef.current === next) {
          latestListOrderRef.current = null;
          if (mountedRef.current) setPendingListOrder(null);
        }
      }
    },
    onError: (_, next, previousOrder) => {
      if (
        latestListOrderRef.current === next &&
        queryClient.isMutating({ mutationKey: LIST_ORDER_MUTATION_KEY, exact: true }) === 1 &&
        previousOrder
      ) {
        setCachedOrder(previousOrder);
      }
      notifyAction('Failed to save list order', { tone: 'error' });
    },
  });

  const deleteList = useMutation({
    mutationKey: DELETE_LIST_MUTATION_KEY,
    mutationFn: (id: string) => api.deleteList(id),
    onSuccess: (_, id) => {
      if (mountedRef.current) {
        updateExpanded(id, false);
      }
      listViewStates.delete(id);
      notifyAction('List deleted');
    },
    onError: (_, id) => {
      if (listRemovalFocusRef.current?.row.dataset.listRow === id) {
        listRemovalFocusRef.current = null;
      }
      notifyAction('Failed to delete list', { tone: 'error' });
    },
    onSettled: () => invalidateListQueries(queryClient),
  });

  const startDelete = (id: string) => {
    const rows = listsContainerRef.current?.querySelectorAll<HTMLElement>('[data-list-row]');
    const index = rows ? Array.from(rows).findIndex((row) => row.dataset.listRow === id) : -1;
    const row = rows?.[index];
    if (row) {
      listRemovalFocusRef.current = { row, dialog: deleteDialogRef.current, index };
    }
    deleteList.mutate(id);
  };

  const pendingDeleteIds = useMutationState({
    filters: { mutationKey: DELETE_LIST_MUTATION_KEY, status: 'pending' },
    select: (mutation) => mutation.state.variables as string,
  });

  const handleDragStart = (event: DragStartEvent) => {
    setActiveListId(event.active.id);
  };

  const moveList = (from: number, to: number) => {
    const next = arrayMove(
      lists.map((list) => list.id),
      from,
      to,
    );
    // Commit in the drop render; query cancellation in onMutate is asynchronous.
    latestListOrderRef.current = next;
    setPendingListOrder(next);
    void trackPendingAppWrite(reorderLists.mutateAsync(next)).catch(() => {});
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveListId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIdx = lists.findIndex((l) => l.id === active.id);
    const newIdx = lists.findIndex((l) => l.id === over.id);
    if (oldIdx === -1 || newIdx === -1) return;
    moveList(oldIdx, newIdx);
  };

  const [deleteTarget, setDeleteTarget] = useState<UserList | null>(null);
  const handleDeleteConfirm = (list: UserList) => {
    if (pendingDeleteIds.includes(list.id)) return;
    if (list.item_ids.length > 0) {
      setDeleteTarget(list);
      return;
    }
    startDelete(list.id);
  };

  return (
    <div
      className='mx-auto max-w-3xl space-y-4'
      data-escape-capture={activeListId !== null ? '' : undefined}
    >
      <div className='flex items-center justify-between'>
        <div>
          <h2 className='text-[15px] font-medium tracking-tight text-white'>Lists</h2>
          <p className='text-[13px] text-zinc-400 mt-1'>
            {lists.length > 0
              ? pluralize(lists.length, 'list')
              : 'Organize saved titles into collections.'}
          </p>
        </div>
        <Button
          ref={newListButtonRef}
          onPointerEnter={warmListEditorDialog}
          onFocus={warmListEditorDialog}
          onClick={() => setCreateOpen(true)}
          className='bg-white text-black hover:bg-zinc-200 font-medium gap-2 h-9 rounded-lg px-4 text-[13px]'
        >
          <ListPlus className='w-4 h-4' />
          New list
        </Button>
      </div>

      {isError && lists.length > 0 && retryBanner}
      {isLoading && !isFetched ? (
        <div role='status' aria-busy='true'>
          <span className='sr-only'>Loading lists…</span>
          <div className='space-y-3' aria-hidden='true'>
            {Array.from(
              {
                length: Math.min((expectedCount || lastResolvedListCount) ?? 3, LIST_SKELETON_CAP),
              },
              (_, index) => (
                <div
                  key={index}
                  className='h-14 rounded-xl bg-zinc-900/40 border border-white/5 animate-pulse'
                />
              ),
            )}
          </div>
        </div>
      ) : (isError && lists.length === 0) || (isFetched && isLoading) ? (
        retryBanner
      ) : lists.length === 0 ? (
        <div className='flex flex-col items-center justify-center px-6 py-12 gap-3 border border-white/[0.06] rounded-lg bg-white/[0.015]'>
          <ListIconTile iconId='Film' size='lg' />
          <div className='text-center'>
            <p className='text-[15px] font-semibold text-zinc-200'>No lists yet</p>
            <p className='text-[13px] leading-relaxed text-zinc-400 mt-1'>
              Create a list and choose &ldquo;Add titles&rdquo;, or save directly from a title's
              details page.
            </p>
          </div>
          <Button
            size='sm'
            onPointerEnter={warmListEditorDialog}
            onFocus={warmListEditorDialog}
            onClick={() => setCreateOpen(true)}
            className='accent-lattice mt-1 h-8 border-0 text-xs'
          >
            <Plus aria-hidden='true' className='h-3.5 w-3.5' />
            Create your first list
          </Button>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={sortableCollisionDetection}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveListId(null)}
        >
          <SortableContext items={lists.map((l) => l.id)} strategy={verticalListSortingStrategy}>
            <div ref={listsContainerRef} className='flex flex-col gap-2'>
              {lists.map((list, index) => (
                <SortableListCard
                  key={list.id}
                  list={list}
                  isExpanded={expanded.has(list.id)}
                  isDeleting={pendingDeleteIds.includes(list.id)}
                  canMoveUp={index > 0}
                  canMoveDown={index < lists.length - 1}
                  onToggleExpand={updateExpanded}
                  onRename={setRenameTarget}
                  onDelete={handleDeleteConfirm}
                  onMove={(delta) => {
                    const next = index + delta;
                    if (next >= 0 && next < lists.length) moveList(index, next);
                  }}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      <CreateListDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        returnFocusRef={newListButtonRef}
      />

      {renameTarget && (
        <RenameListDialog
          list={renameTarget}
          open
          onOpenChange={(open: boolean) => {
            if (!open) setRenameTarget(null);
          }}
        />
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        contentProps={{
          ref: deleteDialogRef,
          className: 'sm:max-w-sm',
          onCloseAutoFocus: (event) => {
            if (restoreDeletedListFocus(true)) event.preventDefault();
          },
        }}
        title='Delete list'
        description={
          deleteTarget &&
          `"${deleteTarget.name}" will be deleted. Titles in your Library won't be removed. This can't be undone.`
        }
        footerClassName='gap-2 sm:space-x-0'
        cancelProps={{ variant: 'ghost' }}
        confirmProps={{ variant: 'destructive' }}
        confirmLabel='Delete'
        confirmDisabled={!deleteTarget || pendingDeleteIds.includes(deleteTarget.id)}
        onConfirm={() => {
          if (!deleteTarget || pendingDeleteIds.includes(deleteTarget.id)) return;
          startDelete(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}
