import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
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
  ChevronDown,
  ChevronRight,
  GripVertical,
  ListPlus,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CreateListDialog, RenameListDialog } from '@/components/list/list-editor-dialog';
import { PosterThumb } from '@/components/poster-thumb';
import { ViewToggle } from '@/components/profile-library-controls';
import { RemoteImage } from '@/components/remote-image';
import { RetryBanner } from '@/components/retry-banner';
import { useLists } from '@/hooks/use-media-library';
import { useTitleSearch } from '@/hooks/use-item-search';
import { useMountedRef } from '@/hooks/use-mounted-ref';
import { usePrefetchDetails } from '@/hooks/use-prefetch-details';
import { useSortableSensors } from '@/hooks/use-sortable-sensors';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SearchInput } from '@/components/ui/search-input';
import { api, type MediaItem, type UserList } from '@/lib/api';
import { navigateToDetails } from '@/lib/player-navigation';
import { notifyAction } from '@/lib/notify';

import { invalidateListQueries, LISTS_QUERY_KEY } from '@/lib/query-invalidation';
import { cn, isHttpUrl } from '@/lib/utils';
import { AddTitlesDialog } from './add-titles-dialog';
import { ListIconTile } from './list-icons';

const LIST_ITEMS_PAGE_SIZE = 150;
const DELETE_LIST_MUTATION_KEY = ['delete-list'] as const;

const LIST_MANAGER_SKELETON_KEYS = [
  'list-manager-skeleton-1',
  'list-manager-skeleton-2',
  'list-manager-skeleton-3',
] as const;

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
  onToggleExpand: (id: string) => void;
  onRename: (list: UserList) => void;
  onDelete: (list: UserList) => void;
}

function SortableListCard({
  list,
  isExpanded,
  isDeleting,
  onToggleExpand,
  onRename,
  onDelete,
}: SortableListCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: list.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'rounded-xl border transition-[background-color,border-color,opacity] duration-200',
        isDragging
          ? 'opacity-40 border-white/20 bg-zinc-900/80 scale-[0.98]'
          : 'border-white/8 bg-zinc-900/40 hover:border-white/15 hover:bg-zinc-900/60',
      )}
    >
      <div className='flex items-center gap-3 px-4 py-3'>
        <button
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
          className='flex min-h-8 items-center gap-3 flex-1 min-w-0 rounded-md group focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/25'
        >
          <ListIconTile iconId={list.icon} />
          <div className='flex-1 min-w-0 text-left'>
            <div className='flex items-center gap-2'>
              <span
                dir='auto'
                title={list.name}
                className='font-medium text-sm text-zinc-200 group-hover:text-white transition-colors truncate'
              >
                {list.name}
              </span>
            </div>
            <p className='mt-0.5 text-[11px] tabular-nums text-zinc-500'>
              {list.item_ids.length} title{list.item_ids.length === 1 ? '' : 's'}
            </p>
          </div>
          <ListPosterStack items={list.items} />
          <div className='text-zinc-600 group-hover:text-zinc-400 transition-colors shrink-0 ml-2'>
            {isExpanded ? (
              <ChevronDown className='w-4 h-4' />
            ) : (
              <ChevronRight className='w-4 h-4' />
            )}
          </div>
        </button>

        <div className='flex items-center gap-1 shrink-0'>
          <Button
            size='icon'
            variant='ghost'
            onClick={() => onRename(list)}
            aria-label={`Rename ${list.name}`}
            title='Rename list'
            className='h-8 w-8 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/8'
          >
            <Pencil className='w-3.5 h-3.5' />
          </Button>
          <Button
            size='icon'
            variant='ghost'
            onClick={() => onDelete(list)}
            disabled={isDeleting}
            aria-label={`Delete ${list.name}`}
            title='Delete list'
            className='h-8 w-8 rounded-md text-zinc-500 hover:text-red-400 hover:bg-red-500/10'
          >
            <Trash2 className='w-3.5 h-3.5' />
          </Button>
        </div>
      </div>

      {isExpanded && (
        <div className='border-t border-white/5'>
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
  onRemoved: (button: HTMLButtonElement | null) => void;
}

// memo: keystrokes re-render the view with the same item objects (structural sharing) — unaffected rows skip rendering.
const SortableItemRow = memo(function SortableItemRow({
  item,
  listId,
  viewMode,
  onRemoved,
}: SortableItemRowProps) {
  const queryClient = useQueryClient();
  const removeButtonRef = useRef<HTMLButtonElement>(null);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `${listId}::${item.id}`,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const removeItem = useMutation({
    mutationFn: () => api.removeFromList(listId, item.id),
    onSuccess: () => {
      onRemoved(removeButtonRef.current);
      notifyAction('Removed from list', { detail: item.title, thumb: item.poster });
    },
    onError: () => notifyAction('Failed to remove item', { tone: 'error' }),
    onSettled: () => invalidateListQueries(queryClient),
  });

  const prefetchDetails = usePrefetchDetails(item.id, item.type);

  if (viewMode === 'grid') {
    return (
      <div
        ref={setNodeRef}
        style={style}
        className={cn(
          'relative group rounded-lg overflow-hidden bg-zinc-900/60 transition-[background-color,opacity,box-shadow] duration-200',
          isDragging ? 'opacity-40 scale-95' : 'hover:ring-1 hover:ring-white/20',
        )}
      >
        <button
          type='button'
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${item.title}`}
          className='absolute top-2 left-2 z-20 flex h-8 w-8 items-center justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-opacity cursor-grab active:cursor-grabbing bg-black/60 rounded-md touch-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40'
        >
          <GripVertical className='w-3 h-3 text-white' />
        </button>

        <button
          ref={removeButtonRef}
          data-list-remove={item.id}
          type='button'
          onClick={(e) => {
            e.stopPropagation();
            if (!removeItem.isPending) removeItem.mutate();
          }}
          aria-disabled={removeItem.isPending || undefined}
          aria-label={`Remove ${item.title} from list`}
          title='Remove from list'
          className='absolute top-2 right-2 z-20 flex h-8 w-8 items-center justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-opacity bg-black/60 rounded-md not-aria-disabled:hover:bg-red-500/80 text-white aria-disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40'
        >
          <X className='w-3 h-3' />
        </button>

        <button
          type='button'
          aria-label={`Open details for ${item.title}`}
          className='aspect-2/3 w-full cursor-pointer focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/40'
          onPointerEnter={prefetchDetails}
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
            className='text-[11px] font-medium text-zinc-300 truncate leading-tight'
          >
            {item.title}
          </p>
          {item.displayYear && (
            <p className='text-[10px] text-zinc-600 capitalize mt-0.5'>{item.displayYear}</p>
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
        'flex items-center gap-3 px-3 py-2 rounded-lg group transition-[background-color,opacity] duration-150',
        isDragging ? 'opacity-40 bg-zinc-800/80' : 'hover:bg-white/5',
      )}
    >
      <button
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
        onPointerEnter={prefetchDetails}
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

      <Button
        ref={removeButtonRef}
        data-list-remove={item.id}
        size='icon'
        variant='ghost'
        onClick={() => {
          if (!removeItem.isPending) removeItem.mutate();
        }}
        aria-disabled={removeItem.isPending || undefined}
        aria-label={`Remove ${item.title} from list`}
        title='Remove from list'
        className='h-8 w-8 rounded-md text-zinc-500 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-colors shrink-0 aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-zinc-500'
      >
        <X className='w-3.5 h-3.5' />
      </Button>
    </div>
  );
});

function ListItemsView({ list }: { list: UserList }) {
  const queryClient = useQueryClient();
  const mountedRef = useMountedRef();

  const [orderedIds, setOrderedIds] = useState<string[] | null>(null);

  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('list');
  const [search, setSearch] = useState('');
  const [visibleLimit, setVisibleLimit] = useState(LIST_ITEMS_PAGE_SIZE);
  const [addTitlesOpen, setAddTitlesOpen] = useState(false);
  const itemsContainerRef = useRef<HTMLDivElement>(null);
  const addTitlesButtonRef = useRef<HTMLButtonElement>(null);
  const removalFocusRef = useRef<{ button: HTMLButtonElement; candidates: string[] } | null>(null);

  const orderedItems = useMemo(() => {
    const sourceItems = list.items ?? [];
    if (!orderedIds) return sourceItems;
    const itemMap = new Map(sourceItems.map((i) => [i.id, i]));
    const ordered = orderedIds.flatMap((id) => {
      const orderedItem = itemMap.get(id);
      return orderedItem ? [orderedItem] : [];
    });
    const orderedSet = new Set(orderedIds);
    const added = sourceItems.filter((i) => !orderedSet.has(i.id));
    return [...ordered, ...added];
  }, [orderedIds, list.items]);

  const orderedItemsRef = useRef(orderedItems);
  useLayoutEffect(() => {
    orderedItemsRef.current = orderedItems;
  }, [orderedItems]);

  const handleRemoved = useCallback((button: HTMLButtonElement | null) => {
    if (!button || document.activeElement !== button) return;
    const items = orderedItemsRef.current;
    const index = items.findIndex((item) => item.id === button.dataset.listRemove);
    removalFocusRef.current = {
      button,
      candidates: [...items.slice(index + 1), ...items.slice(0, index).toReversed()].map(
        (item) => item.id,
      ),
    };
  }, []);

  const sensors = useSortableSensors();

  // Only the latest drag may release its local order after the persisted items have refetched.
  const latestReorderIdsRef = useRef<string[] | null>(null);

  const reorderItems = useMutation({
    mutationFn: (newIds: string[]) => api.reorderListItems(list.id, newIds),
    onSuccess: async (_data, newIds) => {
      await queryClient.invalidateQueries({ queryKey: LISTS_QUERY_KEY });
      if (latestReorderIdsRef.current === newIds) {
        latestReorderIdsRef.current = null;
        if (mountedRef.current) setOrderedIds(null);
      }
    },
    onError: (_error, newIds) => {
      if (latestReorderIdsRef.current === newIds) {
        latestReorderIdsRef.current = null;
        if (mountedRef.current) setOrderedIds(null);
      }
      void queryClient.invalidateQueries({ queryKey: LISTS_QUERY_KEY });
      notifyAction('Failed to save order', { tone: 'error' });
    },
  });

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id);
  };

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveId(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      // Composite drag IDs are `${listId}::${itemId}` — strip the prefix.
      const prefix = `${list.id}::`;
      const activeItemId = String(active.id).startsWith(prefix)
        ? String(active.id).slice(prefix.length)
        : String(active.id);
      const overItemId = String(over.id).startsWith(prefix)
        ? String(over.id).slice(prefix.length)
        : String(over.id);

      // Compute outside the state updater — Strict Mode double-invokes updaters, which would double-fire the mutation.
      const current = orderedItems.map((item) => item.id);

      const oldIndex = current.indexOf(activeItemId);
      const newIndex = current.indexOf(overItemId);
      if (oldIndex === -1 || newIndex === -1) return;

      const next = arrayMove(current, oldIndex, newIndex);
      setOrderedIds(next);
      latestReorderIdsRef.current = next;
      reorderItems.mutate(next);
    },
    [list.id, orderedItems, reorderItems],
  );

  const {
    effectiveSearch,
    filteredItems: filtered,
    isSearchPending,
    searchError,
    isSearchFetching,
    retrySearch,
  } = useTitleSearch(orderedItems, search);

  const visibleItems = useMemo(() => filtered.slice(0, visibleLimit), [filtered, visibleLimit]);

  useLayoutEffect(() => {
    const pending = removalFocusRef.current;
    if (!pending) return;
    if (pending.button.isConnected) {
      if (document.activeElement !== pending.button) removalFocusRef.current = null;
      return;
    }
    removalFocusRef.current = null;
    if (document.activeElement !== document.body) return;
    const buttons = new Map(
      Array.from(
        itemsContainerRef.current?.querySelectorAll<HTMLButtonElement>('[data-list-remove]') ?? [],
        (button) => [button.dataset.listRemove, button] as const,
      ),
    );
    const nextId = pending.candidates.find((id) => buttons.has(id));
    (buttons.get(nextId) ?? addTitlesButtonRef.current)?.focus();
  });

  // SortableContext diffs off this array's identity — keep it stable across membership-equal renders.
  const sortableItemIds = useMemo(
    () => visibleItems.map((i) => `${list.id}::${i.id}`),
    [visibleItems, list.id],
  );

  const activeItem = activeId ? orderedItems.find((i) => `${list.id}::${i.id}` === activeId) : null;

  return (
    <div
      className='p-3 space-y-3'
      data-escape-capture={activeId !== null ? '' : undefined}
      aria-busy={isSearchPending}
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
          </>
        ) : (
          <p className='flex-1 pl-1 text-xs font-medium text-zinc-500'>Your titles</p>
        )}
        <Button
          ref={addTitlesButtonRef}
          variant='outline'
          size='sm'
          onClick={() => setAddTitlesOpen(true)}
          className='h-9 rounded-lg border-white/10 bg-white/[0.03] text-xs text-zinc-300 hover:bg-white/[0.06] hover:text-white'
        >
          <Plus className='h-3.5 w-3.5' />
          Add titles
        </Button>
      </div>

      {searchError && (
        <RetryBanner message='Search failed.' isRetrying={isSearchFetching} onRetry={retrySearch} />
      )}

      {orderedItems.length === 0 && (
        <div className='flex flex-col items-center gap-3 px-4 py-7 text-center'>
          <ListIconTile iconId={list.icon} size='lg' />
          <div>
            <p className='text-sm font-medium text-zinc-300'>Make this collection yours</p>
            <p className='mt-1 max-w-sm text-xs leading-relaxed text-zinc-500'>
              Use &ldquo;Add titles&rdquo; to choose from your library, or the save button on a
              title's details page.
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

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
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
                ? 'grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-2'
                : 'space-y-0.5'
            }
          >
            {visibleItems.map((item) => (
              <SortableItemRow
                key={item.id}
                item={item}
                listId={list.id}
                viewMode={viewMode}
                onRemoved={handleRemoved}
              />
            ))}
          </div>
        </SortableContext>

        <DragOverlay>
          {activeItem ? (
            <div
              className={cn(
                'rounded-lg bg-zinc-800/90 border border-white/20 shadow-2xl shadow-black/60',
                viewMode === 'grid' ? 'w-20 opacity-90' : 'w-64 opacity-90',
              )}
            >
              {viewMode === 'grid' ? (
                <div className='aspect-2/3 overflow-hidden rounded-lg'>
                  {isHttpUrl(activeItem.poster) && (
                    <RemoteImage
                      src={activeItem.poster}
                      alt={activeItem.title}
                      className='w-full h-full object-cover'
                    />
                  )}
                </div>
              ) : (
                <div className='flex items-center gap-3 px-3 py-2.5'>
                  <GripVertical className='w-3.5 h-3.5 text-zinc-400' />
                  {isHttpUrl(activeItem.poster) && (
                    <div className='h-10 w-7 rounded overflow-hidden shrink-0'>
                      <RemoteImage
                        src={activeItem.poster}
                        alt={activeItem.title}
                        className='w-full h-full object-cover'
                      />
                    </div>
                  )}
                  <span className='text-sm font-medium text-white truncate'>
                    {activeItem.title}
                  </span>
                </div>
              )}
            </div>
          ) : null}
        </DragOverlay>
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

      {effectiveSearch && filtered.length === 0 && (
        <p className='text-xs text-zinc-600 text-center py-4'>
          No items match &ldquo;{effectiveSearch}&rdquo;
        </p>
      )}
      {addTitlesOpen && <AddTitlesDialog list={list} onOpenChange={setAddTitlesOpen} />}
    </div>
  );
}

function ListGhostCard({ list }: { list: UserList }) {
  return (
    <div className='rounded-xl border border-white/20 bg-zinc-900/90 shadow-2xl shadow-black/60 px-4 py-3 flex items-center gap-3 opacity-90'>
      <GripVertical className='w-4 h-4 text-zinc-500' />
      <ListIconTile iconId={list.icon} />
      <span className='font-semibold text-sm text-zinc-200'>{list.name}</span>
      <span className='text-[12px] tabular-nums text-zinc-500 ml-1'>{list.item_ids.length}</span>
    </div>
  );
}

export function ListsManager() {
  const queryClient = useQueryClient();
  const mountedRef = useMountedRef();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<UserList | null>(null);
  const [activeListId, setActiveListId] = useState<UniqueIdentifier | null>(null);
  const listOrderGenerationRef = useRef(0);

  const sensors = useSortableSensors();

  const {
    data: lists = [],
    isLoading,
    isLoadingError,
    isFetched,
    isFetching,
    refetch,
  } = useLists();

  const reorderLists = useMutation({
    mutationFn: (next: UserList[]) => api.reorderLists(next.map((list) => list.id)),
    onMutate: async (next) => {
      const generation = ++listOrderGenerationRef.current;
      await queryClient.cancelQueries({ queryKey: LISTS_QUERY_KEY });
      const previous = queryClient.getQueryData<UserList[]>(LISTS_QUERY_KEY);
      if (generation === listOrderGenerationRef.current) {
        queryClient.setQueryData(LISTS_QUERY_KEY, next);
      }
      return { previous, generation };
    },
    onSettled: () => invalidateListQueries(queryClient),
    onError: (_, _next, context) => {
      if (context?.generation === listOrderGenerationRef.current && context.previous) {
        queryClient.setQueryData(LISTS_QUERY_KEY, context.previous);
      }
      notifyAction('Failed to save list order', { tone: 'error' });
    },
  });

  const deleteList = useMutation({
    mutationKey: DELETE_LIST_MUTATION_KEY,
    mutationFn: (id: string) => api.deleteList(id),
    onSuccess: (_, id) => {
      if (mountedRef.current) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
      notifyAction('List deleted');
    },
    onError: () => notifyAction('Failed to delete list', { tone: 'error' }),
    onSettled: () => invalidateListQueries(queryClient),
  });

  const pendingDeleteIds = useMutationState({
    filters: { mutationKey: DELETE_LIST_MUTATION_KEY, status: 'pending' },
    select: (mutation) => mutation.state.variables as string,
  });

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveListId(event.active.id);
  };

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveListId(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIdx = lists.findIndex((l) => l.id === active.id);
      const newIdx = lists.findIndex((l) => l.id === over.id);
      if (oldIdx === -1 || newIdx === -1) return;

      reorderLists.mutate(arrayMove(lists, oldIdx, newIdx));
    },
    [lists, reorderLists],
  );

  const activeList = activeListId ? lists.find((l) => l.id === activeListId) : null;

  // Non-empty lists confirm in-app; empty ones delete straight away.
  const [deleteTarget, setDeleteTarget] = useState<UserList | null>(null);
  const handleDeleteConfirm = (list: UserList) => {
    if (pendingDeleteIds.includes(list.id)) return;
    if (list.item_ids.length > 0) {
      setDeleteTarget(list);
      return;
    }
    deleteList.mutate(list.id);
  };

  return (
    <div className='space-y-6' data-escape-capture={activeListId !== null ? '' : undefined}>
      <div className='flex items-center justify-between'>
        <div>
          <h2 className='text-[15px] font-medium tracking-tight text-white'>Lists</h2>
          <p className='text-[13px] text-zinc-400 mt-1'>
            {lists.length > 0
              ? `${lists.length} list${lists.length !== 1 ? 's' : ''}`
              : 'Organize saved titles into collections.'}
          </p>
        </div>
        <Button
          onClick={() => setCreateOpen(true)}
          className='bg-white text-black hover:bg-zinc-200 font-medium gap-2 h-9 rounded-lg px-4 text-[13px]'
        >
          <ListPlus className='w-4 h-4' />
          New list
        </Button>
      </div>

      {isLoading && !isFetched ? (
        <div role='status' aria-busy='true'>
          <span className='sr-only'>Loading lists…</span>
          <div className='space-y-3' aria-hidden='true'>
            {LIST_MANAGER_SKELETON_KEYS.map((skeletonKey) => (
              <div
                key={skeletonKey}
                className='h-14 rounded-xl bg-zinc-900/40 border border-white/5 animate-pulse'
              />
            ))}
          </div>
        </div>
      ) : isLoadingError || (isFetched && isLoading) ? (
        <RetryBanner
          message="Couldn't load your lists."
          onRetry={() => void refetch()}
          isRetrying={isFetching}
        />
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
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveListId(null)}
        >
          <SortableContext items={lists.map((l) => l.id)} strategy={verticalListSortingStrategy}>
            <div className='space-y-2'>
              {lists.map((list) => (
                <SortableListCard
                  key={list.id}
                  list={list}
                  isExpanded={expanded.has(list.id)}
                  isDeleting={pendingDeleteIds.includes(list.id)}
                  onToggleExpand={toggleExpand}
                  onRename={setRenameTarget}
                  onDelete={handleDeleteConfirm}
                />
              ))}
            </div>
          </SortableContext>

          <DragOverlay>{activeList ? <ListGhostCard list={activeList} /> : null}</DragOverlay>
        </DndContext>
      )}

      <CreateListDialog open={createOpen} onOpenChange={setCreateOpen} />

      {renameTarget && (
        <RenameListDialog
          list={renameTarget}
          open={!!renameTarget}
          onOpenChange={(open: boolean) => {
            if (!open) setRenameTarget(null);
          }}
        />
      )}

      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent className='sm:max-w-sm'>
          <DialogHeader>
            <DialogTitle>Delete list</DialogTitle>
            <DialogDescription>
              {deleteTarget &&
                `"${deleteTarget.name}" and its ${deleteTarget.item_ids.length} item${
                  deleteTarget.item_ids.length === 1 ? '' : 's'
                } will be removed. This can't be undone.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className='gap-2 sm:space-x-0'>
            <Button variant='ghost' onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant='destructive'
              disabled={!deleteTarget || pendingDeleteIds.includes(deleteTarget.id)}
              onClick={() => {
                if (!deleteTarget || pendingDeleteIds.includes(deleteTarget.id)) return;
                deleteList.mutate(deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
