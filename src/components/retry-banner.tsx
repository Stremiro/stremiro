import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface RetryBannerProps {
  className?: string;
  /** Optional bold headline above the message. */
  title?: string;
  message: string;
  onRetry: () => void;
}

/** Slim failed-read alert: a query error must not collapse into an empty state. */
export function RetryBanner({ className, title, message, onRetry }: RetryBannerProps) {
  return (
    <div
      role='alert'
      className={cn(
        'flex items-center justify-between gap-3 rounded-xl border border-white/[0.05] bg-zinc-950/60 px-4 py-3 backdrop-blur-sm',
        className,
      )}
    >
      {title ? (
        <div>
          <p className='text-[13px] font-medium text-white'>{title}</p>
          <p className='text-[12px] text-zinc-500 mt-0.5'>{message}</p>
        </div>
      ) : (
        <p className='text-[12.5px] text-zinc-500'>{message}</p>
      )}
      <Button
        variant='ghost'
        size='sm'
        onClick={onRetry}
        className='h-8 shrink-0 gap-1.5 text-[12px] text-zinc-300 hover:bg-white/[0.06] hover:text-white'
      >
        <RotateCcw className='h-3.5 w-3.5' />
        Retry
      </Button>
    </div>
  );
}
