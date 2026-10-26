import { ClipboardCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { ActionToast, type ActionToastOptions } from '@/components/action-toast';

export async function copyText(
  text: string,
  successMessage: string,
  failureMessage = 'Could not copy link',
  successDetail?: string,
): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    notifyAction(successMessage, {
      detail: successDetail,
      icon: <ClipboardCheck aria-hidden='true' className='size-4 text-emerald-300' />,
    });
    return true;
  } catch {
    notifyAction(failureMessage, { tone: 'error' });
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
