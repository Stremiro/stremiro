import { ArrowUpRight, CircleAlert, Download, Loader2, RefreshCw, Sparkles, X } from 'lucide-react';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { useAppUpdater } from '@/hooks/use-app-updater';
import {
  type AppUpdateProgress,
  appUpdateProgressPercent,
  formatAppUpdateProgress,
} from '@/lib/app-updater';
import { cn } from '@/lib/utils';

// One shared id: the announce card and every later state (progress, error)
// update in place instead of stacking a second toast.
export const APP_UPDATE_TOAST_ID = 'app-update-toast';

export function dismissAppUpdateToast() {
  toast.dismiss(APP_UPDATE_TOAST_ID);
}

// Glass zinc surface matching the resolve toast's treatment; the single
// border/shadow keeps the chrome quiet — color only marks status accents.
const CARD_CHROME =
  'relative box-border w-[min(344px,calc(100vw_-_32px))] overflow-hidden rounded-xl border border-white/[0.08] bg-zinc-950/85 p-3.5 shadow-2xl backdrop-blur-xl';

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type='button'
      onClick={onClose}
      aria-label='Dismiss update notification'
      className='absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25'
    >
      <X className='h-3.5 w-3.5' />
    </button>
  );
}

function UpdateProgress({
  version,
  installProgress,
}: {
  version: string;
  installProgress: AppUpdateProgress | null;
}) {
  const percent = appUpdateProgressPercent(installProgress);

  return (
    <div className={CARD_CHROME} role='status' aria-live='polite'>
      <span
        aria-hidden='true'
        className='absolute inset-x-5 top-0 h-px bg-linear-to-r from-transparent via-emerald-300/50 to-transparent'
      />
      <div className='flex items-center gap-3'>
        <Download className='h-4.5 w-4.5 shrink-0 text-emerald-300/90' strokeWidth={2} />
        <div className='min-w-0 flex-1'>
          <p className='break-words text-[13.5px] font-semibold leading-snug tracking-tight text-zinc-100'>
            Updating to v{version}
          </p>
          <p className='mt-0.5 text-[12px] tabular-nums text-zinc-500'>
            {formatAppUpdateProgress(installProgress)}
          </p>
        </div>
        {percent !== null ? (
          <span className='shrink-0 text-[12.5px] font-semibold tabular-nums text-emerald-300/90'>
            {percent}%
          </span>
        ) : null}
      </div>
      <div
        className='mt-3 h-1 w-full overflow-hidden rounded-full bg-white/[0.07]'
        role='progressbar'
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-label='Update download progress'
      >
        <div
          className={cn(
            'h-full rounded-full bg-emerald-300/90 transition-[width] duration-300',
            percent === null && 'w-1/3 animate-pulse',
          )}
          style={percent !== null ? { width: `${percent}%` } : undefined}
        />
      </div>
    </div>
  );
}

function UpdateError({ message, onCheckAgain }: { message: string; onCheckAgain: () => void }) {
  return (
    <div className={CARD_CHROME} role='alert'>
      <CloseButton onClose={dismissAppUpdateToast} />
      <div className='flex items-start gap-3 pr-8'>
        <span className='flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-red-400/20 bg-red-500/[0.08]'>
          <CircleAlert className='h-4 w-4 text-red-300/90' strokeWidth={2.25} />
        </span>
        <div className='min-w-0 flex-1'>
          <p className='text-[13.5px] font-semibold tracking-tight text-zinc-100'>Update failed</p>
          <p
            title={message}
            className='mt-1 line-clamp-3 break-words text-[12.5px] leading-relaxed text-zinc-400'
          >
            {message}
          </p>
          <button
            type='button'
            onClick={onCheckAgain}
            className='mt-2.5 inline-flex h-9 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-[12.5px] font-medium text-zinc-100 transition-colors hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25'
          >
            <RefreshCw className='h-3.5 w-3.5' />
            Check again
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Persistent update card. Reads live state from `useAppUpdater`, so it
 * morphs announce → download progress → error in place; the process exits
 * on a successful install so no completion state exists. The only
 * useAppUpdater observer on the card — child states receive props.
 */
export function AppUpdateCard({ onViewNotes }: { onViewNotes: () => void }) {
  const {
    checkForUpdates,
    currentVersion,
    installUpdate,
    isInstalling,
    pendingUpdate,
    updateState,
  } = useAppUpdater();

  // Self-close once nothing is actionable — e.g. a failed install whose
  // recovery check found the release already applied or withdrawn.
  useEffect(() => {
    if (!isInstalling && !pendingUpdate && updateState.status === 'up-to-date') {
      dismissAppUpdateToast();
    }
  }, [isInstalling, pendingUpdate, updateState.status]);

  if (isInstalling && pendingUpdate) {
    return (
      <UpdateProgress
        version={pendingUpdate.version}
        installProgress={updateState.installProgress}
      />
    );
  }
  if (!pendingUpdate) {
    if (updateState.status === 'error' && updateState.errorMessage) {
      return (
        <UpdateError
          message={updateState.errorMessage}
          onCheckAgain={() => void checkForUpdates().catch(() => undefined)}
        />
      );
    }
    if (updateState.status === 'checking') {
      return (
        <div className={cn(CARD_CHROME, 'flex items-center gap-3')}>
          <Loader2 className='h-4 w-4 animate-spin text-zinc-400' />
          <p className='text-[13px] text-zinc-400'>Checking for updates…</p>
        </div>
      );
    }
    return null;
  }

  return (
    <div className={CARD_CHROME}>
      {/* The one status accent: a hairline + icon badge carry "update"
          without tinting the surface. Release notes stay in Settings —
          the toast announces and hands off, nothing more. */}
      <span
        aria-hidden='true'
        className='absolute inset-x-5 top-0 h-px bg-linear-to-r from-transparent via-emerald-300/60 to-transparent'
      />
      <CloseButton onClose={dismissAppUpdateToast} />

      <div className='flex items-start gap-3'>
        <span className='flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-300/[0.1]'>
          <Sparkles className='h-4 w-4 text-emerald-300' strokeWidth={2.25} />
        </span>
        <div className='min-w-0 flex-1 pr-6 pt-px'>
          <p className='text-[13.5px] font-semibold leading-snug tracking-tight text-zinc-100'>
            Update available
          </p>
          <p className='mt-0.5 text-[12px] leading-snug text-zinc-500'>
            Stremiro{' '}
            <span className='font-medium tabular-nums text-zinc-300'>v{pendingUpdate.version}</span>
            {currentVersion ? ` · currently v${currentVersion}` : ''}
          </p>
        </div>
      </div>

      {/* A failed install that re-armed via the recovery check keeps the
          update available — surface that the last attempt didn't land. */}
      {updateState.errorMessage ? (
        <p
          title={updateState.errorMessage}
          className='mt-2.5 flex items-center gap-1.5 text-[11.5px] font-medium text-amber-400/90'
        >
          <CircleAlert className='h-3 w-3 shrink-0' />
          Update failed. Try again or check for updates in Settings.
        </p>
      ) : null}

      <div className='mt-3 flex items-center gap-2 pl-11'>
        <button
          type='button'
          onClick={() => {
            // Progress + errors flow through updateState; a throw only means
            // the install failed, which the card already renders.
            void installUpdate(pendingUpdate).catch(() => undefined);
          }}
          className='inline-flex h-8 items-center gap-1.5 rounded-lg bg-white px-3 text-[12px] font-semibold text-black transition-colors hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40'
        >
          <Download className='h-3.5 w-3.5' />
          Update & restart
        </button>
        <button
          type='button'
          onClick={() => {
            dismissAppUpdateToast();
            onViewNotes();
          }}
          className='inline-flex h-8 items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-[12px] font-medium text-zinc-300 transition-colors hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25'
        >
          What's new
          <ArrowUpRight className='h-3.5 w-3.5' />
        </button>
      </div>
    </div>
  );
}
