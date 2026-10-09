import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface RetryBannerProps {
  className?: string;
  /** Optional bold headline above the message. */
  title?: string;
  isRetrying?: boolean;
  message: string;
  onRetry: () => void;
}

export function RetryBanner({
  className,
  title,
  isRetrying = false,
  message,
  onRetry,
}: RetryBannerProps) {
  return (
    <div
      role='alert'
      className={cn(
        'flex items-center justify-between gap-3 rounded-xl border border-white/[0.05] bg-zinc-950/60 px-4 py-3 backdrop-blur-sm',
        className,
      )}
    >
      {title ? (
        <div className='min-w-0'>
          <p className='text-[13px] font-medium text-white'>{title}</p>
          <p className='text-[12px] text-zinc-400 mt-0.5'>{message}</p>
        </div>
      ) : (
        <p className='min-w-0 text-[12.5px] text-zinc-400'>{message}</p>
      )}
      <Button
        variant='ghost'
        size='sm'
        onClick={() => {
          if (!isRetrying) onRetry();
        }}
        aria-disabled={isRetrying || undefined}
        aria-busy={isRetrying}
        className='h-8 shrink-0 gap-1.5 text-[12px] text-zinc-300 hover:bg-white/[0.06] hover:text-white aria-disabled:cursor-wait aria-disabled:opacity-50'
      >
        <RotateCcw
          className={cn('h-3.5 w-3.5', isRetrying && 'animate-spin motion-reduce:animate-none')}
        />
        Retry
      </Button>
    </div>
  );
}
