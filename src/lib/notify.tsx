import { ClipboardCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { ActionToast, type ActionToastOptions } from '@/components/action-toast';

interface CopyTextFeedback {
  /** Omit when the trigger shows its own copied state. */
  success?: string;
  successDetail?: string;
  failure?: string;
}

export async function copyText(
  text: string,
  { success, successDetail, failure = 'Could not copy link' }: CopyTextFeedback = {},
): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    if (success) {
      notifyAction(success, {
        detail: successDetail,
        icon: <ClipboardCheck aria-hidden='true' className='size-4 text-emerald-300' />,
      });
    }
    return true;
  } catch {
    notifyAction(failure, { tone: 'error' });
    return false;
  }
}

export function notifyAction(label: ReactNode, options?: ActionToastOptions) {
  return toast.custom(() => <ActionToast label={label} {...options} />, {
    // Failures carry a reason worth reading; confirmations should clear quickly.
    duration: options?.tone === 'error' ? 4500 : 2600,
    // Sonner owns entrance, exit, stacking and reduced motion; the card only paints chrome.
    unstyled: true,
    style: { left: 0, right: 0 },
  });
}
