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
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns';
import { CalendarDays, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { memo, useCallback, useEffect, useEffectEvent, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { RemoteImage } from '@/components/remote-image';
import { RetryBanner } from '@/components/retry-banner';
import { Button } from '@/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { useLocalDay } from '@/hooks/use-local-day';
import { api, type CalendarScheduleEvent } from '@/lib/api';
import { toCalendarEvent, calendarEventKey, type CalendarEvent } from '@/lib/calendar-events';
import { prefetchDetailsRouteData } from '@/lib/details-prefetch';
import { isEditableTarget, OPEN_DIALOG_SELECTOR, RADIX_POPPER_CONTENT_SELECTOR } from '@/lib/dom';
import { currentPathWithSearch } from '@/lib/navigation';
import { buildDetailsRoute } from '@/lib/player-navigation';
import { CALENDAR_EVENTS_STALE_TIME_MS, calendarEventsQueryKey } from '@/lib/query-invalidation';
import {
  cn,
  formatEpisodeHeading,
  formatSeasonEpisode,
  parseLocalScheduleDate,
  SIDEBAR_PAGE_COLUMN_INSETS,
} from '@/lib/utils';

const MAX_VISIBLE_DAY_EVENTS = 3;
// Shared empty fallback — a fresh `[]` would defeat the memoized cells' prop comparison.
const EMPTY_DAY_EVENTS: CalendarEvent[] = [];
const UPCOMING_WINDOW_DAYS = 14;
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

  const todayStartMs = now.getTime();

  const days = useMemo(() => {
    const start = startOfWeek(startOfMonth(currentMonth));
    const end = endOfWeek(endOfMonth(currentMonth));
    return eachDayOfInterval({ start, end });
  }, [currentMonth]);

  const visibleStartMs = days[0].getTime();
  const visibleEndMs = endOfDay(days[days.length - 1]).getTime();
  const upcomingEndMs = endOfDay(
    addDays(new Date(todayStartMs), UPCOMING_WINDOW_DAYS - 1),
  ).getTime();

  const range = useMemo(
    () => ({
      visibleStart: format(new Date(visibleStartMs), 'yyyy-MM-dd'),
      visibleEnd: format(new Date(visibleEndMs), 'yyyy-MM-dd'),
      upcomingStart: format(new Date(todayStartMs), 'yyyy-MM-dd'),
      upcomingEnd: format(new Date(upcomingEndMs), 'yyyy-MM-dd'),
    }),
    [visibleStartMs, visibleEndMs, todayStartMs, upcomingEndMs],
  );
  const {
    data: schedule,
    isError: isScheduleError,
    isLoading: isLoadingSchedules,
    isFetching: isFetchingSchedules,
    refetch: refetchSchedules,
  } = useQuery({
    queryKey: calendarEventsQueryKey(range),
    queryFn: () => api.getCalendarEvents(range),
    staleTime: CALENDAR_EVENTS_STALE_TIME_MS,
  });
  const upcomingEvents = useMemo(() => toCalendarEvents(schedule?.upcoming ?? []), [schedule]);

  const eventsByDay = useMemo(
    () => new Map((schedule?.days ?? []).map((day) => [day.date, toCalendarEvents(day.events)])),
    [schedule],
  );

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
    <div className={`mx-auto w-full max-w-7xl ${SIDEBAR_PAGE_COLUMN_INSETS} pt-6 pb-16 page-enter`}>
      <div className='flex flex-col md:flex-row items-start md:items-center justify-between mb-6 gap-4'>
        <div>
          <h1 className='text-[20px] font-medium tracking-[-0.03em] text-white'>Calendar</h1>
          <p className='mt-1.5 text-[13px] text-zinc-400'>Releases from your library</p>
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

      {isScheduleError ? (
        <RetryBanner
          className='mb-4'
          title="Couldn't load release schedules"
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
              Add titles to your library to track their release dates.
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
              <span className='text-[12px] text-zinc-500'>Next 14 days</span>
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
          {upcomingEvents.length === 0 ? (
            <div className='flex items-center gap-2 text-[13px] text-zinc-500 py-3' role='status'>
              {isLoadingSchedules && (
                <Loader2 className='h-3.5 w-3.5 animate-spin' aria-hidden='true' />
              )}
              {isLoadingSchedules
                ? 'Loading upcoming releases…'
                : isScheduleError
                  ? 'Release data is unavailable.'
                  : 'No upcoming releases in the next two weeks.'}
            </div>
          ) : (
            <div className='grid gap-1 sm:grid-cols-2 lg:grid-cols-4'>
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
        <div className='min-w-[640px]'>
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
  return (
    <Link
      {...calendarEventLinkProps(event, from, onPrefetch)}
      className='group min-w-0 rounded-md p-2 transition-colors duration-150 hover:bg-white/[0.04] focus-visible:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-nav)/40'
    >
      <div className='flex items-center gap-2.5'>
        <div className='w-9 h-[54px] rounded-sm overflow-hidden bg-black/30 shrink-0'>
          {event.poster && (
            <RemoteImage
              src={event.poster}
              alt=''
              loading='lazy'
              className='w-full h-full object-cover'
            />
          )}
        </div>
        <div className='min-w-0 flex-1'>
          <div className='flex items-center gap-1 text-[11px] leading-4'>
            <span
              className={cn(
                'font-medium',
                dayLabel === 'Today' ? 'text-[var(--accent-nav)]' : 'text-zinc-400',
              )}
            >
              {dayLabel}
            </span>
            {differenceInCalendarDays(event.date, now) < 7 && (
              <span className='text-zinc-500'>· {format(event.date, 'MMM d')}</span>
            )}
          </div>
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
                    <span className='hidden xl:block w-5 h-7 bg-zinc-900 rounded-sm overflow-hidden shrink-0'>
                      <RemoteImage
                        src={event.poster}
                        alt=''
                        loading='lazy'
                        className='w-full h-full object-cover opacity-70'
                      />
                    </span>
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
                      <span className='block w-5 h-7 bg-zinc-900 rounded-[3px] overflow-hidden shrink-0'>
                        <RemoteImage
                          src={event.poster}
                          alt=''
                          loading='lazy'
                          className='w-full h-full object-cover opacity-70'
                        />
                      </span>
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
