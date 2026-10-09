import { useQuery } from '@tanstack/react-query';
import { History, LayoutList, Library, Play, Search } from 'lucide-react';
import { useCallback, useDeferredValue, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ListsManager } from '@/components/list/lists-manager';
import {
  MEDIA_CARD_TEXT_BLOCK_HEIGHT_PX,
  MediaCard,
  MediaCardSkeleton,
  mediaCardRailKey,
} from '@/components/media-card';
import {
  HistoryItem,
  HistoryListView,
  isWatchStatusValue,
  LibraryList,
  watchProgressItemKey,
} from '@/components/profile-collection-rows';
import {
  LibraryToolbar,
  ViewToggle,
  type LibrarySort,
} from '@/components/profile-library-controls';
import { ProfileAvatarEditor } from '@/components/profile-avatar';
import { ProfileSettingsPopover } from '@/components/profile-settings-popover';
import { RetryBanner } from '@/components/retry-banner';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/ui/search-input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { WindowVirtualizedGrid } from '@/components/window-virtualized-grid';
import { useDocumentTitle } from '@/hooks/use-document-title';
import {
  type LocalProfile,
  type LocalProfileUpdate,
  useLocalProfile,
} from '@/hooks/use-local-profile';
import {
  useContinueWatching,
  useLibraryItems,
  useTotalWatchTime,
  useWatchHistory,
  useWatchStatuses,
} from '@/hooks/use-media-library';
import {
  api,
  type MediaItem,
  WATCH_STATUS_COLORS,
  WATCH_STATUS_LABELS,
  WATCH_STATUSES,
  type WatchStatus,
} from '@/lib/api';
import { DATA_STATS_QUERY_KEY, DATA_STATS_STALE_TIME_MS } from '@/lib/query-invalidation';
import { cn, SIDEBAR_PAGE_COLUMN_INSETS } from '@/lib/utils';

const PROFILE_MEDIA_GRID_SKELETON_KEYS = Array.from(
  { length: 12 },
  (_, index) => `profile-grid-skeleton-${index}`,
);

// Leading year of `2010` / `2010–2015`; undated titles sink in both directions.
function compareReleaseYears(a: MediaItem, b: MediaItem, direction: 1 | -1): number {
  const left = Number.parseInt(a.year ?? '', 10);
  const right = Number.parseInt(b.year ?? '', 10);
  if (Number.isNaN(left) || Number.isNaN(right)) {
    return Number(Number.isNaN(left)) - Number(Number.isNaN(right));
  }
  return (left - right) * direction;
}

const PROFILE_TABS = [
  { id: 'library', label: 'Library', icon: Library },
  { id: 'lists', label: 'Lists', icon: LayoutList },
  { id: 'history', label: 'History', icon: History },
  { id: 'continue-watching', label: 'Continue Watching', icon: Play },
] as const;

type ProfileTabId = (typeof PROFILE_TABS)[number]['id'];

function isProfileTabId(value: string | null): value is ProfileTabId {
  return PROFILE_TABS.some((tab) => tab.id === value);
}

// Deferred so typing in the field never blocks on the filtered render.
function useNormalizedSearchQuery(value: string): string {
  return useDeferredValue(value).trim().toLowerCase();
}

export function Profile() {
  const location = useLocation();
  useDocumentTitle(location.pathname === '/library' ? 'Library' : 'Profile');
  const {
    profile,
    viewMode,
    updateProfile,
    updateViewMode,
    isSaving: isSavingProfilePreferences,
  } = useLocalProfile();

  // Preserve the active tab across details navigation.
  const routeTab: ProfileTabId = location.pathname === '/library' ? 'library' : 'history';
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const activeTab = isProfileTabId(tabParam) ? tabParam : routeTab;
  const setActiveTab = useCallback(
    (tab: string) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (tab === routeTab) next.delete('tab');
          else next.set('tab', tab);
          return next;
        },
        { replace: true },
      );
    },
    [routeTab, setSearchParams],
  );

  const {
    data: library,
    isLoading: libraryLoading,
    isError: libraryError,
    isFetching: libraryFetching,
    refetch: refetchLibrary,
  } = useLibraryItems();

  const {
    data: history,
    isLoading: historyLoading,
    isError: historyError,
    isFetching: historyFetching,
    refetch: refetchHistory,
  } = useWatchHistory({ enabled: activeTab === 'history' });

  // Only its own tab consumes this — every other profile visit skips the read.
  const {
    data: continueWatching,
    isLoading: continueWatchingLoading,
    isError: continueWatchingError,
    isFetching: continueWatchingFetching,
    refetch: refetchContinueWatching,
  } = useContinueWatching({
    enabled: activeTab === 'continue-watching',
  });

  // ListsManager fetches full list rows only when its tab opens.
  const { data: dataStats } = useQuery({
    queryKey: DATA_STATS_QUERY_KEY,
    queryFn: api.getDataStats,
    staleTime: DATA_STATS_STALE_TIME_MS,
  });

  const {
    data: allWatchStatuses,
    isError: watchStatusesError,
    isFetching: watchStatusesFetching,
    refetch: refetchWatchStatuses,
  } = useWatchStatuses();

  // Backend aggregate — the collapsed history rows would undercount.
  const { data: totalWatchTimeSecs } = useTotalWatchTime();

  const [libraryStatusFilter, setLibraryStatusFilter] = useState<WatchStatus | 'all'>('all');
  const [libraryTypeFilter, setLibraryTypeFilter] = useState<'all' | 'movie' | 'series'>('all');
  const [librarySort, setLibrarySort] = useState<LibrarySort>('default');
  const [librarySearch, setLibrarySearch] = useState('');
  const normalizedLibrarySearch = useNormalizedSearchQuery(librarySearch);
  const libraryReadFailed = libraryError && library === undefined;
  const statusFilterPending = libraryStatusFilter !== 'all' && allWatchStatuses === undefined;

  const handleViewModeChange = useCallback(
    (mode: 'grid' | 'list') => {
      void updateViewMode(mode).catch(() => toast.error('Failed to save view mode'));
    },
    [updateViewMode],
  );

  const resetLibraryFilters = useCallback(() => {
    setLibraryStatusFilter('all');
    setLibraryTypeFilter('all');
    setLibrarySort('default');
    setLibrarySearch('');
  }, []);

  // Filter and sort changes do not affect unfiltered status counts.
  const statusCounts = useMemo(() => {
    const counts = {} as Record<WatchStatus, number>;
    for (const item of library ?? []) {
      const status = allWatchStatuses?.[item.id];
      if (status && isWatchStatusValue(status)) counts[status] = (counts[status] ?? 0) + 1;
    }
    return counts;
  }, [library, allWatchStatuses]);

  // One combined predicate when filters are active; otherwise the source array passes through.
  const filteredLibrary = useMemo(() => {
    const source = library ?? [];
    const hasStatusFilter = libraryStatusFilter !== 'all';
    const hasTypeFilter = libraryTypeFilter !== 'all';
    const hasSearch = normalizedLibrarySearch.length > 0;
    let items = source;
    if (hasStatusFilter || hasTypeFilter || hasSearch) {
      items = items.filter(
        (item) =>
          (!hasStatusFilter || allWatchStatuses?.[item.id] === libraryStatusFilter) &&
          (!hasTypeFilter || item.type === libraryTypeFilter) &&
          (!hasSearch || item.title.toLowerCase().includes(normalizedLibrarySearch)),
      );
    }
    switch (librarySort) {
      case 'title-asc':
        items = items.toSorted((a, b) => a.title.localeCompare(b.title));
        break;
      case 'title-desc':
        items = items.toSorted((a, b) => b.title.localeCompare(a.title));
        break;
      case 'year-desc':
        items = items.toSorted((a, b) => compareReleaseYears(a, b, -1));
        break;
      case 'year-asc':
        items = items.toSorted((a, b) => compareReleaseYears(a, b, 1));
        break;
      case 'default':
        break;
      default: {
        const unhandled: never = librarySort;
        return unhandled;
      }
    }
    return items;
  }, [
    library,
    libraryStatusFilter,
    libraryTypeFilter,
    librarySort,
    normalizedLibrarySearch,
    allWatchStatuses,
  ]);

  const historyCount =
    activeTab === 'history' && history !== undefined
      ? history.length
      : (dataStats?.history_title_count ?? history?.length);
  const libraryCount = library?.length ?? 0;
  const listsCount = dataStats?.lists_count ?? 0;

  const [historySearch, setHistorySearch] = useState('');
  const normalizedHistorySearch = useNormalizedSearchQuery(historySearch);
  const filteredHistory = useMemo(() => {
    if (!history) return [];
    if (!normalizedHistorySearch) return history;
    return history.filter((item) => item.title.toLowerCase().includes(normalizedHistorySearch));
  }, [history, normalizedHistorySearch]);

  // Per-tab counters for the pill labels — 0/loading reads as no badge.
  const tabCounts: Partial<Record<ProfileTabId, number>> = {
    library: libraryCount || undefined,
    lists: listsCount || undefined,
    history: historyCount || undefined,
    'continue-watching': continueWatching?.length || undefined,
  };

  return (
    <div className='relative min-h-screen page-enter'>
      <div
        className={`mx-auto w-full max-w-7xl ${SIDEBAR_PAGE_COLUMN_INSETS} pt-6 pb-16 space-y-6 relative z-10`}
      >
        <ProfileHeader
          profile={profile}
          onUpdateProfile={updateProfile}
          isSaving={isSavingProfilePreferences}
          libraryCount={library?.length}
          listsCount={dataStats?.lists_count}
          historyCount={historyCount}
          totalWatchTimeSecs={totalWatchTimeSecs}
          statusCounts={statusCounts}
        />

        <Tabs value={activeTab} onValueChange={setActiveTab} className='space-y-4'>
          <TabsList
            aria-label='Profile collections'
            className='max-w-full justify-start overflow-x-auto rounded-lg border border-white/[0.07] bg-white/[0.03] p-1 h-auto gap-0.5 scrollbar-hide'
          >
            {PROFILE_TABS.map((tab) => (
              <TabsTrigger
                key={tab.id}
                value={tab.id}
                style={tab.id === activeTab ? { backgroundColor: 'var(--accent-nav)' } : undefined}
                className={cn(
                  'shrink-0 px-3 py-2 rounded-md text-[13px] font-medium shadow-none transition-colors flex items-center gap-1.5 hover:text-zinc-100',
                  tab.id === activeTab
                    ? 'text-(--on-accent-nav) hover:text-(--on-accent-nav)'
                    : 'text-zinc-400',
                )}
              >
                <tab.icon className='w-3 h-3' />
                <span>{tab.label}</span>
                {tabCounts[tab.id] !== undefined && (
                  <span className='text-[10px] tabular-nums leading-none opacity-60'>
                    {tabCounts[tab.id]}
                  </span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>

          {activeTab === 'library' && libraryCount > 0 && (
            <LibraryToolbar
              typeFilter={libraryTypeFilter}
              onTypeFilterChange={setLibraryTypeFilter}
              statusFilter={libraryStatusFilter}
              onStatusFilterChange={setLibraryStatusFilter}
              statusCounts={statusCounts}
              libraryCount={libraryCount}
              filteredCount={filteredLibrary.length}
              search={librarySearch}
              onSearchChange={setLibrarySearch}
              sort={librarySort}
              onSortChange={setLibrarySort}
              viewMode={viewMode}
              onViewModeChange={handleViewModeChange}
              onReset={resetLibraryFilters}
            />
          )}

          <TabsContent value='library' className='space-y-4'>
            <CollectionTabContent
              isError={libraryReadFailed || (statusFilterPending && watchStatusesError)}
              isLoading={libraryLoading || statusFilterPending}
              items={filteredLibrary}
              errorLabel={libraryReadFailed ? 'your library' : 'your watch statuses'}
              onRetry={libraryReadFailed ? refetchLibrary : refetchWatchStatuses}
              isRetrying={libraryReadFailed ? libraryFetching : watchStatusesFetching}
              viewMode={viewMode}
              getItemKey={mediaCardRailKey}
              renderItem={(item) => (
                <MediaCard
                  item={item}
                  currentStatusOverride={allWatchStatuses?.[item.id] ?? null}
                  isInLibraryOverride
                />
              )}
              renderList={(items) => <LibraryList items={items} watchStatuses={allWatchStatuses} />}
              empty={
                library && library.length > 0 ? (
                  <EmptyState
                    icon={<Library className='w-6 h-6 text-zinc-600' />}
                    title={librarySearch.trim() ? 'No matching items' : 'No items with this filter'}
                    action={
                      <Button
                        size='sm'
                        variant='ghost'
                        className='h-8 text-xs text-zinc-400'
                        onClick={resetLibraryFilters}
                      >
                        Clear filters
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState
                    icon={<Library className='w-6 h-6 text-zinc-600' />}
                    title='Your library is empty'
                    subtitle='Add movies and shows to track them here.'
                    action={<EmptyStateLink to='/search'>Browse titles</EmptyStateLink>}
                  />
                )
              }
            />
          </TabsContent>

          <TabsContent value='lists'>
            <ListsManager />
          </TabsContent>

          <TabsContent value='history' className='space-y-4'>
            {history && history.length > 0 && (
              <div className='flex items-center gap-2'>
                <SearchInput
                  placeholder='Search history…'
                  value={historySearch}
                  onValueChange={setHistorySearch}
                  clearLabel='Clear history search'
                  wrapperClassName='flex-1'
                  className='h-9 text-sm bg-white/[0.03] border-white/[0.07] text-white placeholder:text-zinc-600 focus-visible:ring-white/10 rounded-lg'
                />
                <ViewToggle viewMode={viewMode} onChange={handleViewModeChange} />
              </div>
            )}
            <CollectionTabContent
              isError={historyError && history === undefined}
              isLoading={historyLoading}
              items={filteredHistory}
              errorLabel='your watch history'
              onRetry={refetchHistory}
              isRetrying={historyFetching}
              viewMode={viewMode}
              getItemKey={watchProgressItemKey}
              renderItem={(item) => <HistoryItem item={item} />}
              renderList={(items) => <HistoryListView items={items} />}
              empty={
                historySearch ? (
                  <EmptyState
                    icon={<Search className='w-6 h-6 text-zinc-600' />}
                    title='No results'
                    subtitle={`Nothing in your history matches "${historySearch}".`}
                    action={
                      <Button
                        size='sm'
                        variant='ghost'
                        className='h-8 text-xs text-zinc-400'
                        onClick={() => setHistorySearch('')}
                      >
                        Clear search
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState
                    icon={<History className='w-6 h-6 text-zinc-600' />}
                    title='No watch history yet'
                    subtitle='Start watching to see it here.'
                    action={<EmptyStateLink to='/'>Find something to watch</EmptyStateLink>}
                  />
                )
              }
            />
          </TabsContent>

          <TabsContent value='continue-watching' className='space-y-4'>
            {continueWatching && continueWatching.length > 0 && !continueWatchingLoading && (
              <div className='flex items-center justify-end'>
                <ViewToggle viewMode={viewMode} onChange={handleViewModeChange} />
              </div>
            )}
            <CollectionTabContent
              isError={continueWatchingError && continueWatching === undefined}
              isLoading={continueWatchingLoading || continueWatching === undefined}
              items={continueWatching ?? []}
              errorLabel='continue watching'
              onRetry={refetchContinueWatching}
              isRetrying={continueWatchingFetching}
              viewMode={viewMode}
              getItemKey={watchProgressItemKey}
              renderItem={(item) => <HistoryItem item={item} />}
              renderList={(items) => <HistoryListView items={items} />}
              empty={
                <EmptyState
                  icon={<Play className='w-6 h-6 text-zinc-600 ml-0.5' />}
                  title='Nothing to continue'
                  subtitle='You have no unfinished items.'
                />
              }
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function ProfileHeader({
  profile,
  onUpdateProfile,
  isSaving,
  libraryCount,
  listsCount,
  historyCount,
  totalWatchTimeSecs,
  statusCounts,
}: {
  profile: LocalProfile;
  onUpdateProfile: (updates: LocalProfileUpdate) => Promise<void>;
  isSaving: boolean;
  libraryCount: number | undefined;
  listsCount: number | undefined;
  historyCount: number | undefined;
  totalWatchTimeSecs: number | undefined;
  statusCounts: Record<WatchStatus, number>;
}) {
  return (
    <div>
      <div className='rounded-xl border border-white/[0.06] bg-white/[0.02] px-5 py-4 sm:px-6'>
        <div className='flex flex-col gap-5 lg:flex-row lg:items-center lg:gap-8'>
          <div className='flex min-w-0 items-center gap-4 lg:w-56 lg:shrink-0'>
            <ProfileAvatarEditor profile={profile} onUpdate={onUpdateProfile} />

            <div className='min-w-0'>
              <div className='flex min-w-0 items-center gap-2'>
                <h1
                  dir='auto'
                  title={profile.username}
                  className='truncate text-[22px] font-semibold tracking-[-0.03em] text-white'
                >
                  {profile.username}
                </h1>
                <div className='shrink-0'>
                  <ProfileSettingsPopover
                    profile={profile}
                    onUpdate={onUpdateProfile}
                    isSaving={isSaving}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className='grid w-full max-w-2xl grid-cols-4 gap-3 self-center lg:mx-auto lg:flex-1'>
            <StatChip value={libraryCount} label='Library' valueClassName='text-(--accent-nav)' />
            <StatChip value={listsCount} label='Lists' valueClassName='text-white' />
            <StatChip value={historyCount} label='History' valueClassName='text-white' />
            <StatChip
              value={
                totalWatchTimeSecs == null ? undefined : formatHoursWatched(totalWatchTimeSecs)
              }
              label='Hours watched'
              valueClassName='text-white'
              title='Estimated from saved playback progress, including seeks and episodes marked watched.'
            />
          </div>
        </div>
        {WATCH_STATUSES.some((status) => statusCounts[status] > 0) && (
          <div className='mt-4 flex flex-wrap justify-center gap-x-6 gap-y-2 border-t border-white/[0.06] pt-3'>
            {WATCH_STATUSES.map((s) => {
              const count = statusCounts[s] ?? 0;
              if (count === 0) return null;
              const colors = WATCH_STATUS_COLORS[s];
              return (
                <span key={s} className='flex items-center gap-1.5 text-[12px]'>
                  <span className={cn('font-medium tabular-nums', colors.text)}>{count}</span>
                  <span className='text-zinc-400'>{WATCH_STATUS_LABELS[s]}</span>
                </span>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function formatHoursWatched(secs: number): string {
  const hours = Math.floor(secs / 360) / 10;
  return hours === 0 && secs > 0
    ? '<0.1'
    : hours.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function StatChip({
  value,
  label,
  valueClassName,
  title,
}: {
  value: number | string | undefined;
  label: string;
  valueClassName?: string;
  title?: string;
}) {
  return (
    <div className='flex min-w-0 flex-col items-center gap-1.5 text-center' title={title}>
      <span
        className={cn(
          'text-[21px] font-semibold tabular-nums tracking-tight leading-none',
          valueClassName,
        )}
      >
        {value ?? '—'}
      </span>
      <span className='text-[11px] leading-4 text-zinc-400'>{label}</span>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  subtitle,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className='flex flex-col items-center justify-center py-12 gap-3 border border-white/[0.06] rounded-lg bg-white/[0.015] text-center px-6'>
      <div className='w-10 h-10 flex items-center justify-center'>{icon}</div>
      <p className='text-[15px] font-semibold text-zinc-200'>{title}</p>
      {subtitle && <p className='text-[13px] text-zinc-500 max-w-xs leading-relaxed'>{subtitle}</p>}
      {action}
    </div>
  );
}

function EmptyStateLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Button asChild size='sm' className='mt-1 h-8 border-0 text-[12px] accent-lattice'>
      <Link to={to}>{children}</Link>
    </Button>
  );
}

function CollectionTabContent<T>({
  isError,
  isLoading,
  isRetrying,
  items,
  errorLabel,
  onRetry,
  viewMode,
  getItemKey,
  renderItem,
  renderList,
  empty,
}: {
  isError: boolean;
  isLoading: boolean;
  isRetrying: boolean;
  items: T[];
  errorLabel: string;
  onRetry: () => void;
  viewMode: 'grid' | 'list';
  getItemKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => React.ReactNode;
  renderList: (items: T[]) => React.ReactNode;
  empty: React.ReactNode;
}) {
  if (isError) {
    return (
      <RetryBanner
        message={`Couldn't load ${errorLabel}.`}
        onRetry={onRetry}
        isRetrying={isRetrying}
      />
    );
  }
  if (isLoading) {
    return (
      <div
        aria-hidden='true'
        className={
          viewMode === 'grid'
            ? 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4'
            : 'flex flex-col gap-1.5'
        }
      >
        {PROFILE_MEDIA_GRID_SKELETON_KEYS.map((key) =>
          viewMode === 'grid' ? (
            <MediaCardSkeleton key={key} />
          ) : (
            <Skeleton key={key} className='h-[70px] w-full rounded-md bg-zinc-900/50' />
          ),
        )}
      </div>
    );
  }
  if (items.length > 0) {
    return viewMode === 'grid' ? (
      <WindowVirtualizedGrid
        items={items}
        getItemKey={getItemKey}
        renderItem={renderItem}
        estimateItemHeight={(itemWidth) => itemWidth * 1.5 + MEDIA_CARD_TEXT_BLOCK_HEIGHT_PX}
      />
    ) : (
      renderList(items)
    );
  }
  return empty;
}
