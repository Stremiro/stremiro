import { Loader2, Search, X } from 'lucide-react';
import { type RefObject, useRef } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface SearchInputProps {
  value: string;
  onValueChange: (value: string) => void;
  /** Accessible name — falls back to the placeholder text. */
  'aria-label'?: string;
  placeholder?: string;
  clearLabel?: string;
  className?: string;
  wrapperClassName?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  pending?: boolean;
  /** Enter in the field — e.g. jump to the first result. */
  onSubmit?: () => void;
}

export function SearchInput({
  value,
  onValueChange,
  'aria-label': ariaLabel,
  placeholder,
  clearLabel = 'Clear search',
  className,
  wrapperClassName,
  inputRef: suppliedInputRef,
  onSubmit,
  pending = false,
}: SearchInputProps) {
  const localInputRef = useRef<HTMLInputElement>(null);
  const inputRef = suppliedInputRef ?? localInputRef;
  return (
    <div className={cn('relative', wrapperClassName)}>
      {pending ? (
        <Loader2
          aria-hidden='true'
          className='pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-zinc-400 motion-reduce:animate-none'
        />
      ) : (
        <Search
          aria-hidden='true'
          className='absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-600 pointer-events-none'
        />
      )}
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        className={cn('pl-9 pr-8', className)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onSubmit && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (!e.repeat) onSubmit();
            return;
          }
          // Progressive dismissal: Esc clears text, then blurs so page-level Esc (back) becomes the next step.
          if (e.key !== 'Escape' || e.defaultPrevented || e.nativeEvent.isComposing) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.repeat) return;
          if (value) {
            onValueChange('');
          } else {
            e.currentTarget.blur();
          }
        }}
      />
      {value && (
        <button
          type='button'
          onClick={() => {
            onValueChange('');
            // The button unmounts with the text — keep focus in the field.
            inputRef.current?.focus();
          }}
          aria-label={clearLabel}
          title={clearLabel}
          className='absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-zinc-400 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30'
        >
          <X className='w-3.5 h-3.5' />
        </button>
      )}
    </div>
  );
}
