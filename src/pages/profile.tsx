import { useQuery } from '@tanstack/react-query';
import { CheckSquare, History, LayoutList, Library, Search } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, type SetURLSearchParams, useLocation, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import {
  MEDIA_CARD_TEXT_BLOCK_HEIGHT_PX,
  MediaCard,
  MediaCardSkeleton,
  mediaCardRailKey,
} from '@/components/media-card';
import { HistoryItem, HistoryListView, LibraryList } from '@/components/profile-collection-rows';
import {
  LibraryToolbar,
  LibraryBulkActionBar,
  CollectionBulkActionBar,
  useCollectionSelection,
  ViewToggle,
  isLibrarySort,
  SegmentPill,
} from '@/components/profile-library-controls';
import { ProfileAvatarEditor } from '@/components/profile-avatar';
import { ProfileSettingsPopover } from '@/components/profile-settings-popover';
import { RetryBanner } from '@/components/retry-banner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { SearchInput } from '@/components/ui/search-input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { WindowVirtualizedGrid } from '@/components/window-virtualized-grid';
import { WatchStatusIcon } from '@/components/watch-status-icon';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { useTitleSearch } from '@/hooks/use-item-search';
import {
  type LocalProfile,
  type LocalProfileUpdate,
  useLocalProfile,
} from '@/hooks/use-local-profile';
import {
  getOwnWatchStatus,
  useProfileLibrary,
  useBulkAddToList,
  useBulkRemoveFromLibrary,
  useBulkRemoveFromWatchHistory,
  useBulkSetWatchStatus,
  useTotalWatchTime,
  useWatchHistory,
  useWatchStatuses,
  watchTitleKey,
} from '@/hooks/use-media-library';
import { useMountedRef } from '@/hooks/use-mounted-ref';
import {
  api,
  getListErrorMessage,
  getWatchStatusErrorMessage,
  type LibraryFilters,
  type MediaItem,
  type ProfileLibrary,
  type WatchProgress,
  WATCH_STATUS_COLORS,
  WATCH_STATUS_LABELS,
  WATCH_STATUSES,
  type WatchStatus,
} from '@/lib/api';
import { watchProgressItemKey } from '@/lib/history-playback';
import { cn, pluralize, queryNeedsRetry, SIDEBAR_PAGE_COLUMN_INSETS } from '@/lib/utils';

const loadListsManager = () => import('@/components/list/lists-manager');
const ListsManager = lazy(() =>
  loadListsManager().then((module) => ({ default: module.ListsManager })),
);
const warmListsManager = () => void loadListsManager().catch(() => undefined);

const PROFILE_MEDIA_GRID_SKELETON_KEYS = Array.from(
  { length: 12 },
  (_, index) => `profile-grid-skeleton-${index}`,
);
const EMPTY_LIBRARY_ITEMS: MediaItem[] = [];
const EMPTY_LIBRARY_IDS: string[] = [];
const EMPTY_HISTORY_ITEMS: WatchProgress[] = [];
const EMPTY_STATUS_COUNTS: Record<WatchStatus | 'none', number> = {
  watching: 0,
  watched: 0,
  plan_to_watch: 0,
  dropped: 0,
  none: 0,
};

const PROFILE_TABS = [
  { id: 'library', label: 'Library', icon: Library },
  { id: 'lists', label: 'Lists', icon: LayoutList },
  { id: 'history', label: 'History', icon: History },
] as const;

type ProfileTabId = (typeof PROFILE_TABS)[number]['id'];

function isProfileTabId(value: string | null): value is ProfileTabId {
  return PROFILE_TABS.some((tab) => tab.id === value);
}

function readLibraryFilters(searchParams: URLSearchParams) {
  const status = searchParams.get('status');
  const type = searchParams.get('type');
  const sort = searchParams.get('sort');
  return {
    query: searchParams.get('q') ?? '',
    type: type === 'movie' || type === 'series' ? type : 'all',
    status:
      WATCH_STATUSES.find((watchStatus) => watchStatus === status) ??
      (status === 'none' ? 'none' : 'all'),
    sort: isLibrarySort(sort) ? sort : 'default',
  } satisfies LibraryFilters;
}

function patchSearchParams(
  setSearchParams: SetURLSearchParams,
  updates: Record<string, string | null>,
) {
  setSearchParams(
    (current) => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) next.delete(key);
        else next.set(key, value);
      }
      return next;
    },
    { replace: true },
  );
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
    isHydrating: isHydratingProfile,
    isError: profilePreferencesError,
    profilePreferencesQuery,
  } = useLocalProfile();

  // Preserve collection controls across details navigation.
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const activeTab = isProfileTabId(tabParam) ? tabParam : 'library';
  const setActiveTab = (tab: string) =>
    patchSearchParams(setSearchParams, { tab: tab === 'library' ? null : tab });
  // Header aggregates do not retain collection rows.
  const dataStatsQuery = useQuery(api.dataStatsQueryOptions());
  const { data: dataStats } = dataStatsQuery;

  // Backend aggregate — the collapsed history rows would undercount.
  const totalWatchTimeQuery = useTotalWatchTime();
  const { data: totalWatchTimeSecs } = totalWatchTimeQuery;

  const handleViewModeChange = (mode: 'grid' | 'list') => {
    void updateViewMode(mode).catch(() => toast.error('Failed to save view mode'));
  };

  // The open tab's own rows outrank the aggregate header counts.
  const libraryFilters = readLibraryFilters(searchParams);
  const profileLibraryQuery = useProfileLibrary(libraryFilters, {
    enabled: activeTab === 'library',
  });
  const historyQuery = useWatchHistory({ enabled: activeTab === 'history' });
  // A filter switch without placeholder rows keeps the last library totals.
  const [heldLibrary, setHeldLibrary] = useState<ProfileLibrary>();
  const tabLibrary =
    activeTab === 'library' ? (profileLibraryQuery.data ?? heldLibrary) : undefined;
  if (tabLibrary !== heldLibrary) setHeldLibrary(tabLibrary);
  const libraryTabRef = useRef<HTMLButtonElement>(null);
  const historyCount =
    (activeTab === 'history' ? historyQuery.data?.length : undefined) ??
    dataStats?.history_title_count;
  const libraryCount = tabLibrary?.allIds.length ?? dataStats?.library_count;
  const libraryStatusCounts =
    tabLibrary?.statusCounts ?? dataStats?.library_status_counts ?? EMPTY_STATUS_COUNTS;
  const listsCount = dataStats?.lists_count ?? 0;
  // Per-tab counters for the pill labels — 0/loading reads as no badge.
  const tabCounts: Partial<Record<ProfileTabId, number>> = {
    library: libraryCount || undefined,
    lists: listsCount || undefined,
    history: historyCount || undefined,
  };

  return (
    <div className='relative min-h-[calc(100vh-2rem)] page-enter'>
      <div
        className={`mx-auto w-full max-w-7xl ${SIDEBAR_PAGE_COLUMN_INSETS} pt-6 pb-16 space-y-6 relative z-10`}
      >
        <ProfileHeader
          profile={profile}
          onUpdateProfile={updateProfile}
          isSaving={isSavingProfilePreferences}
          isHydrating={isHydratingProfile}
          isError={profilePreferencesError}
          isRetrying={profilePreferencesQuery.isFetching}
          onRetry={() => void profilePreferencesQuery.refetch()}
          isIdentityReady={
            profilePreferencesQuery.data !== undefined && !profilePreferencesQuery.isPlaceholderData
          }
          statsLoading={dataStatsQuery.isPending}
          watchTimeLoading={totalWatchTimeQuery.isPending}
          headerError={
            profilePreferencesError ||
            queryNeedsRetry(dataStatsQuery) ||
            queryNeedsRetry(totalWatchTimeQuery)
          }
          headerRetrying={
            profilePreferencesQuery.isFetching ||
            dataStatsQuery.isFetching ||
            totalWatchTimeQuery.isFetching
          }
          onRetryHeader={() => {
            if (profilePreferencesError) void profilePreferencesQuery.refetch();
            if (dataStatsQuery.isError) void dataStatsQuery.refetch();
            if (totalWatchTimeQuery.isError) void totalWatchTimeQuery.refetch();
          }}
          libraryCount={libraryCount}
          listsCount={dataStats?.lists_count}
          historyCount={historyCount}
          totalWatchTimeSecs={totalWatchTimeSecs}
          statusCounts={libraryStatusCounts}
          statusCountsLoading={tabLibrary === undefined && dataStatsQuery.isPending}
        />

        <Tabs value={activeTab} onValueChange={setActiveTab} className='space-y-4'>
          <TabsList
            aria-label='Profile collections'
            className='relative isolate inline-grid grid-cols-3 max-w-full overflow-x-auto rounded-lg border border-white/[0.07] bg-white/[0.03] p-1 h-auto gap-0 scrollbar-hide'
          >
            <SegmentPill
              index={PROFILE_TABS.findIndex((tab) => tab.id === activeTab)}
              count={PROFILE_TABS.length}
              inset={4}
              className='rounded-md'
            />
            {PROFILE_TABS.map((tab) => (
              <TabsTrigger
                key={tab.id}
                ref={tab.id === 'library' ? libraryTabRef : undefined}
                value={tab.id}
                onPointerEnter={tab.id === 'lists' ? warmListsManager : undefined}
                onFocus={tab.id === 'lists' ? warmListsManager : undefined}
                className={cn(
                  'nav-switch-item relative z-10 shrink-0 gap-1.5 rounded-md bg-transparent px-3 py-2 text-[13px] font-medium shadow-none transition-colors',
                  tab.id === activeTab
                    ? 'text-(--on-accent-nav)'
                    : 'text-zinc-400 hover:text-zinc-100',
                )}
              >
                <tab.icon className='w-3 h-3' />
                <span>{tab.label}</span>
                <span className='w-[5ch] shrink-0 text-left text-[10px] tabular-nums leading-none opacity-60'>
                  {tabCounts[tab.id]}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value='library'>
            <ProfileLibraryTab
              filters={libraryFilters}
              profileLibraryQuery={profileLibraryQuery}
              libraryIds={tabLibrary?.allIds}
              viewMode={viewMode}
              onViewModeChange={handleViewModeChange}
              libraryTabRef={libraryTabRef}
            />
          </TabsContent>

          <TabsContent value='lists'>
            <Suspense
              fallback={
                <div role='status' aria-busy='true' className='space-y-6'>
                  <span className='sr-only'>Loading lists…</span>
                  <Skeleton className='h-[46px] w-full' />
                  <div aria-hidden='true' className='space-y-3'>
                    <Skeleton className='h-14 w-full rounded-xl' />
                    <Skeleton className='h-14 w-full rounded-xl' />
                    <Skeleton className='h-14 w-full rounded-xl' />
                  </div>
                </div>
              }
            >
              <ListsManager />
            </Suspense>
          </TabsContent>

          <TabsContent value='history'>
            <ProfileHistoryTab
              historyQuery={historyQuery}
              viewMode={viewMode}
              onViewModeChange={handleViewModeChange}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function ProfileLibraryTab({
  filters,
  profileLibraryQuery,
  libraryIds,
  viewMode,
  onViewModeChange,
  libraryTabRef,
}: {
  filters: ReturnType<typeof readLibraryFilters>;
  profileLibraryQuery: ReturnType<typeof useProfileLibrary>;
  libraryIds: string[] | undefined;
  viewMode: 'grid' | 'list';
  onViewModeChange: (mode: 'grid' | 'list') => void;
  libraryTabRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const mountedRef = useMountedRef();
  const location = useLocation();
  const [, setSearchParams] = useSearchParams();
  const setCollectionParam = (
    key: 'type' | 'status' | 'sort',
    value: string,
    defaultValue: string,
  ) => patchSearchParams(setSearchParams, { [key]: value === defaultValue ? null : value });

  const {
    data: allWatchStatuses,
    isError: watchStatusesError,
    isFetching: watchStatusesFetching,
    refetch: refetchWatchStatuses,
  } = useWatchStatuses();

  const {
    query: librarySearchParam,
    type: libraryTypeFilter,
    status: libraryStatusFilter,
    sort: librarySort,
  } = filters;
  const [librarySearch, setLibrarySearch] = useState(librarySearchParam);
  const [previousSearchParam, setPreviousSearchParam] = useState(librarySearchParam);
  if (previousSearchParam !== librarySearchParam) {
    setPreviousSearchParam(librarySearchParam);
    setLibrarySearch(librarySearchParam);
  }
  const librarySearchTimerRef = useRef<number | undefined>(undefined);
  const flushLibrarySearch = useCallback(() => {
    window.clearTimeout(librarySearchTimerRef.current);
    librarySearchTimerRef.current = undefined;
    if (librarySearch === librarySearchParam || window.location.pathname !== location.pathname)
      return;
    const next = new URLSearchParams(window.location.search);
    if ((next.get('q') ?? '') !== librarySearchParam) return;
    if (librarySearch) next.set('q', librarySearch);
    else next.delete('q');
    setSearchParams(next, { replace: true });
  }, [librarySearch, librarySearchParam, location.pathname, setSearchParams]);
  useEffect(() => {
    if (librarySearch === librarySearchParam) return;
    librarySearchTimerRef.current = window.setTimeout(flushLibrarySearch, 250);
    return () => window.clearTimeout(librarySearchTimerRef.current);
  }, [librarySearch, librarySearchParam, flushLibrarySearch]);
  // Keep an unfinished search when switching tabs unmounts this owner.
  const flushLibrarySearchRef = useRef(flushLibrarySearch);
  useLayoutEffect(() => {
    flushLibrarySearchRef.current = flushLibrarySearch;
  }, [flushLibrarySearch]);
  useEffect(() => () => flushLibrarySearchRef.current(), []);
  const [confirmBulkRemoveOpen, setConfirmBulkRemoveOpen] = useState(false);
  const bulkRemoveFromLibrary = useBulkRemoveFromLibrary();
  const bulkSetWatchStatus = useBulkSetWatchStatus();
  const bulkAddToList = useBulkAddToList();
  const isBulkBusy =
    bulkRemoveFromLibrary.isPending || bulkSetWatchStatus.isPending || bulkAddToList.isPending;
  const librarySearchRef = useRef<HTMLInputElement>(null);
  const filteredLibrary = profileLibraryQuery.data?.items ?? EMPTY_LIBRARY_ITEMS;
  const librarySearchPending =
    librarySearch !== librarySearchParam || profileLibraryQuery.isFetching;
  const libraryResultsPending =
    profileLibraryQuery.isPlaceholderData ||
    (librarySearch !== librarySearchParam && profileLibraryQuery.data !== undefined);
  const statusCounts = profileLibraryQuery.data?.statusCounts;
  const librarySelectionIds = libraryIds ?? EMPTY_LIBRARY_IDS;
  const libraryCount = libraryIds?.length;
  const filteredLibraryIds = filteredLibrary.map((item) => item.id);
  const { triggerRef: librarySelectionTriggerRef, ...librarySelection } = useCollectionSelection(
    librarySelectionIds,
    filteredLibraryIds,
    true,
    isBulkBusy,
    confirmBulkRemoveOpen,
    libraryTabRef,
  );
  const { selectionMode, selectedIds, exit: exitSelectionMode } = librarySelection;
  const selectAllDisabled =
    profileLibraryQuery.isError ||
    profileLibraryQuery.isFetching ||
    profileLibraryQuery.isPlaceholderData ||
    librarySearch !== librarySearchParam;

  const resetLibraryFilters = () => {
    setLibrarySearch('');
    patchSearchParams(setSearchParams, { q: null, type: null, status: null, sort: null });
    librarySearchRef.current?.focus({ preventScroll: true });
  };

  const selectedLibraryIds = [...selectedIds];
  const allFilteredSelected =
    filteredLibrary.length > 0 && filteredLibrary.every((item) => selectedIds.has(item.id));

  const handleToggleSelect = (item: MediaItem, shiftKey = false) =>
    librarySelection.toggle(item.id, shiftKey);

  const handleSelectAllFiltered = () => {
    if (isBulkBusy || selectAllDisabled) return;
    librarySelection.selectAll(filteredLibraryIds);
  };

  const handleBulkSetStatus = async (status: WatchStatus | null) => {
    if (selectedIds.size === 0 || isBulkBusy) return;
    await bulkSetWatchStatus
      .mutateAsync({ ids: [...selectedIds], status })
      .then((count) => {
        toast.success(
          status === null
            ? `Cleared status for ${pluralize(count, 'title')}`
            : `Set ${pluralize(count, 'title')} to ${WATCH_STATUS_LABELS[status]}`,
        );
      })
      .catch((error: unknown) => {
        toast.error('Failed to update watch statuses', {
          description: getWatchStatusErrorMessage(error),
        });
      });
  };

  const handleBulkAddToList = async (listId: string, listName: string, itemIds: string[]) => {
    if (itemIds.length === 0 || isBulkBusy) return;
    await bulkAddToList
      .mutateAsync({
        listId,
        itemIds,
      })
      .then((count) => {
        toast.success(
          count === 0
            ? 'Selected titles are already in this list'
            : `Added ${pluralize(count, 'title')} to "${listName}"`,
        );
      })
      .catch((error: unknown) => {
        toast.error(getListErrorMessage(error) ?? 'Failed to add titles to list');
      });
  };

  const handleBulkRemove = () => {
    if (selectedIds.size > 0 && !isBulkBusy) setConfirmBulkRemoveOpen(true);
  };

  const confirmBulkRemove = async () => {
    if (selectedIds.size === 0 || isBulkBusy) return;
    await bulkRemoveFromLibrary
      .mutateAsync([...selectedIds])
      .then((count) => {
        toast.success(`Removed ${pluralize(count, 'title')} from Library`);
        if (mountedRef.current) exitSelectionMode();
      })
      .catch(() => {
        toast.error('Failed to remove titles from Library');
      })
      .finally(() => {
        if (mountedRef.current) setConfirmBulkRemoveOpen(false);
      });
  };

  return (
    <div
      className='space-y-4'
      data-collection-selection=''
      data-escape-capture={selectionMode ? '' : undefined}
    >
      {libraryCount === undefined && profileLibraryQuery.isLoading && (
        <div aria-hidden='true' className='space-y-3'>
          <Skeleton className='h-10 w-full rounded-lg' />
          <Skeleton className='h-[38px] w-64 rounded-md' />
        </div>
      )}
      {libraryCount !== undefined && libraryCount > 0 && (
        <LibraryToolbar
          typeFilter={libraryTypeFilter}
          onTypeFilterChange={(type) => setCollectionParam('type', type, 'all')}
          statusFilter={libraryStatusFilter}
          onStatusFilterChange={(status) => setCollectionParam('status', status, 'all')}
          statusCounts={statusCounts ?? EMPTY_STATUS_COUNTS}
          statusesAvailable={profileLibraryQuery.data !== undefined}
          libraryCount={libraryCount}
          filteredCount={filteredLibrary.length}
          search={librarySearch}
          searchPending={librarySearchPending}
          onSearchChange={setLibrarySearch}
          searchInputRef={librarySearchRef}
          sort={librarySort}
          onSortChange={(sort) => setCollectionParam('sort', sort, 'default')}
          viewMode={viewMode}
          onViewModeChange={onViewModeChange}
          onReset={resetLibraryFilters}
          selectionMode={selectionMode}
          selectionTriggerRef={librarySelectionTriggerRef}
          onToggleSelectionMode={() => {
            if (isBulkBusy) return;
            if (selectionMode) exitSelectionMode();
            else librarySelection.begin();
          }}
        />
      )}

      <div
        className='space-y-4'
        // Capture replaces the origin URL before a card/row can push details; unmount is too late.
        onClickCapture={flushLibrarySearch}
        onKeyDownCapture={(event) => {
          if ((event.key === 'Enter' || event.key === ' ') && !event.nativeEvent.isComposing)
            flushLibrarySearch();
        }}
      >
        {watchStatusesError && (
          <RetryBanner
            message={
              allWatchStatuses === undefined
                ? "Couldn't load title status badges."
                : "Couldn't refresh watch statuses."
            }
            onRetry={() => void refetchWatchStatuses()}
            isRetrying={watchStatusesFetching}
          />
        )}
        {selectionMode && (
          <LibraryBulkActionBar
            selectedIds={selectedLibraryIds}
            filteredCount={filteredLibrary.length}
            selectAllDisabled={selectAllDisabled}
            allFilteredSelected={allFilteredSelected}
            onSelectAllFiltered={handleSelectAllFiltered}
            onClearSelection={librarySelection.clear}
            onExitSelectionMode={exitSelectionMode}
            onBulkSetStatus={(status) => void handleBulkSetStatus(status)}
            onBulkAddToList={handleBulkAddToList}
            onBulkRemove={handleBulkRemove}
            isBusy={isBulkBusy}
          />
        )}
        {librarySearchPending && (
          <span role='status' className='sr-only'>
            Updating library…
          </span>
        )}
        <div
          aria-busy={libraryResultsPending}
          className={cn('transition-opacity', libraryResultsPending && 'opacity-60')}
        >
          <CollectionTabContent
            isError={queryNeedsRetry(profileLibraryQuery)}
            isLoading={profileLibraryQuery.isLoading}
            items={filteredLibrary}
            errorLabel='your library'
            onRetry={() => void profileLibraryQuery.refetch()}
            isRetrying={profileLibraryQuery.isFetching}
            viewMode={viewMode}
            getItemKey={mediaCardRailKey}
            renderItem={(item) => (
              <MediaCard
                item={item}
                currentStatusOverride={getOwnWatchStatus(allWatchStatuses, item.id) ?? null}
                isInLibraryOverride
                selectionMode={selectionMode}
                isSelected={selectedIds.has(item.id)}
                onToggleSelect={handleToggleSelect}
              />
            )}
            renderList={(items) => (
              <LibraryList
                items={items}
                watchStatuses={allWatchStatuses}
                selectionMode={selectionMode}
                selectedIds={selectedIds}
                onToggleSelect={handleToggleSelect}
              />
            )}
            empty={
              libraryCount !== undefined && libraryCount > 0 ? (
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
        </div>
      </div>

      <ConfirmDialog
        open={confirmBulkRemoveOpen}
        onOpenChange={setConfirmBulkRemoveOpen}
        pending={bulkRemoveFromLibrary.isPending}
        title='Remove selected titles?'
        description={`Remove ${pluralize(selectedIds.size, 'title')} from your library and clear their watch statuses? Watch history and custom lists will be kept.`}
        confirmLabel='Remove from Library'
        confirmDisabled={selectedIds.size === 0 || isBulkBusy}
        onConfirm={() => void confirmBulkRemove()}
        triggerRef={librarySelectionTriggerRef}
        fallbackRef={libraryTabRef}
      />
    </div>
  );
}

function ProfileHistoryTab({
  historyQuery,
  viewMode,
  onViewModeChange,
}: {
  historyQuery: ReturnType<typeof useWatchHistory>;
  viewMode: 'grid' | 'list';
  onViewModeChange: (mode: 'grid' | 'list') => void;
}) {
  const mountedRef = useMountedRef();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    data: history,
    isLoading: historyLoading,
    isFetching: historyFetching,
    refetch: refetchHistory,
  } = historyQuery;

  const historySearch = searchParams.get('historyQ') ?? '';
  const setHistorySearch = (value: string) =>
    patchSearchParams(setSearchParams, { historyQ: value || null });
  const historySearchRef = useRef<HTMLInputElement>(null);
  const historyContentRef = useRef<HTMLDivElement>(null);
  const historyRemovalFocusRef = useRef<{ button: HTMLButtonElement; index: number } | null>(null);
  const handleHistoryRemove = (button: HTMLButtonElement, index: number) => {
    if (document.activeElement === button) historyRemovalFocusRef.current = { button, index };
  };
  const {
    effectiveSearch: effectiveHistorySearch,
    filteredItems: filteredHistory,
    isSearchPending: historySearchPending,
    searchError: historySearchError,
    isSearchFetching: historySearchFetching,
    retrySearch: retryHistorySearch,
  } = useTitleSearch(history ?? EMPTY_HISTORY_ITEMS, historySearch);

  const bulkRemoveHistory = useBulkRemoveFromWatchHistory();
  const [confirmHistoryRemoveOpen, setConfirmHistoryRemoveOpen] = useState(false);
  const historySelectionIds = (history ?? EMPTY_HISTORY_ITEMS).map(watchTitleKey);
  const filteredHistoryIds = filteredHistory.map(watchTitleKey);
  const { triggerRef: historySelectionTriggerRef, ...historySelection } = useCollectionSelection(
    historySelectionIds,
    filteredHistoryIds,
    true,
    bulkRemoveHistory.isPending,
    confirmHistoryRemoveOpen,
    historySearchRef,
  );
  const toggleHistorySelection = (item: WatchProgress, shiftKey = false) =>
    historySelection.toggle(watchTitleKey(item), shiftKey);
  const confirmHistoryRemove = async () => {
    if (bulkRemoveHistory.isPending || historySelection.selectedIds.size === 0) return;
    const items = (history ?? EMPTY_HISTORY_ITEMS)
      .filter((item) => historySelection.selectedIds.has(watchTitleKey(item)))
      .map((item) => ({ id: item.id, type: item.type_ }));
    await bulkRemoveHistory
      .mutateAsync(items)
      .then(() => {
        if (mountedRef.current) historySelection.exit();
      })
      .catch(() => {
        // The mutation restores the optimistic rows and reports the error.
      })
      .finally(() => {
        if (mountedRef.current) setConfirmHistoryRemoveOpen(false);
      });
  };

  useLayoutEffect(() => {
    const pending = historyRemovalFocusRef.current;
    if (!pending) return;
    if (pending.button.isConnected) {
      if (document.activeElement !== pending.button) historyRemovalFocusRef.current = null;
      return;
    }
    historyRemovalFocusRef.current = null;
    if (document.activeElement !== document.body) return;
    const index = Math.min(pending.index, filteredHistory.length - 1);
    (
      historyContentRef.current?.querySelector<HTMLButtonElement>(
        `[data-history-remove="${index}"]`,
      ) ?? historySearchRef.current
    )?.focus();
  });

  return (
    <div
      ref={historyContentRef}
      data-collection-selection=''
      data-escape-capture={historySelection.selectionMode ? '' : undefined}
      className='space-y-4'
    >
      {historySearchPending && (
        <span role='status' className='sr-only'>
          Searching history…
        </span>
      )}
      {history === undefined && historyLoading && (
        <Skeleton aria-hidden='true' className='h-9 w-full rounded-lg' />
      )}
      {history !== undefined && (
        <div className='flex items-center gap-2'>
          <SearchInput
            inputRef={historySearchRef}
            placeholder='Search history…'
            value={historySearch}
            pending={historySearchPending}
            onValueChange={setHistorySearch}
            clearLabel='Clear history search'
            wrapperClassName='flex-1 min-w-0'
            className='h-9 text-[13px] bg-white/[0.03] border-white/[0.07] text-white placeholder:text-zinc-500 focus-visible:border-(--accent-nav) focus-visible:ring-(--accent-nav)/25 rounded-lg'
          />
          <output className='shrink-0 text-[12px] tabular-nums text-zinc-400'>
            {effectiveHistorySearch
              ? `${filteredHistory.length} of ${history.length}`
              : pluralize(history.length, 'title')}
          </output>
          <ViewToggle viewMode={viewMode} onChange={onViewModeChange} />
          <Button
            ref={historySelectionTriggerRef}
            size='sm'
            variant='outline'
            aria-pressed={historySelection.selectionMode}
            disabled={history.length === 0 || bulkRemoveHistory.isPending}
            onClick={
              historySelection.selectionMode ? historySelection.exit : historySelection.begin
            }
            className='h-9 rounded-lg border-white/10 bg-white/[0.03] text-xs text-zinc-300'
          >
            <CheckSquare className='h-3.5 w-3.5' />
            Select
          </Button>
        </div>
      )}
      {historySelection.selectionMode && (
        <CollectionBulkActionBar
          selectedCount={historySelection.selectedIds.size}
          filteredCount={filteredHistory.length}
          allFilteredSelected={
            filteredHistoryIds.length > 0 &&
            filteredHistoryIds.every((id) => historySelection.selectedIds.has(id))
          }
          selectAllDisabled={historySearchPending || historySearchError || historyFetching}
          isBusy={bulkRemoveHistory.isPending}
          onSelectAll={() => historySelection.selectAll(filteredHistoryIds)}
          onClear={historySelection.clear}
          onDone={historySelection.exit}
          onRemove={() => setConfirmHistoryRemoveOpen(true)}
          removeLabel='Remove from history'
        />
      )}
      {historySearchError && (
        <RetryBanner
          message='Search failed.'
          isRetrying={historySearchFetching}
          onRetry={retryHistorySearch}
        />
      )}
      <div
        aria-busy={historySearchPending}
        className={cn('transition-opacity', historySearchPending && 'opacity-60')}
      >
        <CollectionTabContent
          isError={queryNeedsRetry(historyQuery)}
          isLoading={historyLoading}
          items={filteredHistory}
          errorLabel='your watch history'
          onRetry={() => void refetchHistory()}
          isRetrying={historyFetching}
          viewMode={viewMode}
          getItemKey={watchProgressItemKey}
          renderItem={(item) => (
            <HistoryItem
              item={item}
              selectionMode={historySelection.selectionMode}
              isSelected={historySelection.selectedIds.has(watchTitleKey(item))}
              onToggleSelect={toggleHistorySelection}
            />
          )}
          renderList={(items) => (
            <HistoryListView
              items={items}
              onRemove={handleHistoryRemove}
              selectionMode={historySelection.selectionMode}
              selectedIds={historySelection.selectedIds}
              onToggleSelect={toggleHistorySelection}
            />
          )}
          empty={
            effectiveHistorySearch ? (
              <EmptyState
                icon={<Search className='w-6 h-6 text-zinc-600' />}
                title='No results'
                subtitle={`Nothing in your history matches "${effectiveHistorySearch}".`}
                action={
                  <Button
                    size='sm'
                    variant='ghost'
                    className='h-8 text-xs text-zinc-400'
                    onClick={() => {
                      setHistorySearch('');
                      historySearchRef.current?.focus({ preventScroll: true });
                    }}
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
      </div>
      <ConfirmDialog
        open={confirmHistoryRemoveOpen}
        onOpenChange={setConfirmHistoryRemoveOpen}
        pending={bulkRemoveHistory.isPending}
        title='Remove selected history?'
        description={`Remove all watched episodes and playback progress for ${pluralize(historySelection.selectedIds.size, 'selected title')}? Your library, watch statuses and custom lists will be kept.`}
        confirmLabel='Remove from history'
        confirmDisabled={historySelection.selectedIds.size === 0}
        onConfirm={() => void confirmHistoryRemove()}
        triggerRef={historySelectionTriggerRef}
        fallbackRef={historySearchRef}
      />
    </div>
  );
}

function ProfileHeader({
  profile,
  onUpdateProfile,
  isSaving,
  isHydrating,
  isError,
  isRetrying,
  onRetry,
  isIdentityReady,
  statsLoading,
  watchTimeLoading,
  headerError,
  headerRetrying,
  onRetryHeader,
  libraryCount,
  listsCount,
  historyCount,
  totalWatchTimeSecs,
  statusCounts,
  statusCountsLoading,
}: {
  profile: LocalProfile;
  onUpdateProfile: (updates: LocalProfileUpdate) => Promise<void>;
  isSaving: boolean;
  isHydrating: boolean;
  isError: boolean;
  isRetrying: boolean;
  onRetry: () => void;
  isIdentityReady: boolean;
  statsLoading: boolean;
  watchTimeLoading: boolean;
  headerError: boolean;
  headerRetrying: boolean;
  onRetryHeader: () => void;
  libraryCount: number | undefined;
  listsCount: number | undefined;
  historyCount: number | undefined;
  totalWatchTimeSecs: number | undefined;
  statusCounts: Record<WatchStatus, number>;
  statusCountsLoading: boolean;
}) {
  return (
    <div className='rounded-xl border border-white/[0.06] bg-white/[0.02] px-5 py-4 sm:px-6'>
      <div className='flex flex-col gap-5 lg:flex-row lg:items-center lg:gap-8'>
        <div
          className='flex min-w-0 items-center gap-4 lg:w-80 lg:shrink-0'
          aria-busy={isHydrating}
        >
          {isIdentityReady ? (
            <>
              <ProfileAvatarEditor profile={profile} />

              <div className='min-w-0 flex-1'>
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
                      isHydrating={isHydrating}
                      isError={isError}
                      isRetrying={isRetrying}
                      onRetry={onRetry}
                    />
                  </div>
                </div>
              </div>
            </>
          ) : (
            <>
              <Skeleton className='h-21 w-21 shrink-0 rounded-full' />
              <Skeleton className='h-7 w-40 max-w-full' />
              <span className='sr-only'>
                {isHydrating ? 'Loading profile…' : 'Profile unavailable'}
              </span>
            </>
          )}
        </div>

        <div className='grid w-full max-w-2xl grid-cols-4 gap-3 self-center lg:mx-auto lg:flex-1'>
          <StatChip
            value={libraryCount}
            isLoading={statsLoading}
            label='Library'
            valueClassName='text-(--accent-nav)'
          />
          <StatChip
            value={listsCount}
            isLoading={statsLoading}
            label='Lists'
            valueClassName='text-white'
          />
          <StatChip
            value={historyCount}
            isLoading={statsLoading}
            label='History'
            valueClassName='text-white'
          />
          <StatChip
            value={totalWatchTimeSecs == null ? undefined : formatHoursWatched(totalWatchTimeSecs)}
            label='Hours watched'
            isLoading={watchTimeLoading}
            valueClassName='text-white'
            title='Estimated from saved playback progress, including seeks and episodes marked watched.'
          />
        </div>
      </div>
      {headerError && (
        <RetryBanner
          className='mt-4 px-3 py-2'
          message="Couldn't load some profile information."
          onRetry={onRetryHeader}
          isRetrying={headerRetrying}
        />
      )}
      {(statusCountsLoading || WATCH_STATUSES.some((status) => statusCounts[status] > 0)) && (
        <div className='mt-4 flex flex-wrap justify-center gap-x-6 gap-y-2 border-t border-white/[0.06] pt-3'>
          {statusCountsLoading ? (
            <Skeleton aria-hidden='true' className='h-4.5 w-48' />
          ) : (
            WATCH_STATUSES.map((s) => {
              const count = statusCounts[s] ?? 0;
              if (count === 0) return null;
              const colors = WATCH_STATUS_COLORS[s];
              return (
                <span key={s} className='flex items-center gap-1.5 text-[12px]'>
                  <WatchStatusIcon status={s} className='size-3.5' strokeWidth={2.1} />
                  <span className={cn('font-medium tabular-nums', colors.text)}>{count}</span>
                  <span className='text-zinc-400'>{WATCH_STATUS_LABELS[s]}</span>
                </span>
              );
            })
          )}
        </div>
      )}
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
  isLoading,
  label,
  valueClassName,
  title,
}: {
  value: number | string | undefined;
  isLoading: boolean;
  label: string;
  valueClassName?: string;
  title?: string;
}) {
  return (
    <div className='flex min-w-0 flex-col items-center gap-1.5 text-center' title={title}>
      {isLoading && value === undefined ? (
        <div role='status'>
          <Skeleton className='h-[21px] w-10' />
          <span className='sr-only'>Loading {label.toLowerCase()}…</span>
        </div>
      ) : (
        <span
          className={cn(
            'text-[21px] font-semibold tabular-nums tracking-tight leading-none',
            valueClassName,
          )}
        >
          {value ?? '—'}
        </span>
      )}
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
      {subtitle && (
        <p className='w-full max-w-xs text-[13px] leading-relaxed text-zinc-500 [overflow-wrap:anywhere]'>
          {subtitle}
        </p>
      )}
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
  const retryBanner = isError && (
    <RetryBanner
      message={`Couldn't ${items.length > 0 ? 'refresh' : 'load'} ${errorLabel}.`}
      onRetry={onRetry}
      isRetrying={isRetrying}
    />
  );
  if (isError && items.length === 0) return retryBanner;
  if (isLoading) {
    return (
      <div role='status' aria-busy='true'>
        <span className='sr-only'>Loading…</span>
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
      </div>
    );
  }
  if (items.length > 0) {
    return (
      <>
        {retryBanner}
        {viewMode === 'grid' ? (
          <WindowVirtualizedGrid
            items={items}
            getItemKey={getItemKey}
            renderItem={renderItem}
            estimateItemHeight={(itemWidth) => itemWidth * 1.5 + MEDIA_CARD_TEXT_BLOCK_HEIGHT_PX}
          />
        ) : (
          renderList(items)
        )}
      </>
    );
  }
  return empty;
}
