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
  ChevronsDownUp,
  ChevronsUpDown,
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
  FILTER_ACTIVE_BUTTON_CLASS,
  FILTER_MENU_BUTTON_CLASS,
  TYPE_OPTIONS,
  useCollectionSelection,
} from '@/components/profile-library-controls';
import { SegmentedControl, ViewToggle } from '@/components/ui/segmented-control';
import { CollectionRowActions } from '@/components/collection-row-actions';
import { RetryBanner } from '@/components/retry-banner';
import { StatePanel } from '@/components/state-panel';
import { SelectionCheck } from '@/components/watch-status-icon';
import { useFindShortcut } from '@/hooks/use-browse-hotkeys';
import { useBulkRemoveFromList, useLists } from '@/hooks/use-media-library';
import { useTitleSearch } from '@/hooks/use-item-search';
import { useMountedRef } from '@/hooks/use-mounted-ref';
import { usePrefetchDetails } from '@/lib/details-prefetch';
import { useInlineMenu } from '@/hooks/use-inline-menu';
import { useSortableSensors } from '@/hooks/use-sortable-sensors';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { SearchInput } from '@/components/ui/search-input';
import { api, type LibraryTypeFilter, type MediaItem, type UserList } from '@/lib/api';
import { navigateToDetails } from '@/lib/player-navigation';
import { notifyAction } from '@/lib/notify';
import { trackPendingAppWrite } from '@/lib/pending-app-writes';

import {
  invalidateListMetadataQueries,
  invalidateListQueries,
  LISTS_QUERY_KEY,
} from '@/lib/query-invalidation';
import {
  boundedMapSet,
  cn,
  isSeriesLikeMediaType,
  mediaTypeLabel,
  orderByIds,
  pluralize,
} from '@/lib/utils';
import { AddTitlesDialog } from './add-titles-dialog';
import { ListIconTile } from './list-icons';

const LIST_ITEMS_PAGE_SIZE = 150;
const LIST_POSTER_PREVIEW_COUNT = 5;
const DELETE_LIST_MUTATION_KEY = ['delete-list'] as const;
const LIST_ORDER_MUTATION_KEY = ['list-order'] as const;
const listViewStates = new Map<
  string,
  { viewMode: 'grid' | 'list'; typeFilter: LibraryTypeFilter; search: string; visibleLimit: number }
>();

// Skeleton rows mirror the last resolved list count instead of a fixed guess.
let lastResolvedListCount: number | undefined;
const LIST_SKELETON_CAP = 6;
const SORTABLE_TRANSITION = { duration: 200, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' };
const CARD_HEADER_ACTION_CLASS =
  'flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 transition-[color,background-color,opacity] duration-150 hover:bg-white/[0.08] hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/30 opacity-100 md:opacity-0 md:group-hover/card:opacity-100 md:group-focus-within/card:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 motion-reduce:transition-none';

// closestCenter flaps between variable-height rows; pointerWithin holds the row under the cursor.
// The closestCenter fallback covers keyboard drags (no pointer coordinates) and gaps between rows.
const sortableCollisionDetection: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length > 0 ? within : closestCenter(args);
};

function formatListSubtitle(list: UserList): string {
  const total = list.item_ids.length;
  if (total === 0) return 'Empty list';
  const items = list.items;
  if (!items || items.length === 0) return pluralize(total, 'title');
  let series = 0;
  let movies = 0;
  for (const item of items) {
    if (isSeriesLikeMediaType(item.type)) series += 1;
    else movies += 1;
  }
  const breakdown = [
    movies > 0 ? pluralize(movies, 'movie') : null,
    series > 0 ? `${series} series` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return breakdown ? `${pluralize(total, 'title')} · ${breakdown}` : pluralize(total, 'title');
}

function ListPosterStack({ items, totalCount }: { items?: MediaItem[]; totalCount: number }) {
  const posters = items?.slice(0, LIST_POSTER_PREVIEW_COUNT) ?? [];
  const overflow = Math.max(0, totalCount - posters.length);
  return (
    <span aria-hidden='true' className='hidden h-12 shrink-0 items-center sm:flex'>
      {posters.length > 0 ? (
        <>
          <span className='flex items-center -space-x-2'>
            {posters.map((item) => (
              <PosterThumb
                key={item.id}
                poster={item.poster}
                mediaType={item.type}
                size='md'
                className='rounded-sm bg-zinc-900 shadow-md shadow-black/60 ring-1 ring-black'
              />
            ))}
          </span>
          {overflow > 0 && (
            <span className='ml-2 text-[11.5px] font-medium tabular-nums text-zinc-500'>
              +{overflow}
            </span>
          )}
        </>
      ) : (
        <span className='flex h-12 w-8 items-center justify-center rounded-sm border border-dashed border-white/[0.1] text-zinc-600'>
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
  dragDisabled: boolean;
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
  dragDisabled,
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
    disabled: dragDisabled,
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
        'group/card rounded-lg border transition-[background-color,border-color,opacity,box-shadow] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none!',
        isDragging
          ? 'relative z-10 border-white/20 bg-zinc-950 shadow-2xl shadow-black/70'
          : isExpanded
            ? 'border-white/[0.13] bg-white/[0.02]'
            : 'border-white/[0.075] bg-white/[0.015] hover:border-white/[0.13] hover:bg-white/[0.03] focus-within:border-white/[0.13]',
      )}
    >
      <div ref={headerRef} className='relative overflow-hidden rounded-t-lg' {...menu.rootProps}>
        <div
          className={cn(
            'flex items-center gap-3 px-4 py-3 sm:gap-3.5 sm:px-4.5 sm:py-3.5 transition-opacity duration-150 ease-out motion-reduce:transition-none',
            menu.presence.mounted && 'opacity-0 duration-0',
          )}
        >
          {!dragDisabled && (
            <button
              ref={setActivatorNodeRef}
              type='button'
              {...attributes}
              {...listeners}
              className='-ml-1.5 flex h-8 w-7 items-center justify-center rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.05] transition-colors cursor-grab active:cursor-grabbing touch-none shrink-0 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/25'
              aria-label={`Reorder ${list.name}`}
            >
              <GripVertical className='w-4 h-4' />
            </button>
          )}

          <button
            type='button'
            onClick={() => onToggleExpand(list.id)}
            aria-expanded={isExpanded}
            aria-controls={isExpanded ? contentId : undefined}
            className='flex min-h-10 items-center gap-3 flex-1 min-w-0 rounded-md group focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/25'
          >
            <ListIconTile
              iconId={list.icon}
              size='md'
              className={cn(
                'transition-colors duration-150 motion-reduce:transition-none',
                isExpanded ? 'text-(--accent-nav)' : 'text-zinc-400 group-hover:text-zinc-100',
              )}
            />
            <div className='flex-1 min-w-0 text-left'>
              <span
                dir='auto'
                className='block truncate text-[15px] font-semibold tracking-[-0.01em] text-zinc-100 group-hover:text-white transition-colors'
              >
                {list.name}
              </span>
              <p className='mt-0.5 text-[12px] tabular-nums text-zinc-400'>
                {formatListSubtitle(list)}
              </p>
            </div>
            <ListPosterStack items={list.items} totalCount={list.item_ids.length} />
          </button>

          <div className='flex shrink-0 items-center gap-0.5'>
            <button
              type='button'
              aria-label={`Edit ${list.name}`}
              title='Edit list'
              onPointerEnter={warmListEditorDialog}
              onFocus={warmListEditorDialog}
              onClick={() => onRename(list)}
              className={CARD_HEADER_ACTION_CLASS}
            >
              <Pencil className='size-3.5' />
            </button>
            <button
              type='button'
              aria-label={`Delete ${list.name}`}
              title='Delete list'
              disabled={isDeleting}
              onClick={() => onDelete(list)}
              className={cn(
                CARD_HEADER_ACTION_CLASS,
                'hover:bg-red-500/10 hover:text-red-400 disabled:opacity-40',
              )}
            >
              <Trash2 className='size-3.5' />
            </button>
            <button
              type='button'
              tabIndex={-1}
              aria-hidden='true'
              onClick={() => onToggleExpand(list.id)}
              className='flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200 transition-colors'
            >
              <ChevronRight
                className={cn(
                  'w-4 h-4 transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                  isExpanded && 'rotate-90 text-zinc-200',
                )}
              />
            </button>
          </div>
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
    if (viewMode === 'grid') {
      return (
        <button
          type='button'
          aria-label={`${isSelected ? 'Deselect' : 'Select'} ${item.title}`}
          aria-pressed={isSelected}
          onClick={(event) => onToggleSelect(item.id, event.shiftKey)}
          className='group/item block w-full rounded-lg text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background'
        >
          <div
            className={cn(
              'relative overflow-hidden rounded-lg bg-zinc-900 ring-1 ring-white/[0.08] transition-shadow duration-150 motion-reduce:transition-none',
              isSelected
                ? 'ring-2 ring-(--accent-nav) ring-offset-2 ring-offset-zinc-950'
                : 'group-hover/item:ring-white/20',
            )}
          >
            <SelectionCheck
              selected={isSelected}
              className={cn(
                'absolute left-2.5 top-2.5 z-20 size-6 rounded-lg [&_svg]:size-3.5',
                !isSelected && 'border-white/30 bg-black/65 group-hover/item:border-white/60',
              )}
            />
            <PosterThumb
              poster={item.poster}
              title={item.title}
              mediaType={item.type}
              className='aspect-2/3 h-auto w-full rounded-none ring-0'
            />
          </div>
          <div className='mt-2 px-0.5'>
            <span
              dir='auto'
              title={item.title}
              className='line-clamp-2 min-h-[2.5em] text-[14px] font-semibold leading-5 text-zinc-100 [overflow-wrap:anywhere]'
            >
              {item.title}
            </span>
          </div>
        </button>
      );
    }
    return (
      <button
        type='button'
        aria-label={`${isSelected ? 'Deselect' : 'Select'} ${item.title}`}
        aria-pressed={isSelected}
        onClick={(event) => onToggleSelect(item.id, event.shiftKey)}
        className={cn(
          'group/item flex w-full items-center gap-3.5 rounded-lg border px-3.5 py-2.5 text-left transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/30',
          isSelected
            ? 'border-(--accent-nav)/40 bg-(--accent-nav)/[0.08]'
            : 'border-white/[0.055] bg-white/[0.015] hover:border-white/[0.12] hover:bg-white/[0.04]',
        )}
      >
        <SelectionCheck
          selected={isSelected}
          className={cn(!isSelected && 'bg-black/40 group-hover/item:border-white/50')}
        />
        <PosterThumb poster={item.poster} title={item.title} mediaType={item.type} size='md' />
        <span
          dir='auto'
          title={item.title}
          className='truncate text-[14.5px] font-medium text-zinc-100'
        >
          {item.title}
        </span>
      </button>
    );
  }

  if (viewMode === 'grid') {
    const synopsis = item.description?.trim() || null;
    return (
      <div
        ref={setNodeRef}
        style={style}
        className={cn('group/item relative min-w-0', isDragging && 'z-20 opacity-95')}
      >
        <button
          ref={setActivatorNodeRef}
          type='button'
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${item.title}`}
          className='absolute left-2 top-2 z-20 flex h-7 w-7 items-center justify-center rounded-md border border-white/15 bg-black/70 text-white/80 opacity-0 transition-[opacity,color,border-color,background-color] duration-150 cursor-grab active:cursor-grabbing touch-none hover:border-white/30 hover:bg-black/85 hover:text-white group-hover/item:opacity-100 group-focus-within/item:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40 motion-reduce:transition-none'
        >
          <GripVertical className='h-3.5 w-3.5' />
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
          className='absolute right-2 top-2 z-20 flex h-7 w-7 items-center justify-center rounded-md border border-white/15 bg-black/70 text-white/80 opacity-0 transition-[opacity,color,border-color,background-color] duration-150 hover:border-red-400/50 hover:bg-red-500/85 hover:text-white group-hover/item:opacity-100 group-focus-within/item:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40 motion-reduce:transition-none'
        >
          <X className='h-3.5 w-3.5' />
        </button>

        <button
          type='button'
          aria-label={`Open details for ${item.title}`}
          className='block w-full rounded-lg text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background'
          onPointerDown={prefetchDetails}
          onFocus={prefetchDetails}
          onClick={() => navigateToDetails(item.type, item.id)}
        >
          <span
            className={cn(
              'relative block aspect-2/3 w-full overflow-hidden rounded-lg bg-zinc-900',
              isDragging && 'shadow-2xl shadow-black/70 ring-1 ring-white/25',
            )}
          >
            <PosterThumb
              poster={item.poster}
              title={item.title}
              mediaType={item.type}
              className='h-full w-full rounded-none bg-zinc-900 ring-0'
            />
            {/* EpisodeCard-inspired hover: crisp inset ring + dark wash, gradient-only opacity fade,
                and color-only text reveal so subpixel antialiasing never softens mid-fade. */}
            <span
              aria-hidden='true'
              className='pointer-events-none absolute inset-0 z-10 rounded-lg bg-black/0 ring-1 ring-inset ring-white/[0.08] transition-[background-color,box-shadow] duration-200 ease-out group-hover/item:bg-black/25 group-hover/item:ring-white/20 group-has-[:focus-visible]/item:bg-black/25 group-has-[:focus-visible]/item:ring-white/20 motion-reduce:transition-none'
            />
            <span
              aria-hidden='true'
              className='pointer-events-none absolute inset-x-0 bottom-0 z-[15] flex flex-col justify-end px-2.5 pb-2.5 pt-12'
            >
              <span className='absolute inset-0 bg-linear-to-t from-black/90 via-black/55 to-transparent opacity-0 transition-opacity duration-200 ease-out group-hover/item:opacity-100 group-has-[:focus-visible]/item:opacity-100 motion-reduce:transition-none' />
              {synopsis ? (
                <span className='relative line-clamp-3 text-[11.5px] leading-[16px] text-transparent transition-colors duration-200 ease-out group-hover/item:text-zinc-100 group-has-[:focus-visible]/item:text-zinc-100 motion-reduce:transition-none'>
                  {synopsis}
                </span>
              ) : (
                <span className='relative flex items-center justify-between text-[11.5px] font-medium text-transparent transition-colors duration-200 ease-out group-hover/item:text-zinc-100 group-has-[:focus-visible]/item:text-zinc-100 motion-reduce:transition-none'>
                  <span>Open details</span>
                  <ChevronRight className='h-3.5 w-3.5 shrink-0' />
                </span>
              )}
            </span>
          </span>
          <span className='mt-2 block px-0.5'>
            <span
              dir='auto'
              title={item.title}
              className='line-clamp-2 min-h-[2.5em] text-[14px] font-semibold leading-5 text-zinc-200 transition-colors duration-150 group-hover/item:text-white [overflow-wrap:anywhere] motion-reduce:transition-none'
            >
              {item.title}
            </span>
            <span className='mt-0.5 flex items-center gap-1.5 text-[12px] leading-4 text-zinc-400'>
              <span>{mediaTypeLabel(item.type)}</span>
              {item.displayYear && (
                <>
                  <span aria-hidden='true' className='text-zinc-600'>
                    ·
                  </span>
                  <span className='tabular-nums'>{item.displayYear}</span>
                </>
              )}
            </span>
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group flex items-center gap-3 px-3 py-2 rounded-lg border transition-[background-color,border-color,opacity] duration-150 ease-out motion-reduce:transition-none!',
        isDragging
          ? 'relative z-10 border-white/15 bg-zinc-900 shadow-lg shadow-black/60'
          : 'border-transparent hover:border-white/[0.08] hover:bg-white/[0.035] focus-within:border-white/[0.08] focus-within:bg-white/[0.035]',
      )}
    >
      <button
        ref={setActivatorNodeRef}
        type='button'
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${item.title}`}
        className='-ml-1 flex h-8 w-7 items-center justify-center rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.05] transition-colors cursor-grab active:cursor-grabbing touch-none shrink-0 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/25'
      >
        <GripVertical className='w-3.5 h-3.5' />
      </button>

      <button
        type='button'
        aria-label={`Open details for ${item.title}`}
        className='flex flex-1 min-w-0 items-center gap-3.5 rounded-md cursor-pointer text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/25'
        onPointerDown={prefetchDetails}
        onFocus={prefetchDetails}
        onClick={() => navigateToDetails(item.type, item.id)}
      >
        <PosterThumb
          poster={item.poster}
          mediaType={item.type}
          size='lg'
          className='ring-1 ring-inset ring-white/[0.08] transition-shadow duration-200 group-hover:ring-white/20 motion-reduce:transition-none'
        />
        <span className='flex-1 min-w-0'>
          <span
            dir='auto'
            title={item.title}
            className='block text-[14.5px] font-semibold tracking-[-0.01em] text-zinc-200 group-hover:text-white transition-colors duration-150 truncate motion-reduce:transition-none'
          >
            {item.title}
          </span>
          <span className='mt-1 flex items-center gap-1.5 text-[12px] leading-4 text-zinc-400'>
            <span>{mediaTypeLabel(item.type)}</span>
            {item.displayYear && (
              <>
                <span aria-hidden='true' className='text-zinc-600'>
                  ·
                </span>
                <span className='tabular-nums'>{item.displayYear}</span>
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
    () => listViewStates.get(list.id)?.viewMode ?? 'grid',
  );
  const [typeFilter, setTypeFilter] = useState<LibraryTypeFilter>(
    () => listViewStates.get(list.id)?.typeFilter ?? 'all',
  );
  const [search, setSearch] = useState(() => listViewStates.get(list.id)?.search ?? '');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [visibleLimit, setVisibleLimit] = useState(
    () => listViewStates.get(list.id)?.visibleLimit ?? LIST_ITEMS_PAGE_SIZE,
  );
  useLayoutEffect(() => {
    boundedMapSet(listViewStates, list.id, { viewMode, typeFilter, search, visibleLimit }, 64);
  }, [list.id, viewMode, typeFilter, search, visibleLimit]);
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
    filteredItems: searchedItems,
    isSearchPending,
    searchError,
    isSearchFetching,
    retrySearch,
  } = useTitleSearch(orderedItems, search);

  const filtered =
    typeFilter === 'all'
      ? searchedItems
      : searchedItems.filter(
          (item) => isSeriesLikeMediaType(item.type) === (typeFilter === 'series'),
        );
  const hasFilters = Boolean(effectiveSearch) || typeFilter !== 'all';
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
      className='p-4 sm:p-5 space-y-4'
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
              wrapperClassName='min-w-44 flex-1'
              className='h-9 pl-8 rounded-lg bg-white/[0.03] border-white/[0.08] text-[13px] text-white placeholder:text-zinc-500 focus-visible:border-(--accent-nav) focus-visible:ring-(--accent-nav)/25'
            />
            {hasFilters && (
              <span className='shrink-0 text-[12px] tabular-nums text-zinc-400'>
                {filtered.length} of {orderedItems.length}
              </span>
            )}
            <SegmentedControl
              label='List media type'
              value={typeFilter}
              options={TYPE_OPTIONS}
              onChange={(nextType) => {
                setTypeFilter(nextType);
                setVisibleLimit(LIST_ITEMS_PAGE_SIZE);
              }}
            />
            <ViewToggle viewMode={viewMode} onChange={setViewMode} />
            <Button
              ref={selectionTriggerRef}
              size='sm'
              variant='outline'
              aria-pressed={selection.selectionMode}
              disabled={bulkRemove.isPending || reorderItems.isPending || activeId !== null}
              onClick={selection.selectionMode ? selection.exit : selection.begin}
              className={cn(
                FILTER_MENU_BUTTON_CLASS,
                selection.selectionMode && FILTER_ACTIVE_BUTTON_CLASS,
              )}
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
          className='h-9 rounded-lg border-white/10 bg-white/[0.03] text-xs text-zinc-200 hover:border-white/[0.18] hover:bg-white/[0.07] hover:text-white'
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
          onInvert={() => selection.invert(filteredIds)}
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
                  ? 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4'
                  : 'flex flex-col gap-1'
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

        {orderedItems.length > 0 && hasFilters && filtered.length === 0 && (
          <StatePanel
            icon={<Search aria-hidden='true' className='h-6 w-6 text-zinc-600' />}
            title='No results'
            description={
              effectiveSearch ? (
                <>Nothing in this list matches &ldquo;{effectiveSearch}&rdquo;.</>
              ) : (
                <>No {typeFilter === 'movie' ? 'movies' : 'series'} in this list.</>
              )
            }
            descriptionClassName='text-[13px] text-zinc-500'
            className='rounded-lg border border-white/[0.06] bg-white/[0.015] px-6 py-12'
            action={
              <Button
                size='sm'
                variant='ghost'
                className='h-8 text-xs text-zinc-400'
                onClick={() => {
                  setSearch('');
                  setTypeFilter('all');
                  setVisibleLimit(LIST_ITEMS_PAGE_SIZE);
                  searchInputRef.current?.focus({ preventScroll: true });
                }}
              >
                Clear filters
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
  const [listFilter, setListFilter] = useState('');
  const listFilterRef = useRef<HTMLInputElement>(null);
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

  const trimmedListFilter = listFilter.trim().toLowerCase();
  const visibleLists = trimmedListFilter
    ? lists.filter((list) => list.name.toLowerCase().includes(trimmedListFilter))
    : lists;
  const totalListEntries = lists.reduce((sum, list) => sum + list.item_ids.length, 0);
  const allVisibleExpanded =
    visibleLists.length > 0 && visibleLists.every((list) => expanded.has(list.id));

  const toggleAllExpanded = () => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('list');
        if (!allVisibleExpanded) {
          for (const list of visibleLists) next.append('list', list.id);
        }
        return next;
      },
      { replace: true },
    );
  };

  useFindShortcut(
    () =>
      listFilterRef.current ??
      listsContainerRef.current?.querySelector<HTMLInputElement>('input[type="search"]') ??
      null,
  );

  return (
    <div className='space-y-4' data-escape-capture={activeListId !== null ? '' : undefined}>
      <div className='flex flex-wrap items-center justify-between gap-2.5'>
        <p className='text-[13px] tabular-nums text-zinc-400'>
          {lists.length > 0
            ? `${pluralize(lists.length, 'list')} · ${pluralize(totalListEntries, 'title')}`
            : 'Organize saved titles into collections.'}
        </p>
        <div className='flex flex-wrap items-center gap-2'>
          {lists.length >= 3 && (
            <SearchInput
              inputRef={listFilterRef}
              value={listFilter}
              onValueChange={setListFilter}
              placeholder='Filter lists…'
              clearLabel='Clear list filter'
              wrapperClassName='w-48 sm:w-56'
              className='h-9 rounded-lg border-white/[0.08] bg-white/[0.03] text-[13px] text-white placeholder:text-zinc-500 focus-visible:border-(--accent-nav) focus-visible:ring-(--accent-nav)/25'
            />
          )}
          {lists.length > 1 && visibleLists.length > 0 && (
            <Button
              variant='outline'
              size='sm'
              onClick={toggleAllExpanded}
              className={FILTER_MENU_BUTTON_CLASS}
            >
              {allVisibleExpanded ? (
                <>
                  <ChevronsDownUp className='size-3.5' />
                  Collapse all
                </>
              ) : (
                <>
                  <ChevronsUpDown className='size-3.5' />
                  Expand all
                </>
              )}
            </Button>
          )}
          <Button
            ref={newListButtonRef}
            onPointerEnter={warmListEditorDialog}
            onFocus={warmListEditorDialog}
            onClick={() => setCreateOpen(true)}
            className='accent-lattice h-9 gap-2 rounded-lg border-0 px-3.5 text-[13px] font-semibold'
          >
            <ListPlus className='w-4 h-4' />
            New list
          </Button>
        </div>
      </div>

      {isError && lists.length > 0 && retryBanner}
      {isLoading && !isFetched ? (
        <div role='status' aria-busy='true'>
          <span className='sr-only'>Loading lists…</span>
          <div className='space-y-2.5' aria-hidden='true'>
            {Array.from(
              {
                length: Math.min((expectedCount || lastResolvedListCount) ?? 3, LIST_SKELETON_CAP),
              },
              (_, index) => (
                <div
                  key={index}
                  className='h-[74px] rounded-lg bg-zinc-900/40 border border-white/5 animate-pulse'
                />
              ),
            )}
          </div>
        </div>
      ) : isError && lists.length === 0 ? (
        retryBanner
      ) : lists.length === 0 ? (
        <div className='flex flex-col items-center justify-center px-6 py-14 gap-3 border border-white/[0.08] rounded-lg bg-white/[0.02]'>
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
            className='accent-lattice mt-1 h-9 border-0 px-4 text-xs font-semibold'
          >
            <Plus aria-hidden='true' className='h-3.5 w-3.5' />
            Create your first list
          </Button>
        </div>
      ) : visibleLists.length === 0 ? (
        <StatePanel
          icon={<Search aria-hidden='true' className='h-6 w-6 text-zinc-600' />}
          title='No matching lists'
          description={<>None of your lists match &ldquo;{listFilter.trim()}&rdquo;.</>}
          descriptionClassName='text-sm text-zinc-400'
          className='rounded-lg border border-white/[0.08] bg-white/[0.02] px-6 py-12'
          action={
            <Button
              size='sm'
              variant='ghost'
              className='h-8 text-xs text-zinc-400'
              onClick={() => {
                setListFilter('');
                listFilterRef.current?.focus({ preventScroll: true });
              }}
            >
              Clear filter
            </Button>
          }
        />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={sortableCollisionDetection}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveListId(null)}
        >
          <SortableContext
            items={visibleLists.map((l) => l.id)}
            strategy={verticalListSortingStrategy}
          >
            <div ref={listsContainerRef} className='flex flex-col gap-3'>
              {visibleLists.map((list, index) => (
                <SortableListCard
                  key={list.id}
                  list={list}
                  isExpanded={expanded.has(list.id)}
                  isDeleting={pendingDeleteIds.includes(list.id)}
                  dragDisabled={Boolean(trimmedListFilter)}
                  canMoveUp={!trimmedListFilter && index > 0}
                  canMoveDown={!trimmedListFilter && index < visibleLists.length - 1}
                  onToggleExpand={updateExpanded}
                  onRename={setRenameTarget}
                  onDelete={handleDeleteConfirm}
                  onMove={(delta) => {
                    const next = index + delta;
                    if (!trimmedListFilter && next >= 0 && next < lists.length)
                      moveList(index, next);
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
