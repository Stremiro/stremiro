import { useQuery } from '@tanstack/react-query';
import {
  CalendarArrowDown,
  CalendarArrowUp,
  CheckSquare,
  ChevronRight,
  History,
  LayoutList,
  Library,
  Search,
  X,
} from 'lucide-react';
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
  FILTER_ACTIVE_BUTTON_CLASS,
  FILTER_MENU_BUTTON_CLASS,
  LibraryToolbar,
  LibraryBulkActionBar,
  CollectionBulkActionBar,
  useCollectionSelection,
  isLibrarySort,
  TYPE_OPTIONS,
} from '@/components/profile-library-controls';
import { SegmentedControl, SegmentPill, ViewToggle } from '@/components/ui/segmented-control';
import { PageCard } from '@/components/page-section';
import { ProfileAvatarEditor } from '@/components/profile-avatar';
import { ProfileSettingsPopover } from '@/components/profile-settings-popover';
import { RetryBanner } from '@/components/retry-banner';
import { ScrollToTop } from '@/components/scroll-to-top';
import { StatePanel } from '@/components/state-panel';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { SearchInput } from '@/components/ui/search-input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { WindowVirtualizedGrid } from '@/components/window-virtualized-grid';
import { WatchStatusIcon } from '@/components/watch-status-icon';
import { useFindShortcut } from '@/hooks/use-browse-hotkeys';
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
import { notifyAction } from '@/lib/notify';
import {
  cn,
  isSeriesLikeMediaType,
  pluralize,
  queryNeedsRetry,
  SIDEBAR_PAGE_COLUMN_INSETS,
} from '@/lib/utils';

const loadListsManager = () => import('@/components/list/lists-manager');
const ListsManager = lazy(() =>
  loadListsManager().then((module) => ({ default: module.ListsManager })),
);
const warmListsManager = () => void loadListsManager().catch(() => undefined);

const PROFILE_SKELETON_CAP = 12;
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

const HISTORY_ORDER_OPTIONS = [
  { value: 'recent', label: 'Most recent first', icon: CalendarArrowDown },
  { value: 'oldest', label: 'Oldest first', icon: CalendarArrowUp },
] as const;

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
  const activeLibraryStatus =
    activeTab === 'library' && libraryFilters.status !== 'all' && libraryFilters.status !== 'none'
      ? libraryFilters.status
      : undefined;
  const toggleLibraryStatus = (status: WatchStatus) =>
    patchSearchParams(setSearchParams, {
      tab: null,
      status: activeLibraryStatus === status ? null : status,
    });
  const profileLibraryQuery = useProfileLibrary(libraryFilters, {
    enabled: activeTab === 'library',
  });
  const historyQuery = useWatchHistory({ enabled: activeTab === 'history' });
  // A filter switch without placeholder rows keeps the last library totals.
  const [heldLibrary, setHeldLibrary] = useState<Pick<ProfileLibrary, 'allIds' | 'statusCounts'>>();
  const currentLibrary = activeTab === 'library' ? profileLibraryQuery.data : undefined;
  const tabLibrary = activeTab === 'library' ? (currentLibrary ?? heldLibrary) : undefined;
  if (
    currentLibrary &&
    (currentLibrary.allIds !== heldLibrary?.allIds ||
      currentLibrary.statusCounts !== heldLibrary?.statusCounts)
  ) {
    setHeldLibrary({ allIds: currentLibrary.allIds, statusCounts: currentLibrary.statusCounts });
  } else if (activeTab !== 'library' && heldLibrary) {
    setHeldLibrary(undefined);
  }
  const libraryTabRef = useRef<HTMLButtonElement>(null);
  const activeTabIndex = PROFILE_TABS.findIndex((tab) => tab.id === activeTab);
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
      <ScrollToTop />
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
            if (queryNeedsRetry(dataStatsQuery)) void dataStatsQuery.refetch();
            if (queryNeedsRetry(totalWatchTimeQuery)) void totalWatchTimeQuery.refetch();
          }}
          libraryCount={libraryCount}
          listsCount={dataStats?.lists_count}
          historyCount={historyCount}
          totalWatchTimeSecs={totalWatchTimeSecs}
          statusCounts={libraryStatusCounts}
          statusCountsLoading={tabLibrary === undefined && dataStatsQuery.isPending}
          activeTab={activeTab}
          onOpenTab={setActiveTab}
          activeStatus={activeLibraryStatus}
          onToggleStatus={toggleLibraryStatus}
        />

        <Tabs value={activeTab} onValueChange={setActiveTab} className='space-y-4'>
          <div className='flex justify-center'>
            <TabsList
              aria-label='Profile collections'
              className='relative isolate grid h-auto w-full max-w-lg grid-cols-3 rounded-lg border border-white/[0.08] bg-white/[0.03] p-1'
            >
              <SegmentPill
                index={activeTabIndex}
                count={PROFILE_TABS.length}
                inset={4}
                className='rounded-md border border-white/[0.12] bg-white/[0.09] shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]'
              />
              {PROFILE_TABS.map((tab) => {
                const isActive = tab.id === activeTab;
                const count = tabCounts[tab.id];
                return (
                  <TabsTrigger
                    key={tab.id}
                    ref={tab.id === 'library' ? libraryTabRef : undefined}
                    value={tab.id}
                    onPointerEnter={tab.id === 'lists' ? warmListsManager : undefined}
                    onFocus={tab.id === 'lists' ? warmListsManager : undefined}
                    className={cn(
                      'nav-switch-item relative z-10 h-10 min-w-0 gap-1.5 rounded-md border-0 bg-transparent px-1.5 py-2 text-[13px] font-medium shadow-none focus-visible:ring-inset focus-visible:ring-offset-0 sm:gap-2 sm:px-4 sm:text-sm',
                      isActive
                        ? 'text-white'
                        : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100',
                    )}
                  >
                    <tab.icon
                      aria-hidden='true'
                      className={cn(
                        'size-3.5 shrink-0 transition-colors duration-150 motion-reduce:transition-none',
                        isActive && 'text-(--accent-nav)',
                      )}
                    />
                    <span>{tab.label}</span>
                    {count !== undefined && (
                      <span
                        className={cn(
                          'shrink-0 text-[11px] tabular-nums leading-none',
                          isActive ? 'text-zinc-300' : 'text-zinc-500',
                        )}
                      >
                        {count}
                      </span>
                    )}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </div>

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
                <div role='status' aria-busy='true' className='space-y-4'>
                  <span className='sr-only'>Loading lists…</span>
                  <div aria-hidden='true' className='flex items-center justify-between gap-3'>
                    <Skeleton className='h-5 w-36 rounded-md' />
                    <Skeleton className='h-9 w-28 rounded-lg' />
                  </div>
                  <div aria-hidden='true' className='space-y-2.5'>
                    <Skeleton className='h-[74px] w-full rounded-lg' />
                    <Skeleton className='h-[74px] w-full rounded-lg' />
                    <Skeleton className='h-[74px] w-full rounded-lg' />
                  </div>
                </div>
              }
            >
              <ListsManager expectedCount={dataStats?.lists_count} />
            </Suspense>
          </TabsContent>

          <TabsContent value='history'>
            <ProfileHistoryTab
              historyQuery={historyQuery}
              expectedCount={historyCount}
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
  useFindShortcut(() => librarySearchRef.current);
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
  const selectAllDisabled =
    profileLibraryQuery.isError ||
    profileLibraryQuery.isFetching ||
    profileLibraryQuery.isPlaceholderData ||
    librarySearch !== librarySearchParam;
  const { triggerRef: librarySelectionTriggerRef, ...librarySelection } = useCollectionSelection(
    librarySelectionIds,
    filteredLibraryIds,
    true,
    isBulkBusy,
    confirmBulkRemoveOpen,
    libraryTabRef,
    selectAllDisabled,
  );
  const { selectionMode, selectedIds, exit: exitSelectionMode } = librarySelection;

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

  const handleBulkSetStatus = async (status: WatchStatus | null) => {
    if (selectedIds.size === 0 || isBulkBusy) return;
    await bulkSetWatchStatus
      .mutateAsync({ ids: [...selectedIds], status })
      .then((count) => {
        notifyAction(
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
        notifyAction(
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
        notifyAction(`Removed ${pluralize(count, 'title')} from Library`);
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
          <div className='flex items-center justify-between gap-2'>
            <Skeleton className='h-9 w-64 rounded-md' />
            <Skeleton className='h-9 w-56 rounded-md' />
          </div>
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
            onSelectAllFiltered={() => librarySelection.selectAll(filteredLibraryIds)}
            onInvertSelection={() => librarySelection.invert(filteredLibraryIds)}
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
          className={cn(
            'transition-opacity duration-150 motion-reduce:transition-none',
            libraryResultsPending && 'opacity-60 delay-200',
          )}
        >
          <CollectionTabContent
            isError={queryNeedsRetry(profileLibraryQuery)}
            isLoading={profileLibraryQuery.isLoading}
            expectedCount={libraryCount}
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
  expectedCount,
  viewMode,
  onViewModeChange,
}: {
  historyQuery: ReturnType<typeof useWatchHistory>;
  expectedCount?: number;
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
  const historyTypeParam = searchParams.get('historyType');
  const historyType =
    historyTypeParam === 'movie' || historyTypeParam === 'series' ? historyTypeParam : 'all';
  const historyOrder = searchParams.get('historyOrder') === 'oldest' ? 'oldest' : 'recent';
  const historySearchRef = useRef<HTMLInputElement>(null);
  useFindShortcut(() => historySearchRef.current);
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
  } = useTitleSearch(history ?? EMPTY_HISTORY_ITEMS, historySearch, history !== undefined);
  // Filter after search so the searched list keeps the query-cached identity.
  const typedHistory =
    historyType === 'all'
      ? filteredHistory
      : filteredHistory.filter(
          (item) => isSeriesLikeMediaType(item.type_) === (historyType === 'series'),
        );
  const visibleHistory = historyOrder === 'oldest' ? typedHistory.toReversed() : typedHistory;
  const historyFiltered = Boolean(effectiveHistorySearch) || historyType !== 'all';
  const clearHistoryFilters = () => {
    patchSearchParams(setSearchParams, { historyQ: null, historyType: null });
    historySearchRef.current?.focus({ preventScroll: true });
  };

  const bulkRemoveHistory = useBulkRemoveFromWatchHistory();
  const [confirmHistoryRemoveOpen, setConfirmHistoryRemoveOpen] = useState(false);
  const historySelectionIds = (history ?? EMPTY_HISTORY_ITEMS).map(watchTitleKey);
  const filteredHistoryIds = visibleHistory.map(watchTitleKey);
  const selectAllDisabled = historySearchPending || historySearchError || historyFetching;
  const { triggerRef: historySelectionTriggerRef, ...historySelection } = useCollectionSelection(
    historySelectionIds,
    filteredHistoryIds,
    true,
    bulkRemoveHistory.isPending,
    confirmHistoryRemoveOpen,
    historySearchRef,
    selectAllDisabled,
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
    const index = Math.min(pending.index, visibleHistory.length - 1);
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
            {historyFiltered
              ? `${visibleHistory.length} of ${history.length}`
              : pluralize(history.length, 'title')}
          </output>
        </div>
      )}
      {history !== undefined && history.length > 0 && (
        <div className='flex flex-wrap items-center gap-2'>
          <SegmentedControl
            label='History media type'
            value={historyType}
            options={TYPE_OPTIONS}
            onChange={(type) =>
              patchSearchParams(setSearchParams, { historyType: type === 'all' ? null : type })
            }
          />
          <SegmentedControl
            label='History order'
            value={historyOrder}
            options={HISTORY_ORDER_OPTIONS}
            onChange={(order) =>
              patchSearchParams(setSearchParams, {
                historyOrder: order === 'recent' ? null : order,
              })
            }
          />
          <div className='ml-auto flex items-center gap-2'>
            <ViewToggle viewMode={viewMode} onChange={onViewModeChange} />
            <Button
              ref={historySelectionTriggerRef}
              size='sm'
              variant='outline'
              aria-pressed={historySelection.selectionMode}
              disabled={bulkRemoveHistory.isPending}
              onClick={
                historySelection.selectionMode ? historySelection.exit : historySelection.begin
              }
              className={cn(
                FILTER_MENU_BUTTON_CLASS,
                historySelection.selectionMode && FILTER_ACTIVE_BUTTON_CLASS,
              )}
            >
              <CheckSquare className='h-3.5 w-3.5' />
              Select
            </Button>
          </div>
        </div>
      )}
      {historySelection.selectionMode && (
        <CollectionBulkActionBar
          selectedCount={historySelection.selectedIds.size}
          filteredCount={visibleHistory.length}
          allFilteredSelected={
            filteredHistoryIds.length > 0 &&
            filteredHistoryIds.every((id) => historySelection.selectedIds.has(id))
          }
          selectAllDisabled={selectAllDisabled}
          isBusy={bulkRemoveHistory.isPending}
          onSelectAll={() => historySelection.selectAll(filteredHistoryIds)}
          onInvert={() => historySelection.invert(filteredHistoryIds)}
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
        className={cn(
          'transition-opacity duration-150 motion-reduce:transition-none',
          historySearchPending && 'opacity-60 delay-200',
        )}
      >
        <CollectionTabContent
          isError={queryNeedsRetry(historyQuery)}
          isLoading={historyLoading}
          expectedCount={expectedCount}
          items={visibleHistory}
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
            historyFiltered ? (
              <EmptyState
                icon={<Search className='w-6 h-6 text-zinc-600' />}
                title='No results'
                subtitle={
                  effectiveHistorySearch
                    ? `Nothing in your history matches "${effectiveHistorySearch}".`
                    : `No ${historyType === 'movie' ? 'movies' : 'series'} in your history.`
                }
                action={
                  <Button
                    size='sm'
                    variant='ghost'
                    className='h-8 text-xs text-zinc-400'
                    onClick={clearHistoryFilters}
                  >
                    Clear filters
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
  activeTab,
  onOpenTab,
  activeStatus,
  onToggleStatus,
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
  activeTab: ProfileTabId;
  onOpenTab: (tab: ProfileTabId) => void;
  activeStatus: WatchStatus | undefined;
  onToggleStatus: (status: WatchStatus) => void;
}) {
  return (
    <div className='relative'>
      <PageCard aria-label='Profile summary' className='px-5 py-5 sm:px-6 sm:py-6'>
        <span
          aria-hidden='true'
          className='pointer-events-none absolute inset-0'
          style={{
            background:
              'linear-gradient(125deg, transparent 62%, rgb(var(--app-accent-rgb) / 0.04) 100%)',
          }}
        />
        <div className='relative flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between lg:gap-6'>
          <div className='flex min-w-0 items-center gap-4 lg:flex-1' aria-busy={isHydrating}>
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
                <Skeleton className='size-[84px] shrink-0 rounded-full' />
                <Skeleton className='h-8 w-40 max-w-full' />
                <span className='sr-only'>
                  {isHydrating ? 'Loading profile…' : 'Profile unavailable'}
                </span>
              </>
            )}
          </div>

          <div className='grid w-full grid-cols-2 gap-1.5 rounded-lg border border-white/[0.07] bg-black/25 p-1.5 shadow-[inset_0_1px_0_rgb(255_255_255/0.03)] sm:grid-cols-4 lg:w-auto lg:shrink-0 lg:gap-2'>
            <StatChip
              value={libraryCount}
              isLoading={statsLoading}
              label='Library'
              active={activeTab === 'library'}
              valueClassName={activeTab === 'library' ? 'text-(--accent-nav)' : 'text-white'}
              onClick={() => onOpenTab('library')}
            />
            <StatChip
              value={listsCount}
              isLoading={statsLoading}
              label='Lists'
              active={activeTab === 'lists'}
              valueClassName={activeTab === 'lists' ? 'text-(--accent-nav)' : 'text-white'}
              onClick={() => onOpenTab('lists')}
            />
            <StatChip
              value={historyCount}
              isLoading={statsLoading}
              label='History'
              active={activeTab === 'history'}
              valueClassName={activeTab === 'history' ? 'text-(--accent-nav)' : 'text-white'}
              onClick={() => onOpenTab('history')}
            />
            <StatChip
              value={
                totalWatchTimeSecs == null ? undefined : formatHoursWatched(totalWatchTimeSecs)
              }
              label='Hours watched'
              isLoading={watchTimeLoading}
              valueClassName='text-white'
              title='Estimated from saved playback progress, including seeks and episodes marked watched.'
            />
          </div>
        </div>
        {headerError && (
          <RetryBanner
            className='relative mt-4 px-3 py-2'
            message="Couldn't load some profile information."
            onRetry={onRetryHeader}
            isRetrying={headerRetrying}
          />
        )}
        {(statusCountsLoading || WATCH_STATUSES.some((status) => statusCounts[status] > 0)) && (
          <div className='relative mt-3.5 flex flex-wrap items-center gap-1.5 border-t border-white/[0.06] pt-2.5'>
            {statusCountsLoading ? (
              <div aria-hidden='true' className='flex flex-wrap items-center gap-1.5'>
                <Skeleton className='h-9 w-24 rounded-md' />
                <Skeleton className='h-9 w-24 rounded-md' />
                <Skeleton className='h-9 w-28 rounded-md' />
              </div>
            ) : (
              WATCH_STATUSES.map((s) => {
                const count = statusCounts[s] ?? 0;
                if (count === 0) return null;
                const colors = WATCH_STATUS_COLORS[s];
                const active = activeStatus === s;
                return (
                  <button
                    key={s}
                    type='button'
                    aria-pressed={active}
                    title={
                      active
                        ? 'Show all Library titles'
                        : `Show ${WATCH_STATUS_LABELS[s]} in Library`
                    }
                    onClick={() => onToggleStatus(s)}
                    className={cn(
                      'flex min-h-9 items-center gap-1.5 rounded-md border px-2.5 py-1 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 motion-reduce:transition-none',
                      active
                        ? cn(
                            'text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.07)]',
                            colors.bg,
                            colors.border,
                          )
                        : 'border-transparent bg-transparent hover:border-white/10 hover:bg-white/[0.05]',
                    )}
                  >
                    <WatchStatusIcon status={s} className='size-3.5' strokeWidth={2.1} />
                    <span className={cn('font-medium tabular-nums', colors.text)}>{count}</span>
                    <span className={active ? 'text-zinc-100' : 'text-zinc-400'}>
                      {WATCH_STATUS_LABELS[s]}
                    </span>
                    {active && <X aria-hidden='true' className='ml-0.5 size-3 text-zinc-300' />}
                  </button>
                );
              })
            )}
          </div>
        )}
      </PageCard>
      {/* Top-right accent ridge drawn over PageCard's 1px rounded-xl border, synced to the user's accent color. */}
      <span aria-hidden='true' className='pointer-events-none absolute inset-0 rounded-xl'>
        <span className='absolute right-0 top-0 size-[13px] rounded-tr-xl border-r border-t border-[rgb(var(--app-accent-rgb))]' />
        <span className='absolute right-[12px] top-0 h-px w-28 bg-linear-to-l from-[rgb(var(--app-accent-rgb))] to-transparent' />
        <span className='absolute right-0 top-[12px] h-16 w-px bg-linear-to-b from-[rgb(var(--app-accent-rgb))] to-transparent' />
      </span>
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
  active = false,
  valueClassName,
  title,
  onClick,
}: {
  value: number | string | undefined;
  isLoading: boolean;
  label: string;
  active?: boolean;
  valueClassName?: string;
  title?: string;
  onClick?: () => void;
}) {
  const Root = onClick ? 'button' : 'div';
  return (
    <Root
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      aria-current={onClick && active ? 'page' : undefined}
      title={title ?? (onClick ? `Open ${label}` : undefined)}
      className={cn(
        'group/stat flex min-w-[92px] flex-col items-start gap-1.5 rounded-md px-3.5 py-2 text-left',
        onClick &&
          'transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 motion-reduce:transition-none',
      )}
    >
      {isLoading && value === undefined ? (
        <span role='status'>
          <Skeleton className='h-6 w-10' />
          <span className='sr-only'>Loading {label.toLowerCase()}…</span>
        </span>
      ) : (
        <span
          className={cn(
            'text-2xl font-semibold tabular-nums tracking-tight leading-none transition-colors duration-150 motion-reduce:transition-none',
            valueClassName,
          )}
        >
          {value ?? '—'}
        </span>
      )}
      <span className='inline-flex items-center gap-1 text-xs leading-4 text-zinc-400'>
        <span className={cn(active && 'text-zinc-200')}>{label}</span>
        {onClick && (
          <ChevronRight
            aria-hidden='true'
            className='size-3 shrink-0 text-zinc-500 transition-[color,transform] duration-150 group-hover/stat:translate-x-0.5 group-hover/stat:text-zinc-300 motion-reduce:transition-none'
          />
        )}
      </span>
    </Root>
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
    <StatePanel
      icon={icon}
      title={title}
      description={subtitle}
      descriptionClassName='text-sm text-zinc-400'
      action={action}
      className='rounded-xl border border-white/[0.08] bg-white/[0.025] px-6 py-12'
    />
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
  expectedCount,
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
  expectedCount?: number;
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
    // Skeletons mirror the known collection size (dataStats aggregates or the
    // open tab's own rows) instead of speculating a fixed wall of cards; a
    // resolved zero falls back so the loading pane never paints blank.
    const skeletonCount = Math.min(expectedCount || PROFILE_SKELETON_CAP, PROFILE_SKELETON_CAP);
    return (
      <div role='status' aria-busy='true'>
        <span className='sr-only'>Loading…</span>
        {skeletonCount > 0 && (
          <div
            aria-hidden='true'
            className={
              viewMode === 'grid'
                ? 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4'
                : 'flex flex-col gap-1.5'
            }
          >
            {Array.from({ length: skeletonCount }, (_, index) =>
              viewMode === 'grid' ? (
                <MediaCardSkeleton key={index} />
              ) : (
                <Skeleton key={index} className='h-[78px] w-full rounded-lg bg-zinc-900/50' />
              ),
            )}
          </div>
        )}
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
