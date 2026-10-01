import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { AlertTriangle, Download, Loader2, type LucideIcon, Upload } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api, getErrorMessage } from '@/lib/api';
import { flushPendingAppWrites } from '@/lib/pending-app-writes';
import {
  DATA_STATS_QUERY_KEY,
  DATA_STATS_STALE_TIME_MS,
  invalidateDataStatsQuery,
  invalidateLibraryQueries,
  invalidateListQueries,
  invalidatePlaybackHistoryQueries,
  invalidateSettingsQueries,
  invalidateStoredDataQueries,
  invalidateWatchStatusQueries,
} from '@/lib/query-invalidation';
import { cn } from '@/lib/utils';
import { SETTINGS_OUTLINE_BUTTON_CLASS, SettingsGroup, SettingsGroupHeader } from './chrome';

// ── Types ────────────────────────────────────────────────────────────────────

interface DataCategory {
  key: 'history' | 'library' | 'lists' | 'statuses';
  label: string;
  description: string;
  count: number;
  unit: string;
  clearFn: () => Promise<void>;
  invalidateCaches: () => Promise<void>;
}

// ── Backup & Restore ─────────────────────────────────────────────────────────

function BackupRestore() {
  const queryClient = useQueryClient();
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      const selected = await saveDialog({
        title: 'Export Stremiro Backup',
        defaultPath: `stremiro-backup-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!selected) return;
      const path = selected.toLowerCase().endsWith('.json') ? selected : `${selected}.json`;

      await flushPendingAppWrites();
      await api.exportAppDataToFile(path);
      toast.success('Backup exported successfully');
    } catch (err) {
      toast.error(`Export failed: ${getErrorMessage(err)}`);
    } finally {
      setExporting(false);
    }
  };

  const handleImport = async () => {
    setImporting(true);
    try {
      const selected = await openDialog({
        title: 'Import Stremiro Backup',
        multiple: false,
        directory: false,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!selected) return;

      await flushPendingAppWrites();
      const result = await api.importAppDataFromFile(selected);
      await Promise.all([
        invalidateStoredDataQueries(queryClient),
        (result.settings_restored || result.addons_imported > 0) &&
          invalidateSettingsQueries(queryClient),
      ]);
      const summary = [
        `${result.history_imported} history`,
        `${result.library_imported} library`,
        `${result.lists_imported} lists`,
        `${result.statuses_imported} statuses`,
        result.addons_imported > 0 && `${result.addons_imported} addons`,
        result.settings_restored && 'settings restored',
      ].filter(Boolean);
      toast.success('Backup imported', { description: summary.join(' · ') });
    } catch (err) {
      toast.error(`Import failed: ${getErrorMessage(err)}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className='flex items-center justify-between gap-4 px-5 py-4'>
      <div className='min-w-0'>
        <p className='text-[13.5px] font-medium text-white'>Backup & restore</p>
        <p className='mt-0.5 text-[12.5px] leading-relaxed text-zinc-500'>
          Export history, library, lists, addons, and settings to a JSON file. Importing merges
          records and restores settings. Addon URLs can hold account keys — keep backups private.
        </p>
      </div>
      <div className='flex shrink-0 items-center gap-2'>
        <BackupButton
          icon={Download}
          busy={exporting}
          disabled={exporting || importing}
          onClick={handleExport}
        >
          Export
        </BackupButton>
        <BackupButton
          icon={Upload}
          busy={importing}
          disabled={exporting || importing}
          onClick={handleImport}
        >
          Import
        </BackupButton>
      </div>
    </div>
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
      className={cn('h-8 gap-1.5 px-3 text-[12px]', SETTINGS_OUTLINE_BUTTON_CLASS)}
    >
      {busy ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : <Icon className='h-3.5 w-3.5' />}
      {children}
    </Button>
  );
}

// ── Data manager ─────────────────────────────────────────────────────────────

function DataManager() {
  const queryClient = useQueryClient();
  const [confirmKey, setConfirmKey] = useState<string | null>(null);

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: DATA_STATS_QUERY_KEY,
    queryFn: api.getDataStats,
    staleTime: DATA_STATS_STALE_TIME_MS,
  });

  const clearMutation = useMutation({
    mutationFn: async (cat: DataCategory) => {
      await cat.clearFn();
      return cat;
    },
    onSuccess: async (cat) => {
      setConfirmKey(null);
      // Invalidation refetches this mounted query — a manual refetchStats()
      // would issue a second identical read.
      await Promise.all([cat.invalidateCaches(), invalidateDataStatsQuery(queryClient)]);
      toast.success(`${cat.label} cleared`);
    },
    onError: (err: unknown, cat) => {
      setConfirmKey(null);
      toast.error(`Failed to clear ${cat.label}: ${getErrorMessage(err)}`);
    },
  });

  const categories: DataCategory[] = [
    {
      key: 'history',
      label: 'Watch History',
      description: 'Viewed episodes, movies and progress data.',
      count: stats?.history_count ?? 0,
      unit: 'entries',
      clearFn: api.clearWatchHistory,
      invalidateCaches: () => invalidatePlaybackHistoryQueries(queryClient),
    },
    {
      key: 'library',
      label: 'Library',
      description: 'Saved movies and shows.',
      count: stats?.library_count ?? 0,
      unit: 'items',
      clearFn: api.clearLibrary,
      // `clear_library` wipes watch statuses too — status is a library
      // attribute, so both surfaces refetch.
      invalidateCaches: async () => {
        await Promise.all([
          invalidateLibraryQueries(queryClient),
          invalidateWatchStatusQueries(queryClient),
        ]);
      },
    },
    {
      key: 'lists',
      label: 'Custom Lists',
      description: 'All custom lists and their contents.',
      count: stats?.lists_count ?? 0,
      unit: 'lists',
      clearFn: api.clearAllLists,
      invalidateCaches: () => invalidateListQueries(queryClient),
    },
    {
      key: 'statuses',
      label: 'Watch Statuses',
      description: 'Watching / Watched / Plan to Watch / Dropped labels.',
      count: stats?.watch_statuses_count ?? 0,
      unit: 'labels',
      clearFn: api.clearAllWatchStatuses,
      invalidateCaches: () => invalidateWatchStatusQueries(queryClient),
    },
  ];

  return (
    <div className='border-t border-white/[0.06]'>
      <div className='flex items-baseline justify-between gap-3 px-5 pb-1 pt-4'>
        <p className='text-[11px] font-medium uppercase tracking-[0.12em] text-zinc-500'>
          Clear local records
        </p>
        <p className='text-[11.5px] text-zinc-600'>Permanent — no undo</p>
      </div>

      <div className='divide-y divide-white/[0.05]'>
        {categories.map((cat) => {
          const isPending = clearMutation.isPending && clearMutation.variables?.key === cat.key;
          const isConfirming = confirmKey === cat.key;
          const isEmpty = cat.count === 0;

          return (
            <div key={cat.key} className='flex items-center justify-between gap-4 px-5 py-3.5'>
              <div className='min-w-0'>
                <div className='flex flex-wrap items-center gap-2'>
                  <span className='text-[13.5px] font-medium text-white'>{cat.label}</span>
                  {statsLoading ? (
                    <span className='text-[12px] text-zinc-600'>loading…</span>
                  ) : (
                    <span className='text-[12px] tabular-nums text-zinc-500'>
                      {cat.count} {cat.unit}
                    </span>
                  )}
                </div>
                <p className='mt-0.5 truncate text-[12.5px] text-zinc-500'>{cat.description}</p>
              </div>

              <div className='flex shrink-0 items-center gap-2'>
                {isConfirming ? (
                  <>
                    <span className='flex items-center gap-1 text-[12px] font-medium text-amber-400'>
                      <AlertTriangle className='h-3.5 w-3.5' />
                      Confirm?
                    </span>
                    <Button
                      size='sm'
                      variant='outline'
                      onClick={() => setConfirmKey(null)}
                      className={cn('h-8 px-3 text-[12px]', SETTINGS_OUTLINE_BUTTON_CLASS)}
                    >
                      Cancel
                    </Button>
                    <Button
                      size='sm'
                      onClick={() => clearMutation.mutate(cat)}
                      disabled={isPending}
                      className='h-8 rounded-lg border-0 bg-red-500 px-3 text-[12px] font-semibold text-white hover:bg-red-600'
                    >
                      {isPending ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : 'Clear'}
                    </Button>
                  </>
                ) : (
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() => setConfirmKey(cat.key)}
                    disabled={isEmpty || clearMutation.isPending}
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
      </div>
    </div>
  );
}

// ── Main export ──────────────────────────────────────────────────────────────

export function DataSection() {
  return (
    <SettingsGroup>
      <SettingsGroupHeader
        title='Data & storage'
        description='Back up this device or permanently clear local records.'
      />
      <BackupRestore />
      <DataManager />
    </SettingsGroup>
  );
}
