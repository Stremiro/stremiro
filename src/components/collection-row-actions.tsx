import { Bookmark, Check, CircleDashed } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { CreateListDialog, warmListEditorDialog } from '@/components/list/list-editor-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { WatchStatusIcon } from '@/components/watch-status-icon';
import { useDetailsWatchStatus } from '@/hooks/use-details-watch-status';
import {
  useIsItemInLibrary,
  useItemWatchStatus,
  useMediaCollectionActions,
} from '@/hooks/use-media-library';
import { type MediaItem, WATCH_STATUS_LABELS, WATCH_STATUSES } from '@/lib/api';

const loadSaveToCollectionPanel = () => import('@/components/list/save-to-collection');
const SaveToCollectionPanel = lazy(() =>
  loadSaveToCollectionPanel().then((module) => ({ default: module.SaveToCollectionPanel })),
);
const warmSaveToCollectionPanel = () => void loadSaveToCollectionPanel().catch(() => undefined);

// Ghost icon buttons that surface on row hover/focus — same reveal as the row remove buttons.
const ROW_ACTION_CLASS =
  'flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 transition-[color,background-color,opacity] duration-150 hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 focus-visible:opacity-100 data-[state=open]:bg-white/[0.08] data-[state=open]:text-white data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100 motion-reduce:transition-none';

// Mounted only while the status menu is open — keeps the details-status mutation and
// library-membership query out of resting rows.
function StatusMenuItems({ item }: { item: MediaItem }) {
  const { watchStatus, watchStatusMutation } = useDetailsWatchStatus(item, item.id);
  const busy = watchStatusMutation.isPending;
  return (
    <>
      {WATCH_STATUSES.map((status) => (
        <DropdownMenuItem
          key={status}
          role='menuitemradio'
          aria-checked={watchStatus === status}
          disabled={busy}
          onSelect={() => {
            if (watchStatus !== status) watchStatusMutation.mutate(status);
          }}
          className='cursor-pointer gap-2 rounded-md py-1.5 text-[12px]'
        >
          <WatchStatusIcon status={status} className='size-3.5' />
          <span className='flex-1'>{WATCH_STATUS_LABELS[status]}</span>
          {watchStatus === status && <Check className='size-3 shrink-0 opacity-70' />}
        </DropdownMenuItem>
      ))}
      {watchStatus && (
        <>
          <div aria-hidden='true' className='my-1 h-px bg-white/[0.08]' />
          <DropdownMenuItem
            disabled={busy}
            onSelect={() => watchStatusMutation.mutate(null)}
            className='cursor-pointer gap-2 rounded-md py-1.5 text-[12px] text-zinc-400'
          >
            Clear status
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}

// Mounted only while the popover is open — same lazy bound for list summaries/membership.
function RowListsContent({
  item,
  onCreateList,
  actionsRef,
}: {
  item: MediaItem;
  onCreateList: () => void;
  actionsRef: React.RefObject<ReturnType<typeof useMediaCollectionActions> | null>;
}) {
  const libraryQuery = useIsItemInLibrary(item.id);
  const actions = useMediaCollectionActions({ item, isInLibrary: libraryQuery.data === true });
  useEffect(() => {
    actionsRef.current = actions;
  });
  return (
    <Suspense
      fallback={
        <p role='status' className='p-3 text-[13px] leading-5 text-zinc-400'>
          Loading lists…
        </p>
      }
    >
      <SaveToCollectionPanel
        item={item}
        isInLibrary={libraryQuery.data === true}
        showLibrary
        libraryBusy={libraryQuery.isPending}
        actions={actions}
        onCreateList={onCreateList}
      />
    </Suspense>
  );
}

// Hover-revealed quick actions for collection rows: watch-status menu + save-to-list popover.
export function CollectionRowActions({ item }: { item: MediaItem }) {
  const { data: status } = useItemWatchStatus(item.id);
  const [createListOpen, setCreateListOpen] = useState(false);
  // The popover unmounts when the dialog steals focus; the latest actions stay callable via ref.
  const actionsRef = useRef<ReturnType<typeof useMediaCollectionActions> | null>(null);
  return (
    <div className='flex shrink-0 items-center gap-0.5'>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type='button'
            aria-label={`Set watch status for ${item.title}`}
            title='Set status'
            className={ROW_ACTION_CLASS}
          >
            {status ? (
              <WatchStatusIcon status={status} className='size-3.5' />
            ) : (
              <CircleDashed aria-hidden='true' className='size-3.5' />
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end' className='w-40 border-white/10 bg-zinc-950/98'>
          <StatusMenuItems item={item} />
        </DropdownMenuContent>
      </DropdownMenu>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type='button'
            aria-label={`Save ${item.title} to a list`}
            title='Add to list'
            onPointerEnter={() => {
              warmSaveToCollectionPanel();
              warmListEditorDialog();
            }}
            onFocus={() => {
              warmSaveToCollectionPanel();
              warmListEditorDialog();
            }}
            className={ROW_ACTION_CLASS}
          >
            <Bookmark aria-hidden='true' className='size-3.5' />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align='end'
          className='w-64 rounded-xl border-white/[0.08] bg-zinc-950/95 p-0 shadow-2xl backdrop-blur-xl'
        >
          <div className='flex max-h-[min(20rem,var(--radix-popover-content-available-height))] flex-col overflow-y-auto overscroll-contain p-1.5 scrollbar-hide'>
            <RowListsContent
              item={item}
              actionsRef={actionsRef}
              onCreateList={() => setCreateListOpen(true)}
            />
          </div>
        </PopoverContent>
      </Popover>
      {createListOpen && (
        <CreateListDialog
          open={createListOpen}
          onOpenChange={setCreateListOpen}
          onCreated={(list) => actionsRef.current?.addItemToNewList(list)}
        />
      )}
    </div>
  );
}
