import { openUrl } from '@tauri-apps/plugin-opener';
import { format, formatDistanceToNow } from 'date-fns';
import { ArrowUpRight, Download, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { ReleaseNotes } from '@/components/release-notes';
import { Button } from '@/components/ui/button';
import { useAppUpdater } from '@/hooks/use-app-updater';
import { getErrorMessage } from '@/lib/api';
import {
  appReleaseTagUrl,
  appUpdateProgressPercent,
  formatAppUpdateProgress,
} from '@/lib/app-updater';
import { cn } from '@/lib/utils';
import {
  SETTINGS_OUTLINE_BUTTON_CLASS,
  SettingsBody,
  SettingsGroup,
  SettingsGroupHeader,
} from './chrome';

function formatReleaseDate(date: string | null | undefined): string | null {
  if (!date) return null;
  // The backend emits ISO dates ("2026-09-15"); anchor to local noon so a
  // timezone shift can never roll the label back a day.
  const parsed = new Date(`${date.slice(0, 10)}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? date : format(parsed, 'MMM d, yyyy');
}

export function UpdatesSection() {
  const {
    checkForUpdates,
    currentVersion,
    installUpdate,
    isChecking,
    isInstalling,
    isSupported,
    isUpdateAvailable,
    markUpdateNotified,
    pendingUpdate,
    updateState,
  } = useAppUpdater();

  const installPercent = appUpdateProgressPercent(updateState.installProgress);
  const releaseDate = formatReleaseDate(pendingUpdate?.date);

  const lastCheckedLabel = updateState.lastCheckedAt
    ? formatDistanceToNow(updateState.lastCheckedAt, { addSuffix: true })
    : 'not checked yet';

  const statusNote = !isSupported
    ? 'Updater controls are only active inside the packaged desktop app.'
    : isInstalling
      ? 'Installing replaces the app in place and relaunches it. Your library, addons, and settings carry over.'
      : isUpdateAvailable
        ? 'A signed update is ready. Installing will replace the current app in place and keep your existing app data.'
        : updateState.status === 'up-to-date'
          ? 'The installed build matches the latest signed GitHub release.'
          : 'Updates download a signed installer from GitHub Releases and apply it in place.';

  const statusChip = isInstalling ? null : updateState.status === 'up-to-date' ? (
    <span className='inline-flex items-center gap-1.5 rounded-md border border-white/[0.09] bg-white/[0.04] px-2 py-1 text-[11px] font-semibold text-zinc-300'>
      <span className='h-1.5 w-1.5 rounded-full bg-emerald-300/80' />
      Up to date
    </span>
  ) : isUpdateAvailable ? (
    <span className='inline-flex items-center gap-1.5 rounded-md border border-white/[0.09] bg-white/[0.04] px-2 py-1 text-[11px] font-semibold text-zinc-300'>
      <span className='h-1.5 w-1.5 rounded-full bg-emerald-300' />
      <span className='tabular-nums text-emerald-200'>v{pendingUpdate?.version}</span> ready
    </span>
  ) : isChecking ? (
    <span className='rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[11px] font-medium text-zinc-400'>
      Checking…
    </span>
  ) : null;

  const handleCheck = () => {
    void checkForUpdates()
      .then((update) => {
        if (!update) {
          toast.success('Stremiro is up to date');
          return;
        }
        // The user has now seen this version — mark it so the scheduled
        // announce card doesn't re-notify the same release.
        void markUpdateNotified(update.version).catch(() => undefined);
        toast.info(`Update ${update.version} is available`, {
          description: 'Install the latest signed desktop release from GitHub Releases.',
        });
      })
      .catch((error) => toast.error(`Update check failed: ${getErrorMessage(error)}`));
  };

  const handleInstall = () => {
    if (!pendingUpdate) return;
    // Progress renders in the page (and the announce card when mounted) —
    // only the failure needs a toast.
    void installUpdate(pendingUpdate).catch((error) => {
      toast.error(`Update install failed: ${getErrorMessage(error)}`);
    });
  };

  const handleOpenRelease = () => {
    if (!pendingUpdate) return;
    void openUrl(appReleaseTagUrl(pendingUpdate.version)).catch(() => undefined);
  };

  return (
    <SettingsGroup className={isUpdateAvailable ? 'relative' : undefined}>
      {/* Same accent vocabulary as the announce card: a hairline, not a tint. */}
      {isUpdateAvailable ? (
        <span
          aria-hidden='true'
          className='absolute inset-x-5 top-0 h-px bg-linear-to-r from-transparent via-emerald-300/50 to-transparent'
        />
      ) : null}
      <SettingsGroupHeader
        title='Updates'
        description='Signed desktop releases from GitHub, applied in place — your data carries over.'
        action={statusChip}
      />

      <SettingsBody className='space-y-4'>
        <div className='flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-zinc-500'>
          <span>
            Installed{' '}
            <span className='font-semibold tabular-nums text-zinc-100'>
              {currentVersion ? `v${currentVersion}` : 'Unknown'}
            </span>
          </span>
          {pendingUpdate ? (
            <>
              <span aria-hidden='true' className='text-zinc-700'>
                →
              </span>
              <span>
                Latest{' '}
                <span className='font-semibold tabular-nums text-emerald-300'>
                  v{pendingUpdate.version}
                </span>
              </span>
            </>
          ) : null}
          <span className='text-zinc-600'>· checked {lastCheckedLabel}</span>
        </div>

        {isInstalling ? (
          <div className='space-y-2' role='status' aria-live='polite'>
            <div
              className='h-1.5 w-full overflow-hidden rounded-full bg-white/[0.07]'
              role='progressbar'
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={installPercent ?? undefined}
              aria-label='Update download progress'
            >
              <div
                className={cn(
                  'h-full rounded-full bg-emerald-300 transition-[width] duration-300',
                  installPercent === null && 'w-1/3 animate-pulse',
                )}
                style={installPercent !== null ? { width: `${installPercent}%` } : undefined}
              />
            </div>
            <p className='text-[12px] tabular-nums text-zinc-500'>
              {formatAppUpdateProgress(updateState.installProgress)}
            </p>
          </div>
        ) : null}

        {updateState.errorMessage ? (
          <div className='rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3'>
            <p className='text-[12px] font-medium text-red-300'>
              {isUpdateAvailable ? 'Update install failed' : 'Update check failed'}
            </p>
            <p className='mt-1 text-[12px] leading-relaxed text-red-200/80'>
              {updateState.errorMessage}
            </p>
          </div>
        ) : null}

        {pendingUpdate ? (
          <div className='border-t border-white/[0.06] pt-4'>
            <div className='flex items-baseline justify-between gap-3'>
              <p className='text-[13px] font-semibold text-white'>
                What's new in v{pendingUpdate.version}
              </p>
              {releaseDate ? (
                <p className='shrink-0 text-[12px] tabular-nums text-zinc-600'>{releaseDate}</p>
              ) : null}
            </div>
            <div data-selectable='true' className='mt-2 max-h-56 overflow-y-auto pr-1'>
              <ReleaseNotes body={pendingUpdate.body} />
            </div>
          </div>
        ) : null}

        <div className='flex flex-wrap items-center gap-2.5 border-t border-white/[0.06] pt-4'>
          <Button
            size='sm'
            variant='outline'
            onClick={handleCheck}
            disabled={!isSupported || isChecking || isInstalling}
            className={cn('h-9 gap-2 px-3.5 text-[13px]', SETTINGS_OUTLINE_BUTTON_CLASS)}
          >
            {isChecking ? (
              <Loader2 className='h-3.5 w-3.5 animate-spin' />
            ) : (
              <RefreshCw className='h-3.5 w-3.5' />
            )}
            Check
          </Button>

          <Button
            size='sm'
            onClick={handleInstall}
            disabled={!pendingUpdate || isInstalling || isChecking}
            className='h-9 gap-2 rounded-lg bg-white px-3.5 text-[13px] font-semibold text-black hover:bg-zinc-200'
          >
            {isInstalling ? (
              <Loader2 className='h-3.5 w-3.5 animate-spin' />
            ) : (
              <Download className='h-3.5 w-3.5' />
            )}
            Update & restart
          </Button>

          {pendingUpdate ? (
            <button
              type='button'
              onClick={handleOpenRelease}
              className='ml-auto inline-flex items-center gap-1 text-[12.5px] font-medium text-zinc-500 transition-colors hover:text-zinc-200'
            >
              View release on GitHub
              <ArrowUpRight className='h-3.5 w-3.5' />
            </button>
          ) : null}
        </div>

        <p className='text-[12.5px] leading-relaxed text-zinc-500'>{statusNote}</p>
      </SettingsBody>
    </SettingsGroup>
  );
}
