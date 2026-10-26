import { ArrowUpRight, CircleAlert, Download, RefreshCw, Sparkles, X } from 'lucide-react';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { useAppUpdater, useMarkAppUpdateSeen } from '@/hooks/use-app-updater';
import {
  type AppUpdateProgress,
  appUpdateProgressPercent,
  formatAppUpdateProgress,
} from '@/lib/app-updater';
import { cn } from '@/lib/utils';

// One shared id so announce → progress → error update the same toast in place.
export const APP_UPDATE_TOAST_ID = 'app-update-toast';

function dismissAppUpdateToast() {
  toast.dismiss(APP_UPDATE_TOAST_ID);
}

const CARD_CHROME =
  'relative box-border w-[min(344px,calc(100vw_-_32px))] overflow-hidden rounded-[10px] border border-white/[0.07] bg-[#141417]/95 p-3.5 shadow-[0_10px_30px_-12px_rgb(0_0_0/0.65),0_1px_2px_rgb(0_0_0/0.35),inset_0_1px_0_rgb(255_255_255/0.04)] backdrop-blur-md';

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type='button'
      onClick={onClose}
      aria-label='Dismiss update notification'
      className='absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md bg-white/[0.08] text-white/50 transition-colors hover:bg-white/[0.12] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25'
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
          <p className='break-words text-[13px] font-medium leading-5 tracking-[-0.005em] text-white/95'>
            Updating to v{version}
          </p>
          <p className='mt-0.5 text-[12px] leading-4 tabular-nums text-white/50'>
            {formatAppUpdateProgress(installProgress)}
          </p>
        </div>
        {percent !== null ? (
          <span className='shrink-0 text-[12px] font-medium tabular-nums text-emerald-300/90'>
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
            'h-full origin-left rounded-full bg-emerald-300/90 transition-transform duration-300 motion-reduce:transition-none',
            percent === null && 'w-1/3 motion-safe:animate-pulse',
          )}
          style={percent !== null ? { transform: `scaleX(${percent / 100})` } : undefined}
        />
      </div>
    </div>
  );
}

function UpdateError({
  message,
  isChecking,
  onCheckAgain,
}: {
  message: string;
  isChecking: boolean;
  onCheckAgain: () => void;
}) {
  return (
    <div className={CARD_CHROME} role={isChecking ? 'status' : 'alert'}>
      <CloseButton onClose={dismissAppUpdateToast} />
      <div className='flex items-start gap-3 pr-8'>
        <span
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border',
            isChecking ? 'border-white/10 bg-white/[0.04]' : 'border-red-400/20 bg-red-500/[0.08]',
          )}
        >
          {isChecking ? (
            <Sparkles className='h-4 w-4 text-zinc-400' strokeWidth={2.25} />
          ) : (
            <CircleAlert className='h-4 w-4 text-red-300/90' strokeWidth={2.25} />
          )}
        </span>
        <div className='min-w-0 flex-1'>
          <p className='text-[13px] font-medium leading-5 tracking-[-0.005em] text-white/95'>
            {isChecking ? 'Checking for updates' : 'Update failed'}
          </p>
          <p
            title={message}
            className='mt-1 line-clamp-3 break-words text-[12px] leading-4 text-white/50'
          >
            {message}
          </p>
          <button
            type='button'
            onClick={() => {
              if (!isChecking) onCheckAgain();
            }}
            aria-disabled={isChecking || undefined}
            aria-busy={isChecking}
            className='mt-2.5 inline-flex h-9 items-center gap-1.5 rounded-md bg-white/[0.08] px-3 text-[12px] font-medium text-white transition-colors hover:bg-white/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 aria-disabled:cursor-wait aria-disabled:opacity-50'
          >
            <RefreshCw
              className={cn('h-3.5 w-3.5', isChecking && 'animate-spin motion-reduce:animate-none')}
            />
            Check again
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Persistent update card morphing announce → progress → error in place; a
 * successful install exits the process, so no completion state exists.
 */
export function AppUpdateCard({ onViewNotes }: { onViewNotes: () => void }) {
  const {
    checkForUpdates,
    currentVersion,
    installUpdate,
    isInstalling,
    pendingUpdate,
    updateState,
  } = useAppUpdater({ includeCurrentVersion: true });

  useMarkAppUpdateSeen(isInstalling ? null : pendingUpdate);

  // Self-close once nothing is actionable (e.g. a failed install whose
  // recovery check found the release already applied or withdrawn).
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
    const isChecking = updateState.status === 'checking';
    if (isChecking || (updateState.status === 'error' && updateState.errorMessage)) {
      return (
        <UpdateError
          message={updateState.errorMessage ?? 'Contacting the update server…'}
          isChecking={isChecking}
          onCheckAgain={() => void checkForUpdates().catch(() => undefined)}
        />
      );
    }
    return null;
  }

  return (
    <div className={CARD_CHROME}>
      {/* Release notes stay in Settings — the toast announces and hands off. */}
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
          <p className='text-[13px] font-medium leading-5 tracking-[-0.005em] text-white/95'>
            Update available
          </p>
          <p className='mt-0.5 text-[12px] leading-4 text-white/50'>
            Stremiro{' '}
            <span className='font-medium tabular-nums text-white/70'>v{pendingUpdate.version}</span>
            {currentVersion ? ` · currently v${currentVersion}` : ''}
          </p>
        </div>
      </div>

      {/* A re-armed failed install keeps the update available — surface that the last attempt didn't land. */}
      {updateState.errorMessage ? (
        <p
          title={updateState.errorMessage}
          className='mt-2.5 flex items-center gap-1.5 text-[12px] font-medium leading-4 text-amber-400/90'
        >
          <CircleAlert className='h-3 w-3 shrink-0' />
          Update failed. Try again or check for updates in Settings.
        </p>
      ) : null}

      <div className='mt-3 flex items-center gap-2 pl-11'>
        <button
          type='button'
          onClick={() => {
            // A throw just means the install failed; the card already renders that.
            void installUpdate(pendingUpdate).catch(() => undefined);
          }}
          className='inline-flex h-8 items-center gap-1.5 rounded-md bg-white px-3 text-[12px] font-medium text-black transition-colors hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40'
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
          className='inline-flex h-8 items-center gap-1 rounded-md bg-white/[0.08] px-3 text-[12px] font-medium text-white transition-colors hover:bg-white/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25'
        >
          What's new
          <ArrowUpRight className='h-3.5 w-3.5' />
        </button>
      </div>
    </div>
  );
}
