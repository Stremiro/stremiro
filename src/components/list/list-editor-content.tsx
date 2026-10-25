import { useQuery } from '@tanstack/react-query';
import { Check, Loader2, Sparkles } from 'lucide-react';
import { type RefObject, useEffect, useEffectEvent, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { RetryBanner } from '@/components/retry-banner';
import { api, type SmartListRules, WATCH_STATUSES, WATCH_STATUS_LABELS } from '@/lib/api';
import { LIBRARY_GENRES_QUERY_KEY } from '@/lib/query-invalidation';
import { cn } from '@/lib/utils';
import { DEFAULT_LIST_ICON, LIST_ICONS, ListIconTile } from './list-icons';
const EMPTY_RULES: SmartListRules = { genres: [], statuses: [] };

function chipClass(selected: boolean) {
  return cn(
    'rounded-md border px-2 py-1 text-[11px] transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-50',
    selected
      ? 'border-(--accent-nav) bg-white/5 text-white'
      : 'border-white/10 text-zinc-400 hover:bg-white/5',
  );
}

export interface ListEditorValues {
  icon: string;
  name: string;
  rules?: SmartListRules;
}

function SmartRulesEditor({
  rules,
  onChange,
  disabled,
  open,
  id,
}: {
  rules: SmartListRules;
  onChange: (rules: SmartListRules) => void;
  disabled: boolean;
  open: boolean;
  id: string;
}) {
  const libraryGenres = useQuery({
    queryKey: LIBRARY_GENRES_QUERY_KEY,
    queryFn: api.getLibraryGenres,
    enabled: open,
    staleTime: 1000 * 60 * 5,
  });
  const options = libraryGenres.data ?? [];
  const genres = [
    ...options,
    ...rules.genres.filter(
      (genre) => !options.some((option) => option.toLowerCase() === genre.toLowerCase()),
    ),
  ];
  return (
    <fieldset
      disabled={disabled}
      className='space-y-3 rounded-lg border border-white/10 bg-white/[0.02] p-3'
    >
      <legend className='px-1 text-xs font-medium text-zinc-300'>Smart rules</legend>
      <p className='text-[11px] leading-relaxed text-zinc-500'>
        Updates automatically from your Library. All rule groups must match; any selected genre or
        status can match.
      </p>
      <div className='space-y-1.5'>
        <span id={`${id}-type`} className='block text-xs text-zinc-300'>
          Type
        </span>
        <div
          role='group'
          aria-labelledby={`${id}-type`}
          className='flex rounded-lg border border-white/[0.08] bg-black/25 p-0.5'
        >
          {(
            [
              ['', 'Any type'],
              ['movie', 'Movies'],
              ['series', 'Series'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value || 'any'}
              type='button'
              aria-pressed={(rules.media_type ?? '') === value}
              onClick={() => onChange({ ...rules, media_type: value || null })}
              className={cn(
                'h-7 flex-1 rounded-md text-[11.5px] font-medium transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/35',
                (rules.media_type ?? '') === value
                  ? 'bg-white/[0.1] text-white'
                  : 'text-zinc-400 hover:text-zinc-200',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <fieldset className='space-y-1.5'>
        <legend className='mb-1.5 text-xs text-zinc-300'>
          Genres <span className='text-zinc-500'>(any selected)</span>
        </legend>
        {libraryGenres.isError && (
          <RetryBanner
            message="Couldn't load Library genres."
            isRetrying={libraryGenres.isFetching}
            onRetry={() => void libraryGenres.refetch()}
          />
        )}
        <div className='flex max-h-28 flex-wrap gap-1.5 overflow-y-auto'>
          {genres.map((genre) => {
            const selected = rules.genres.some(
              (value) => value.toLowerCase() === genre.toLowerCase(),
            );
            return (
              <button
                key={genre.toLowerCase()}
                type='button'
                aria-pressed={selected}
                disabled={!selected && rules.genres.length >= 12}
                className={chipClass(selected)}
                onClick={() =>
                  onChange({
                    ...rules,
                    genres: selected
                      ? rules.genres.filter((value) => value.toLowerCase() !== genre.toLowerCase())
                      : [...rules.genres, genre],
                  })
                }
              >
                {genre}
              </button>
            );
          })}
        </div>
        {!libraryGenres.isError && genres.length === 0 && (
          <p className='text-[11px] text-zinc-500'>
            {libraryGenres.isPending
              ? 'Loading genres…'
              : 'Genres appear as you save titles to your Library.'}
          </p>
        )}
      </fieldset>
      <fieldset>
        <legend className='mb-1.5 text-xs text-zinc-300'>
          Status <span className='text-zinc-500'>(any selected)</span>
        </legend>
        <div className='flex flex-wrap gap-1.5'>
          {WATCH_STATUSES.map((status) => (
            <button
              key={status}
              type='button'
              aria-pressed={rules.statuses.includes(status)}
              className={chipClass(rules.statuses.includes(status))}
              onClick={() =>
                onChange({
                  ...rules,
                  statuses: rules.statuses.includes(status)
                    ? rules.statuses.filter((value) => value !== status)
                    : [...rules.statuses, status],
                })
              }
            >
              {WATCH_STATUS_LABELS[status]}
            </button>
          ))}
        </div>
      </fieldset>
      <div className='grid grid-cols-2 gap-3'>
        {(['year_from', 'year_to'] as const).map((field) => (
          <div key={field} className='space-y-1.5'>
            <label htmlFor={`${id}-${field}`} className='text-xs text-zinc-300'>
              {field === 'year_from' ? 'Year from' : 'Year to'}
            </label>
            <Input
              id={`${id}-${field}`}
              type='number'
              min={1889}
              max={2100}
              step={1}
              placeholder='Any year'
              value={rules[field] ?? ''}
              onChange={(event) =>
                onChange({
                  ...rules,
                  [field]: event.target.value === '' ? null : event.target.valueAsNumber,
                })
              }
              className='h-9 border-white/10 bg-zinc-950 text-xs'
            />
          </div>
        ))}
      </div>
    </fieldset>
  );
}

export interface ListEditorDialogProps {
  initialIcon?: string;
  initialName: string;
  initialRules?: SmartListRules | null;
  allowSmart?: boolean;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: ListEditorValues) => void;
  open: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  submitLabel: string;
  submitReady: (values: { icon: string; trimmedName: string; rules?: SmartListRules }) => boolean;
  title: string;
}

export function ListEditorContent({
  initialIcon = DEFAULT_LIST_ICON,
  initialName,
  initialRules,
  allowSmart = false,
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
  const [isSmart, setIsSmart] = useState(Boolean(initialRules));
  const [rules, setRules] = useState(initialRules ?? EMPTY_RULES);
  const nameInputId = useId();
  const resetDraft = useEffectEvent(() => {
    setName(initialName);
    setSelectedIcon(initialIcon);
    setIsSmart(Boolean(initialRules));
    setRules(initialRules ?? EMPTY_RULES);
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

    onSubmit({ icon: selectedIcon, name: trimmedName, rules: isSmart ? rules : undefined });
  };

  const trimmedName = name.trim();
  const nameLength = [...name].length;
  const canSubmit =
    nameLength <= 64 &&
    submitReady({ icon: selectedIcon, trimmedName, rules: isSmart ? rules : undefined });

  return (
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

      {allowSmart && (
        <button
          type='button'
          aria-pressed={isSmart}
          disabled={isPending}
          onClick={() => setIsSmart(!isSmart)}
          className={cn(
            'flex w-full items-center gap-2 rounded-lg border px-3 py-2.5 text-left text-xs focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/30',
            isSmart
              ? 'border-(--accent-nav) bg-white/5 text-white'
              : 'border-white/10 text-zinc-400',
          )}
        >
          <Sparkles className='size-4' />
          <span className='flex-1'>
            Smart list{' '}
            <span className='block mt-0.5 text-[11px] text-zinc-500'>
              Automatically collect Library titles using rules
            </span>
          </span>
          {isSmart && <Check className='size-4' />}
        </button>
      )}
      {isSmart && (
        <SmartRulesEditor
          rules={rules}
          onChange={setRules}
          disabled={isPending}
          open={open}
          id={nameInputId}
        />
      )}

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
          disabled={!canSubmit}
          aria-disabled={isPending || undefined}
          aria-busy={isPending || undefined}
          className='bg-white text-black hover:bg-zinc-200 font-semibold aria-disabled:cursor-default'
        >
          {isPending && (
            <Loader2
              aria-hidden='true'
              className='h-4 w-4 animate-spin motion-reduce:animate-none'
            />
          )}
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
