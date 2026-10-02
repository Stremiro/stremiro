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
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  Film,
  GripVertical,
  LayoutGrid,
  LayoutList,
  ListPlus,
  Pencil,
  Search,
  Trash2,
  Tv,
  X,
} from 'lucide-react';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { CreateListDialog, RenameListDialog } from '@/components/list/list-editor-dialog';
import { ListIcon } from '@/components/list/list-icons';
import { RemoteImage } from '@/components/remote-image';
import { RetryBanner } from '@/components/retry-banner';
import { useLists } from '@/hooks/use-media-library';
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

const LIST_MANAGER_SKELETON_KEYS = [
  'list-manager-skeleton-1',
  'list-manager-skeleton-2',
  'list-manager-skeleton-3',
] as const;

// ─── Sortable List Card ────────────────────────────────────────────────────────

interface SortableListCardProps {
  list: UserList;
  isExpanded: boolean;
  onToggleExpand: (id: string) => void;
  onRename: (list: UserList) => void;
  onDelete: (list: UserList) => void;
}

function SortableListCard({
  list,
  isExpanded,
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
        'rounded-xl border transition-all duration-200',
        isDragging
          ? 'opacity-40 border-white/20 bg-zinc-900/80 scale-[0.98]'
          : 'border-white/8 bg-zinc-900/40 hover:border-white/15 hover:bg-zinc-900/60',
      )}
    >
      {/* List Header */}
      <div className='flex items-center gap-3 px-4 py-3'>
        {/* Drag handle */}
        <button
          type='button'
          {...attributes}
          {...listeners}
          className='text-zinc-700 hover:text-zinc-400 transition-colors cursor-grab active:cursor-grabbing touch-none shrink-0'
          aria-label='Drag to reorder'
        >
          <GripVertical className='w-4 h-4' />
        </button>

        {/* Expand toggle */}
        <button
          type='button'
          onClick={() => onToggleExpand(list.id)}
          aria-expanded={isExpanded}
          className='flex items-center gap-3 flex-1 min-w-0 group'
        >
          <span className='shrink-0 text-zinc-300'>
            <ListIcon iconId={list.icon} size={16} />
          </span>
          <div className='flex-1 min-w-0 text-left'>
            <div className='flex items-center gap-2'>
              <span className='font-semibold text-sm text-zinc-200 group-hover:text-white transition-colors truncate'>
                {list.name}
              </span>
              <span className='text-[10px] font-bold text-zinc-600 bg-zinc-800/80 px-1.5 py-0.5 rounded-full shrink-0'>
                {list.item_ids.length}
              </span>
            </div>
          </div>
          <div className='text-zinc-600 group-hover:text-zinc-400 transition-colors shrink-0 ml-2'>
            {isExpanded ? (
              <ChevronDown className='w-4 h-4' />
            ) : (
              <ChevronRight className='w-4 h-4' />
            )}
          </div>
        </button>

        {/* Actions */}
        <div className='flex items-center gap-1 shrink-0'>
          <Button
            size='icon'
            variant='ghost'
            onClick={() => onRename(list)}
            aria-label={`Rename ${list.name}`}
            title='Rename list'
            className='h-7 w-7 rounded-lg text-zinc-600 hover:text-zinc-200 hover:bg-white/8'
          >
            <Pencil className='w-3.5 h-3.5' />
          </Button>
          <Button
            size='icon'
            variant='ghost'
            onClick={() => onDelete(list)}
            aria-label={`Delete ${list.name}`}
            title='Delete list'
            className='h-7 w-7 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-500/10'
          >
            <Trash2 className='w-3.5 h-3.5' />
          </Button>
        </div>
      </div>

      {/* Expanded items */}
      {isExpanded && (
        <div className='border-t border-white/5'>
          <ListItemsView list={list} />
        </div>
      )}
    </div>
  );
}

// ─── Sortable Item Row ─────────────────────────────────────────────────────────

interface SortableItemRowProps {
  item: MediaItem;
  listId: string;
  viewMode: 'grid' | 'list';
}

// memo: search keystrokes re-render ListItemsView with the same item objects
// (structural sharing), so rows not affected by the filter skip rendering.
const SortableItemRow = memo(function SortableItemRow({
  item,
  listId,
  viewMode,
}: SortableItemRowProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
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
      void invalidateListQueries(queryClient);
      notifyAction('Removed from list', { detail: item.title, thumb: item.poster });
    },
    onError: () => notifyAction('Failed to remove item', { tone: 'error' }),
  });

  const prefetchDetails = usePrefetchDetails(item.id, item.type);

  if (viewMode === 'grid') {
    return (
      <div
        ref={setNodeRef}
        style={style}
        className={cn(
          'relative group rounded-lg overflow-hidden bg-zinc-900/60 transition-all duration-200',
          isDragging ? 'opacity-40 scale-95' : 'hover:ring-1 hover:ring-white/20',
        )}
      >
        {/* Drag handle */}
        <div
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${item.title}`}
          className='absolute top-2 left-2 z-20 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-opacity cursor-grab active:cursor-grabbing bg-black/60 rounded-md p-1 touch-none'
        >
          <GripVertical className='w-3 h-3 text-white' />
        </div>

        {/* Remove button */}
        <button
          type='button'
          onClick={(e) => {
            e.stopPropagation();
            removeItem.mutate();
          }}
          disabled={removeItem.isPending}
          aria-label={`Remove ${item.title} from list`}
          title='Remove from list'
          className='absolute top-2 right-2 z-20 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-opacity bg-black/60 rounded-md p-1 hover:bg-red-500/80 text-white disabled:opacity-50'
        >
          <X className='w-3 h-3' />
        </button>

        <button
          type='button'
          aria-label={`Open details for ${item.title}`}
          className='aspect-2/3 w-full cursor-pointer'
          onPointerEnter={prefetchDetails}
          onFocus={prefetchDetails}
          onClick={() => navigateToDetails(navigate, item.type, item.id)}
        >
          {isHttpUrl(item.poster) ? (
            <RemoteImage
              src={item.poster}
              alt={item.title}
              className='w-full h-full object-cover group-hover:opacity-80 transition-opacity'
              loading='lazy'
            />
          ) : (
            <div className='w-full h-full flex items-center justify-center bg-zinc-800 p-2'>
              {item.type === 'movie' ? (
                <Film className='w-6 h-6 text-zinc-600' />
              ) : (
                <Tv className='w-6 h-6 text-zinc-600' />
              )}
            </div>
          )}
        </button>
        <div className='p-2'>
          <p className='text-[11px] font-medium text-zinc-300 truncate leading-tight'>
            {item.title}
          </p>
          {item.displayYear && (
            <p className='text-[10px] text-zinc-600 capitalize mt-0.5'>{item.displayYear}</p>
          )}
        </div>
      </div>
    );
  }

  // List view
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'flex items-center gap-3 px-3 py-2 rounded-lg group transition-all duration-150',
        isDragging ? 'opacity-40 bg-zinc-800/80' : 'hover:bg-white/5',
      )}
    >
      <div
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${item.title}`}
        className='text-zinc-700 hover:text-zinc-400 transition-colors cursor-grab active:cursor-grabbing touch-none shrink-0'
      >
        <GripVertical className='w-3.5 h-3.5' />
      </div>

      {/* Poster thumb */}
      <button
        type='button'
        aria-label={`Open details for ${item.title}`}
        className='h-10 w-7 rounded overflow-hidden bg-zinc-800 shrink-0 cursor-pointer'
        onPointerEnter={prefetchDetails}
        onFocus={prefetchDetails}
        onClick={() => navigateToDetails(navigate, item.type, item.id)}
      >
        {isHttpUrl(item.poster) ? (
          <RemoteImage
            src={item.poster}
            alt={item.title}
            className='w-full h-full object-cover'
            loading='lazy'
          />
        ) : (
          <div className='w-full h-full flex items-center justify-center'>
            {item.type === 'movie' ? (
              <Film className='w-3 h-3 text-zinc-600' />
            ) : (
              <Tv className='w-3 h-3 text-zinc-600' />
            )}
          </div>
        )}
      </button>

      {/* Title info */}
      <button
        type='button'
        className='flex-1 min-w-0 cursor-pointer text-left'
        onPointerEnter={prefetchDetails}
        onFocus={prefetchDetails}
        onClick={() => navigateToDetails(navigate, item.type, item.id)}
      >
        <p className='text-sm font-medium text-zinc-200 group-hover:text-white transition-colors truncate'>
          {item.title}
        </p>
        <div className='flex items-center gap-1.5 mt-0.5'>
          <span className='text-[10px] text-zinc-500 capitalize'>{item.type}</span>
          {item.displayYear && (
            <>
              <span className='text-zinc-700 text-[10px]'>·</span>
              <span className='text-[10px] text-zinc-500'>{item.displayYear}</span>
            </>
          )}
        </div>
      </button>

      {/* Remove */}
      <Button
        size='icon'
        variant='ghost'
        onClick={() => removeItem.mutate()}
        disabled={removeItem.isPending}
        aria-label={`Remove ${item.title} from list`}
        title='Remove from list'
        className='h-7 w-7 rounded-lg text-zinc-700 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-all shrink-0'
      >
        <X className='w-3.5 h-3.5' />
      </Button>
    </div>
  );
});

// ─── List Items View (inner DnD for items) ────────────────────────────────────

// orderedIds resets via the parent SortableListCard's key={list.id} remount
// and via collapse/expand unmount — there is no key on the usage itself.
function ListItemsView({ list }: { list: UserList }) {
  const queryClient = useQueryClient();

  // Store only the ordered IDs — lightweight and easy to reset.
  // Initialised lazily so it only runs once per mount.
  const [orderedIds, setOrderedIds] = useState<string[]>(() => list.item_ids);

  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('list');
  const [search, setSearch] = useState('');

  // Derive the full item objects from the user's preferred ordering.
  // • Items removed externally disappear automatically (filter step).
  // • Items added externally via context-menu appear at the end.
  // TanStack Query uses structural sharing, so list.items only gets a new
  // reference when actual data changes — memo recomputes are infrequent.
  const orderedItems = useMemo(() => {
    // `items` is absent on the create-list response; list views always read
    // through get_lists which populates it.
    const sourceItems = list.items ?? [];
    const itemMap = new Map(sourceItems.map((i) => [i.id, i]));
    const ordered = orderedIds.flatMap((id) => {
      const orderedItem = itemMap.get(id);
      return orderedItem ? [orderedItem] : [];
    });
    const orderedSet = new Set(orderedIds);
    const added = sourceItems.filter((i) => !orderedSet.has(i.id));
    return [...ordered, ...added];
  }, [orderedIds, list.items]);

  const sensors = useSortableSensors();

  // The newest issued order owns cache writes and failure reverts: two
  // in-flight saves can settle out of order, and a superseded response must
  // neither roll the cache back nor stomp a newer drag's display order.
  const latestReorderIdsRef = useRef<string[] | null>(null);

  const reorderItems = useMutation({
    mutationFn: (newIds: string[]) => api.reorderListItems(list.id, newIds),
    onSuccess: (_data, newIds) => {
      // Collapsing a list unmounts this view, and `orderedIds` re-initializes
      // from `list.item_ids` — mirror the saved order into the cached lists
      // so a collapse/re-expand doesn't snap back to the pre-drag order.
      if (latestReorderIdsRef.current === newIds) {
        queryClient.setQueryData<UserList[]>(LISTS_QUERY_KEY, (lists) =>
          lists?.map((entry) => (entry.id === list.id ? { ...entry, item_ids: newIds } : entry)),
        );
      }
      void invalidateListQueries(queryClient);
    },
    onError: (_error, newIds) => {
      // Revert display order to the freshest persisted order, read from the
      // cache rather than the render-stale `list` prop.
      if (latestReorderIdsRef.current === newIds) {
        const persisted = queryClient
          .getQueryData<UserList[]>(LISTS_QUERY_KEY)
          ?.find((entry) => entry.id === list.id)?.item_ids;
        setOrderedIds(persisted ?? list.item_ids);
      }
      void invalidateListQueries(queryClient);
      toast.error('Failed to save order');
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

      // Compute the next order outside the state updater: updaters must be
      // pure — React may invoke them more than once (Strict Mode double
      // render), which would double-fire the persistence mutation.
      let current = orderedIds.includes(activeItemId) ? orderedIds : [...orderedIds, activeItemId];
      current = current.includes(overItemId) ? current : [...current, overItemId];

      const oldIndex = current.indexOf(activeItemId);
      const newIndex = current.indexOf(overItemId);
      if (oldIndex === -1 || newIndex === -1) return;

      const next = arrayMove(current, oldIndex, newIndex);
      setOrderedIds(next);
      latestReorderIdsRef.current = next;
      reorderItems.mutate(next);
    },
    [list.id, orderedIds, reorderItems],
  );

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? orderedItems.filter((i) => i.title.toLowerCase().includes(query)) : orderedItems;
  }, [orderedItems, search]);

  // SortableContext diff work keys off this array's identity — keep it
  // stable between renders that don't change membership.
  const sortableItemIds = useMemo(
    () => filtered.map((i) => `${list.id}::${i.id}`),
    [filtered, list.id],
  );

  const activeItem = activeId ? orderedItems.find((i) => `${list.id}::${i.id}` === activeId) : null;

  if (orderedItems.length === 0) {
    return (
      <div className='flex flex-col items-center justify-center py-8 text-zinc-600 gap-2'>
        <Search className='w-6 h-6' />
        <p className='text-sm'>This list is empty</p>
        <p className='text-xs text-zinc-700'>
          Open a movie or show's card and choose &ldquo;Add to List&rdquo;.
        </p>
      </div>
    );
  }

  return (
    <div className='p-3 space-y-3'>
      {/* Toolbar */}
      <div className='flex items-center gap-2'>
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder='Search in list...'
          clearLabel='Clear list search'
          wrapperClassName='flex-1'
          className='h-8 pl-8 rounded-lg bg-zinc-800/60 border-white/8 text-xs text-zinc-300 placeholder:text-zinc-600 focus-visible:ring-0 focus-visible:border-white/20'
        />
        <div className='flex items-center bg-zinc-800/60 rounded-lg border border-white/8 p-0.5'>
          <button
            type='button'
            onClick={() => setViewMode('list')}
            aria-label='List view'
            aria-pressed={viewMode === 'list'}
            title='List view'
            className={cn(
              'h-6 w-6 rounded-md flex items-center justify-center transition-all',
              viewMode === 'list' ? 'bg-white/15 text-white' : 'text-zinc-600 hover:text-zinc-400',
            )}
          >
            <LayoutList className='w-3.5 h-3.5' />
          </button>
          <button
            type='button'
            onClick={() => setViewMode('grid')}
            aria-label='Grid view'
            aria-pressed={viewMode === 'grid'}
            title='Grid view'
            className={cn(
              'h-6 w-6 rounded-md flex items-center justify-center transition-all',
              viewMode === 'grid' ? 'bg-white/15 text-white' : 'text-zinc-600 hover:text-zinc-400',
            )}
          >
            <LayoutGrid className='w-3.5 h-3.5' />
          </button>
        </div>
      </div>

      {/* Items */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={sortableItemIds}
          strategy={viewMode === 'grid' ? rectSortingStrategy : verticalListSortingStrategy}
        >
          {viewMode === 'grid' ? (
            <div className='grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-2'>
              {filtered.map((item) => (
                <SortableItemRow key={item.id} item={item} listId={list.id} viewMode='grid' />
              ))}
            </div>
          ) : (
            <div className='space-y-0.5'>
              {filtered.map((item) => (
                <SortableItemRow key={item.id} item={item} listId={list.id} viewMode='list' />
              ))}
            </div>
          )}
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

      {search && filtered.length === 0 && (
        <p className='text-xs text-zinc-600 text-center py-4'>
          No items match &ldquo;{search}&rdquo;
        </p>
      )}
    </div>
  );
}

// ─── Ghost Overlay Card (list drag) ──────────────────────────────────────────

function ListGhostCard({ list }: { list: UserList }) {
  return (
    <div className='rounded-xl border border-white/20 bg-zinc-900/90 shadow-2xl shadow-black/60 px-4 py-3 flex items-center gap-3 opacity-90'>
      <GripVertical className='w-4 h-4 text-zinc-500' />
      <span className='text-zinc-300'>
        <ListIcon iconId={list.icon} size={16} />
      </span>
      <span className='font-semibold text-sm text-zinc-200'>{list.name}</span>
      <span className='text-[10px] font-bold text-zinc-600 bg-zinc-800 px-1.5 py-0.5 rounded-full ml-1'>
        {list.item_ids.length}
      </span>
    </div>
  );
}

// ─── Main ListsManager ────────────────────────────────────────────────────────

export function ListsManager() {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<UserList | null>(null);
  const [activeListId, setActiveListId] = useState<UniqueIdentifier | null>(null);

  const sensors = useSortableSensors();

  const { data: lists = [], isLoading, isLoadingError, refetch } = useLists();

  const reorderLists = useMutation({
    mutationFn: (ids: string[]) => api.reorderLists(ids),
    onError: () => {
      // Revert the optimistic cache write to server order.
      void invalidateListQueries(queryClient);
      toast.error('Failed to save list order');
    },
  });

  const deleteList = useMutation({
    mutationFn: (id: string) => api.deleteList(id),
    onSuccess: (_, id) => {
      void invalidateListQueries(queryClient);
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      toast.success('List deleted');
    },
    onError: () => toast.error('Failed to delete list'),
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

      const next = arrayMove(lists, oldIdx, newIdx);
      queryClient.setQueryData(LISTS_QUERY_KEY, next);
      reorderLists.mutate(next.map((l) => l.id));
    },
    [lists, reorderLists, queryClient],
  );

  const activeList = activeListId ? lists.find((l) => l.id === activeListId) : null;

  // Non-empty lists confirm through the in-app dialog; empty ones delete
  // straight away — there is nothing to lose.
  const [deleteTarget, setDeleteTarget] = useState<UserList | null>(null);
  const handleDeleteConfirm = (list: UserList) => {
    if (list.item_ids.length > 0) {
      setDeleteTarget(list);
      return;
    }
    // Empty lists delete without the dialog — gate repeat clicks on the
    // in-flight delete for this list, or a double-click issues a second
    // request that fails after the first already removed it.
    if (deleteList.isPending && deleteList.variables === list.id) return;
    deleteList.mutate(list.id);
  };

  return (
    <div className='space-y-6'>
      {/* Header */}
      <div className='flex items-center justify-between'>
        <div>
          <h2 className='text-2xl font-bold text-white'>My Lists</h2>
          <p className='text-sm text-zinc-500 mt-0.5'>
            {lists.length > 0
              ? `${lists.length} list${lists.length !== 1 ? 's' : ''} · add titles via a card's "Add to List" button`
              : 'Create lists to organise your media'}
          </p>
        </div>
        <Button
          onClick={() => setCreateOpen(true)}
          className='bg-white text-black hover:bg-zinc-200 font-semibold gap-2 h-9 px-4 text-sm'
        >
          <ListPlus className='w-4 h-4' />
          New List
        </Button>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className='space-y-3'>
          {LIST_MANAGER_SKELETON_KEYS.map((skeletonKey) => (
            <div
              key={skeletonKey}
              className='h-14 rounded-xl bg-zinc-900/40 border border-white/5 animate-pulse'
            />
          ))}
        </div>
      ) : isLoadingError ? (
        <RetryBanner
          message="Couldn't load your lists — try again."
          onRetry={() => void refetch()}
        />
      ) : lists.length === 0 ? (
        <div className='flex flex-col items-center justify-center py-20 gap-5 border border-dashed border-white/10 rounded-3xl bg-zinc-900/20'>
          <div className='w-16 h-16 rounded-full bg-zinc-800/50 flex items-center justify-center text-zinc-400'>
            <ListIcon iconId='Film' size={28} />
          </div>
          <div className='text-center'>
            <p className='text-lg font-medium text-zinc-300'>No lists yet</p>
            <p className='text-sm text-zinc-600 mt-1'>
              Create a list, then use &ldquo;Add to List&rdquo; on any movie or show's card.
            </p>
          </div>
          <Button
            onClick={() => setCreateOpen(true)}
            className='bg-white text-black hover:bg-zinc-200 font-semibold gap-2'
          >
            <ListPlus className='w-4 h-4' />
            Create your first list
          </Button>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={lists.map((l) => l.id)} strategy={verticalListSortingStrategy}>
            <div className='space-y-2'>
              {lists.map((list) => (
                <SortableListCard
                  key={list.id}
                  list={list}
                  isExpanded={expanded.has(list.id)}
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
          onRenamed={() => {
            setRenameTarget(null);
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
              disabled={deleteList.isPending}
              onClick={() => {
                if (!deleteTarget) return;
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
