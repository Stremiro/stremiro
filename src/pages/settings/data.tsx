import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Loader2, type LucideIcon, Upload } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useMountedRef } from '@/hooks/use-mounted-ref';
import { api, getBackupImportErrorMessage, getErrorMessage, type ImportResult } from '@/lib/api';
import { flushPendingAppWrites } from '@/lib/pending-app-writes';
import {
  ADDON_CONFIGS_QUERY_KEY,
  invalidateLibraryQueries,
  invalidateListQueries,
  invalidatePlaybackHistoryQueries,
  invalidatePlaybackLanguageQueries,
  invalidateStoredDataQueries,
  invalidateWatchStatusQueries,
  PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY,
  PROFILE_PREFERENCES_QUERY_KEY,
  STREAM_SELECTOR_PREFERENCES_QUERY_KEY,
} from '@/lib/query-invalidation';
import { cn } from '@/lib/utils';
import {
  SETTINGS_OUTLINE_BUTTON_CLASS,
  SettingsBody,
  SettingsGroup,
  SettingsGroupHeader,
  SettingsQueryError,
} from './chrome';

const CLEAR_CONFIRM_TIMEOUT_MS = 8_000;

interface DataCategory {
  key: 'history' | 'library' | 'lists' | 'statuses';
  label: string;
  description: string;
  count: number | undefined;
  isEmpty?: boolean;
  unit: string;
  clearFn: () => Promise<void>;
  invalidateCaches: () => Promise<void>;
}

function BackupRestore() {
  const queryClient = useQueryClient();
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [confirmImport, setConfirmImport] = useState(false);
  const cancelImportRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useMountedRef();

  const handleExport = async () => {
    setExporting(true);
    await flushPendingAppWrites()
      .then(() => api.exportAppDataToFile())
      .then((exported) => {
        if (exported) toast.success('Backup exported successfully');
      })
      .catch((err: unknown) => toast.error(`Export failed: ${getErrorMessage(err)}`))
      .finally(() => {
        if (mountedRef.current) setExporting(false);
      });
  };

  const handleImport = async () => {
    setImporting(true);
    setConfirmImport(false);
    await flushPendingAppWrites()
      .then(async () => {
        let result: ImportResult | null | undefined;
        await api
          .importAppDataFromFile()
          .then((imported) => {
            result = imported;
          })
          .finally(async () => {
            // Whole-snapshot writers (profile, selector prefs, addon list) compose
            // writes from cached state — reset, not just invalidate, so a settings
            // write can't re-persist pre-import values over the restore. The addon
            // reset also gates the list editor until the fresh registry lands.
            // Failed restores may have persisted earlier domains before failing.
            if (result !== null) {
              const settingsChanged = result?.settings_restored ?? true;
              if (settingsChanged) {
                await Promise.all([
                  queryClient.resetQueries({ queryKey: PROFILE_PREFERENCES_QUERY_KEY }),
                  queryClient.resetQueries({ queryKey: PLAYBACK_LANGUAGE_PREFERENCES_QUERY_KEY }),
                  queryClient.resetQueries({ queryKey: STREAM_SELECTOR_PREFERENCES_QUERY_KEY }),
                ]);
              }
              if (settingsChanged || (result?.addons_imported ?? 0) > 0) {
                await queryClient.resetQueries({ queryKey: ADDON_CONFIGS_QUERY_KEY });
              }
              await invalidateStoredDataQueries(
                queryClient,
                settingsChanged || (result?.addons_imported ?? 0) > 0,
              );
            }
          });
        if (!result) return;
        const summary = [
          `${result.history_imported} history`,
          `${result.library_imported} library`,
          `${result.lists_imported} lists`,
          `${result.statuses_imported} statuses`,
          result.addons_imported > 0 && `${result.addons_imported} addons`,
          result.settings_restored && 'settings restored',
        ].filter(Boolean);
        toast.success('Backup imported', { description: summary.join(' · ') });
      })
      .catch((err: unknown) => {
        toast.error(`Import failed: ${getBackupImportErrorMessage(err)}`);
      })
      .finally(() => {
        if (mountedRef.current) setImporting(false);
      });
  };

  return (
    <SettingsBody className='flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center'>
      <div className='min-w-0'>
        <p className='text-[14px] font-medium text-zinc-100'>Backup & restore</p>
        <p className='mt-1 text-[13px] leading-relaxed text-zinc-400'>
          Export your data to a JSON file, or merge one back in. Backups can contain addon keys, so
          keep them private.
        </p>
      </div>
      <div className='flex shrink-0 items-center gap-2'>
        <BackupButton
          icon={Download}
          busy={exporting}
          disabled={exporting || importing || confirmImport}
          onClick={handleExport}
        >
          Export
        </BackupButton>
        <BackupButton
          icon={Upload}
          busy={importing}
          disabled={exporting || importing || confirmImport}
          onClick={() => setConfirmImport(true)}
        >
          Import
        </BackupButton>
      </div>
      <Dialog open={confirmImport} onOpenChange={setConfirmImport}>
        <DialogContent
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelImportRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Import backup?</DialogTitle>
            <DialogDescription>
              Records, addons and per-title language picks merge with your existing data.
              Preferences, profile and appearance are replaced by the backup's. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button ref={cancelImportRef} variant='outline' onClick={() => setConfirmImport(false)}>
              Cancel
            </Button>
            <Button onClick={() => void handleImport()}>Import backup</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsBody>
  );
}

function BackupButton({
  busy,
  children,
  disabled,
  icon: Icon,
  onClick,
}: {
  busy: boolean;
  children: string;
  disabled: boolean;
  icon: LucideIcon;
  onClick: () => void;
}) {
  return (
    <Button
      size='sm'
      variant='outline'
      onClick={onClick}
      disabled={disabled}
      className={cn('h-9 gap-2 px-3.5 text-[13px]', SETTINGS_OUTLINE_BUTTON_CLASS)}
    >
      {busy ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : <Icon className='h-3.5 w-3.5' />}
      {children}
    </Button>
  );
}

function DataManager() {
  const queryClient = useQueryClient();
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const mountedRef = useMountedRef();

  const statsQuery = useQuery(api.dataStatsQueryOptions());
  const stats = statsQuery.data;

  const clearMutation = useMutation({
    mutationFn: async (cat: DataCategory) => {
      await flushPendingAppWrites();
      await cat.clearFn();
      return cat;
    },
    onSuccess: (cat) => {
      toast.success(`${cat.label} cleared`);
    },
    onError: (err: unknown, cat) => {
      toast.error(`Failed to clear ${cat.label}: ${getErrorMessage(err)}`, {
        description: 'Some data may have been partially cleared.',
      });
    },
    onSettled: (_data, _error, cat) => {
      if (mountedRef.current) setConfirmKey(null);
      return cat.invalidateCaches();
    },
  });

  useEffect(() => {
    if (!confirmKey || clearMutation.isPending) return;
    const timer = window.setTimeout(() => setConfirmKey(null), CLEAR_CONFIRM_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [clearMutation.isPending, confirmKey]);

  // Two-step confirm focus: arming lands on Cancel (a double Enter must never
  // hit "Clear permanently"); disarming with lost focus returns to the row's
  // Clear button or category heading.
  const previousConfirmKeyRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (clearMutation.isPending) return;
    const armedKey = previousConfirmKeyRef.current;
    previousConfirmKeyRef.current = confirmKey;
    const row = document.querySelector<HTMLElement>(`[data-clear-row="${confirmKey ?? armedKey}"]`);
    if (confirmKey) {
      row?.querySelector<HTMLElement>('[data-clear-cancel]')?.focus();
    } else if (armedKey && document.activeElement === document.body) {
      (
        row?.querySelector<HTMLElement>('[data-clear-arm]:not(:disabled)') ??
        row?.querySelector<HTMLElement>('[data-clear-heading]')
      )?.focus({ preventScroll: true });
    }
  }, [clearMutation.isPending, confirmKey]);

  const categories: DataCategory[] = [
    {
      key: 'history',
      label: 'Watch history',
      description: 'Watched titles, resume progress and per-title track and source picks.',
      count: stats?.history_count,
      isEmpty: stats?.history_count === 0 && stats.has_learned_playback_data === false,
      unit: stats?.history_count === 1 ? 'entry' : 'entries',
      clearFn: api.clearWatchHistory,
      // `clear_watch_history` also wipes per-title language picks and source health/affinity that feed stream ranking (Rust `PlaybackStateService::clear`).
      invalidateCaches: async () => {
        await Promise.all([
          invalidatePlaybackHistoryQueries(queryClient),
          invalidatePlaybackLanguageQueries(queryClient),
        ]);
      },
    },
    {
      key: 'library',
      label: 'Library',
      description: 'Saved movies and shows, with their watch statuses.',
      count: stats?.library_count,
      unit: stats?.library_count === 1 ? 'item' : 'items',
      clearFn: api.clearLibrary,
      // `clear_library` also wipes watch statuses — both surfaces refetch.
      invalidateCaches: () => invalidateLibraryQueries(queryClient),
    },
    {
      key: 'lists',
      label: 'Custom lists',
      description: 'Every custom list and its contents.',
      count: stats?.lists_count,
      unit: stats?.lists_count === 1 ? 'list' : 'lists',
      clearFn: api.clearAllLists,
      invalidateCaches: () => invalidateListQueries(queryClient),
    },
    {
      key: 'statuses',
      label: 'Watch statuses',
      description: 'Watching, Watched, Plan to Watch and Dropped labels.',
      count: stats?.watch_statuses_count,
      unit: stats?.watch_statuses_count === 1 ? 'label' : 'labels',
      clearFn: api.clearAllWatchStatuses,
      invalidateCaches: () => invalidateWatchStatusQueries(queryClient),
    },
  ];

  return (
    <div className='border-t border-white/[0.06]'>
      <div className='flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-5 pb-1 pt-4'>
        <p className='text-[11px] font-medium uppercase tracking-[0.12em] text-zinc-500'>
          Clear local records
        </p>
        <p className='text-xs text-zinc-400'>Permanent — no undo</p>
      </div>

      <SettingsQueryError
        query={statsQuery}
        className='mx-5 my-3'
        message="Couldn't load local record counts."
      />

      <SettingsBody rows>
        {categories.map((cat) => {
          const isPending = clearMutation.isPending && clearMutation.variables?.key === cat.key;
          const isConfirming = confirmKey === cat.key;
          const isEmpty = cat.isEmpty ?? cat.count === 0;

          return (
            <div
              key={cat.key}
              data-clear-row={cat.key}
              className='flex flex-col items-start justify-between gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center'
            >
              <div className='min-w-0'>
                <div className='flex flex-wrap items-center gap-2'>
                  <h3
                    data-clear-heading
                    tabIndex={-1}
                    className='text-[14px] font-medium text-zinc-100 focus:outline-hidden'
                  >
                    {cat.label}
                  </h3>
                  <span className='text-[12px] tabular-nums text-zinc-500'>
                    {cat.count ?? '—'} {cat.unit}
                  </span>
                </div>
                <p className='mt-1 text-[13px] leading-relaxed text-zinc-400'>{cat.description}</p>
              </div>

              <div className='flex max-w-full shrink-0 flex-wrap items-center gap-2'>
                {isConfirming ? (
                  <>
                    <Button
                      size='sm'
                      variant='outline'
                      data-clear-cancel
                      aria-label={`Cancel clearing ${cat.label.toLowerCase()}`}
                      onClick={() => setConfirmKey(null)}
                      disabled={clearMutation.isPending}
                      className={cn('h-8 px-3 text-[12px]', SETTINGS_OUTLINE_BUTTON_CLASS)}
                    >
                      Cancel
                    </Button>
                    <Button
                      size='sm'
                      aria-label={`Clear permanently: ${cat.label.toLowerCase()}`}
                      onClick={() => clearMutation.mutate(cat)}
                      disabled={clearMutation.isPending || cat.count === undefined}
                      className='h-8 rounded-lg border-0 bg-red-500 px-3 text-[12px] font-semibold text-white hover:bg-red-600'
                    >
                      {isPending && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
                      Clear permanently
                    </Button>
                  </>
                ) : (
                  <Button
                    size='sm'
                    variant='outline'
                    data-clear-arm
                    aria-label={`Clear ${cat.label.toLowerCase()}`}
                    onClick={() => setConfirmKey(cat.key)}
                    disabled={cat.count === undefined || isEmpty || clearMutation.isPending}
                    className={cn(
                      'h-8 rounded-lg px-3 text-[12px] font-medium',
                      isEmpty
                        ? 'cursor-not-allowed opacity-30'
                        : 'border-red-500/20 text-red-400 hover:bg-red-500/10 hover:text-red-300',
                    )}
                  >
                    Clear
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </SettingsBody>
    </div>
  );
}

export function DataSection() {
  return (
    <SettingsGroup>
      <SettingsGroupHeader title='Data & storage' />
      <BackupRestore />
      <DataManager />
    </SettingsGroup>
  );
}
