import { Check, Loader2, Plus } from 'lucide-react';
import { type RefObject, useRef, useState } from 'react';
import { PosterThumb } from '@/components/poster-thumb';
import { RetryBanner } from '@/components/retry-banner';
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
import { useDebounce } from '@/hooks/use-debounce';
import { useBulkAddToList, useProfileLibrary } from '@/hooks/use-media-library';
import { getListErrorMessage, type UserList } from '@/lib/api';
import { navigateApp } from '@/lib/navigation';
import { notifyAction } from '@/lib/notify';
import { cn, pluralize } from '@/lib/utils';
import { ListIconTile } from './list-icons';

const VISIBLE_PAGE_SIZE = 150;

export function AddTitlesDialog({
  list,
  onOpenChange,
  returnFocusRef,
}: {
  list: UserList;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [visibleLimit, setVisibleLimit] = useState(VISIBLE_PAGE_SIZE);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const debouncedSearch = useDebounce(search, 180);
  const matchingLibraryQuery = useProfileLibrary({
    query: debouncedSearch,
    sort: 'title-asc',
  });
  const hasLibraryError =
    matchingLibraryQuery.isError ||
    (matchingLibraryQuery.isFetched &&
      (matchingLibraryQuery.isPending || matchingLibraryQuery.isPlaceholderData));
  const isSearchPending = search !== debouncedSearch || matchingLibraryQuery.isPlaceholderData;
  const matchingItems = matchingLibraryQuery.data?.items ?? [];
  const existingIds = new Set(list.item_ids);
  const selectedItemIds =
    selectedIds.size === 0
      ? []
      : (matchingLibraryQuery.data?.allIds ?? []).filter(
          (id) => selectedIds.has(id) && !existingIds.has(id),
        );

  const addTitles = useBulkAddToList();
  const selectionDisabled =
    addTitles.isPending ||
    hasLibraryError ||
    isSearchPending ||
    matchingLibraryQuery.isPending ||
    matchingLibraryQuery.isFetching;

  const toggleSelection = (id: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!addTitles.isPending) onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className='flex max-h-[85vh] flex-col gap-4 rounded-xl border-white/10 bg-zinc-950 text-zinc-200 sm:max-w-lg'
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          searchInputRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef.current;
          if (target?.isConnected) {
            event.preventDefault();
            target.focus({ preventScroll: true });
          }
        }}
      >
        <DialogHeader className='shrink-0 pr-6'>
          <div className='flex items-center gap-3'>
            <ListIconTile iconId={list.icon} />
            <div className='min-w-0'>
              <DialogTitle className='text-white'>Add titles</DialogTitle>
              <DialogDescription className='mt-1 truncate text-zinc-400'>
                From your library to <span dir='auto'>{list.name}</span>
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <SearchInput
          inputRef={searchInputRef}
          value={search}
          onValueChange={(value) => {
            setSearch(value);
            setVisibleLimit(VISIBLE_PAGE_SIZE);
          }}
          placeholder='Search your library…'
          clearLabel='Clear library search'
          wrapperClassName='shrink-0'
          className='h-10 rounded-lg border-white/10 bg-white/[0.03] text-white placeholder:text-zinc-500 focus-visible:ring-white/20'
        />

        <span role='status' className='sr-only'>
          {isSearchPending ? 'Searching library…' : ''}
        </span>
        <div
          aria-busy={isSearchPending || matchingLibraryQuery.isPending}
          className={cn(
            'min-h-0 overflow-y-auto rounded-xl border border-white/[0.06] bg-white/[0.02] p-1.5 transition-opacity duration-200',
            matchingLibraryQuery.isPlaceholderData && 'opacity-60',
          )}
        >
          {hasLibraryError ? (
            <RetryBanner
              message="Couldn't load your library."
              onRetry={() => {
                void matchingLibraryQuery.refetch();
              }}
              isRetrying={matchingLibraryQuery.isFetching}
            />
          ) : matchingLibraryQuery.isPending ? (
            <div
              role='status'
              className='flex items-center justify-center gap-2 py-12 text-sm text-zinc-500'
            >
              <Loader2 className='h-4 w-4 animate-spin' />
              Loading your library…
            </div>
          ) : matchingLibraryQuery.data?.allIds.length === 0 ? (
            <div className='space-y-3 px-4 py-10 text-center'>
              <p className='text-sm font-medium text-zinc-300'>Your library is empty</p>
              <p className='text-xs leading-relaxed text-zinc-500'>
                Save titles to your library first, or use the save button on a title's details page
                to add it directly to a list.
              </p>
              <Button
                variant='outline'
                size='sm'
                className='border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06]'
                onClick={() => {
                  onOpenChange(false);
                  navigateApp('/search');
                }}
              >
                Find titles
              </Button>
            </div>
          ) : matchingItems.length === 0 ? (
            <p className='py-10 text-center text-sm text-zinc-500'>No titles match your search.</p>
          ) : (
            <div role='group' aria-label='Library titles' className='space-y-0.5'>
              {matchingItems.slice(0, visibleLimit).map((item) => {
                const inList = existingIds.has(item.id);
                const selected = selectedIds.has(item.id) && !inList;
                const year = item.displayYear || item.primaryYear || item.year;
                return (
                  <button
                    key={item.id}
                    type='button'
                    disabled={inList || addTitles.isPending}
                    aria-label={inList ? `${item.title}, already in list` : item.title}
                    aria-pressed={inList || selected}
                    onClick={() => toggleSelection(item.id)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/30',
                      inList
                        ? 'text-zinc-500'
                        : selected
                          ? 'bg-white/[0.06] text-white'
                          : 'text-zinc-300 hover:bg-white/[0.04]',
                    )}
                  >
                    <PosterThumb
                      poster={item.poster}
                      mediaType={item.type}
                      className='bg-zinc-900 ring-white/10'
                    />
                    <span className='min-w-0 flex-1'>
                      <span dir='auto' className='block truncate text-[13px] font-medium'>
                        {item.title}
                      </span>
                      <span className='mt-0.5 block text-[11px] text-zinc-500'>
                        {year && `${year} · `}
                        {item.type === 'movie' ? 'Movie' : 'Series'}
                      </span>
                    </span>
                    {inList && <span className='text-[10px] text-zinc-500'>In list</span>}
                    <span
                      aria-hidden='true'
                      className={cn(
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded-md',
                        selected
                          ? 'bg-[var(--accent-nav)] text-[var(--on-accent-nav)]'
                          : 'border border-white/10 text-zinc-500',
                      )}
                    >
                      {inList || selected ? (
                        <Check className='h-3 w-3' strokeWidth={2.5} />
                      ) : (
                        <Plus className='h-3 w-3' />
                      )}
                    </span>
                  </button>
                );
              })}
              {matchingItems.length > visibleLimit && (
                <div className='space-y-2 px-3 py-3 text-center'>
                  <p className='text-[11px] text-zinc-500'>
                    Showing {visibleLimit} of {matchingItems.length}
                  </p>
                  <Button
                    variant='outline'
                    size='sm'
                    disabled={addTitles.isPending}
                    onClick={() => setVisibleLimit((limit) => limit + VISIBLE_PAGE_SIZE)}
                  >
                    Load more
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className='shrink-0 items-center gap-3 sm:justify-between'>
          <div className='flex flex-wrap items-center gap-3'>
            <span role='status' className='text-xs tabular-nums text-zinc-500'>
              {selectedItemIds.length} selected
            </span>
            <button
              type='button'
              disabled={
                selectionDisabled || !matchingItems.some((item) => !existingIds.has(item.id))
              }
              onClick={() =>
                setSelectedIds((previous) => {
                  const next = new Set(previous);
                  for (const item of matchingItems) {
                    if (!existingIds.has(item.id)) next.add(item.id);
                  }
                  return next;
                })
              }
              className='rounded-md text-xs font-medium text-zinc-300 transition-colors hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-40'
            >
              Select all
            </button>
            <button
              type='button'
              disabled={selectionDisabled || selectedIds.size === 0}
              onClick={() => setSelectedIds(new Set())}
              className='rounded-md text-xs font-medium text-zinc-300 transition-colors hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-40'
            >
              Clear
            </button>
          </div>
          <div className='flex items-center gap-2'>
            <Button
              variant='ghost'
              disabled={addTitles.isPending}
              onClick={() => onOpenChange(false)}
              className='text-zinc-400'
            >
              Cancel
            </Button>
            <Button
              disabled={selectedItemIds.length === 0 || addTitles.isPending}
              onClick={() =>
                addTitles.mutate(
                  { listId: list.id, itemIds: selectedItemIds },
                  {
                    onSuccess: (count) => {
                      notifyAction(`Added ${pluralize(count, 'title')}`, {
                        detail: list.name,
                      });
                      onOpenChange(false);
                    },
                    onError: (error) =>
                      notifyAction(getListErrorMessage(error) ?? 'Failed to add titles', {
                        tone: 'error',
                      }),
                  },
                )
              }
              className='bg-white font-semibold text-black hover:bg-zinc-200'
            >
              {addTitles.isPending && <Loader2 className='h-4 w-4 animate-spin' />}
              Add {pluralize(selectedItemIds.length, 'title')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
