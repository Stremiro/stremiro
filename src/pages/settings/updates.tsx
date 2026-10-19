import { openUrl } from '@tauri-apps/plugin-opener';
import { format, formatDistanceToNow } from 'date-fns';
import { ArrowUpRight, Download, Loader2, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ReleaseNotes } from '@/components/release-notes';
import { RetryBanner } from '@/components/retry-banner';
import { Button } from '@/components/ui/button';
import { useAppReleaseNotes, useAppUpdater, useMarkAppUpdateSeen } from '@/hooks/use-app-updater';
import { useAppUiPreferences } from '@/hooks/use-app-ui-preferences';
import { getErrorMessage } from '@/lib/api';
import {
  appReleaseTagUrl,
  appUpdateProgressPercent,
  type AppUpdateHandle,
  formatAppUpdateProgress,
  isTauriDesktopRuntime,
} from '@/lib/app-updater';
import { parseLocalScheduleDate } from '@/lib/schedule-dates';
import { cn } from '@/lib/utils';
import {
  SETTINGS_HEADER_STATUS_CLASS,
  SETTINGS_OUTLINE_BUTTON_CLASS,
  SettingsBody,
  SettingsGroup,
  SettingsGroupHeader,
  SettingsQueryError,
  SettingsRow,
  SettingsSwitch,
} from './chrome';

function formatReleaseDate(date: string | null | undefined): string | null {
  if (!date) return null;
  const parsed = parseLocalScheduleDate(date);
  return parsed ? format(parsed, 'MMM d, yyyy') : date;
}

function AppChangelog({
  currentVersion,
  pendingUpdate,
}: {
  currentVersion: string | null;
  pendingUpdate: AppUpdateHandle | null;
}) {
  const [selectedRelease, setSelectedRelease] = useState<'new' | 'installed'>('new');
  const showNewRelease = pendingUpdate !== null && selectedRelease === 'new';
  const installedRelease = useAppReleaseNotes(showNewRelease ? null : currentVersion);
  const release = showNewRelease ? pendingUpdate : installedRelease.data;
  const version = showNewRelease ? pendingUpdate.version : currentVersion;
  const releaseDate = formatReleaseDate(release?.date);
  const isLoading = !showNewRelease && installedRelease.isLoading;
  const showReleaseError =
    !showNewRelease &&
    !release &&
    (installedRelease.isError ||
      installedRelease.fetchStatus === 'paused' ||
      (isLoading && installedRelease.errorUpdatedAt > 0));

  const handleOpenRelease = () => {
    if (!version) return;
    void openUrl(appReleaseTagUrl(version)).catch((error) => toast.error(getErrorMessage(error)));
  };

  return (
    <section
      aria-label='Changelog'
      className='overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.02]'
    >
      <div className='flex flex-wrap items-center justify-between gap-3 px-4 pt-3'>
        <p className='text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500'>
          Changelog
        </p>
        {pendingUpdate && currentVersion ? (
          <div
            className='relative isolate grid grid-cols-2 rounded-md border border-white/[0.07] bg-white/[0.03] p-0.5'
            role='group'
            aria-label='Release version'
          >
            <span
              aria-hidden='true'
              className='pointer-events-none absolute bottom-0.5 left-0.5 top-0.5 rounded-sm bg-(--accent-nav) transition-transform duration-200 ease-out motion-reduce:transition-none'
              style={{
                width: 'calc((100% - 4px) / 2)',
                transform: `translateX(${showNewRelease ? 0 : 100}%)`,
              }}
            />
            {(['new', 'installed'] as const).map((option) => (
              <button
                key={option}
                type='button'
                aria-pressed={selectedRelease === option}
                onClick={() => setSelectedRelease(option)}
                className={cn(
                  'nav-switch-item relative z-10 h-7 rounded-sm px-2.5 text-[11px] font-medium tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25',
                  selectedRelease === option
                    ? 'text-(--on-accent-nav)'
                    : option === 'new'
                      ? 'text-emerald-300 hover:bg-white/[0.06] hover:text-emerald-200'
                      : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100',
                )}
              >
                v{option === 'new' ? pendingUpdate.version : currentVersion} ·{' '}
                {option === 'new' ? 'New' : 'Installed'}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className='flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/[0.06] px-4 py-3'>
        <p className='text-[13px] font-semibold text-white'>
          What's new{version ? ' in' : ''}
          {version ? (
            <span
              className={cn(
                'ml-1 font-medium tabular-nums',
                showNewRelease ? 'text-emerald-200' : 'text-zinc-300',
              )}
            >
              v{version}
            </span>
          ) : null}
        </p>
        {releaseDate ? (
          <p className='text-[12px] tabular-nums text-zinc-500'>{releaseDate}</p>
        ) : null}
        {version ? (
          <button
            type='button'
            onClick={handleOpenRelease}
            className='ml-auto inline-flex items-center gap-1 rounded-sm text-[12px] font-medium text-zinc-500 transition-colors hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25'
          >
            View on GitHub
            <ArrowUpRight className='h-3.5 w-3.5' />
          </button>
        ) : null}
      </div>
      <div
        data-selectable='true'
        aria-busy={isLoading}
        className='max-h-64 overflow-y-auto overscroll-contain px-4 py-3.5'
      >
        {!version ? (
          <p className='text-[13px] leading-relaxed text-zinc-400'>
            {isTauriDesktopRuntime()
              ? 'Release notes will appear when the installed version is available.'
              : 'Release notes are available in the desktop app.'}
          </p>
        ) : showReleaseError ? (
          <RetryBanner
            message='Release notes are unavailable right now.'
            isRetrying={installedRelease.isFetching}
            onRetry={() => void installedRelease.refetch()}
          />
        ) : isLoading ? (
          <div role='status' className='space-y-3'>
            <span className='sr-only'>Loading release notes…</span>
            <div
              aria-hidden='true'
              className='h-2 w-20 animate-pulse rounded bg-white/[0.06] motion-reduce:animate-none'
            />
            {['w-full', 'w-5/6', 'w-2/3'].map((width) => (
              <div key={width} aria-hidden='true' className='flex items-center gap-2.5'>
                <span className='h-1 w-1 shrink-0 rounded-full bg-zinc-700' />
                <span
                  className={cn(
                    'h-2.5 animate-pulse rounded bg-white/[0.05] motion-reduce:animate-none',
                    width,
                  )}
                />
              </div>
            ))}
          </div>
        ) : !showNewRelease && !release ? (
          <p className='text-[13px] leading-relaxed text-zinc-400'>
            No GitHub release was found for this version.
          </p>
        ) : (
          <ReleaseNotes notes={release?.notes} />
        )}
      </div>
    </section>
  );
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
    pendingUpdate,
    updateState,
  } = useAppUpdater({ includeCurrentVersion: true });
  const {
    preferences: automaticUpdateChecks,
    isHydrating,
    preferencesQuery,
    updatePreferences,
  } = useAppUiPreferences((preferences) => preferences.automaticUpdateChecks);

  useMarkAppUpdateSeen(isInstalling ? null : pendingUpdate);

  const installPercent = appUpdateProgressPercent(updateState.installProgress);

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

  const headerStatus = isInstalling ? null : updateState.status === 'up-to-date' ? (
    <span className={SETTINGS_HEADER_STATUS_CLASS}>Up to date</span>
  ) : isUpdateAvailable ? (
    <span className={cn(SETTINGS_HEADER_STATUS_CLASS, 'text-emerald-300')}>
      v{pendingUpdate?.version} ready
    </span>
  ) : isChecking ? (
    <span className={SETTINGS_HEADER_STATUS_CLASS}>Checking…</span>
  ) : null;

  const handleCheck = () => {
    if (!isSupported || isChecking || isInstalling) return;
    void checkForUpdates()
      .then((update) => {
        if (!update) {
          toast.success('Stremiro is up to date');
          return;
        }
        toast.info(`Update v${update.version} is available`);
      })
      .catch((error) => toast.error(`Update check failed: ${getErrorMessage(error)}`));
  };

  const handleInstall = () => {
    if (!pendingUpdate || isInstalling || isChecking) return;
    // Progress renders in the page; only the failure needs a toast.
    void installUpdate(pendingUpdate).catch((error) => {
      toast.error(`Update install failed: ${getErrorMessage(error)}`);
    });
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
        action={headerStatus}
      />

      <SettingsBody className='space-y-4'>
        <SettingsQueryError query={preferencesQuery} message="Couldn't load your preferences." />
        <SettingsRow
          label='Check for updates automatically'
          description='Check shortly after launch and every six hours. Updates are installed only when you choose.'
        >
          <SettingsSwitch
            ariaLabel='Check for updates automatically'
            checked={automaticUpdateChecks}
            disabled={isHydrating || !isSupported}
            onChange={() => updatePreferences({ automaticUpdateChecks: !automaticUpdateChecks })}
          />
        </SettingsRow>
        <div className='flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-zinc-400'>
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
          <span className='text-zinc-400'>· Last checked {lastCheckedLabel}</span>
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
              {updateState.errorOperation === 'install'
                ? 'Update install failed'
                : 'Update check failed'}
            </p>
            <p className='mt-1 text-[12px] leading-relaxed text-red-200/80'>
              {updateState.errorMessage}
            </p>
          </div>
        ) : null}

        <AppChangelog
          key={pendingUpdate?.version ?? 'installed'}
          currentVersion={currentVersion}
          pendingUpdate={pendingUpdate}
        />

        <div className='flex flex-wrap items-center gap-2.5 border-t border-white/[0.06] pt-4'>
          {pendingUpdate ? (
            <Button
              size='sm'
              onClick={handleInstall}
              aria-disabled={isInstalling || isChecking || undefined}
              aria-busy={isInstalling || undefined}
              className='h-9 gap-2 rounded-lg bg-white px-3.5 text-[13px] font-semibold text-black hover:bg-zinc-200 aria-disabled:cursor-wait aria-disabled:opacity-50'
            >
              {isInstalling ? (
                <Loader2
                  aria-hidden='true'
                  className='h-3.5 w-3.5 animate-spin motion-reduce:animate-none'
                />
              ) : (
                <Download className='h-3.5 w-3.5' />
              )}
              Update & restart
            </Button>
          ) : null}
          <Button
            size='sm'
            variant='outline'
            onClick={handleCheck}
            disabled={!isSupported}
            aria-disabled={isChecking || isInstalling || undefined}
            aria-busy={isChecking || undefined}
            className={cn(
              'h-9 gap-2 px-3.5 text-[13px] aria-disabled:cursor-wait aria-disabled:opacity-50',
              SETTINGS_OUTLINE_BUTTON_CLASS,
            )}
          >
            {isChecking ? (
              <Loader2
                aria-hidden='true'
                className='h-3.5 w-3.5 animate-spin motion-reduce:animate-none'
              />
            ) : (
              <RefreshCw className='h-3.5 w-3.5' />
            )}
            {pendingUpdate ? 'Check again' : 'Check for updates'}
          </Button>
        </div>

        <p className='text-[13px] leading-relaxed text-zinc-400'>{statusNote}</p>
      </SettingsBody>
    </SettingsGroup>
  );
}
