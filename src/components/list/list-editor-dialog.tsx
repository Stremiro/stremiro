import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useEffect, useEffectEvent, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api, type UserList } from '@/lib/api';
import { invalidateListQueries } from '@/lib/query-invalidation';
import { cn } from '@/lib/utils';

import { DEFAULT_LIST_ICON, LIST_ICONS, ListIcon } from './list-icons';

interface ListEditorDialogProps {
  initialIcon: string;
  initialName: string;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: { icon: string; name: string }) => void;
  open: boolean;
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
  submitLabel,
  submitReady,
  title,
}: ListEditorDialogProps) {
  const [name, setName] = useState(initialName);
  const [selectedIcon, setSelectedIcon] = useState(initialIcon);
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

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setName(initialName);
      setSelectedIcon(initialIcon);
    }

    onOpenChange(nextOpen);
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();

    const trimmedName = name.trim();
    if (!submitReady({ icon: selectedIcon, trimmedName })) {
      return;
    }

    onSubmit({ icon: selectedIcon, name: trimmedName });
  };

  const trimmedName = name.trim();
  const canSubmit = submitReady({ icon: selectedIcon, trimmedName });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className='sm:max-w-sm bg-zinc-950 border-zinc-800 text-zinc-200'>
        <DialogHeader>
          <DialogTitle className='text-white font-bold'>{title}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className='space-y-5 mt-2'>
          <div className='space-y-2'>
            <div className='text-[11px] font-bold text-zinc-500 uppercase tracking-widest'>
              Icon
            </div>
            <div role='group' aria-label='Icon' className='grid grid-cols-8 gap-2'>
              {LIST_ICONS.map(({ id, label }) => (
                <button
                  key={id}
                  type='button'
                  title={label}
                  aria-label={label}
                  aria-pressed={selectedIcon === id}
                  onClick={() => setSelectedIcon(id)}
                  className={cn(
                    'h-9 w-9 rounded-lg flex items-center justify-center transition-all duration-150',
                    selectedIcon === id
                      ? 'bg-white/15 ring-1 ring-white/40 scale-110 text-white'
                      : 'bg-zinc-900 hover:bg-zinc-800 hover:scale-105 text-zinc-500 hover:text-zinc-300',
                  )}
                >
                  <ListIcon iconId={id} size={16} />
                </button>
              ))}
            </div>
          </div>

          <div className='space-y-2'>
            <label
              htmlFor={nameInputId}
              className='text-[11px] font-bold text-zinc-500 uppercase tracking-widest'
            >
              List Name
            </label>
            <div className='flex items-center gap-2'>
              <div className='h-9 w-9 rounded-lg bg-zinc-900 border border-white/10 flex items-center justify-center text-white shrink-0'>
                <ListIcon iconId={selectedIcon} size={16} />
              </div>
              {/* eslint-disable jsx-a11y/no-autofocus -- moving focus into
                  the dialog's primary field is the intended focus target. */}
              <Input
                id={nameInputId}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder='My Favourites'
                className='bg-zinc-900 border-white/10 focus-visible:ring-white/20 text-white placeholder:text-zinc-600'
                maxLength={40}
                autoFocus
              />
              {/* eslint-enable jsx-a11y/no-autofocus */}
            </div>
          </div>

          <DialogFooter className='gap-2 mt-4'>
            <Button
              type='button'
              variant='ghost'
              onClick={() => handleOpenChange(false)}
              className='text-zinc-400 hover:text-white hover:bg-white/5'
            >
              Cancel
            </Button>
            <Button
              type='submit'
              disabled={!canSubmit || isPending}
              className='bg-white text-black hover:bg-zinc-200 font-semibold'
            >
              {isPending ? <Loader2 className='w-4 h-4 animate-spin' /> : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface CreateListDialogProps {
  onCreated?: (list: UserList) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

export function CreateListDialog({ open, onOpenChange, onCreated }: CreateListDialogProps) {
  const queryClient = useQueryClient();

  const createList = useMutation({
    mutationFn: ({ icon, name }: { icon: string; name: string }) => api.createList(name, icon),
    onSuccess: (newList) => {
      void invalidateListQueries(queryClient);
      toast.success(`"${newList.name}" created`);
      onCreated?.(newList);
      onOpenChange(false);
    },
    onError: () => toast.error('Failed to create list'),
  });

  return (
    <ListEditorDialog
      initialIcon={DEFAULT_LIST_ICON}
      initialName=''
      isPending={createList.isPending}
      onOpenChange={onOpenChange}
      onSubmit={(values) => createList.mutate(values)}
      open={open}
      submitLabel='Create List'
      submitReady={({ trimmedName }) => Boolean(trimmedName)}
      title='Create New List'
    />
  );
}

interface RenameListDialogProps {
  list: UserList;
  onOpenChange: (open: boolean) => void;
  onRenamed?: () => void;
  open: boolean;
}

export function RenameListDialog({ list, open, onOpenChange, onRenamed }: RenameListDialogProps) {
  const queryClient = useQueryClient();

  const renameList = useMutation({
    mutationFn: ({ icon, name }: { icon: string; name: string }) =>
      api.renameList(list.id, name, icon),
    onSuccess: (_result, variables) => {
      void invalidateListQueries(queryClient);
      toast.success(`List renamed to "${variables.name}"`);
      onRenamed?.();
      onOpenChange(false);
    },
    onError: () => toast.error('Failed to rename list'),
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
