import { useQuery } from '@tanstack/react-query';
import { CheckSquare, History, LayoutList, Library, Search } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ListsManager } from '@/components/list/lists-manager';
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
} from '@/components/profile-library-controls';
import { ProfileAvatarEditor } from '@/components/profile-avatar';
import { ProfileSettingsPopover } from '@/components/profile-settings-popover';
import { RetryBanner } from '@/components/retry-banner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SearchInput } from '@/components/ui/search-input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { WindowVirtualizedGrid } from '@/components/window-virtualized-grid';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { useTitleSearch } from '@/hooks/use-item-search';
import {
  type LocalProfile,
  type LocalProfileUpdate,
  useLocalProfile,
} from '@/hooks/use-local-profile';
import {
  getOwnWatchStatus,
  useLibraryItems,
  useProfileLibrary,
  useBulkAddToList,
  useBulkRemoveFromLibrary,
  useBulkRemoveFromWatchHistory,
  useBulkSetWatchStatus,
  useTotalWatchTime,
  useWatchHistory,
  useWatchStatuses,
} from '@/hooks/use-media-library';
import { useMountedRef } from '@/hooks/use-mounted-ref';
import {
  api,
  getListErrorMessage,
  getWatchStatusErrorMessage,
  type MediaItem,
  type WatchProgress,
  WATCH_STATUS_COLORS,
  WATCH_STATUS_LABELS,
  WATCH_STATUSES,
  type WatchStatus,
} from '@/lib/api';
import { watchProgressItemKey } from '@/lib/history-playback';
import { cn, queryNeedsRetry, SIDEBAR_PAGE_COLUMN_INSETS } from '@/lib/utils';

const PROFILE_MEDIA_GRID_SKELETON_KEYS = Array.from(
  { length: 12 },
  (_, index) => `profile-grid-skeleton-${index}`,
);
const EMPTY_LIBRARY_ITEMS: MediaItem[] = [];
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
  const setActiveTab = useCallback(
    (tab: string) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (tab === 'library') next.delete('tab');
          else next.set('tab', tab);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  // Header aggregates do not retain collection rows.
  const dataStatsQuery = useQuery(api.dataStatsQueryOptions());
  const { data: dataStats } = dataStatsQuery;

  // Backend aggregate — the collapsed history rows would undercount.
  const totalWatchTimeQuery = useTotalWatchTime();
  const { data: totalWatchTimeSecs } = totalWatchTimeQuery;

  const handleViewModeChange = useCallback(
    (mode: 'grid' | 'list') => {
      void updateViewMode(mode).catch(() => toast.error('Failed to save view mode'));
    },
    [updateViewMode],
  );

  const [libraryTabCount, setLibraryTabCount] = useState<number>();
  const [libraryTabStatusCounts, setLibraryTabStatusCounts] =
    useState<Record<WatchStatus | 'none', number>>();
  const libraryTabRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (activeTab !== 'library') {
      setLibraryTabCount(undefined);
      setLibraryTabStatusCounts(undefined);
    }
  }, [activeTab]);
  const [historyTabCount, setHistoryTabCount] = useState<number>();
  useEffect(() => {
    if (activeTab !== 'history') setHistoryTabCount(undefined);
  }, [activeTab]);
  const historyCount =
    activeTab === 'history'
      ? (historyTabCount ?? dataStats?.history_title_count)
      : dataStats?.history_title_count;
  const libraryCount =
    activeTab === 'library'
      ? (libraryTabCount ?? dataStats?.library_count)
      : dataStats?.library_count;
  const libraryStatusCounts =
    (activeTab === 'library'
      ? (libraryTabStatusCounts ?? dataStats?.library_status_counts)
      : dataStats?.library_status_counts) ?? EMPTY_STATUS_COUNTS;
  const listsCount = dataStats?.lists_count ?? 0;
  // Per-tab counters for the pill labels — 0/loading reads as no badge.
  const tabCounts: Partial<Record<ProfileTabId, number>> = {
    library: libraryCount || undefined,
    lists: listsCount || undefined,
    history: historyCount || undefined,
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
            (profilePreferencesQuery.isFetched && isHydratingProfile) ||
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
        />

        <Tabs value={activeTab} onValueChange={setActiveTab} className='space-y-4'>
          <TabsList
            aria-label='Profile collections'
            className='relative isolate inline-grid grid-cols-3 max-w-full overflow-x-auto rounded-lg border border-white/[0.07] bg-white/[0.03] p-1 h-auto gap-0 scrollbar-hide'
          >
            <span
              aria-hidden='true'
              className='pointer-events-none absolute top-1 bottom-1 left-1 rounded-md bg-(--accent-nav) transition-transform duration-200 ease-out motion-reduce:transition-none'
              style={{
                width: `calc((100% - 8px) / ${PROFILE_TABS.length})`,
                transform: `translateX(${PROFILE_TABS.findIndex((tab) => tab.id === activeTab) * 100}%)`,
              }}
            />
            {PROFILE_TABS.map((tab) => (
              <TabsTrigger
                key={tab.id}
                ref={tab.id === 'library' ? libraryTabRef : undefined}
                value={tab.id}
                style={{ backgroundColor: 'transparent' }}
                className={cn(
                  'nav-switch-item relative z-10 shrink-0 px-3 py-2 rounded-md text-[13px] font-medium shadow-none data-[state=active]:shadow-none data-[state=active]:text-(--on-accent-nav) transition-colors duration-150 flex items-center justify-center gap-1.5 hover:text-zinc-100',
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

          <TabsContent value='library'>
            <ProfileLibraryTab
              viewMode={viewMode}
              onViewModeChange={handleViewModeChange}
              onCountChange={setLibraryTabCount}
              onStatusCountsChange={setLibraryTabStatusCounts}
              libraryTabRef={libraryTabRef}
            />
          </TabsContent>

          <TabsContent value='lists'>
            <ListsManager />
          </TabsContent>

          <TabsContent value='history'>
            <ProfileHistoryTab
              viewMode={viewMode}
              onViewModeChange={handleViewModeChange}
              onCountChange={setHistoryTabCount}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function ProfileLibraryTab({
  viewMode,
  onViewModeChange,
  onCountChange,
  onStatusCountsChange,
  libraryTabRef,
}: {
  viewMode: 'grid' | 'list';
  onViewModeChange: (mode: 'grid' | 'list') => void;
  onCountChange: (count: number) => void;
  onStatusCountsChange: (counts: Record<WatchStatus | 'none', number>) => void;
  libraryTabRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const mountedRef = useMountedRef();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const setCollectionParam = useCallback(
    (key: 'type' | 'status' | 'sort', value: string, defaultValue = '') => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (value === defaultValue) next.delete(key);
          else next.set(key, value);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const libraryQuery = useLibraryItems();
  const { data: library, isFetching: libraryFetching, refetch: refetchLibrary } = libraryQuery;

  const {
    data: allWatchStatuses,
    isError: watchStatusesError,
    isFetching: watchStatusesFetching,
    refetch: refetchWatchStatuses,
  } = useWatchStatuses();

  const statusParam = searchParams.get('status');
  const libraryStatusFilter =
    WATCH_STATUSES.find((status) => status === statusParam) ??
    (statusParam === 'none' ? 'none' : 'all');
  const typeParam = searchParams.get('type');
  const libraryTypeFilter = typeParam === 'movie' || typeParam === 'series' ? typeParam : 'all';
  const sortParam = searchParams.get('sort');
  const librarySort = isLibrarySort(sortParam) ? sortParam : 'default';
  const librarySearchParam = searchParams.get('q') ?? '';
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
  const libraryReadFailed = queryNeedsRetry(libraryQuery) && library === undefined;
  const profileLibraryQuery = useProfileLibrary({
    query: librarySearchParam,
    type: libraryTypeFilter,
    status: libraryStatusFilter,
    sort: librarySort,
  });
  const filteredLibrary = profileLibraryQuery.data?.items ?? EMPTY_LIBRARY_ITEMS;
  const librarySearchPending =
    librarySearch !== librarySearchParam || profileLibraryQuery.isFetching;
  const libraryResultsPending =
    profileLibraryQuery.isPlaceholderData ||
    (librarySearch !== librarySearchParam && profileLibraryQuery.data !== undefined);
  const statusCounts = profileLibraryQuery.data?.statusCounts;
  const libraryCount = library?.length;
  useLayoutEffect(() => {
    if (libraryCount !== undefined) onCountChange(libraryCount);
  }, [libraryCount, onCountChange]);
  useLayoutEffect(() => {
    if (statusCounts !== undefined) onStatusCountsChange(statusCounts);
  }, [statusCounts, onStatusCountsChange]);
  const librarySelectionIds = useMemo(
    () => (library ?? EMPTY_LIBRARY_ITEMS).map((item) => item.id),
    [library],
  );
  const filteredLibraryIds = useMemo(
    () => filteredLibrary.map((item) => item.id),
    [filteredLibrary],
  );
  const librarySelection = useCollectionSelection(
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

  const resetLibraryFilters = useCallback(() => {
    setLibrarySearch('');
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const key of ['q', 'type', 'status', 'sort']) next.delete(key);
        return next;
      },
      { replace: true },
    );
    librarySearchRef.current?.focus({ preventScroll: true });
  }, [setSearchParams]);

  const selectedItems = useMemo(
    () =>
      selectedIds.size === 0
        ? EMPTY_LIBRARY_ITEMS
        : (library ?? EMPTY_LIBRARY_ITEMS).filter((item) => selectedIds.has(item.id)),
    [library, selectedIds],
  );
  const allFilteredSelected =
    filteredLibrary.length > 0 && filteredLibrary.every((item) => selectedIds.has(item.id));

  const handleToggleSelect = (item: MediaItem, shiftKey = false) =>
    librarySelection.toggle(item.id, shiftKey);

  const handleSelectAllFiltered = () => {
    if (isBulkBusy || selectAllDisabled) return;
    librarySelection.selectAll(filteredLibraryIds);
  };

  const handleBulkSetStatus = async (status: WatchStatus | null) => {
    if (selectedItems.length === 0 || isBulkBusy) return;
    try {
      const count = await bulkSetWatchStatus.mutateAsync({ ids: [...selectedIds], status });
      toast.success(
        status === null
          ? `Cleared status for ${count} title${count === 1 ? '' : 's'}`
          : `Set ${count} title${count === 1 ? '' : 's'} to ${WATCH_STATUS_LABELS[status]}`,
      );
    } catch (error) {
      toast.error('Failed to update watch statuses', {
        description: getWatchStatusErrorMessage(error),
      });
    }
  };

  const handleBulkAddToList = async (listId: string, listName: string, items: MediaItem[]) => {
    if (items.length === 0 || isBulkBusy) return;
    try {
      const count = await bulkAddToList.mutateAsync({
        listId,
        itemIds: items.map((item) => item.id),
      });
      toast.success(
        count === 0
          ? 'Selected titles are already in this list'
          : `Added ${count} title${count === 1 ? '' : 's'} to "${listName}"`,
      );
    } catch (error) {
      toast.error(getListErrorMessage(error) ?? 'Failed to add titles to list');
    }
  };

  const handleBulkRemove = () => {
    if (selectedItems.length > 0 && !isBulkBusy) setConfirmBulkRemoveOpen(true);
  };

  const confirmBulkRemove = async () => {
    if (selectedItems.length === 0 || isBulkBusy) return;
    const ids = selectedItems.map((item) => item.id);
    try {
      const count = await bulkRemoveFromLibrary.mutateAsync(ids);
      toast.success(`Removed ${count} title${count === 1 ? '' : 's'} from Library`);
      if (mountedRef.current) exitSelectionMode();
    } catch {
      toast.error('Failed to remove titles from Library');
    } finally {
      if (mountedRef.current) setConfirmBulkRemoveOpen(false);
    }
  };

  return (
    <div
      className='space-y-4'
      data-collection-selection=''
      data-escape-capture={selectionMode ? '' : undefined}
    >
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
          selectionTriggerRef={librarySelection.triggerRef}
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
            selectedItems={selectedItems}
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
            isError={libraryReadFailed || queryNeedsRetry(profileLibraryQuery)}
            isLoading={
              profileLibraryQuery.isLoading ||
              (libraryQuery.isLoading && filteredLibrary.length === 0)
            }
            items={filteredLibrary}
            errorLabel='your library'
            onRetry={() => Promise.all([refetchLibrary(), profileLibraryQuery.refetch()])}
            isRetrying={libraryFetching || profileLibraryQuery.isFetching}
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
        </div>
      </div>

      <Dialog
        open={confirmBulkRemoveOpen}
        onOpenChange={(open) => {
          if (!bulkRemoveFromLibrary.isPending) setConfirmBulkRemoveOpen(open);
        }}
      >
        <DialogContent
          onEscapeKeyDown={(event) => {
            if (bulkRemoveFromLibrary.isPending) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (bulkRemoveFromLibrary.isPending) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const trigger = librarySelection.triggerRef.current;
            (trigger && !trigger.disabled ? trigger : libraryTabRef.current)?.focus({
              preventScroll: true,
            });
          }}
          className='border-white/10 bg-zinc-950 sm:max-w-md'
        >
          <DialogHeader>
            <DialogTitle>Remove selected titles?</DialogTitle>
            <DialogDescription>
              Remove {selectedIds.size} title{selectedIds.size === 1 ? '' : 's'} from your library
              and clear their watch statuses? Watch history and custom lists will be kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant='outline'
              disabled={bulkRemoveFromLibrary.isPending}
              onClick={() => setConfirmBulkRemoveOpen(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={selectedItems.length === 0 || isBulkBusy}
              onClick={() => void confirmBulkRemove()}
              className='border border-rose-500/25 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25'
            >
              {bulkRemoveFromLibrary.isPending ? 'Removing…' : 'Remove from Library'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProfileHistoryTab({
  viewMode,
  onViewModeChange,
  onCountChange,
}: {
  viewMode: 'grid' | 'list';
  onViewModeChange: (mode: 'grid' | 'list') => void;
  onCountChange: (count: number) => void;
}) {
  const mountedRef = useMountedRef();
  const [searchParams, setSearchParams] = useSearchParams();
  const historyQuery = useWatchHistory();
  const {
    data: history,
    isLoading: historyLoading,
    isFetching: historyFetching,
    refetch: refetchHistory,
  } = historyQuery;

  const historyCount = history?.length;
  useLayoutEffect(() => {
    if (historyCount !== undefined) onCountChange(historyCount);
  }, [historyCount, onCountChange]);

  const historySearch = searchParams.get('historyQ') ?? '';
  const setHistorySearch = (value: string) => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set('historyQ', value);
        else next.delete('historyQ');
        return next;
      },
      { replace: true },
    );
  };
  const historySearchRef = useRef<HTMLInputElement>(null);
  const historyContentRef = useRef<HTMLDivElement>(null);
  const historyRemovalFocusRef = useRef<{ button: HTMLButtonElement; index: number } | null>(null);
  const handleHistoryRemove = useCallback((button: HTMLButtonElement, index: number) => {
    if (document.activeElement === button) historyRemovalFocusRef.current = { button, index };
  }, []);
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
  const historySelectionIds = useMemo(
    () => (history ?? EMPTY_HISTORY_ITEMS).map((item) => `${item.type_}:${item.id}`),
    [history],
  );
  const filteredHistoryIds = useMemo(
    () => filteredHistory.map((item) => `${item.type_}:${item.id}`),
    [filteredHistory],
  );
  const historySelection = useCollectionSelection(
    historySelectionIds,
    filteredHistoryIds,
    true,
    bulkRemoveHistory.isPending,
    confirmHistoryRemoveOpen,
    historySearchRef,
  );
  const toggleHistorySelection = (item: WatchProgress, shiftKey = false) =>
    historySelection.toggle(`${item.type_}:${item.id}`, shiftKey);
  const confirmHistoryRemove = async () => {
    if (bulkRemoveHistory.isPending || historySelection.selectedIds.size === 0) return;
    const items = (history ?? EMPTY_HISTORY_ITEMS)
      .filter((item) => historySelection.selectedIds.has(`${item.type_}:${item.id}`))
      .map((item) => ({ id: item.id, type: item.type_ }));
    try {
      await bulkRemoveHistory.mutateAsync(items);
      if (mountedRef.current) historySelection.exit();
    } catch {
      // The mutation restores the optimistic rows and reports the error.
    } finally {
      if (mountedRef.current) setConfirmHistoryRemoveOpen(false);
    }
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
              : `${history.length} ${history.length === 1 ? 'title' : 'titles'}`}
          </output>
          <ViewToggle viewMode={viewMode} onChange={onViewModeChange} />
          <Button
            ref={historySelection.triggerRef}
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
          onRetry={refetchHistory}
          isRetrying={historyFetching}
          viewMode={viewMode}
          getItemKey={watchProgressItemKey}
          renderItem={(item) => (
            <HistoryItem
              item={item}
              selectionMode={historySelection.selectionMode}
              isSelected={historySelection.selectedIds.has(`${item.type_}:${item.id}`)}
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
      <Dialog
        open={confirmHistoryRemoveOpen}
        onOpenChange={(open) => {
          if (!bulkRemoveHistory.isPending) setConfirmHistoryRemoveOpen(open);
        }}
      >
        <DialogContent
          className='border-white/10 bg-zinc-950 sm:max-w-md'
          onEscapeKeyDown={(event) => {
            if (bulkRemoveHistory.isPending) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (bulkRemoveHistory.isPending) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const trigger = historySelection.triggerRef.current;
            (trigger && !trigger.disabled ? trigger : historySearchRef.current)?.focus({
              preventScroll: true,
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>Remove selected history?</DialogTitle>
            <DialogDescription>
              Remove all watched episodes and playback progress for{' '}
              {historySelection.selectedIds.size} selected title
              {historySelection.selectedIds.size === 1 ? '' : 's'}? Your library, watch statuses and
              custom lists will be kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant='outline'
              disabled={bulkRemoveHistory.isPending}
              onClick={() => setConfirmHistoryRemoveOpen(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={historySelection.selectedIds.size === 0 || bulkRemoveHistory.isPending}
              onClick={() => void confirmHistoryRemove()}
              className='border border-rose-500/25 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25'
            >
              {bulkRemoveHistory.isPending ? 'Removing…' : 'Remove from history'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
}) {
  return (
    <div>
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
            className='mt-4 px-3 py-2'
            message="Couldn't load some profile information."
            onRetry={onRetryHeader}
            isRetrying={headerRetrying}
          />
        )}
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
