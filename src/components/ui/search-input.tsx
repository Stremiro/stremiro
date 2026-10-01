import { Search, X } from 'lucide-react';
import { useRef } from 'react';
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
}

export function SearchInput({
  value,
  onValueChange,
  'aria-label': ariaLabel,
  placeholder,
  clearLabel = 'Clear search',
  className,
  wrapperClassName,
}: SearchInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className={cn('relative', wrapperClassName)}>
      <Search className='absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-600 pointer-events-none' />
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        className={cn('pl-9 pr-8', className)}
        onKeyDown={(e) => {
          // Progressive dismissal: Esc clears the text, then blurs the field
          // so page-level Esc (back) becomes the next step.
          if (e.key !== 'Escape') return;
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
          className='absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-zinc-600 transition-colors hover:text-white'
        >
          <X className='w-3.5 h-3.5' />
        </button>
      )}
    </div>
  );
}
