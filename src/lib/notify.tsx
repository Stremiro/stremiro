import { CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { cn, hideBrokenImage } from '@/lib/utils';

// Top-center action channel: a compact card that slides down under the
// titlebar for deliberate "tracked" confirmations — watch status, library,
// and list membership. Ambient notices (player, progress, background ops)
// stay on the bottom-center channel so this one stays meaningful.
//
// One shared id: a rapid add→remove updates the card in place instead of
// stacking a second toast over the first.
const ACTION_TOAST_ID = 'action-toast';

interface ActionToastOptions {
  /** Secondary context rendered muted under the label (e.g. the title). */
  detail?: ReactNode;
  /** Text-color class for a glowing status dot beside the label. */
  dot?: string;
  /** Poster/thumbnail for the acted-on title — usually still browser-warm
      from the surface the action fired on, so it paints instantly. */
  thumb?: string;
  tone?: 'default' | 'error';
}

function ActionToast({
  label,
  detail,
  dot,
  thumb,
  tone = 'default',
}: ActionToastOptions & { label: ReactNode }) {
  const isError = tone === 'error';
  return (
    <div
      className={cn(
        'animate-action-pill mx-auto flex w-fit min-w-[240px] max-w-[min(440px,calc(100vw_-_48px))] items-center gap-3.5 rounded-[14px] border p-2 pr-5 backdrop-blur-xl backdrop-saturate-150',
        'shadow-[0_20px_50px_-12px_rgba(0,0,0,0.8),0_2px_8px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.06)]',
        isError ? 'border-red-400/[0.14] bg-[#1a0e10]/90' : 'border-white/[0.08] bg-[#111115]/90',
      )}
    >
      {thumb ? (
        <img
          src={thumb}
          alt=''
          draggable={false}
          referrerPolicy='no-referrer'
          onError={hideBrokenImage}
          className='h-12 w-8 shrink-0 rounded-[7px] object-cover shadow-[0_4px_12px_rgba(0,0,0,0.5)] ring-1 ring-white/10'
        />
      ) : isError ? (
        <span className='flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-red-500/[0.12] ring-1 ring-red-400/15'>
          <CircleAlert className='h-[18px] w-[18px] text-red-300' strokeWidth={2.25} />
        </span>
      ) : null}
      <div className={cn('min-w-0 py-0.5', !thumb && !isError && 'pl-2')}>
        <span
          className={cn(
            'flex items-center gap-2 text-[14px] font-semibold leading-5 tracking-[-0.01em]',
            isError ? 'text-red-100' : 'text-white',
          )}
        >
          {dot && (
            <span
              aria-hidden='true'
              className={cn(
                'h-2 w-2 shrink-0 rounded-full bg-current shadow-[0_0_10px_1px_currentColor]',
                dot,
              )}
            />
          )}
          <span className='truncate'>{label}</span>
        </span>
        {detail ? (
          <span className='mt-0.5 block truncate text-[12.5px] leading-4 text-white/50'>
            {detail}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function notifyAction(label: ReactNode, options?: ActionToastOptions) {
  return toast.custom(() => <ActionToast label={label} {...options} />, {
    id: ACTION_TOAST_ID,
    position: 'top-center',
    duration: 2600,
    // Custom toasts skip sonner's fixed-width chrome, so the li needs the
    // full column to let the card center inside it — and unstyled drops
    // the default background/border/shadow the li would otherwise paint
    // as bars around the card.
    unstyled: true,
    style: { left: 0, right: 0 },
  });
}
