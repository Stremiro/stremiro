import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2 } from 'lucide-react';
import { type RefObject, useEffect, useEffectEvent, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useMountedRef } from '@/hooks/use-mounted-ref';
import { api, getListErrorMessage, type UserList } from '@/lib/api';
import { notifyAction } from '@/lib/notify';
import { invalidateListQueries } from '@/lib/query-invalidation';
import { cn } from '@/lib/utils';

import { DEFAULT_LIST_ICON, LIST_ICONS, ListIconTile } from './list-icons';

interface ListEditorDialogProps {
  initialIcon: string;
  initialName: string;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: { icon: string; name: string }) => void;
  open: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  submitLabel: string;
  submitReady: (values: { icon: string; trimmedName: string }) => boolean;
  title: string;
}

function ListEditorDialog({
  initialIcon,
  initialName,
  isPending,
  onOpenChange,
  onSubmit,
  open,
  returnFocusRef,
  submitLabel,
  submitReady,
  title,
}: ListEditorDialogProps) {
  const [name, setName] = useState(initialName);
  const [selectedIcon, setSelectedIcon] = useState(initialIcon);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const nameInputId = `${title.replace(/\s+/g, '-').toLowerCase()}-name`;

  const syncInitialState = useEffectEvent((nextInitialIcon: string, nextInitialName: string) => {
    setName(nextInitialName);
    setSelectedIcon(nextInitialIcon);
  });

  useEffect(() => {
    if (!open) {
      return;
    }

    syncInitialState(initialIcon, initialName);
  }, [initialIcon, initialName, open]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();

    if (!canSubmit || isPending) return;

    onSubmit({ icon: selectedIcon, name: trimmedName });
  };

  const trimmedName = name.trim();
  const nameLength = [...name].length;
  const canSubmit = nameLength <= 64 && submitReady({ icon: selectedIcon, trimmedName });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isPending) onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className='sm:max-w-md max-h-[90vh] overflow-y-auto rounded-xl bg-zinc-950 border-white/10 text-zinc-200'
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          nameInputRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef?.current;
          if (target?.isConnected) {
            event.preventDefault();
            target.focus({ preventScroll: true });
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className='text-white font-semibold'>{title}</DialogTitle>
          <DialogDescription className='text-zinc-400'>
            A home for your next obsession, favourites, or movie night.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className='space-y-5'>
          <div className='flex items-center gap-4 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4'>
            <ListIconTile iconId={selectedIcon} size='lg' />
            <div className='min-w-0'>
              <p className='text-[10px] font-medium uppercase tracking-widest text-zinc-500'>
                Your collection
              </p>
              <p
                dir='auto'
                className={cn(
                  'mt-1 truncate text-lg font-semibold tracking-tight',
                  trimmedName ? 'text-white' : 'text-zinc-500',
                )}
              >
                {trimmedName || 'Give it a name'}
              </p>
            </div>
          </div>

          <div className='space-y-2'>
            <div className='flex items-center justify-between'>
              <label htmlFor={nameInputId} className='text-xs font-medium text-zinc-300'>
                List name
              </label>
              <span id={`${nameInputId}-count`} className='text-[11px] tabular-nums text-zinc-500'>
                {nameLength}/64
              </span>
            </div>
            <Input
              ref={nameInputRef}
              id={nameInputId}
              aria-describedby={`${nameInputId}-count`}
              value={name}
              onChange={(event) => setName([...event.target.value].slice(0, 64).join(''))}
              placeholder='Weekend cinema'
              className='h-10 rounded-lg bg-white/[0.03] border-white/10 focus-visible:ring-white/20 text-white placeholder:text-zinc-600'
              disabled={isPending}
            />
          </div>

          <div className='space-y-2'>
            <div className='text-xs font-medium text-zinc-300'>Choose an icon</div>
            <div role='group' aria-label='List icon' className='grid grid-cols-6 gap-1.5'>
              {LIST_ICONS.map(({ id, label }) => (
                <button
                  key={id}
                  type='button'
                  title={label}
                  aria-label={label}
                  aria-pressed={selectedIcon === id}
                  onClick={() => setSelectedIcon(id)}
                  disabled={isPending}
                  className={cn(
                    'relative flex items-center justify-center rounded-xl p-2 transition-colors duration-150 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-50',
                    selectedIcon === id
                      ? 'bg-white/[0.05] ring-2 ring-[var(--accent-nav)]'
                      : 'hover:bg-white/[0.04]',
                  )}
                >
                  <ListIconTile iconId={id} />
                  {selectedIcon === id && (
                    <span className='absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--accent-nav)] text-[var(--on-accent-nav)]'>
                      <Check className='h-2.5 w-2.5' strokeWidth={3} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          <DialogFooter className='gap-2 mt-4'>
            <Button
              type='button'
              variant='ghost'
              disabled={isPending}
              onClick={() => onOpenChange(false)}
              className='text-zinc-400 hover:text-white hover:bg-white/5'
            >
              Cancel
            </Button>
            <Button
              type='submit'
              disabled={!canSubmit || isPending}
              className='bg-white text-black hover:bg-zinc-200 font-semibold'
            >
              {isPending && <Loader2 className='w-4 h-4 animate-spin' />}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
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
    mutationFn: ({ icon, name }: { icon: string; name: string }) => api.createList(name, icon),
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
      initialIcon={DEFAULT_LIST_ICON}
      initialName=''
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
    mutationFn: ({ icon, name }: { icon: string; name: string }) =>
      api.renameList(list.id, name, icon),
    onSuccess: (_result, variables) => {
      notifyAction('List renamed', { detail: variables.name });
      if (mountedRef.current) onOpenChange(false);
    },
    onError: (error) =>
      notifyAction(getListErrorMessage(error) ?? 'Failed to rename list', { tone: 'error' }),
    onSettled: () => invalidateListQueries(queryClient),
  });

  return (
    <ListEditorDialog
      initialIcon={list.icon || DEFAULT_LIST_ICON}
      initialName={list.name}
      isPending={renameList.isPending}
      onOpenChange={onOpenChange}
      onSubmit={(values) => renameList.mutate(values)}
      open={open}
      submitLabel='Save Changes'
      submitReady={({ icon, trimmedName }) =>
        Boolean(trimmedName) && (trimmedName !== list.name || icon !== list.icon)
      }
      title='Edit List'
    />
  );
}
