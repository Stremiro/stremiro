import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Channel } from '@tauri-apps/api/core';
import {
  addMonths,
  differenceInCalendarDays,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns';
import { CalendarDays, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { Fragment, memo, useEffect, useEffectEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { PosterThumb } from '@/components/poster-thumb';
import { RetryBanner } from '@/components/retry-banner';
import { Button } from '@/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { useLocalDay } from '@/hooks/use-local-day';
import { api, type CalendarSchedule, type CalendarScheduleEvent } from '@/lib/api';
import { toCalendarEvent, calendarEventKey, type CalendarEvent } from '@/lib/calendar-events';
import { prefetchDetailsRouteData } from '@/lib/details-prefetch';
import { isEditableTarget, OPEN_DIALOG_SELECTOR, RADIX_POPPER_CONTENT_SELECTOR } from '@/lib/dom';
import { currentPathWithSearch } from '@/lib/navigation';
import { buildDetailsRoute } from '@/lib/player-navigation';
import { CALENDAR_EVENTS_STALE_TIME_MS, calendarEventsQueryKey } from '@/lib/query-invalidation';
import { parseLocalScheduleDate } from '@/lib/schedule-dates';
import {
  cn,
  formatEpisodeHeading,
  formatSeasonEpisode,
  queryNeedsRetry,
  SIDEBAR_PAGE_COLUMN_INSETS,
} from '@/lib/utils';

const MAX_VISIBLE_DAY_EVENTS = 3;
// Shared empty fallback — a fresh `[]` would defeat the memoized cells' prop comparison.
const EMPTY_DAY_EVENTS: CalendarEvent[] = [];
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CALENDAR_POPOVER_CLASS =
  'w-72 max-w-[calc(100vw-2rem)] bg-zinc-950/95 backdrop-blur-xl border-white/[0.1] text-white shadow-xl rounded-lg';

function formatEventDayLabel(date: Date, today: Date): string {
  const diff = differenceInCalendarDays(date, today);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff < 7) return format(date, 'EEEE');
  return format(date, 'MMM d');
}

function calendarEventLinkProps(
  event: CalendarEvent,
  from: string,
  onPrefetch: (event: CalendarEvent) => void,
) {
  const detail =
    event.type === 'episode'
      ? formatEpisodeHeading(event.season, event.episode, event.title) || 'Episode'
      : 'Movie';
  const label = `${event.seriesTitle} — ${detail} — ${format(event.date, 'EEEE, MMMM d, yyyy')}`;
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
  events.flatMap((event) => {
    const calendarEvent = toCalendarEvent(event);
    return calendarEvent ? [calendarEvent] : [];
  });

export function Calendar() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const now = useLocalDay();
  const monthParam = searchParams.get('month');
  const currentMonth =
    (monthParam && /^\d{4}-\d{2}$/.test(monthParam)
      ? parseLocalScheduleDate(`${monthParam}-01`)
      : null) ?? startOfMonth(now);
  const from = currentPathWithSearch();
  useDocumentTitle('Calendar');

  const days = eachDayOfInterval({
    start: startOfWeek(startOfMonth(currentMonth)),
    end: endOfWeek(endOfMonth(currentMonth)),
  });
  const range = {
    visibleStart: format(days[0], 'yyyy-MM-dd'),
    visibleEnd: format(days[days.length - 1], 'yyyy-MM-dd'),
    upcomingStart: format(now, 'yyyy-MM-dd'),
  };
  const {
    data: schedule,
    isError,
    isFetched,
    isPending,
    isLoading,
    isFetching: isFetchingSchedules,
    refetch: refetchSchedules,
  } = useQuery({
    queryKey: calendarEventsQueryKey(range),
    queryFn: ({ queryKey, signal }) => {
      const channel = new Channel<CalendarSchedule>();
      // eslint-disable-next-line unicorn/prefer-add-event-listener
      channel.onmessage = (cached) => {
        if (!signal.aborted && queryClient.getQueryData(queryKey) === undefined) {
          queryClient.setQueryData(queryKey, cached);
        }
      };
      return api.getCalendarEvents(range, channel);
    },
    staleTime: CALENDAR_EVENTS_STALE_TIME_MS,
  });
  const isScheduleError = queryNeedsRetry({ isError, isFetched, isPending });
  const isLoadingSchedules = isLoading && !isScheduleError;
  const hasMissingSchedules = (schedule?.missingCount ?? 0) > 0;
  const upcomingEvents = toCalendarEvents(schedule?.upcoming ?? []);

  const eventsByDay = new Map(
    (schedule?.days ?? []).map((day) => [day.date, toCalendarEvents(day.events)]),
  );

  const airingTodayCount = eventsByDay.get(range.upcomingStart)?.length ?? 0;
  const monthKey = format(currentMonth, 'yyyy-MM');
  const hasMonthReleases = schedule?.days.some(
    (day) => day.events.length > 0 && day.date.startsWith(monthKey),
  );

  const prefetchEventDetails = (event: CalendarEvent) => {
    prefetchDetailsRouteData(queryClient, {
      mediaId: event.mediaId,
      mediaType: event.mediaType,
    });
  };

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

        <div className='flex w-full md:w-auto items-center gap-0.5'>
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
            {format(currentMonth, 'MMMM yyyy')}
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
            // aria-disabled, not disabled: it would drop the focused button's focus to <body>.
            aria-disabled={isCurrentMonthView || undefined}
            aria-label='Today — jump to current month'
            aria-keyshortcuts='T'
            onClick={() => {
              if (!isCurrentMonthView) handleToday();
            }}
            title='Jump to current month (T)'
            className={cn(
              'ml-2 text-[12px] font-medium rounded-md h-9 px-3 border border-white/[0.08]',
              isCurrentMonthView
                ? 'bg-white/[0.06] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-400 cursor-default'
                : 'text-zinc-400 hover:text-white hover:bg-white/[0.06]',
            )}
          >
            Today
          </Button>
        </div>
      </div>

      {isScheduleError || (hasMissingSchedules && !isFetchingSchedules) ? (
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
            <div className='flex items-center gap-2.5'>
              <h2 className='text-[15px] font-semibold text-white tracking-tight'>Upcoming</h2>
              <span className='text-[12px] text-zinc-500'>Next 14 days · up to 8 releases</span>
              {isFetchingSchedules && !isLoadingSchedules && (
                <Loader2
                  className='h-3 w-3 animate-spin text-zinc-500'
                  aria-label='Refreshing schedules'
                />
              )}
            </div>
            {airingTodayCount > 0 && (
              <span className='text-[12px] font-medium text-[var(--accent-nav)]'>
                {airingTodayCount} today
              </span>
            )}
          </div>
          {isLoadingSchedules ? (
            <>
              <span role='status' className='sr-only'>
                Loading upcoming releases
              </span>
              <div aria-hidden='true' className='grid gap-1 sm:grid-cols-2 lg:grid-cols-4'>
                {[0, 1, 2, 3].map((key) => (
                  <div key={key} className='flex min-w-0 items-center gap-2.5 p-2'>
                    <Skeleton className='h-[54px] w-9 shrink-0 rounded-sm bg-white/[0.06]' />
                    <div className='min-w-0 flex-1 space-y-2'>
                      <Skeleton className='h-3.5 w-3/4 bg-white/[0.06]' />
                      <Skeleton className='h-3 w-1/2 bg-white/[0.06]' />
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : upcomingEvents.length === 0 ? (
            <div className='flex items-center gap-2 text-[13px] text-zinc-500 py-3' role='status'>
              {isFetchingSchedules
                ? 'Loading release schedules…'
                : isScheduleError || hasMissingSchedules
                  ? 'Release data is incomplete or unavailable.'
                  : 'No upcoming releases in the next two weeks.'}
            </div>
          ) : (
            <div className='grid gap-1 sm:grid-cols-2 lg:grid-cols-4'>
              {upcomingEvents.map((event, index) => (
                <Fragment key={calendarEventKey(event)}>
                  {(index === 0 || !isSameDay(event.date, upcomingEvents[index - 1].date)) && (
                    <h3
                      className={cn(
                        'col-span-full px-2 pb-1 pt-2 text-[11px] font-medium',
                        isSameDay(event.date, now) ? 'text-(--accent-nav)' : 'text-zinc-400',
                      )}
                    >
                      <time dateTime={format(event.date, 'yyyy-MM-dd')}>
                        {formatEventDayLabel(event.date, now)}
                      </time>
                    </h3>
                  )}
                  <UpcomingEventCard event={event} from={from} onPrefetch={prefetchEventDetails} />
                </Fragment>
              ))}
            </div>
          )}
        </div>
      )}

      {schedule &&
        schedule.trackedCount > 0 &&
        !isFetchingSchedules &&
        !isScheduleError &&
        !hasMissingSchedules &&
        !hasMonthReleases && (
          <div
            role='status'
            className='mb-3 flex items-center justify-between gap-3 text-[13px] text-zinc-400'
          >
            <p>No releases in {format(currentMonth, 'MMMM yyyy')}</p>
            <Button
              variant='ghost'
              size='sm'
              aria-disabled={isCurrentMonthView || undefined}
              onClick={() => {
                if (!isCurrentMonthView) handleToday();
              }}
              className='h-8 rounded-md px-3 text-[12px] aria-disabled:opacity-50'
            >
              Today
            </Button>
          </div>
        )}

      {(schedule?.trackedCount !== 0 || isScheduleError) && (
        <>
          {isLoadingSchedules && (
            <span role='status' className='sr-only'>
              Loading releases for {format(currentMonth, 'MMMM yyyy')}
            </span>
          )}
          {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- Keyboard scrolling needs a focusable region. */}
          <div
            role='region'
            aria-label={`${format(currentMonth, 'MMMM yyyy')} releases`}
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
            <div className={cn('min-w-[640px]', isLoadingSchedules && 'opacity-50')}>
              <div className='grid grid-cols-7 border-b border-white/[0.05] bg-white/[0.02]'>
                {WEEKDAY_LABELS.map((day, dayIndex) => (
                  <div
                    key={day}
                    className={cn(
                      'py-3 text-center text-[11px] font-medium',
                      isCurrentMonthView && dayIndex === now.getDay()
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
}: {
  event: CalendarEvent;
  from: string;
  onPrefetch: (event: CalendarEvent) => void;
}) {
  return (
    <Link
      {...calendarEventLinkProps(event, from, onPrefetch)}
      className='group min-w-0 rounded-md p-2 transition-colors duration-150 hover:bg-white/[0.04] focus-visible:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-nav)/40'
    >
      <div className='flex items-center gap-2.5'>
        <PosterThumb
          poster={event.poster}
          showFallback={false}
          className='w-9 h-[54px] rounded-sm bg-black/30 ring-0'
        />
        <div className='min-w-0 flex-1'>
          <div className='text-[13px] font-medium text-zinc-200 truncate'>{event.seriesTitle}</div>
          <div className='text-[11px] text-zinc-400 truncate'>
            {event.type === 'episode'
              ? formatEpisodeHeading(event.season, event.episode, event.title)
              : 'Movie'}
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
  const hiddenCount = dayEvents.length - visibleDayEvents.length;

  return (
    <div
      className={cn(
        'min-w-0 min-h-[132px] p-1.5 sm:p-2 border-b border-r border-white/[0.05] relative group transition-colors hover:bg-white/[0.025]',
        isToday &&
          'bg-[rgb(var(--accent-nav-rgb)/0.035)] shadow-[inset_0_0_0_1px_rgb(var(--accent-nav-rgb)/0.18)]',
        !isCurrentMonth && 'bg-black/20',
        isLastColumn && 'border-r-0',
      )}
    >
      <time
        dateTime={format(day, 'yyyy-MM-dd')}
        aria-label={format(day, 'EEEE, MMMM d, yyyy')}
        aria-current={isToday ? 'date' : undefined}
        className={cn(
          'text-[12px] font-medium tabular-nums mb-2 w-7 h-7 flex items-center justify-center rounded-md transition-colors',
          isToday
            ? 'bg-[rgb(var(--accent-nav-rgb)/0.12)] text-[var(--accent-nav)] font-semibold'
            : isCurrentMonth
              ? 'text-zinc-400 group-hover:text-zinc-300'
              : 'text-zinc-600',
        )}
      >
        {format(day, 'd')}
      </time>

      <div className='space-y-1'>
        {visibleDayEvents.map((event) => {
          const episodeLabel = formatSeasonEpisode(event.season, event.episode);
          return (
            <HoverCard key={calendarEventKey(event)} openDelay={150} closeDelay={120}>
              <HoverCardTrigger asChild>
                <Link
                  {...calendarEventLinkProps(event, from, onPrefetch)}
                  title={undefined}
                  className={cn(
                    'min-h-10 w-full min-w-0 text-left hover:bg-white/[0.06] rounded-md px-1.5 py-1 transition-colors duration-150 flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30',
                    isToday && 'bg-white/[0.035]',
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
                        'block truncate text-[11px] tabular-nums',
                        isToday ? 'text-[var(--accent-nav)]' : 'text-zinc-400',
                      )}
                    >
                      {event.type === 'episode' ? episodeLabel || 'Episode' : 'Movie'}
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
                          {event.title}
                        </p>
                      </>
                    ) : (
                      <p className='text-[11px] text-zinc-400 font-medium mb-1.5'>Movie</p>
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

        {hiddenCount > 0 && (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type='button'
                aria-label={`${hiddenCount} more releases on ${format(day, 'EEEE, MMMM d, yyyy')}`}
                className='min-h-8 w-full text-left text-[11px] font-medium text-zinc-400 hover:text-zinc-200 px-1.5 py-1 rounded-md hover:bg-white/[0.05] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30'
              >
                +{hiddenCount} more
              </button>
            </PopoverTrigger>
            <PopoverContent
              className={cn(CALENDAR_POPOVER_CLASS, 'p-1.5')}
              align='start'
              aria-label={`Releases on ${format(day, 'EEEE, MMMM d, yyyy')}`}
            >
              <p className='px-2 pt-1 pb-1.5 text-[11px] font-semibold text-zinc-400'>
                {format(day, 'EEEE, MMM d')}
              </p>
              <div className='max-h-72 overflow-y-auto overscroll-contain space-y-0.5 p-0.5'>
                {dayEvents.map((event) => (
                  <Link
                    key={calendarEventKey(event)}
                    {...calendarEventLinkProps(event, from, onPrefetch)}
                    className='flex min-h-10 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-white/[0.06] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30'
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
