import { Check, Library, Plus } from 'lucide-react';
import { warmListEditorDialog } from '@/components/list/list-editor-dialog';
import { ListIconTile } from '@/components/list/list-icons';
import { RetryBanner } from '@/components/retry-banner';
import { Skeleton } from '@/components/ui/skeleton';
import { useListSummaries, type useMediaCollectionActions } from '@/hooks/use-media-library';
import type { MediaItem } from '@/lib/api';
import { cn, pluralize, queryNeedsRetry } from '@/lib/utils';

const ROW_CLASS =
  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-white/[0.06] focus-visible:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/30 aria-disabled:cursor-default';

function SavedCheck({ saved }: { saved: boolean }) {
  return (
    <span className='grid size-5 shrink-0 place-items-center' aria-hidden='true'>
      <span
        className={cn(
          'grid size-4.5 place-items-center rounded-full bg-[rgb(var(--accent-act-rgb)/0.14)] text-(--accent-act) transition-[opacity,transform] duration-150 motion-reduce:transition-none',
          saved ? 'scale-100 opacity-100' : 'scale-75 opacity-0',
        )}
      >
        <Check className='size-3' strokeWidth={2.5} />
      </span>
    </span>
  );
}

interface SaveToCollectionPanelProps {
  item: MediaItem;
  isInLibrary: boolean;
  showLibrary?: boolean;
  libraryBusy?: boolean;
  actions: ReturnType<typeof useMediaCollectionActions>;
  onCreateList: () => void;
}

export function SaveToCollectionPanel({
  item,
  isInLibrary,
  showLibrary = false,
  libraryBusy = false,
  actions,
  onCreateList,
}: SaveToCollectionPanelProps) {
  const listsQuery = useListSummaries(item.id);
  const lists = (listsQuery.data ?? []).filter((list) => !list.is_smart);
  const hasListsError = queryNeedsRetry(listsQuery);
  const { toggleLibrary, toggleListMembership, pendingListIds } = actions;
  const isLibraryBusy = libraryBusy || toggleLibrary.isPending;

  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      {showLibrary && (
        <>
          <button
            type='button'
            className={ROW_CLASS}
            aria-pressed={isInLibrary}
            aria-disabled={isLibraryBusy || undefined}
            aria-busy={isLibraryBusy || undefined}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!isLibraryBusy) toggleLibrary.mutate();
            }}
          >
            <span className='grid size-7 shrink-0 place-items-center rounded-md bg-white/[0.06] text-zinc-300 ring-1 ring-inset ring-white/10'>
              <Library size={15} strokeWidth={2.25} />
            </span>
            <span className='min-w-0 flex-1'>
              <span className='block text-xs font-medium text-zinc-200'>Library</span>
              <span className='block text-[10px] text-zinc-500'>
                {isInLibrary ? 'Saved to your profile' : 'Add to your profile'}
              </span>
            </span>
            <SavedCheck saved={isInLibrary} />
          </button>
          <div className='my-1.5 h-px bg-white/[0.08]' />
        </>
      )}

      <div className='flex shrink-0 items-center justify-between px-2.5 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-500'>
        <span>Lists</span>
        {listsQuery.data && <span className='tabular-nums'>{lists.length}</span>}
      </div>
      <div className='min-h-0 max-h-72 space-y-0.5 overflow-y-auto overscroll-contain'>
        {hasListsError && (
          <RetryBanner
            className='gap-2 px-2.5 py-3'
            message={listsQuery.data ? "Couldn't refresh lists." : "Couldn't load lists."}
            isRetrying={listsQuery.isFetching}
            onRetry={() => void listsQuery.refetch()}
          />
        )}
        {listsQuery.isPending && !hasListsError ? (
          <div role='status' aria-label='Loading lists' className='space-y-1'>
            {[0, 1, 2].map((row) => (
              <div key={row} className='flex items-center gap-2.5 px-2.5 py-2'>
                <Skeleton className='size-7 rounded-md' />
                <div className='flex-1 space-y-1.5'>
                  <Skeleton className='h-3 w-3/4' />
                  <Skeleton className='h-2 w-1/3' />
                </div>
              </div>
            ))}
          </div>
        ) : lists.length > 0 ? (
          lists.map((list) => {
            const pending = pendingListIds.includes(list.id);
            return (
              <button
                key={list.id}
                type='button'
                className={ROW_CLASS}
                title={list.name}
                aria-pressed={list.contains_item}
                aria-disabled={pending || undefined}
                aria-busy={pending || undefined}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!pending) toggleListMembership.mutate(list);
                }}
              >
                <ListIconTile iconId={list.icon} size='sm' />
                <span className='min-w-0 flex-1'>
                  <span dir='auto' className='block truncate text-xs font-medium text-zinc-200'>
                    {list.name}
                  </span>
                  <span className='block text-[10px] tabular-nums text-zinc-500'>
                    {pluralize(list.item_count, 'title')}
                  </span>
                </span>
                <SavedCheck saved={list.contains_item} />
              </button>
            );
          })
        ) : listsQuery.data !== undefined ? (
          <p className='px-2.5 py-3 text-[11px] leading-relaxed text-zinc-500'>
            No manual lists yet — create one to group titles.
            {listsQuery.data.length > 0 && (
              <span className='mt-1 block'>Smart lists fill automatically from their rules.</span>
            )}
          </p>
        ) : null}
      </div>
      <div className='mt-1.5 shrink-0 border-t border-white/[0.08] pt-1.5'>
        <button
          type='button'
          className={ROW_CLASS}
          onPointerEnter={warmListEditorDialog}
          onFocus={warmListEditorDialog}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onCreateList();
          }}
        >
          <Plus className='size-4 shrink-0 text-zinc-400' />
          <span className='text-xs font-medium text-zinc-300'>New list…</span>
        </button>
      </div>
    </div>
  );
}
