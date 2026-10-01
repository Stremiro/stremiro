import { useQuery } from '@tanstack/react-query';
import { History, LayoutList, Library, Play, Search, TriangleAlert } from 'lucide-react';
import { useCallback, useDeferredValue, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ListsManager } from '@/components/list/lists-manager';
import {
  MEDIA_CARD_TEXT_BLOCK_HEIGHT_PX,
  MediaCard,
  MediaCardSkeleton,
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
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/ui/search-input';
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
import { cn } from '@/lib/utils';

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
  const deferred = useDeferredValue(value);
  return useMemo(() => deferred.trim().toLowerCase(), [deferred]);
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
    refetch: refetchLibrary,
  } = useLibraryItems();

  const {
    data: history,
    isLoading: historyLoading,
    isError: historyError,
    refetch: refetchHistory,
  } = useWatchHistory();

  // Only its own tab consumes this — every other profile visit skips the read.
  const {
    data: continueWatching,
    isLoading: continueWatchingLoading,
    isError: continueWatchingError,
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

  const { data: allWatchStatuses } = useWatchStatuses();

  // Backend aggregate — the collapsed history rows would undercount.
  const { data: totalWatchTimeSecs } = useTotalWatchTime();

  const [libraryStatusFilter, setLibraryStatusFilter] = useState<WatchStatus | 'all'>('all');
  const [libraryTypeFilter, setLibraryTypeFilter] = useState<'all' | 'movie' | 'series'>('all');
  const [librarySort, setLibrarySort] = useState<LibrarySort>('default');
  const [librarySearch, setLibrarySearch] = useState('');
  const normalizedLibrarySearch = useNormalizedSearchQuery(librarySearch);

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

  const totalWatched = history?.length ?? 0;
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
    history: totalWatched || undefined,
    'continue-watching': continueWatching?.length || undefined,
  };

  return (
    <div className='relative min-h-screen page-enter'>
      <div className='mx-auto w-full max-w-7xl pr-4 pl-[84px] sm:pr-6 lg:pl-[92px] lg:pr-8 pt-6 pb-16 space-y-6 relative z-10'>
        <ProfileHeader
          profile={profile}
          onUpdateProfile={updateProfile}
          isSaving={isSavingProfilePreferences}
          libraryCount={libraryCount}
          listsCount={listsCount}
          totalWatched={totalWatched}
          totalWatchTimeSecs={totalWatchTimeSecs}
          statusCounts={statusCounts}
        />

        <Tabs value={activeTab} onValueChange={setActiveTab} className='space-y-4'>
          <TabsList className='bg-white/[0.04] border border-white/[0.07] p-1 rounded-xl h-auto inline-flex gap-0.5 self-start'>
            {PROFILE_TABS.map((tab) => (
              <TabsTrigger
                key={tab.id}
                value={tab.id}
                style={tab.id === activeTab ? { backgroundColor: 'var(--accent-nav)' } : undefined}
                className={cn(
                  'px-4 py-2 rounded-lg text-[13px] font-semibold transition-colors flex items-center gap-1.5 hover:text-zinc-100',
                  tab.id === activeTab
                    ? 'shadow-xs text-(--on-accent-nav) hover:text-(--on-accent-nav)'
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
            />
          )}

          <TabsContent value='library' className='space-y-4'>
            <CollectionTabContent
              isError={libraryError && library === undefined}
              isLoading={libraryLoading}
              items={filteredLibrary}
              errorLabel='your library'
              onRetry={refetchLibrary}
              viewMode={viewMode}
              getItemKey={(item) => `${item.type}:${item.id}`}
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
                      <button
                        type='button'
                        className='text-xs text-zinc-500 hover:text-zinc-300 transition-colors'
                        onClick={resetLibraryFilters}
                      >
                        Clear filters →
                      </button>
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
                      <button
                        type='button'
                        className='text-xs text-zinc-500 hover:text-zinc-300 transition-colors'
                        onClick={() => setHistorySearch('')}
                      >
                        Clear search →
                      </button>
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
  totalWatched,
  totalWatchTimeSecs,
  statusCounts,
}: {
  profile: LocalProfile;
  onUpdateProfile: (updates: LocalProfileUpdate) => Promise<void>;
  isSaving: boolean;
  libraryCount: number;
  listsCount: number;
  totalWatched: number;
  totalWatchTimeSecs: number | undefined;
  statusCounts: Record<WatchStatus, number>;
}) {
  const accentColor = profile.accentColor;

  return (
    <div className='animate-in fade-in slide-in-from-bottom-2 duration-300'>
      <div className='relative rounded-2xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-xs overflow-hidden px-6 py-6'>
        <div
          className='absolute inset-x-0 top-0 h-px pointer-events-none transition-colors duration-700'
          style={{
            background: `linear-gradient(to right, transparent, ${accentColor}40, transparent)`,
          }}
        />

        <div className='flex flex-col sm:flex-row gap-6 items-start sm:items-center justify-between'>
          <div className='flex items-center gap-5'>
            <ProfileAvatarEditor profile={profile} onUpdate={onUpdateProfile} />

            <div className='min-w-0'>
              <div className='flex items-center gap-3 flex-wrap'>
                <h1 className='truncate text-[22px] font-semibold tracking-[-0.03em] text-white'>
                  {profile.username}
                </h1>
                <ProfileSettingsPopover
                  profile={profile}
                  onUpdate={onUpdateProfile}
                  isSaving={isSaving}
                />
              </div>
            </div>
          </div>

          <div className='flex items-center gap-1 flex-wrap rounded-lg bg-black/30 border border-white/[0.05] px-3 py-2 shrink-0'>
            <StatChip value={libraryCount} label='Library' valueClassName='text-(--accent-nav)' />
            <StatDivider />
            <StatChip value={listsCount} label='Lists' valueClassName='text-white' />
            <StatDivider />
            <StatChip value={totalWatched} label='Watched' valueClassName='text-white' />
            {totalWatchTimeSecs != null && (
              <>
                <StatDivider />
                <StatChip
                  value={formatHoursWatched(totalWatchTimeSecs)}
                  label='Hours watched'
                  valueClassName='text-white'
                />
              </>
            )}
            {WATCH_STATUSES.map((s) => {
              const count = statusCounts[s] ?? 0;
              if (count === 0) return null;
              const colors = WATCH_STATUS_COLORS[s];
              return (
                <span key={s} className='flex items-center gap-1'>
                  <StatDivider />
                  <StatChip
                    value={count}
                    label={WATCH_STATUS_LABELS[s]}
                    valueClassName={colors.text}
                  />
                </span>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// Whole hours; a sub-hour total still reads as honest time watched.
function formatHoursWatched(secs: number): string {
  const hours = Math.floor(secs / 3600);
  return hours === 0 && secs > 0 ? '<1' : String(hours);
}

function StatChip({
  value,
  label,
  valueClassName,
}: {
  value: number | string;
  label: string;
  valueClassName?: string;
}) {
  return (
    <div className='flex flex-col items-center px-3 py-2 min-w-[56px]'>
      <span className={cn('text-[22px] font-bold tracking-tight leading-none', valueClassName)}>
        {value}
      </span>
      <span className='text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mt-1.5 whitespace-nowrap'>
        {label}
      </span>
    </div>
  );
}

function StatDivider() {
  return <div className='w-px h-8 bg-white/[0.07]' />;
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
    <div className='flex flex-col items-center justify-center py-16 gap-3 border border-dashed border-white/[0.08] rounded-2xl bg-white/[0.02] text-center px-6'>
      <div className='w-14 h-14 rounded-2xl bg-white/[0.05] border border-white/[0.07] flex items-center justify-center'>
        {icon}
      </div>
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

// Every collection tab runs the same switch: a failed read must never pose
// as an empty list (error wins over loading), a pending read shows skeletons,
// and the populated view is grid-or-list on the shared virtualizers. Per-tab
// wrinkles arrive as resolved props.
function CollectionTabContent<T>({
  isError,
  isLoading,
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
    return <CollectionErrorState label={errorLabel} onRetry={onRetry} />;
  }
  if (isLoading) {
    return (
      <div className='grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4'>
        {PROFILE_MEDIA_GRID_SKELETON_KEYS.map((key) => (
          <MediaCardSkeleton key={key} />
        ))}
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

// A failed collection read must never pose as an empty list or spin a
// skeleton forever — surface the failure with a retry instead.
function CollectionErrorState({ label, onRetry }: { label: string; onRetry: () => void }) {
  return (
    <EmptyState
      icon={<TriangleAlert className='w-6 h-6 text-amber-400/80' />}
      title={`Couldn't load ${label}`}
      subtitle='The read failed — this is usually temporary.'
      action={
        <Button variant='outline' size='sm' onClick={() => onRetry()}>
          Retry
        </Button>
      }
    />
  );
}
