import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Channel } from '@tauri-apps/api/core';
import { CalendarDays, Check, ChevronLeft, ChevronRight, Eye, EyeOff, WifiOff } from 'lucide-react';
import { Fragment, memo, useEffect, useEffectEvent, useRef } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { PosterThumb } from '@/components/poster-thumb';
import { RetryBanner } from '@/components/retry-banner';
import { Button } from '@/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { useAppUiPreferences } from '@/hooks/use-app-ui-preferences';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { useLocalDay } from '@/hooks/use-local-day';
import { useOnlineStatus } from '@/hooks/use-online-status';
import {
  api,
  type AppUiPreferences,
  type CalendarSchedule,
  type CalendarScheduleEvent,
} from '@/lib/api';
import { calendarEventKey, type CalendarEvent } from '@/lib/calendar-events';
import { prefetchDetailsRouteData } from '@/lib/details-prefetch';
import { isEditableTarget, OPEN_DIALOG_SELECTOR, RADIX_POPPER_CONTENT_SELECTOR } from '@/lib/dom';
import { buildDetailsRoute } from '@/lib/player-navigation';
import { CALENDAR_EVENTS_STALE_TIME_MS, calendarEventsQueryKey } from '@/lib/query-invalidation';
import { parseScheduleDay, SHORT_DATE_FORMATTER, toLocalDate } from '@/lib/schedule-dates';
import {
  cn,
  formatEpisodeHeading,
  formatSeasonEpisode,
  pluralize,
  queryNeedsRetry,
  scrollBehavior,
  SIDEBAR_PAGE_COLUMN_INSETS,
} from '@/lib/utils';

const MAX_VISIBLE_DAY_EVENTS = 3;
// Shared empty fallback — a fresh `[]` would defeat the memoized cells' prop comparison.
const EMPTY_DAY_EVENTS: CalendarEvent[] = [];
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_FORMATTER = new Intl.DateTimeFormat('en-US', { weekday: 'long' });
const MONTH_YEAR_FORMATTER = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' });
const FULL_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});
const WEEKDAY_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'short',
  day: 'numeric',
});
const CALENDAR_POPOVER_CLASS =
  'w-72 max-w-[calc(100vw-2rem)] bg-zinc-950/95 border-white/[0.1] text-white shadow-xl rounded-lg';

function formatEventDayLabel(date: Temporal.PlainDate, today: Temporal.PlainDate): string {
  const diff = today.until(date).days;
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff < 7) return WEEKDAY_FORMATTER.format(date);
  return SHORT_DATE_FORMATTER.format(date);
}

const selectCalendarPreferences = (preferences: AppUiPreferences) => ({
  spoilerProtection: preferences.spoilerProtection,
  hideWatched: preferences.calendarHideWatched,
});

const visibleEpisodeTitle = (event: CalendarEvent, hideSpoilers: boolean) =>
  hideSpoilers && !event.seen ? undefined : event.title;

function WatchedMark() {
  return (
    <Check aria-hidden='true' className='size-3 shrink-0 text-(--accent-act)' strokeWidth={2.5} />
  );
}

const WATCHED_EVENT_CLASS =
  'opacity-55 hover:opacity-100 focus-visible:opacity-100 transition-opacity motion-reduce:transition-none';

function calendarEventLinkProps(
  event: CalendarEvent,
  from: string,
  onPrefetch: (event: CalendarEvent) => void,
  hideSpoilers: boolean,
) {
  const detail =
    event.type === 'episode'
      ? formatEpisodeHeading(
          event.season,
          event.episode,
          visibleEpisodeTitle(event, hideSpoilers),
        ) || 'Episode'
      : 'Movie';
  const label = `${event.seriesTitle} — ${detail} — ${FULL_DATE_FORMATTER.format(event.date)}${event.watched ? ' — Watched' : ''}`;
  return {
    to: buildDetailsRoute(event.mediaType, event.mediaId),
    state:
      event.type === 'episode' ? { from, season: event.season, episode: event.episode } : { from },
    onPointerEnter: () => onPrefetch(event),
    onFocus: () => onPrefetch(event),
    'aria-label': label,
    title: label,
  };
}

// Grouping/sorting live in `get_calendar_events`; the frontend only parses `releaseDate`.
const toCalendarEvents = (events: CalendarScheduleEvent[]) =>
  events.map((event) => ({ ...event, date: Temporal.PlainDate.from(event.releaseDate) }));

function focusCalendarToday(container: HTMLDivElement | null) {
  const today = container?.querySelector<HTMLElement>('[data-calendar-today]');
  today?.focus({ preventScroll: true });
  today?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: scrollBehavior() });
}

export function Calendar() {
  const queryClient = useQueryClient();
  const isOnline = useOnlineStatus();
  const calendarRef = useRef<HTMLDivElement>(null);
  const pendingTodayJump = useRef(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const now = toLocalDate(useLocalDay());
  const monthParam = searchParams.get('month');
  const selectedMonth =
    monthParam && /^\d{4}-\d{2}$/.test(monthParam) ? parseScheduleDay(`${monthParam}-01`) : null;
  const currentMonth = (selectedMonth ?? now).with({ day: 1 });
  const { pathname, search } = useLocation();
  const from = `${pathname}${search}`;
  useDocumentTitle('Calendar');
  const {
    preferences: { spoilerProtection, hideWatched },
    isHydrating: isHydratingPreferences,
    updatePreferences,
  } = useAppUiPreferences(selectCalendarPreferences);
  const hideSpoilers = spoilerProtection || isHydratingPreferences;

  const visibleStart = currentMonth.subtract({ days: currentMonth.dayOfWeek % 7 });
  const lastDay = currentMonth.with({ day: currentMonth.daysInMonth });
  const visibleEnd = lastDay.add({ days: 6 - (lastDay.dayOfWeek % 7) });
  const days = Array.from({ length: visibleStart.until(visibleEnd).days + 1 }, (_, index) =>
    visibleStart.add({ days: index }),
  );
  const range = {
    visibleStart: visibleStart.toString(),
    visibleEnd: visibleEnd.toString(),
    upcomingStart: now.toString(),
    hideWatched,
  };
  const {
    data: schedule,
    isError,
    isFetched,
    isPending,
    isLoading,
    isPlaceholderData,
    isFetching: isFetchingSchedules,
    refetch: refetchSchedules,
  } = useQuery({
    queryKey: calendarEventsQueryKey(range),
    queryFn: ({ queryKey, signal }) => {
      const channel = new Channel<CalendarSchedule>();
      const acceptSnapshots = queryClient.getQueryData(queryKey) === undefined;
      let settled = false;
      // eslint-disable-next-line unicorn/prefer-add-event-listener
      channel.onmessage = (cached) => {
        if (acceptSnapshots && !settled && !signal.aborted) {
          queryClient.setQueryData(queryKey, cached);
        }
      };
      return api.getCalendarEvents(range, channel).finally(() => {
        settled = true;
      });
    },
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[3] === range.upcomingStart &&
      previousQuery.queryKey[4] === range.hideWatched &&
      previous
        ? { ...previous, days: [] }
        : undefined,
    staleTime: CALENDAR_EVENTS_STALE_TIME_MS,
    enabled: isOnline,
  });
  const isScheduleError = queryNeedsRetry({ isError, isFetched, isPending });
  const isLoadingSchedules = (isLoading || isPlaceholderData) && !isScheduleError;
  const hasMissingSchedules = (schedule?.missingCount ?? 0) > 0;
  const upcomingEvents = toCalendarEvents(schedule?.upcoming ?? []);

  const eventsByDay = new Map(
    (schedule?.days ?? []).map((day) => [day.date, toCalendarEvents(day.events)]),
  );

  const airingTodayCount = eventsByDay.get(range.upcomingStart)?.length ?? 0;
  const monthKey = currentMonth.toPlainYearMonth().toString();
  const hasMonthReleases = schedule?.days.some(
    (day) => day.events.length > 0 && day.date.startsWith(monthKey),
  );
  useEffect(() => {
    if (!pendingTodayJump.current) return;
    pendingTodayJump.current = false;
    focusCalendarToday(calendarRef.current);
  }, [monthKey]);

  const prefetchEventDetails = (event: CalendarEvent) => {
    prefetchDetailsRouteData(queryClient, {
      mediaId: event.mediaId,
      mediaType: event.mediaType,
    });
  };

  const setCurrentMonth = (month: Temporal.PlainDate) => {
    if (calendarRef.current?.contains(document.activeElement)) {
      calendarRef.current.focus({ preventScroll: true });
    }
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (month.toPlainYearMonth().equals(now.toPlainYearMonth())) next.delete('month');
        else next.set('month', month.toPlainYearMonth().toString());
        return next;
      },
      { replace: true },
    );
  };
  const handlePrevMonth = () => setCurrentMonth(currentMonth.subtract({ months: 1 }));
  const handleNextMonth = () => setCurrentMonth(currentMonth.add({ months: 1 }));
  const isCurrentMonthView = currentMonth.toPlainYearMonth().equals(now.toPlainYearMonth());
  const handleToday = () => {
    if (isCurrentMonthView) {
      focusCalendarToday(calendarRef.current);
    } else {
      pendingTodayJump.current = true;
      setCurrentMonth(now);
    }
  };

  // Dialogs, the mini player, and popovers own their navigation keys.
  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (isEditableTarget(event.target, '[role="dialog"], [data-mini-player]')) return;
    if (document.querySelector(OPEN_DIALOG_SELECTOR)) return;
    if (document.querySelector(RADIX_POPPER_CONTENT_SELECTOR)) return;
    if (!['ArrowLeft', 'ArrowRight', 't', 'T'].includes(event.key)) return;
    event.preventDefault();
    if (event.repeat) return;

    if (event.key === 'ArrowLeft') {
      handlePrevMonth();
    } else if (event.key === 'ArrowRight') {
      handleNextMonth();
    } else {
      handleToday();
    }
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => handleKeyDown(event);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className={`mx-auto w-full max-w-7xl ${SIDEBAR_PAGE_COLUMN_INSETS} pt-8 pb-16 page-enter`}>
      <div className='flex flex-col md:flex-row items-start md:items-center justify-between mb-6 gap-4'>
        <div>
          <h1 className='text-[24px] font-semibold leading-none tracking-[-0.03em] text-white'>
            Calendar
          </h1>
          <p className='mt-1.5 text-[13px] text-zinc-400'>Releases from your library and lists</p>
        </div>

        <div className='flex w-full md:w-auto items-stretch gap-2'>
          <Button
            variant='ghost'
            size='sm'
            aria-pressed={hideWatched}
            onClick={() => updatePreferences({ calendarHideWatched: !hideWatched })}
            title={hideWatched ? 'Show watched releases' : 'Hide watched releases'}
            className={cn(
              'h-auto shrink-0 gap-1.5 rounded-lg border px-3 text-[12px] font-medium',
              hideWatched
                ? 'accent-lattice-soft hover:bg-(--accent-nav)/15 hover:text-(--accent-nav)'
                : 'border-white/[0.08] bg-white/[0.025] text-zinc-400 hover:bg-white/[0.06] hover:text-white',
            )}
          >
            {hideWatched ? (
              <EyeOff aria-hidden='true' className='h-3.5 w-3.5' />
            ) : (
              <Eye aria-hidden='true' className='h-3.5 w-3.5' />
            )}
            Hide watched
          </Button>
          <div
            role='group'
            aria-label='Calendar navigation'
            className='flex flex-1 md:flex-none items-center gap-0.5 rounded-lg border border-white/[0.08] bg-white/[0.025] p-1'
          >
            <Button
              variant='ghost'
              size='icon'
              onClick={handlePrevMonth}
              aria-label='Previous month'
              aria-keyshortcuts='ArrowLeft'
              title='Previous month (←)'
              className='h-9 w-9 shrink-0 hover:bg-white/[0.06] rounded-md'
            >
              <ChevronLeft className='w-3.5 h-3.5' />
            </Button>
            <div
              className='px-1 font-medium text-[13px] flex-1 md:min-w-[130px] text-center text-zinc-200 tabular-nums'
              aria-live='polite'
            >
              {MONTH_YEAR_FORMATTER.format(currentMonth)}
            </div>
            <Button
              variant='ghost'
              size='icon'
              onClick={handleNextMonth}
              aria-label='Next month'
              aria-keyshortcuts='ArrowRight'
              title='Next month (→)'
              className='h-9 w-9 shrink-0 hover:bg-white/[0.06] rounded-md'
            >
              <ChevronRight className='w-3.5 h-3.5' />
            </Button>
            <Button
              variant='ghost'
              size='sm'
              aria-label='Jump to today'
              aria-keyshortcuts='T'
              onClick={handleToday}
              title='Jump to today (T)'
              className={cn(
                'ml-1 text-[12px] font-medium rounded-md h-9 px-3 border',
                isCurrentMonthView
                  ? 'accent-lattice-soft hover:bg-(--accent-nav)/15 hover:text-(--accent-nav)'
                  : 'border-white/[0.08] text-zinc-400 hover:text-white hover:bg-white/[0.06]',
              )}
            >
              Today
            </Button>
          </div>
        </div>
      </div>

      {!isOnline && (
        <div
          role='status'
          className='mb-4 flex items-center gap-2.5 rounded-lg border border-white/[0.08] bg-white/[0.025] px-4 py-3 text-[12px] text-zinc-400'
        >
          <WifiOff aria-hidden='true' className='h-4 w-4 shrink-0 text-zinc-500' />
          {schedule
            ? "You're offline. Showing saved release schedules until you reconnect."
            : "You're offline. Connect to load release schedules for this month."}
        </div>
      )}

      {isOnline && (isScheduleError || (hasMissingSchedules && !isFetchingSchedules)) ? (
        <RetryBanner
          className='mb-4'
          title="Couldn't load all release schedules"
          message='Releases may be missing — try again.'
          onRetry={() => void refetchSchedules()}
          isRetrying={isFetchingSchedules}
        />
      ) : (
        schedule?.trackedCount === 0 && (
          <div className='mb-5 flex flex-col items-center rounded-lg border border-white/[0.07] bg-white/[0.02] px-6 py-8 text-center'>
            <span className='mb-3 flex h-10 w-10 items-center justify-center'>
              <CalendarDays className='h-5 w-5 text-zinc-400' />
            </span>
            <h2 className='text-[15px] font-semibold text-white'>Your schedule is empty</h2>
            <p className='mt-1 max-w-sm text-[13px] leading-relaxed text-zinc-500'>
              Add titles to your library or a list to track their release dates.
            </p>
            <Button asChild size='sm' className='mt-4 h-9 rounded-md px-3 text-[12px]'>
              <Link to='/search?type=series'>Find shows</Link>
            </Button>
          </div>
        )
      )}

      {(schedule?.trackedCount !== 0 || isScheduleError) && (
        <div className='mb-5 rounded-lg border border-white/[0.07] bg-white/[0.015] p-3 sm:p-4'>
          <div className='flex flex-wrap items-center justify-between mb-3 gap-2'>
            <div className='flex flex-wrap items-baseline gap-x-2.5 gap-y-1'>
              <h2 className='text-[15px] font-semibold text-white tracking-tight'>Upcoming</h2>
              <span className='text-[12px] text-zinc-500'>Next 14 days · up to 8 releases</span>
              {isFetchingSchedules && schedule && (
                <span role='status' className='text-[11px] text-(--accent-nav)'>
                  Updating…
                </span>
              )}
            </div>
            {airingTodayCount > 0 && (
              <button
                type='button'
                onClick={handleToday}
                title='Jump to today'
                className='rounded-md px-2 py-1 text-[12px] font-medium text-(--accent-nav) transition-colors duration-150 hover:bg-(--accent-nav)/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-nav)/40 motion-reduce:transition-none'
              >
                {airingTodayCount} today
              </button>
            )}
          </div>
          {isLoadingSchedules && !schedule ? (
            <>
              <span role='status' className='sr-only'>
                Loading upcoming releases
              </span>
              <div aria-hidden='true' className='grid gap-1 sm:grid-cols-2 lg:grid-cols-4'>
                {[0, 1, 2, 3].map((key) => (
                  <div key={key} className='flex min-w-0 items-center gap-2.5 p-2'>
                    <Skeleton className='h-[54px] w-9 shrink-0 animate-none rounded-sm bg-white/[0.06]' />
                    <div className='min-w-0 flex-1 space-y-2'>
                      <Skeleton className='h-3.5 w-3/4 animate-none bg-white/[0.06]' />
                      <Skeleton className='h-3 w-1/2 animate-none bg-white/[0.06]' />
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : upcomingEvents.length === 0 ? (
            <div className='flex items-center gap-2 text-[13px] text-zinc-500 py-3' role='status'>
              {!isOnline && !schedule
                ? 'Upcoming releases will appear when you reconnect.'
                : isFetchingSchedules
                  ? 'Loading release schedules…'
                  : isScheduleError || hasMissingSchedules
                    ? 'Release data is incomplete or unavailable.'
                    : 'No upcoming releases in the next two weeks.'}
            </div>
          ) : (
            <div className='grid gap-1 sm:grid-cols-2 lg:grid-cols-4'>
              {upcomingEvents.map((event, index) => (
                <Fragment key={calendarEventKey(event)}>
                  {(index === 0 || !event.date.equals(upcomingEvents[index - 1].date)) && (
                    <h3
                      className={cn(
                        'col-span-full px-2 pb-1 pt-2 text-[11px] font-medium',
                        event.date.equals(now) ? 'text-(--accent-nav)' : 'text-zinc-400',
                      )}
                    >
                      <time dateTime={event.date.toString()}>
                        {formatEventDayLabel(event.date, now)}
                      </time>
                    </h3>
                  )}
                  <UpcomingEventCard
                    event={event}
                    from={from}
                    onPrefetch={prefetchEventDetails}
                    hideSpoilers={hideSpoilers}
                  />
                </Fragment>
              ))}
            </div>
          )}
        </div>
      )}

      {schedule &&
        schedule.trackedCount > 0 &&
        isOnline &&
        !isFetchingSchedules &&
        !isScheduleError &&
        !isPlaceholderData &&
        !hasMissingSchedules &&
        !hasMonthReleases && (
          <div
            role='status'
            className='mb-3 flex items-center justify-between gap-3 text-[13px] text-zinc-400'
          >
            <p>
              No {hideWatched ? 'unwatched ' : ''}releases in{' '}
              {MONTH_YEAR_FORMATTER.format(currentMonth)}
            </p>
            <Button
              variant='ghost'
              size='sm'
              onClick={handleToday}
              className='h-8 rounded-md px-3 text-[12px]'
            >
              Today
            </Button>
          </div>
        )}

      {(schedule?.trackedCount !== 0 || isScheduleError) && (
        <>
          {isLoadingSchedules && (
            <span role='status' className='sr-only'>
              Loading releases for {MONTH_YEAR_FORMATTER.format(currentMonth)}
            </span>
          )}
          {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- Keyboard scrolling needs a focusable region. */}
          <div
            ref={calendarRef}
            role='region'
            aria-label={`${MONTH_YEAR_FORMATTER.format(currentMonth)} releases`}
            aria-busy={isFetchingSchedules}
            tabIndex={0}
            onKeyDown={(event) => {
              if (
                event.target === event.currentTarget &&
                (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
              ) {
                event.stopPropagation();
              }
            }}
            className='overflow-x-auto rounded-lg border border-white/[0.07] bg-zinc-950/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-nav)/40'
          >
            <div className='min-w-[640px]'>
              <div className='grid grid-cols-7 border-b border-white/[0.05] bg-white/[0.02]'>
                {WEEKDAY_LABELS.map((day, dayIndex) => (
                  <div
                    key={day}
                    className={cn(
                      'py-3 text-center text-[11px] font-medium',
                      isCurrentMonthView && dayIndex === now.dayOfWeek % 7
                        ? 'text-[var(--accent-nav)]'
                        : 'text-zinc-500',
                    )}
                  >
                    {day}
                  </div>
                ))}
              </div>

              <div className='grid grid-cols-7 auto-rows-fr'>
                {days.map((day, dayIdx) => {
                  const dayKey = day.toString();
                  return (
                    <CalendarDayCell
                      key={dayKey}
                      day={day}
                      dayEvents={eventsByDay.get(dayKey) ?? EMPTY_DAY_EVENTS}
                      isToday={day.equals(now)}
                      isCurrentMonth={day
                        .toPlainYearMonth()
                        .equals(currentMonth.toPlainYearMonth())}
                      isLastColumn={dayIdx % 7 === 6}
                      isLoading={isLoadingSchedules}
                      isComplete={
                        !!schedule &&
                        !isPlaceholderData &&
                        !isScheduleError &&
                        !hasMissingSchedules &&
                        !isFetchingSchedules
                      }
                      from={from}
                      onPrefetch={prefetchEventDetails}
                      hideSpoilers={hideSpoilers}
                    />
                  );
                })}
              </div>
            </div>
          </div>
          {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
        </>
      )}
    </div>
  );
}

const UpcomingEventCard = memo(function UpcomingEventCard({
  event,
  from,
  onPrefetch,
  hideSpoilers,
}: {
  event: CalendarEvent;
  from: string;
  onPrefetch: (event: CalendarEvent) => void;
  hideSpoilers: boolean;
}) {
  return (
    <Link
      {...calendarEventLinkProps(event, from, onPrefetch, hideSpoilers)}
      className={cn(
        'group min-w-0 rounded-md p-2 transition-colors duration-150 hover:bg-white/[0.04] focus-visible:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-nav)/40',
        event.watched && WATCHED_EVENT_CLASS,
      )}
    >
      <div className='flex items-center gap-2.5'>
        <PosterThumb
          poster={event.poster}
          showFallback={false}
          className='w-9 h-[54px] rounded-sm bg-black/30 ring-0'
        />
        <div className='min-w-0 flex-1'>
          <div className='text-[13px] font-medium text-zinc-200 truncate'>{event.seriesTitle}</div>
          <div className='flex items-center gap-1 text-[11px] text-zinc-400'>
            {event.watched && <WatchedMark />}
            <span className='truncate'>
              {event.type === 'episode'
                ? formatEpisodeHeading(
                    event.season,
                    event.episode,
                    visibleEpisodeTitle(event, hideSpoilers),
                  )
                : 'Movie'}
            </span>
          </div>
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
  isLoading,
  isComplete,
  from,
  onPrefetch,
  hideSpoilers,
}: {
  day: Temporal.PlainDate;
  dayEvents: CalendarEvent[];
  isToday: boolean;
  isCurrentMonth: boolean;
  isLastColumn: boolean;
  isLoading: boolean;
  isComplete: boolean;
  from: string;
  onPrefetch: (event: CalendarEvent) => void;
  hideSpoilers: boolean;
}) {
  const visibleDayEvents = dayEvents.slice(0, MAX_VISIBLE_DAY_EVENTS);
  const hiddenCount = dayEvents.length - visibleDayEvents.length;
  const daySummary = isLoading
    ? 'Loading releases'
    : dayEvents.length > 0
      ? pluralize(dayEvents.length, 'release')
      : isComplete
        ? 'No releases'
        : '';

  return (
    <div
      role='group'
      aria-label={`${FULL_DATE_FORMATTER.format(day)}${daySummary ? ` — ${daySummary}` : ''}`}
      data-calendar-today={isToday ? '' : undefined}
      tabIndex={isToday ? -1 : undefined}
      className={cn(
        'min-w-0 min-h-[132px] p-1.5 sm:p-2 border-b border-r border-white/[0.05] relative group transition-colors duration-150 hover:bg-white/[0.025] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-(--accent-nav)/50 motion-reduce:transition-none',
        isToday &&
          'bg-[rgb(var(--accent-nav-rgb)/0.035)] shadow-[inset_0_0_0_1px_rgb(var(--accent-nav-rgb)/0.18)]',
        !isCurrentMonth && 'bg-black/20',
        isLastColumn && 'border-r-0',
      )}
    >
      <div className='mb-2 flex h-7 items-center justify-between gap-1'>
        <time
          dateTime={day.toString()}
          aria-label={FULL_DATE_FORMATTER.format(day)}
          aria-current={isToday ? 'date' : undefined}
          className={cn(
            'text-[12px] font-medium tabular-nums w-7 h-7 flex shrink-0 items-center justify-center rounded-md',
            isToday
              ? 'bg-[rgb(var(--accent-nav-rgb)/0.12)] text-[var(--accent-nav)] font-semibold'
              : isCurrentMonth
                ? 'text-zinc-400 group-hover:text-zinc-300'
                : 'text-zinc-600',
          )}
        >
          {day.day}
        </time>
        {isToday ? (
          <span aria-hidden='true' className='truncate text-[10px] font-medium text-(--accent-nav)'>
            Today
          </span>
        ) : dayEvents.length > 0 ? (
          <span aria-hidden='true' className='px-1 text-[10px] tabular-nums text-zinc-500'>
            {dayEvents.length}
          </span>
        ) : null}
      </div>

      <div className='space-y-1'>
        {isLoading && isCurrentMonth && (
          <div aria-hidden='true' className='space-y-1 px-1.5'>
            <div className='flex h-10 flex-col justify-center gap-1.5'>
              <div className='h-2.5 w-4/5 rounded-sm bg-white/[0.06]' />
              <div className='h-2 w-1/2 rounded-sm bg-white/[0.04]' />
            </div>
            <div className='h-2.5 w-3/5 rounded-sm bg-white/[0.04]' />
          </div>
        )}
        {isToday && isComplete && dayEvents.length === 0 && (
          <p className='px-1.5 py-2 text-[11px] leading-relaxed text-zinc-500'>No releases today</p>
        )}
        {visibleDayEvents.map((event) => {
          const episodeLabel = formatSeasonEpisode(event.season, event.episode);
          return (
            <HoverCard key={calendarEventKey(event)} openDelay={150} closeDelay={120}>
              <HoverCardTrigger asChild>
                <Link
                  {...calendarEventLinkProps(event, from, onPrefetch, hideSpoilers)}
                  title={undefined}
                  className={cn(
                    'min-h-10 w-full min-w-0 text-left hover:bg-white/[0.06] rounded-md px-1.5 py-1 transition-colors duration-150 flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30',
                    isToday && 'bg-white/[0.035]',
                    event.watched && WATCHED_EVENT_CLASS,
                  )}
                >
                  {event.poster && (
                    <PosterThumb
                      poster={event.poster}
                      showFallback={false}
                      className='hidden xl:flex w-5 h-7 bg-zinc-900 rounded-sm ring-0'
                      imageClassName='opacity-70'
                    />
                  )}
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate text-[12px] text-zinc-200 font-medium'>
                      {event.seriesTitle}
                    </span>
                    <span
                      className={cn(
                        'flex items-center gap-1 text-[11px] tabular-nums',
                        isToday ? 'text-[var(--accent-nav)]' : 'text-zinc-400',
                      )}
                    >
                      {event.watched && <WatchedMark />}
                      <span className='truncate'>
                        {event.type === 'episode' ? episodeLabel || 'Episode' : 'Movie'}
                      </span>
                    </span>
                  </span>
                </Link>
              </HoverCardTrigger>
              <HoverCardContent
                className={cn(CALENDAR_POPOVER_CLASS, 'p-0')}
                align='start'
                sideOffset={6}
              >
                <div className='flex gap-2.5 p-2.5'>
                  <PosterThumb
                    poster={event.poster}
                    title={`${event.seriesTitle} poster`}
                    showFallback={false}
                    className='w-16 h-auto aspect-2/3 bg-black/30 ring-0'
                  />
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
                          {visibleEpisodeTitle(event, hideSpoilers) ??
                            'Title hidden to prevent spoilers.'}
                        </p>
                      </>
                    ) : (
                      <p className='text-[11px] text-zinc-400 font-medium mb-1.5'>Movie</p>
                    )}
                    <p className='text-[10px] text-zinc-500'>
                      {WEEKDAY_DATE_FORMATTER.format(event.date)}
                      {isToday && (
                        <span className='text-[var(--accent-nav)] font-semibold'> · Today</span>
                      )}
                      {event.watched && <span className='text-zinc-400'> · Watched</span>}
                    </p>
                  </div>
                </div>
              </HoverCardContent>
            </HoverCard>
          );
        })}

        {hiddenCount > 0 && (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type='button'
                aria-label={`${hiddenCount} more releases on ${FULL_DATE_FORMATTER.format(day)}`}
                className='min-h-8 w-full text-left text-[11px] font-medium text-zinc-400 hover:text-zinc-200 px-1.5 py-1 rounded-md hover:bg-white/[0.05] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30'
              >
                +{hiddenCount} more
              </button>
            </PopoverTrigger>
            <PopoverContent
              className={cn(CALENDAR_POPOVER_CLASS, 'p-1.5')}
              align='start'
              aria-label={`Releases on ${FULL_DATE_FORMATTER.format(day)}`}
            >
              <p className='px-2 pt-1 pb-1.5 text-[11px] font-semibold text-zinc-400'>
                {WEEKDAY_DATE_FORMATTER.format(day)}
              </p>
              <div className='max-h-72 overflow-y-auto overscroll-contain space-y-0.5 p-0.5'>
                {dayEvents.map((event) => (
                  <Link
                    key={calendarEventKey(event)}
                    {...calendarEventLinkProps(event, from, onPrefetch, hideSpoilers)}
                    className={cn(
                      'flex min-h-10 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-white/[0.06] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30',
                      event.watched && WATCHED_EVENT_CLASS,
                    )}
                  >
                    {event.poster && (
                      <PosterThumb
                        poster={event.poster}
                        showFallback={false}
                        className='w-5 h-7 bg-zinc-900 rounded-[3px] ring-0'
                        imageClassName='opacity-70'
                      />
                    )}
                    <span className='min-w-0 flex-1 truncate text-[12px] text-zinc-200'>
                      {event.seriesTitle}
                    </span>
                    {event.watched && <WatchedMark />}
                    <span className='shrink-0 text-[11px] text-zinc-400 tabular-nums'>
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
