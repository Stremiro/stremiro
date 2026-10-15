import { useQuery } from '@tanstack/react-query';
import { History, LayoutList, Library, Search } from 'lucide-react';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  type LocalProfile,
  type LocalProfileUpdate,
  useLocalProfile,
} from '@/hooks/use-local-profile';
import {
  useLibraryItems,
  useProfileLibrary,
  useBulkAddToList,
  useBulkRemoveFromLibrary,
  useBulkSetWatchStatus,
  useTotalWatchTime,
  useWatchHistory,
  useWatchStatuses,
} from '@/hooks/use-media-library';
import {
  api,
  getListErrorMessage,
  type MediaItem,
  WATCH_STATUS_COLORS,
  WATCH_STATUS_LABELS,
  WATCH_STATUSES,
  type WatchStatus,
} from '@/lib/api';
import { DATA_STATS_QUERY_KEY, DATA_STATS_STALE_TIME_MS } from '@/lib/query-invalidation';
import { watchProgressItemKey } from '@/lib/history-playback';
import { isEditableTarget, OPEN_DIALOG_SELECTOR, RADIX_POPPER_CONTENT_SELECTOR } from '@/lib/dom';
import { cn, SIDEBAR_PAGE_COLUMN_INSETS } from '@/lib/utils';

const PROFILE_MEDIA_GRID_SKELETON_KEYS = Array.from(
  { length: 12 },
  (_, index) => `profile-grid-skeleton-${index}`,
);
const EMPTY_LIBRARY_ITEMS: MediaItem[] = [];
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
  const setLibraryParam = useCallback(
    (key: 'q' | 'type' | 'status' | 'sort', value: string, defaultValue = '') => {
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

  const {
    data: library,
    isLoading: libraryLoading,
    isFetched: libraryFetched,
    isError: libraryError,
    isFetching: libraryFetching,
    refetch: refetchLibrary,
  } = useLibraryItems();

  const {
    data: history,
    isLoading: historyLoading,
    isFetched: historyFetched,
    isError: historyError,
    isFetching: historyFetching,
    refetch: refetchHistory,
  } = useWatchHistory({ enabled: activeTab === 'history' });

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
    setLibraryParam('q', librarySearch);
  }, [librarySearch, librarySearchParam, location.pathname, setLibraryParam]);
  useEffect(() => {
    if (librarySearch === librarySearchParam) return;
    librarySearchTimerRef.current = window.setTimeout(flushLibrarySearch, 250);
    return () => window.clearTimeout(librarySearchTimerRef.current);
  }, [librarySearch, librarySearchParam, flushLibrarySearch]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [confirmBulkRemoveOpen, setConfirmBulkRemoveOpen] = useState(false);
  const bulkRemoveFromLibrary = useBulkRemoveFromLibrary();
  const bulkSetWatchStatus = useBulkSetWatchStatus();
  const bulkAddToList = useBulkAddToList();
  const isBulkBusy =
    bulkRemoveFromLibrary.isPending || bulkSetWatchStatus.isPending || bulkAddToList.isPending;
  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
    setConfirmBulkRemoveOpen(false);
  }, []);

  useEffect(() => {
    if (!selectionMode) return;
    if (activeTab !== 'library' || (library?.length === 0 && !bulkRemoveFromLibrary.isPending)) {
      exitSelectionMode();
      return;
    }
    if (!library || bulkRemoveFromLibrary.isPending) return;
    const libraryIds = new Set(library.map((item) => item.id));
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => libraryIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [selectionMode, activeTab, library, bulkRemoveFromLibrary.isPending, exitSelectionMode]);

  useEffect(() => {
    if (!selectionMode || confirmBulkRemoveOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (
        isEditableTarget(document.activeElement, RADIX_POPPER_CONTENT_SELECTOR) ||
        document.querySelector(`${RADIX_POPPER_CONTENT_SELECTOR}, ${OPEN_DIALOG_SELECTOR}`)
      )
        return;
      event.preventDefault();
      exitSelectionMode();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [selectionMode, confirmBulkRemoveOpen, exitSelectionMode]);
  const librarySearchRef = useRef<HTMLInputElement>(null);
  const libraryReadFailed =
    (libraryError || (libraryFetched && libraryLoading)) && library === undefined;
  const statusFilterPending = libraryStatusFilter !== 'all' && allWatchStatuses === undefined;
  const profileLibraryQuery = useProfileLibrary({
    query: librarySearchParam,
    type: libraryTypeFilter,
    status: libraryStatusFilter,
    sort: librarySort,
  });
  const filteredLibrary =
    statusFilterPending || profileLibraryQuery.isError
      ? EMPTY_LIBRARY_ITEMS
      : (profileLibraryQuery.data?.items ?? EMPTY_LIBRARY_ITEMS);
  const statusCounts = profileLibraryQuery.data?.statusCounts ?? EMPTY_STATUS_COUNTS;
  const selectAllDisabled =
    statusFilterPending ||
    profileLibraryQuery.isError ||
    profileLibraryQuery.isFetching ||
    profileLibraryQuery.isPlaceholderData ||
    librarySearch !== librarySearchParam;

  const handleViewModeChange = useCallback(
    (mode: 'grid' | 'list') => {
      void updateViewMode(mode).catch(() => toast.error('Failed to save view mode'));
    },
    [updateViewMode],
  );

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
    () => (library ?? []).filter((item) => selectedIds.has(item.id)),
    [library, selectedIds],
  );
  const allFilteredSelected =
    filteredLibrary.length > 0 && filteredLibrary.every((item) => selectedIds.has(item.id));

  const handleToggleSelect = useCallback(
    (item: MediaItem) => {
      if (isBulkBusy) return;
      setSelectedIds((current) => {
        const next = new Set(current);
        if (next.has(item.id)) next.delete(item.id);
        else next.add(item.id);
        return next;
      });
    },
    [isBulkBusy],
  );

  const handleSelectAllFiltered = useCallback(() => {
    if (isBulkBusy || selectAllDisabled) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const item of filteredLibrary) next.add(item.id);
      return next;
    });
  }, [filteredLibrary, isBulkBusy, selectAllDisabled]);

  const handleBulkSetStatus = async (status: WatchStatus | null) => {
    if (selectedItems.length === 0 || isBulkBusy) return;
    try {
      const count = await bulkSetWatchStatus.mutateAsync({ items: selectedItems, status });
      toast.success(
        status === null
          ? `Cleared status for ${count} title${count === 1 ? '' : 's'}`
          : `Set ${count} title${count === 1 ? '' : 's'} to ${WATCH_STATUS_LABELS[status]}`,
      );
    } catch {
      toast.error('Failed to update watch statuses');
    }
  };

  const handleBulkAddToList = async (listId: string, listName: string, items: MediaItem[]) => {
    if (items.length === 0 || isBulkBusy) return;
    try {
      const count = await bulkAddToList.mutateAsync({ listId, items });
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
      exitSelectionMode();
    } catch {
      toast.error('Failed to remove titles from Library');
      setConfirmBulkRemoveOpen(false);
    }
  };

  const historyCount =
    activeTab === 'history' && history !== undefined
      ? history.length
      : (dataStats?.history_title_count ?? history?.length);
  const libraryCount = library?.length ?? 0;
  const listsCount = dataStats?.lists_count ?? 0;

  const [historySearch, setHistorySearch] = useState('');
  const historySearchRef = useRef<HTMLInputElement>(null);
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
  };

  return (
    <div
      className='relative min-h-screen page-enter'
      data-escape-capture={selectionMode && activeTab === 'library' ? '' : undefined}
    >
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
          libraryCount={library?.length}
          listsCount={dataStats?.lists_count}
          historyCount={historyCount}
          totalWatchTimeSecs={totalWatchTimeSecs}
          statusCounts={statusCounts}
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

          {activeTab === 'library' && libraryCount > 0 && (
            <LibraryToolbar
              typeFilter={libraryTypeFilter}
              onTypeFilterChange={(type) => setLibraryParam('type', type, 'all')}
              statusFilter={libraryStatusFilter}
              onStatusFilterChange={(status) => setLibraryParam('status', status, 'all')}
              statusCounts={statusCounts}
              statusesAvailable={allWatchStatuses !== undefined}
              libraryCount={libraryCount}
              filteredCount={filteredLibrary.length}
              search={librarySearch}
              onSearchChange={setLibrarySearch}
              searchInputRef={librarySearchRef}
              sort={librarySort}
              onSortChange={(sort) => setLibraryParam('sort', sort, 'default')}
              viewMode={viewMode}
              onViewModeChange={handleViewModeChange}
              onReset={resetLibraryFilters}
              selectionMode={selectionMode}
              onToggleSelectionMode={() => {
                if (isBulkBusy) return;
                if (selectionMode) exitSelectionMode();
                else setSelectionMode(true);
              }}
            />
          )}

          <TabsContent
            value='library'
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
                    ? "Couldn't load watch statuses. Status filters are unavailable."
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
                onClearSelection={() => setSelectedIds(new Set())}
                onExitSelectionMode={exitSelectionMode}
                onBulkSetStatus={(status) => void handleBulkSetStatus(status)}
                onBulkAddToList={handleBulkAddToList}
                onBulkRemove={handleBulkRemove}
                isBusy={isBulkBusy}
              />
            )}
            <CollectionTabContent
              isError={libraryReadFailed || profileLibraryQuery.isError}
              isLoading={
                libraryLoading ||
                profileLibraryQuery.isLoading ||
                (statusFilterPending && !watchStatusesError)
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
                  currentStatusOverride={allWatchStatuses?.[item.id] ?? null}
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
          </TabsContent>

          <TabsContent value='lists'>
            <ListsManager />
          </TabsContent>

          <TabsContent value='history' className='space-y-4'>
            {history && history.length > 0 && (
              <div className='flex items-center gap-2'>
                <SearchInput
                  inputRef={historySearchRef}
                  placeholder='Search history…'
                  value={historySearch}
                  onValueChange={setHistorySearch}
                  clearLabel='Clear history search'
                  wrapperClassName='flex-1 min-w-0'
                  className='h-9 text-[13px] bg-white/[0.03] border-white/[0.07] text-white placeholder:text-zinc-500 focus-visible:border-(--accent-nav) focus-visible:ring-(--accent-nav)/25 rounded-lg'
                />
                <output className='shrink-0 text-[12px] tabular-nums text-zinc-400'>
                  {normalizedHistorySearch
                    ? `${filteredHistory.length} of ${history.length}`
                    : `${history.length} ${history.length === 1 ? 'title' : 'titles'}`}
                </output>
                <ViewToggle viewMode={viewMode} onChange={handleViewModeChange} />
              </div>
            )}
            <CollectionTabContent
              isError={
                (historyError || (historyFetched && historyLoading)) && history === undefined
              }
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
          </TabsContent>
        </Tabs>
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
                    isHydrating={isHydrating}
                    isError={isError}
                    isRetrying={isRetrying}
                    onRetry={onRetry}
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
