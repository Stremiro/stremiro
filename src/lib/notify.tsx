import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { ActionToast, type ActionToastOptions } from '@/components/action-toast';

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
