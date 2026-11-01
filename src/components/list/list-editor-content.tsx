import { Loader2 } from 'lucide-react';
import { type RefObject, useEffect, useEffectEvent, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { DEFAULT_LIST_ICON, LIST_ICONS, ListIconTile } from './list-icons';

export interface ListEditorValues {
  icon: string;
  name: string;
}

export interface ListEditorDialogProps {
  initialIcon?: string;
  initialName: string;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: ListEditorValues) => void;
  open: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  submitLabel: string;
  submitReady: (values: { icon: string; trimmedName: string }) => boolean;
  title: string;
}

export function ListEditorContent({
  initialIcon = DEFAULT_LIST_ICON,
  initialName,
  isPending,
  onOpenChange,
  onSubmit,
  open,
  nameInputRef,
  submitLabel,
  submitReady,
}: ListEditorDialogProps & { nameInputRef: RefObject<HTMLInputElement | null> }) {
  const [name, setName] = useState(initialName);
  const [selectedIcon, setSelectedIcon] = useState(initialIcon);
  const nameInputId = useId();
  const resetDraft = useEffectEvent(() => {
    setName(initialName);
    setSelectedIcon(initialIcon);
  });

  useEffect(() => {
    if (!open) return;
    resetDraft();
    const input = nameInputRef.current;
    if (input && document.activeElement === input.closest('[role="dialog"]')) {
      input.focus({ preventScroll: true });
    }
  }, [nameInputRef, open]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();

    if (!canSubmit || isPending) return;

    onSubmit({ icon: selectedIcon, name: trimmedName });
  };

  const trimmedName = name.trim();
  const nameLength = [...name].length;
  const canSubmit = nameLength <= 64 && submitReady({ icon: selectedIcon, trimmedName });

  return (
    <form onSubmit={handleSubmit} className='space-y-5'>
      <div className='flex items-center gap-3'>
        <ListIconTile iconId={selectedIcon} size='lg' />
        <p
          dir='auto'
          className={cn(
            'min-w-0 truncate text-[15px] font-semibold tracking-tight',
            trimmedName ? 'text-white' : 'text-zinc-500',
          )}
        >
          {trimmedName || 'Give it a name'}
        </p>
      </div>

      <div className='space-y-2'>
        <div className='flex h-4 items-center justify-between'>
          <label htmlFor={nameInputId} className='text-[13px] font-medium text-zinc-300'>
            List name
          </label>
          <span id={`${nameInputId}-count`} className='text-[12px] tabular-nums text-zinc-500'>
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
          className='h-10 rounded-lg bg-white/[0.03] border-white/10 text-[13px] text-white placeholder:text-zinc-600 focus-visible:ring-white/20'
          disabled={isPending}
        />
      </div>

      <div className='space-y-2'>
        <div className='h-4 text-[13px] font-medium leading-4 text-zinc-300'>Icon</div>
        <div role='group' aria-label='List icon' className='grid grid-cols-6 gap-1.5'>
          {LIST_ICONS.map(({ id, label }) => (
            <button
              key={id}
              type='button'
              aria-label={label}
              aria-pressed={selectedIcon === id}
              onClick={() => setSelectedIcon(id)}
              disabled={isPending}
              className={cn(
                'flex aspect-square items-center justify-center rounded-lg transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-50',
                selectedIcon === id
                  ? 'bg-white/[0.08] ring-1 ring-inset ring-white/25'
                  : 'hover:bg-white/[0.04]',
              )}
            >
              <ListIconTile iconId={id} />
            </button>
          ))}
        </div>
      </div>

      <DialogFooter className='mt-2 gap-2'>
        <Button
          type='button'
          variant='ghost'
          disabled={isPending}
          onClick={() => onOpenChange(false)}
          className='h-9 text-[13px] text-zinc-400 hover:bg-white/5 hover:text-white'
        >
          Cancel
        </Button>
        <Button
          type='submit'
          disabled={!canSubmit}
          aria-disabled={isPending || undefined}
          aria-busy={isPending || undefined}
          className='relative h-9 min-w-[8.25rem] bg-white text-[13px] font-semibold text-black hover:bg-zinc-200 aria-disabled:cursor-default'
        >
          {isPending && (
            <Loader2
              aria-hidden='true'
              className='absolute size-4 animate-spin motion-reduce:animate-none'
            />
          )}
          <span className={cn(isPending && 'opacity-0')}>{submitLabel}</span>
        </Button>
      </DialogFooter>
    </form>
  );
}
