import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bookmark,
  DatabaseBackup,
  Download,
  Eraser,
  History,
  Library,
  List,
  Loader2,
  Search,
  Upload,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { useRecentSearches } from '@/hooks/use-app-ui-preferences';
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
import { cn, pluralize } from '@/lib/utils';
import {
  SETTINGS_OUTLINE_BUTTON_CLASS,
  SETTINGS_ROW_CLASS,
  SETTINGS_ROW_DESCRIPTION_CLASS,
  SettingsBody,
  SettingsCard,
  SettingsGroup,
  SettingsGroupHeader,
  SettingsQueryError,
  settingsControlId,
} from './chrome';

const CLEAR_CONFIRM_TIMEOUT_MS = 8_000;
// Keep backup and destructive actions exclusive, even after leaving and reopening this section.
const DATA_MUTATION_KEY = ['settingsDataOperation'] as const;

interface DataCategory {
  key: 'history' | 'library' | 'lists' | 'searches' | 'statuses';
  icon: LucideIcon;
  label: string;
  description: string;
  count: number | undefined;
  isEmpty?: boolean;
  unitSingular: string;
  unitPlural?: string;
  clearFn: () => Promise<void>;
  invalidateCaches?: () => Promise<void>;
}

function BackupRestore() {
  const queryClient = useQueryClient();
  const isWorking = useIsMutating({ mutationKey: DATA_MUTATION_KEY }) > 0;
  const [confirmImport, setConfirmImport] = useState(false);
  const cancelImportRef = useRef<HTMLButtonElement>(null);

  const exportMutation = useMutation({
    mutationKey: DATA_MUTATION_KEY,
    mutationFn: async () => {
      await flushPendingAppWrites();
      if (await api.exportAppDataToFile()) toast.success('Backup exported successfully');
    },
    onError: (err: unknown) => toast.error(`Export failed: ${getErrorMessage(err)}`),
  });

  const importMutation = useMutation({
    mutationKey: DATA_MUTATION_KEY,
    mutationFn: async () => {
      let result: ImportResult | null | undefined;
      await flushPendingAppWrites();
      try {
        result = await api.importAppDataFromFile();
      } finally {
        // Whole-snapshot writers (profile, selector prefs, addon list) compose
        // writes from cached state — reset, not just invalidate, so a settings
        // write can't re-persist pre-import values over the restore. The addon
        // reset also gates the list editor until the fresh registry lands.
        // Failed restores may have persisted earlier domains before failing.
        // A cancelled dialog (null result) restored nothing — skip the resets.
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
      }
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
    },
    onError: (err: unknown) => toast.error(`Import failed: ${getBackupImportErrorMessage(err)}`),
  });

  return (
    <SettingsBody className='flex flex-wrap items-center justify-between gap-x-5 gap-y-3'>
      <div className='flex min-w-0 flex-1 basis-48 items-center gap-3'>
        <DatabaseBackup
          aria-hidden='true'
          className='size-[18px] shrink-0 text-zinc-400'
          strokeWidth={1.75}
        />
        <div className='min-w-0'>
          <p className='text-[16px] font-medium text-zinc-100'>Backup file</p>
          <p className={SETTINGS_ROW_DESCRIPTION_CLASS}>
            Backups can contain addon keys, so keep them private.
          </p>
        </div>
      </div>
      <div className='flex shrink-0 items-center gap-2'>
        <BackupButton
          icon={Download}
          busy={exportMutation.isPending}
          disabled={isWorking}
          onClick={() => {
            if (!queryClient.isMutating({ mutationKey: DATA_MUTATION_KEY }))
              exportMutation.mutate();
          }}
        >
          Export
        </BackupButton>
        <BackupButton
          icon={Upload}
          busy={importMutation.isPending}
          disabled={isWorking}
          onClick={() => {
            if (!isWorking) setConfirmImport(true);
          }}
        >
          Import
        </BackupButton>
      </div>
      <ConfirmDialog
        open={confirmImport}
        onOpenChange={setConfirmImport}
        contentProps={{
          onOpenAutoFocus: (event) => {
            event.preventDefault();
            cancelImportRef.current?.focus();
          },
        }}
        title='Import backup?'
        description="Records, addons and per-title language picks merge with your existing data. Preferences, profile and appearance are replaced by the backup's. This cannot be undone."
        cancelProps={{ ref: cancelImportRef }}
        confirmProps={{}}
        confirmDisabled={isWorking}
        confirmLabel='Import backup'
        onConfirm={() => {
          if (queryClient.isMutating({ mutationKey: DATA_MUTATION_KEY })) return;
          setConfirmImport(false);
          importMutation.mutate();
        }}
      />
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
      id={settingsControlId(children)}
      size='sm'
      variant='outline'
      onClick={onClick}
      disabled={disabled}
      className={cn('h-10 gap-2 px-3.5 text-[14px]', SETTINGS_OUTLINE_BUTTON_CLASS)}
    >
      {busy ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : <Icon className='h-3.5 w-3.5' />}
      {children}
    </Button>
  );
}

function DataManager() {
  const queryClient = useQueryClient();
  const isWorking = useIsMutating({ mutationKey: DATA_MUTATION_KEY }) > 0;
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const mountedRef = useMountedRef();

  const statsQuery = useQuery(api.dataStatsQueryOptions());
  const stats = statsQuery.data;
  const {
    recentSearches,
    isHydrating: recentSearchesHydrating,
    clearRecentSearches,
  } = useRecentSearches();
  const recentSearchCount = recentSearchesHydrating ? undefined : recentSearches.length;

  const clearMutation = useMutation({
    mutationKey: DATA_MUTATION_KEY,
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
      return cat.invalidateCaches?.();
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
      icon: History,
      label: 'Watch history',
      description: 'Watched titles, resume progress and per-title track and source picks.',
      count: stats?.history_count,
      isEmpty: stats?.history_count === 0 && !stats.has_learned_playback_data,
      unitSingular: 'entry',
      unitPlural: 'entries',
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
      icon: Library,
      label: 'Library',
      description: 'Saved movies and shows, with their watch statuses.',
      count: stats?.library_count,
      unitSingular: 'item',
      clearFn: api.clearLibrary,
      // `clear_library` also wipes watch statuses — both surfaces refetch.
      invalidateCaches: () => invalidateLibraryQueries(queryClient),
    },
    {
      key: 'lists',
      icon: List,
      label: 'Custom lists',
      description: 'Every custom list and its contents.',
      count: stats?.lists_count,
      unitSingular: 'list',
      clearFn: api.clearAllLists,
      invalidateCaches: () => invalidateListQueries(queryClient),
    },
    {
      key: 'statuses',
      icon: Bookmark,
      label: 'Watch statuses',
      description: 'Watching, Watched, Plan to Watch and Dropped labels.',
      count: stats?.watch_statuses_count,
      unitSingular: 'label',
      clearFn: api.clearAllWatchStatuses,
      invalidateCaches: () => invalidateWatchStatusQueries(queryClient),
    },
    {
      key: 'searches',
      icon: Search,
      label: 'Recent searches',
      description: 'Queries offered when the search field is empty.',
      count: recentSearchCount,
      unitSingular: 'search',
      unitPlural: 'searches',
      clearFn: clearRecentSearches,
    },
  ];

  return (
    <>
      <SettingsQueryError
        query={statsQuery}
        className='mx-4 mt-4 sm:mx-5'
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
              id={settingsControlId(cat.label)}
              data-clear-row={cat.key}
              className={SETTINGS_ROW_CLASS}
            >
              <div className='flex min-w-0 flex-1 basis-32 items-center gap-3'>
                <cat.icon
                  aria-hidden='true'
                  className='size-[18px] shrink-0 text-zinc-400'
                  strokeWidth={1.75}
                />
                <div className='min-w-0'>
                  <span className='flex flex-wrap items-baseline gap-x-2'>
                    <h3
                      data-clear-heading
                      tabIndex={-1}
                      className='text-[16px] font-medium leading-snug text-zinc-100 focus:outline-hidden'
                    >
                      {cat.label}
                    </h3>
                    <span className='text-[12px] tabular-nums text-zinc-500'>
                      {cat.count === undefined
                        ? '—'
                        : pluralize(cat.count, cat.unitSingular, cat.unitPlural)}
                    </span>
                  </span>
                  <p className={SETTINGS_ROW_DESCRIPTION_CLASS}>{cat.description}</p>
                </div>
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
                      className={cn('h-9 px-3 text-[13px]', SETTINGS_OUTLINE_BUTTON_CLASS)}
                    >
                      Cancel
                    </Button>
                    <Button
                      size='sm'
                      aria-label={`Clear permanently: ${cat.label.toLowerCase()}`}
                      onClick={() => {
                        if (!queryClient.isMutating({ mutationKey: DATA_MUTATION_KEY }))
                          clearMutation.mutate(cat);
                      }}
                      disabled={isWorking || cat.count === undefined}
                      className='h-9 rounded-lg border-0 bg-red-500 px-3 text-[13px] font-semibold text-white hover:bg-red-600'
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
                    disabled={cat.count === undefined || isEmpty || isWorking}
                    className={cn(
                      'h-9 rounded-lg px-3 text-[13px] font-medium',
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
    </>
  );
}

export function DataSection() {
  return (
    <div className='space-y-8'>
      <SettingsGroup>
        <SettingsGroupHeader
          icon={Download}
          title='Backup & restore'
          description='Export your data to a JSON file, or merge one back in.'
        />
        <SettingsCard>
          <BackupRestore />
        </SettingsCard>
      </SettingsGroup>
      <SettingsGroup>
        <SettingsGroupHeader
          icon={Eraser}
          title='Clear local records'
          description='Permanently remove stored records by category.'
        />
        <SettingsCard>
          <DataManager />
        </SettingsCard>
      </SettingsGroup>
    </div>
  );
}
