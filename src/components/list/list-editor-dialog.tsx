import { useMutation, useQueryClient } from '@tanstack/react-query';
import { lazy, type RefObject, Suspense, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useMountedRef } from '@/hooks/use-mounted-ref';
import { api, getListErrorMessage, type UserList } from '@/lib/api';
import { notifyAction } from '@/lib/notify';
import { invalidateListMetadataQueries, invalidateListQueries } from '@/lib/query-invalidation';
import type { ListEditorDialogProps, ListEditorValues } from './list-editor-content';

const loadListEditor = () => import('./list-editor-content');
const ListEditorContent = lazy(() =>
  loadListEditor().then((module) => ({ default: module.ListEditorContent })),
);

export function warmListEditorDialog() {
  void loadListEditor().catch(() => undefined);
}

function ListEditorDialog(props: ListEditorDialogProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!props.isPending) props.onOpenChange(open);
      }}
    >
      <DialogContent
        ref={contentRef}
        className='sm:max-w-md max-h-[90vh] overflow-y-auto rounded-xl bg-zinc-950 border-white/10 text-zinc-200'
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (nameInputRef.current ?? contentRef.current)?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          const target = props.returnFocusRef?.current;
          if (target?.isConnected) {
            event.preventDefault();
            target.focus({ preventScroll: true });
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className='text-white font-semibold'>{props.title}</DialogTitle>
          <DialogDescription className='text-zinc-400'>
            A home for your next obsession, favourites, or movie night.
          </DialogDescription>
        </DialogHeader>
        <Suspense
          fallback={
            <div role='status'>
              <span className='sr-only'>Loading list editor…</span>
              <div aria-hidden='true' className='space-y-5'>
                <Skeleton className='h-20 rounded-xl' />
                <Skeleton className='h-16 rounded-lg' />
                <Skeleton className='h-32 rounded-xl' />
                <Skeleton className='ml-auto h-9 w-28 rounded-lg' />
              </div>
            </div>
          }
        >
          <ListEditorContent {...props} nameInputRef={nameInputRef} />
        </Suspense>
      </DialogContent>
    </Dialog>
  );
}
interface CreateListDialogProps {
  onCreated?: (list: UserList) => Promise<void> | void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

export function CreateListDialog({
  open,
  onOpenChange,
  onCreated,
  returnFocusRef,
}: CreateListDialogProps) {
  const queryClient = useQueryClient();
  const mountedRef = useMountedRef();

  const createList = useMutation({
    mutationFn: ({ icon, name, rules }: ListEditorValues) => api.createList(name, icon, rules),
    onSuccess: (newList) => {
      notifyAction('List created', { detail: newList.name });
      // Refresh after any follow-up write (e.g. adding the item) settles, so lists don't refetch empty first.
      void Promise.resolve(onCreated?.(newList)).finally(() => invalidateListQueries(queryClient));
      if (mountedRef.current) onOpenChange(false);
    },
    onError: (error) => {
      notifyAction(getListErrorMessage(error) ?? 'Failed to create list', { tone: 'error' });
      void invalidateListQueries(queryClient);
    },
  });

  return (
    <ListEditorDialog
      initialName=''
      allowSmart={!onCreated}
      isPending={createList.isPending}
      onOpenChange={onOpenChange}
      onSubmit={(values) => createList.mutate(values)}
      open={open}
      returnFocusRef={returnFocusRef}
      submitLabel='Create List'
      submitReady={({ trimmedName }) => Boolean(trimmedName)}
      title='Create New List'
    />
  );
}

interface RenameListDialogProps {
  list: UserList;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

export function RenameListDialog({ list, open, onOpenChange }: RenameListDialogProps) {
  const queryClient = useQueryClient();
  const mountedRef = useMountedRef();

  const renameList = useMutation({
    mutationFn: ({ icon, name, rules }: ListEditorValues) =>
      api.renameList(list.id, name, icon, rules),
    onSuccess: (_result, variables) => {
      notifyAction('List updated', { detail: variables.name });
      if (mountedRef.current) onOpenChange(false);
    },
    onError: (error) =>
      notifyAction(getListErrorMessage(error) ?? 'Failed to rename list', { tone: 'error' }),
    onSettled: (_data, _error, { rules }) =>
      JSON.stringify(rules) === JSON.stringify(list.rules ?? undefined)
        ? invalidateListMetadataQueries(queryClient)
        : invalidateListQueries(queryClient),
  });

  return (
    <ListEditorDialog
      initialIcon={list.icon || undefined}
      initialName={list.name}
      initialRules={list.rules}
      isPending={renameList.isPending}
      onOpenChange={onOpenChange}
      onSubmit={(values) => renameList.mutate(values)}
      open={open}
      submitLabel='Save Changes'
      submitReady={({ icon, trimmedName, rules }) =>
        Boolean(trimmedName) &&
        (trimmedName !== list.name ||
          icon !== list.icon ||
          JSON.stringify(rules) !== JSON.stringify(list.rules ?? undefined))
      }
      title={list.rules ? 'Edit Smart List' : 'Edit List'}
    />
  );
}
