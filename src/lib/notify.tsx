import { CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { cn, hideBrokenImage } from '@/lib/utils';

export async function copyText(
  text: string,
  successMessage: string,
  failureMessage = 'Could not copy link',
): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(successMessage);
    return true;
  } catch {
    toast.error(failureMessage);
    return false;
  }
}

// Top-center action channel for deliberate "tracked" confirmations (watch status, library, lists);
// ambient notices stay on the bottom-center channel.
//
// Shared id: a rapid add→remove updates the card in place instead of stacking.
const ACTION_TOAST_ID = 'action-toast';

interface ActionToastOptions {
  /** Secondary context rendered muted under the label (e.g. the title). */
  detail?: ReactNode;
  /** Text-color class for a glowing status dot beside the label. */
  dot?: string;
  /** Poster for the acted-on title — usually still browser-warm, so it paints instantly. */
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
        'animate-action-pill mx-auto flex w-fit min-w-[220px] max-w-[min(420px,calc(100vw_-_48px))] items-center gap-3 rounded-xl border p-1.5 pr-4 backdrop-blur-xl backdrop-saturate-150',
        'shadow-[0_18px_44px_-14px_rgba(0,0,0,0.85),0_2px_6px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.05)]',
        isError ? 'border-red-400/[0.16] bg-[#190f11]/92' : 'border-white/[0.08] bg-[#111114]/92',
      )}
    >
      {thumb ? (
        <img
          key={thumb}
          src={thumb}
          alt=''
          draggable={false}
          referrerPolicy='no-referrer'
          onError={hideBrokenImage}
          className='h-11 w-[30px] shrink-0 rounded-[4px] object-cover ring-1 ring-white/10'
        />
      ) : isError ? (
        <span className='flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-red-500/[0.12] ring-1 ring-red-400/15'>
          <CircleAlert aria-hidden='true' className='h-4 w-4 text-red-300' strokeWidth={2.25} />
        </span>
      ) : null}
      <div className={cn('min-w-0 py-1', !thumb && !isError && 'pl-2.5')}>
        <span
          className={cn(
            'flex items-center gap-2 text-[13.5px] font-semibold leading-5 tracking-[-0.01em]',
            isError ? 'text-red-100' : 'text-white',
          )}
        >
          {dot && (
            <span
              aria-hidden='true'
              className={cn(
                'h-1.5 w-1.5 shrink-0 rounded-full bg-current shadow-[0_0_6px_currentColor]',
                dot,
              )}
            />
          )}
          <span className='truncate'>{label}</span>
        </span>
        {detail ? (
          <span className='mt-0.5 block truncate text-[12px] leading-4 text-white/55'>
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
    // Failures carry a reason worth reading; confirmations should clear quickly.
    duration: options?.tone === 'error' ? 4500 : 2600,
    // `unstyled` drops chrome the li would paint as bars; left/right 0 gives the card the full column to center in.
    unstyled: true,
    style: { left: 0, right: 0 },
  });
}
