import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  eachDayOfInterval,
  endOfDay,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  startOfDay,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns';
import { CalendarDays, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { memo, useCallback, useEffect, useEffectEvent, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { RemoteImage } from '@/components/remote-image';
import { RetryBanner } from '@/components/retry-banner';
import { Button } from '@/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { useLibraryItems, useWatchHistory, useWatchStatuses } from '@/hooks/use-media-library';
import { api, type WatchProgress } from '@/lib/api';
import { buildCalendarEvents, calendarEventKey, type CalendarEvent } from '@/lib/calendar-events';
import { prefetchDetailsRouteData } from '@/lib/details-prefetch';
import { isEditableTarget, OPEN_DIALOG_SELECTOR, RADIX_POPPER_CONTENT_SELECTOR } from '@/lib/dom';
import { currentPathWithSearch } from '@/lib/navigation';
import { resolvePlayerRouteMediaType } from '@/lib/player-navigation';
import {
  MEDIA_SCHEDULES_STALE_TIME_MS,
  mediaSchedulesQueryKey,
  WATCH_HISTORY_VIEW_STALE_TIME_MS,
} from '@/lib/query-invalidation';
import { cn, formatSeasonEpisode, parseLocalScheduleDate } from '@/lib/utils';

// Day cells keep height by capping rows; the rest live behind "+N more".
const MAX_VISIBLE_DAY_EVENTS = 3;
// Shared empty fallback — a fresh `[]` per lookup would defeat the memoized
// day cells' prop comparison.
const EMPTY_DAY_EVENTS: CalendarEvent[] = [];
const UPCOMING_WINDOW_DAYS = 14;
const MAX_UPCOMING_EVENTS = 8;
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CALENDAR_POPOVER_CLASS =
  'w-72 bg-zinc-950/95 backdrop-blur-xl border-white/[0.08] text-white shadow-2xl rounded-xl';

/** Short "when" for an upcoming event — relative inside a week, else the date. */
function formatEventDayLabel(date: Date, today: Date): string {
  const diff = differenceInCalendarDays(date, today);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff < 7) return format(date, 'EEEE');
  return format(date, 'MMM d');
}

function eventDetailsPath(event: CalendarEvent) {
  return `/details/${resolvePlayerRouteMediaType(event.mediaType)}/${event.mediaId}`;
}

function eventDetailsState(event: CalendarEvent, from: string) {
  return event.type === 'episode' ? { from, season: event.season } : { from };
}

export function Calendar() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [now, setNow] = useState(() => new Date());
  const monthParam = searchParams.get('month');
  const defaultMonthMs = startOfMonth(now).getTime();
  const currentMonth = useMemo(
    () =>
      (monthParam && /^\d{4}-\d{2}$/.test(monthParam)
        ? parseLocalScheduleDate(`${monthParam}-01`)
        : null) ?? new Date(defaultMonthMs),
    [monthParam, defaultMonthMs],
  );
  const from = currentPathWithSearch();
  useDocumentTitle('Calendar');

  const {
    data: library,
    isLoading: libraryLoading,
    isLoadingError: libraryLoadError,
    refetch: refetchLibrary,
  } = useLibraryItems();

  const { data: allWatchStatuses } = useWatchStatuses();

  const { data: watchHistory } = useWatchHistory({
    staleTime: WATCH_HISTORY_VIEW_STALE_TIME_MS,
  });

  // Dedupe canonical identities while preserving raw request types for IPC.
  const scheduleLookupItems = useMemo(() => {
    const watchHistoryById = new Map<string, WatchProgress>();
    (watchHistory ?? []).forEach((entry) => {
      if (!entry?.id) return;
      const existing = watchHistoryById.get(entry.id);
      if (!existing || entry.last_watched > existing.last_watched) {
        watchHistoryById.set(entry.id, entry);
      }
    });

    const byKey = new Map<string, { mediaType: string; id: string }>();

    for (const item of library ?? []) {
      if (
        (item.type !== 'movie' && item.type !== 'series') ||
        allWatchStatuses?.[item.id] === 'dropped'
      )
        continue;
      byKey.set(`${item.type}:${item.id}`, { mediaType: item.type, id: item.id });
    }

    Object.entries(allWatchStatuses ?? {}).forEach(([itemId, status]) => {
      if (status !== 'watching') return;

      const fromHistory = watchHistoryById.get(itemId);
      if (!fromHistory) return;

      if (
        fromHistory.type_ !== 'movie' &&
        fromHistory.type_ !== 'series' &&
        fromHistory.type_ !== 'anime'
      )
        return;

      const scheduleType = fromHistory.type_ === 'anime' ? 'series' : fromHistory.type_;
      byKey.set(`${scheduleType}:${fromHistory.id}`, {
        mediaType: fromHistory.type_,
        id: fromHistory.id,
      });
    });

    // Sort raw request keys once for stable query identity.
    return Array.from(byKey.values())
      .map((item) => ({
        mediaType: item.mediaType,
        id: item.id,
        key: `${item.mediaType}:${item.id}`,
      }))
      .toSorted((left, right) => {
        if (left.key === right.key) return 0;
        return left.key < right.key ? -1 : 1;
      })
      .map(({ mediaType, id }) => ({ mediaType, id }));
  }, [library, allWatchStatuses, watchHistory]);
  const scheduleQueryKey = useMemo(
    () => mediaSchedulesQueryKey(scheduleLookupItems),
    [scheduleLookupItems],
  );
  const {
    data: schedules = [],
    isError: isScheduleError,
    isLoading: isLoadingSchedules,
    isFetching: isFetchingSchedules,
    refetch: refetchSchedules,
  } = useQuery({
    queryKey: scheduleQueryKey,
    queryFn: () => api.getMediaSchedules(scheduleLookupItems),
    enabled: scheduleLookupItems.length > 0,
    staleTime: MEDIA_SCHEDULES_STALE_TIME_MS,
  });
  const isScheduleLoading =
    scheduleLookupItems.length > 0 && (isLoadingSchedules || isFetchingSchedules);

  // Re-sync the local day at midnight and when returning to the app.
  const todayStartMs = startOfDay(now).getTime();

  useEffect(() => {
    let timer = 0;
    const scheduleMidnight = () => {
      timer = window.setTimeout(
        () => {
          setNow(new Date());
          scheduleMidnight();
        },
        startOfDay(addDays(new Date(), 1)).getTime() - Date.now(),
      );
    };
    const onReturnToView = () => {
      if (document.visibilityState !== 'visible') return;
      window.clearTimeout(timer);
      setNow(new Date());
      scheduleMidnight();
    };
    scheduleMidnight();
    document.addEventListener('visibilitychange', onReturnToView);
    window.addEventListener('focus', onReturnToView);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onReturnToView);
      window.removeEventListener('focus', onReturnToView);
    };
  }, []);

  const days = useMemo(() => {
    const start = startOfWeek(startOfMonth(currentMonth));
    const end = endOfWeek(endOfMonth(currentMonth));
    return eachDayOfInterval({ start, end });
  }, [currentMonth]);

  // Materialize events only in the visible grid or upcoming strip.
  const visibleStartMs = days[0].getTime();
  const visibleEndMs = endOfDay(days[days.length - 1]).getTime();
  const upcomingEndMs = endOfDay(
    addDays(new Date(todayStartMs), UPCOMING_WINDOW_DAYS - 1),
  ).getTime();

  const events = useMemo(
    () =>
      buildCalendarEvents(schedules, {
        visibleStartMs,
        visibleEndMs,
        todayStartMs,
        upcomingEndMs,
      }),
    [schedules, todayStartMs, visibleStartMs, visibleEndMs, upcomingEndMs],
  );

  const upcomingEvents = useMemo(
    () =>
      events
        .filter((event) => {
          const ms = event.date.getTime();
          return ms >= todayStartMs && ms <= upcomingEndMs;
        })
        .toSorted((a, b) => a.date.getTime() - b.date.getTime())
        .slice(0, MAX_UPCOMING_EVENTS),
    [events, todayStartMs, upcomingEndMs],
  );

  const eventsByDay = useMemo(() => {
    const grouped = new Map<string, CalendarEvent[]>();
    for (const event of events) {
      const key = format(event.date, 'yyyy-MM-dd');
      const existing = grouped.get(key);
      if (existing) {
        existing.push(event);
      } else {
        grouped.set(key, [event]);
      }
    }

    grouped.forEach((list) => {
      list.sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'episode' ? -1 : 1;
        }
        if (a.type === 'episode' && b.type === 'episode') {
          if ((a.season ?? 0) !== (b.season ?? 0)) return (a.season ?? 0) - (b.season ?? 0);
          return (a.episode ?? 0) - (b.episode ?? 0);
        }
        return a.seriesTitle.localeCompare(b.seriesTitle);
      });
    });

    return grouped;
  }, [events]);

  // All of today's events — the strip itself is capped at MAX_UPCOMING_EVENTS.
  const airingTodayCount = eventsByDay.get(format(now, 'yyyy-MM-dd'))?.length ?? 0;

  const prefetchEventDetails = useCallback(
    (event: CalendarEvent) => {
      prefetchDetailsRouteData(queryClient, {
        mediaId: event.mediaId,
        mediaType: event.mediaType,
      });
    },
    [queryClient],
  );

  const setCurrentMonth = (month: Date) => {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (isSameMonth(month, new Date())) next.delete('month');
        else next.set('month', format(month, 'yyyy-MM'));
        return next;
      },
      { replace: true },
    );
  };
  const handlePrevMonth = () => setCurrentMonth(subMonths(currentMonth, 1));
  const handleNextMonth = () => setCurrentMonth(addMonths(currentMonth, 1));
  const handleToday = () => setCurrentMonth(new Date());
  const isCurrentMonthView = isSameMonth(currentMonth, now);

  // Dialogs, the mini player, and popovers own their navigation keys.
  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (isEditableTarget(event.target, '[role="dialog"]')) return;
    if (document.querySelector(OPEN_DIALOG_SELECTOR)) return;
    if (document.querySelector(RADIX_POPPER_CONTENT_SELECTOR)) return;

    if (event.key === 'ArrowLeft') {
      handlePrevMonth();
    } else if (event.key === 'ArrowRight') {
      handleNextMonth();
    } else if (event.key === 't' || event.key === 'T') {
      handleToday();
    } else {
      return;
    }
    event.preventDefault();
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => handleKeyDown(event);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (libraryLoading) {
    return (
      <div className='mx-auto flex min-h-[70vh] w-full max-w-7xl items-center justify-center pl-[84px] pr-4 page-enter'>
        <Loader2 className='h-7 w-7 animate-spin text-white/35' aria-label='Loading calendar' />
      </div>
    );
  }

  return (
    <div className='mx-auto w-full max-w-7xl pr-4 pl-[84px] sm:pr-6 lg:pl-[92px] lg:pr-8 pt-6 pb-16 page-enter'>
      <div className='flex flex-col md:flex-row items-start md:items-center justify-between mb-4 gap-3'>
        <div>
          <h1 className='text-[20px] font-medium tracking-[-0.03em] text-white'>Calendar</h1>
          <p className='mt-1.5 text-[13px] text-zinc-500'>Upcoming episodes from your library</p>
        </div>

        <div className='flex items-center gap-1 bg-white/[0.03] p-0.5 rounded-lg border border-white/[0.06]'>
          <Button
            variant='ghost'
            size='icon'
            onClick={handlePrevMonth}
            aria-label='Previous month'
            title='Previous month (←)'
            className='h-7 w-7 hover:bg-white/[0.06] rounded-md'
          >
            <ChevronLeft className='w-3.5 h-3.5' />
          </Button>
          <div
            className='px-3 font-semibold text-[13px] min-w-[130px] text-center text-zinc-200 tabular-nums'
            aria-live='polite'
          >
            {format(currentMonth, 'MMMM yyyy')}
          </div>
          <Button
            variant='ghost'
            size='icon'
            onClick={handleNextMonth}
            aria-label='Next month'
            title='Next month (→)'
            className='h-7 w-7 hover:bg-white/[0.06] rounded-md'
          >
            <ChevronRight className='w-3.5 h-3.5' />
          </Button>
          <Button
            variant='ghost'
            size='sm'
            // aria-disabled, not disabled: landing on the current month would
            // drop the focused button's focus to <body>.
            aria-disabled={isCurrentMonthView || undefined}
            onClick={() => {
              if (!isCurrentMonthView) handleToday();
            }}
            title='Jump to current month (T)'
            className={cn(
              'ml-0.5 text-[11px] font-semibold rounded-md h-7 px-2.5',
              isCurrentMonthView
                ? 'bg-white/[0.06] text-zinc-400 cursor-default'
                : 'text-zinc-400 hover:text-white hover:bg-white/[0.06]',
            )}
          >
            Today
          </Button>
        </div>
      </div>

      {libraryLoadError ? (
        <RetryBanner
          className='mb-4'
          title="Couldn't load your library"
          message='Upcoming episodes need your library — try again.'
          onRetry={() => void refetchLibrary()}
        />
      ) : (
        scheduleLookupItems.length === 0 && (
          <div className='mb-4 flex flex-col items-center rounded-xl border border-dashed border-white/[0.08] bg-white/[0.02] px-6 py-8 text-center'>
            <span className='mb-3 flex h-12 w-12 items-center justify-center rounded-2xl border border-white/[0.07] bg-white/[0.05]'>
              <CalendarDays className='h-5 w-5 text-zinc-400' />
            </span>
            <h2 className='text-[15px] font-semibold text-white'>Your schedule is empty</h2>
            <p className='mt-1 max-w-sm text-[13px] leading-relaxed text-zinc-500'>
              Add shows to your library to track upcoming episodes.
            </p>
            <Button asChild size='sm' className='mt-4 h-8 border-0 text-[12px] accent-lattice'>
              <Link to='/search?type=series'>Find shows</Link>
            </Button>
          </div>
        )
      )}

      {scheduleLookupItems.length > 0 && isLoadingSchedules && (
        <div className='mb-4 flex items-center gap-2 text-xs text-zinc-400'>
          <Loader2 className='h-3.5 w-3.5 animate-spin' />
          <span>Loading release data from your library…</span>
        </div>
      )}

      {scheduleLookupItems.length > 0 && isScheduleError && !isScheduleLoading && (
        <RetryBanner
          className='mb-4'
          title="Couldn't load release schedules"
          message='Upcoming episodes may be missing — try again.'
          onRetry={() => void refetchSchedules()}
        />
      )}

      <div className='mb-4 rounded-xl border border-white/[0.06] bg-zinc-950/60 p-5 backdrop-blur-sm'>
        <div className='flex items-center justify-between mb-3'>
          <div className='flex items-center gap-2.5'>
            <h2 className='text-[15px] font-semibold text-white tracking-tight'>Upcoming</h2>
            <span className='text-[11px] text-zinc-600 font-medium'>Next 14 days</span>
            {isFetchingSchedules && !isLoadingSchedules && (
              <Loader2
                className='h-3 w-3 animate-spin text-zinc-500'
                aria-label='Refreshing schedules'
              />
            )}
          </div>
          <div className='flex items-center gap-2'>
            {airingTodayCount > 0 && (
              <span className='accent-lattice-soft rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide'>
                {airingTodayCount} today
              </span>
            )}
            {upcomingEvents.length > 0 && (
              <span className='text-[11px] text-zinc-600 font-medium tabular-nums'>
                {upcomingEvents.length}
              </span>
            )}
          </div>
        </div>
        {upcomingEvents.length === 0 ? (
          <div className='text-[13px] text-zinc-600 py-3'>
            No upcoming episodes in the next two weeks.
          </div>
        ) : (
          <div className='grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4'>
            {upcomingEvents.map((event) => (
              <UpcomingEventCard
                key={calendarEventKey(event)}
                event={event}
                from={from}
                now={now}
                onPrefetch={prefetchEventDetails}
              />
            ))}
          </div>
        )}
      </div>

      <div className='overflow-hidden rounded-xl border border-white/[0.06] bg-zinc-950/60 backdrop-blur-sm'>
        <div className='grid grid-cols-7 border-b border-white/[0.05] bg-white/[0.02]'>
          {WEEKDAY_LABELS.map((day, dayIndex) => (
            <div
              key={day}
              className={cn(
                'py-2.5 text-center text-[11px] font-semibold uppercase tracking-widest',
                isCurrentMonthView && dayIndex === now.getDay()
                  ? 'text-[var(--accent-nav)]'
                  : 'text-zinc-600',
              )}
            >
              {day}
            </div>
          ))}
        </div>

        <div className='grid grid-cols-7 auto-rows-fr'>
          {days.map((day, dayIdx) => {
            const dayKey = format(day, 'yyyy-MM-dd');
            return (
              <CalendarDayCell
                key={dayKey}
                day={day}
                dayEvents={eventsByDay.get(dayKey) ?? EMPTY_DAY_EVENTS}
                isToday={isSameDay(day, now)}
                isCurrentMonth={isSameMonth(day, currentMonth)}
                isLastColumn={dayIdx % 7 === 6}
                from={from}
                onPrefetch={prefetchEventDetails}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

const UpcomingEventCard = memo(function UpcomingEventCard({
  event,
  from,
  now,
  onPrefetch,
}: {
  event: CalendarEvent;
  from: string;
  now: Date;
  onPrefetch: (event: CalendarEvent) => void;
}) {
  const dayLabel = formatEventDayLabel(event.date, now);
  const episodeLabel = formatSeasonEpisode(event.season, event.episode);
  return (
    <Link
      onPointerEnter={() => onPrefetch(event)}
      onFocus={() => onPrefetch(event)}
      to={eventDetailsPath(event)}
      state={eventDetailsState(event, from)}
      className='group rounded-lg border border-white/[0.06] bg-white/[0.03] p-2.5 transition-colors duration-150 hover:border-white/[0.1] hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20'
    >
      <div className='flex items-center gap-2.5'>
        <div className='w-8 h-12 rounded-md overflow-hidden bg-black/30 shrink-0'>
          {event.poster && (
            <RemoteImage
              src={event.poster}
              alt={`${event.seriesTitle} poster`}
              loading='lazy'
              className='w-full h-full object-cover'
            />
          )}
        </div>
        <div className='min-w-0 flex-1'>
          <div className='flex items-center gap-1 text-[10px] leading-4'>
            {dayLabel === 'Today' ? (
              <span className='accent-lattice-soft rounded border px-1 py-px text-[9px] font-bold uppercase tracking-wide'>
                Today
              </span>
            ) : (
              <span className='font-medium text-zinc-400'>{dayLabel}</span>
            )}
            <span className='text-zinc-600'>· {format(event.date, 'MMM d')}</span>
          </div>
          <div className='text-[12px] font-semibold text-white truncate'>{event.seriesTitle}</div>
          {event.type === 'episode' ? (
            <div className='text-[10px] text-zinc-400 truncate'>
              {episodeLabel}
              {event.title ? ` · ${event.title}` : ''}
            </div>
          ) : (
            <div className='text-[10px] text-amber-400/80 font-medium'>Movie</div>
          )}
        </div>
      </div>
    </Link>
  );
});

const CalendarDayCell = memo(function CalendarDayCell({
  day,
  dayEvents,
  isToday,
  isCurrentMonth,
  isLastColumn,
  from,
  onPrefetch,
}: {
  day: Date;
  dayEvents: CalendarEvent[];
  isToday: boolean;
  isCurrentMonth: boolean;
  isLastColumn: boolean;
  from: string;
  onPrefetch: (event: CalendarEvent) => void;
}) {
  const visibleDayEvents = dayEvents.slice(0, MAX_VISIBLE_DAY_EVENTS);
  const hiddenDayEvents = dayEvents.slice(MAX_VISIBLE_DAY_EVENTS);

  return (
    <div
      className={cn(
        'min-h-[120px] p-2 border-b border-r border-white/[0.04] relative group transition-colors hover:bg-white/[0.04]',
        !isCurrentMonth && 'bg-black/30 opacity-40',
        isLastColumn && 'border-r-0',
      )}
    >
      <div
        className={cn(
          'text-[12px] font-medium tabular-nums mb-2 w-7 h-7 flex items-center justify-center rounded-md transition-colors',
          isToday ? 'accent-lattice font-bold' : 'text-zinc-500 group-hover:text-zinc-300',
        )}
      >
        {format(day, 'd')}
      </div>

      <div className='space-y-1.5'>
        {visibleDayEvents.map((event) => {
          const episodeLabel = formatSeasonEpisode(event.season, event.episode);
          return (
            <HoverCard key={calendarEventKey(event)} openDelay={150} closeDelay={120}>
              <HoverCardTrigger asChild>
                <Link
                  to={eventDetailsPath(event)}
                  state={eventDetailsState(event, from)}
                  onPointerEnter={() => onPrefetch(event)}
                  onFocus={() => onPrefetch(event)}
                  aria-label={`${event.seriesTitle} — ${
                    event.type === 'episode'
                      ? `${episodeLabel || 'Episode'} airing`
                      : 'Movie releasing'
                  } ${format(event.date, 'EEEE, MMMM d')}`}
                  className={cn(
                    'w-full text-left text-[10px] bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] hover:border-white/[0.12] rounded-md px-1.5 py-1 transition-colors duration-150 flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30',
                    isToday && 'border-[rgb(var(--accent-nav-rgb)/0.35)] bg-white/[0.06]',
                  )}
                >
                  {event.poster && (
                    <span className='block w-4 h-[22px] bg-zinc-900 rounded-[3px] overflow-hidden shrink-0'>
                      <RemoteImage
                        src={event.poster}
                        alt=''
                        loading='lazy'
                        className='w-full h-full object-cover opacity-70'
                      />
                    </span>
                  )}
                  <span className='min-w-0 truncate text-zinc-300 font-medium'>
                    {event.seriesTitle}
                  </span>
                  {event.type === 'episode' ? (
                    episodeLabel && (
                      <span
                        className={cn(
                          'ml-auto shrink-0 tabular-nums',
                          isToday ? 'text-[var(--accent-nav)] font-semibold' : 'text-zinc-500',
                        )}
                      >
                        {episodeLabel}
                      </span>
                    )
                  ) : (
                    <span
                      className='ml-auto w-1.5 h-1.5 rounded-full bg-amber-400/80 shrink-0'
                      aria-hidden='true'
                    />
                  )}
                </Link>
              </HoverCardTrigger>
              <HoverCardContent
                className={cn(CALENDAR_POPOVER_CLASS, 'p-0')}
                align='start'
                sideOffset={6}
              >
                <div className='flex gap-2.5 p-2.5'>
                  <div className='w-16 shrink-0 aspect-2/3 bg-black/30 rounded-md overflow-hidden'>
                    {event.poster && (
                      <RemoteImage
                        src={event.poster}
                        alt={`${event.seriesTitle} poster`}
                        loading='lazy'
                        className='w-full h-full object-cover'
                      />
                    )}
                  </div>
                  <div className='flex-1 min-w-0'>
                    <h4 className='font-semibold text-[13px] leading-tight mb-1'>
                      {event.seriesTitle}
                    </h4>
                    {event.type === 'episode' ? (
                      <>
                        <p className='text-[11px] text-zinc-400 font-medium mb-0.5'>
                          {episodeLabel}
                        </p>
                        <p className='text-[11px] text-zinc-500 line-clamp-2 mb-1.5'>
                          {event.title}
                        </p>
                      </>
                    ) : (
                      <p className='text-[11px] text-amber-400/80 font-medium mb-1.5'>
                        Upcoming Movie
                      </p>
                    )}
                    <p className='text-[10px] text-zinc-500'>
                      {format(event.date, 'EEEE, MMM d')}
                      {isToday && (
                        <span className='text-[var(--accent-nav)] font-semibold'> · Today</span>
                      )}
                    </p>
                  </div>
                </div>
              </HoverCardContent>
            </HoverCard>
          );
        })}

        {hiddenDayEvents.length > 0 && (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type='button'
                className='w-full text-left text-[10px] font-medium text-zinc-500 hover:text-zinc-200 px-1.5 py-1 rounded-md hover:bg-white/[0.05] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30'
              >
                +{hiddenDayEvents.length} more
              </button>
            </PopoverTrigger>
            <PopoverContent className={cn(CALENDAR_POPOVER_CLASS, 'p-1.5')} align='start'>
              <p className='px-2 pt-1 pb-1.5 text-[11px] font-semibold text-zinc-400'>
                {format(day, 'EEEE, MMM d')}
              </p>
              <div className='space-y-0.5'>
                {dayEvents.map((event) => (
                  <Link
                    key={calendarEventKey(event)}
                    to={eventDetailsPath(event)}
                    state={eventDetailsState(event, from)}
                    onPointerEnter={() => onPrefetch(event)}
                    onFocus={() => onPrefetch(event)}
                    className='flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-white/[0.06] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30'
                  >
                    {event.poster && (
                      <span className='block w-5 h-7 bg-zinc-900 rounded-[3px] overflow-hidden shrink-0'>
                        <RemoteImage
                          src={event.poster}
                          alt=''
                          loading='lazy'
                          className='w-full h-full object-cover opacity-70'
                        />
                      </span>
                    )}
                    <span className='min-w-0 flex-1 truncate text-[11px] text-zinc-300'>
                      {event.seriesTitle}
                    </span>
                    <span className='shrink-0 text-[10px] text-zinc-500 tabular-nums'>
                      {event.type === 'episode'
                        ? formatSeasonEpisode(event.season, event.episode)
                        : 'Movie'}
                    </span>
                  </Link>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        )}
      </div>
    </div>
  );
});
