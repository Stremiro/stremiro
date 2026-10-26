import { Check, CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn, hideBrokenImage } from '@/lib/utils';

export interface ActionToastOptions {
  /** Secondary context rendered muted under the label (e.g. the title). */
  detail?: ReactNode;
  icon?: ReactNode;
  /** Poster for the acted-on title — usually still browser-warm, so it paints instantly. */
  thumb?: string;
  tone?: 'default' | 'error';
}

export function ActionToast({
  label,
  detail,
  icon,
  thumb,
  tone = 'default',
}: ActionToastOptions & { label: ReactNode }) {
  const isError = tone === 'error';
  const feedbackIcon = isError ? (
    <CircleAlert aria-hidden='true' className='size-4 text-red-300' />
  ) : (
    (icon ?? <Check aria-hidden='true' className='size-4 text-emerald-300' />)
  );
  return (
    <div className='flex w-full items-center gap-2.5 rounded-[10px] border border-white/[0.1] bg-[#17171b]/98 p-2.5 shadow-[0_8px_24px_-10px_rgb(0_0_0/0.65),0_1px_2px_rgb(0_0_0/0.35),inset_0_1px_0_rgb(255_255_255/0.04)]'>
      {thumb ? (
        <img
          key={thumb}
          src={thumb}
          alt=''
          draggable={false}
          referrerPolicy='no-referrer'
          onError={hideBrokenImage}
          className='h-10 w-7 shrink-0 rounded-[4px] object-cover ring-1 ring-white/10'
        />
      ) : (
        <span
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-md',
            isError ? 'bg-red-400/[0.1]' : 'bg-white/[0.05]',
          )}
        >
          {feedbackIcon}
        </span>
      )}
      <div className='min-w-0 flex-1'>
        <span className='flex items-center gap-2 text-[13px] font-medium leading-5 tracking-[-0.005em] text-white/95'>
          {thumb && <span className='shrink-0'>{feedbackIcon}</span>}
          <span className='truncate'>{label}</span>
        </span>
        {detail ? (
          <span
            className={cn(
              'mt-0.5 block text-[12px] leading-4 text-zinc-400',
              'break-words',
              isError ? 'line-clamp-3' : 'line-clamp-2',
            )}
          >
            {detail}
          </span>
        ) : null}
      </div>
    </div>
  );
}
