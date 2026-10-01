import type { MediaSchedule } from '@/lib/api';
import { getEpisodeTitle, parseLocalScheduleDate } from '@/lib/utils';

export interface CalendarEvent {
  id: string;
  mediaId: string;
  mediaType: MediaSchedule['type'];
  title: string;
  seriesTitle: string;
  season?: number;
  episode?: number;
  date: Date;
  poster?: string;
  type: 'movie' | 'episode';
}

export function calendarEventKey(event: CalendarEvent): string {
  return JSON.stringify([
    event.type,
    event.mediaId,
    event.id,
    event.season ?? null,
    event.episode ?? null,
  ]);
}

export function buildCalendarEvents(
  schedules: readonly MediaSchedule[],
  range: {
    visibleStartMs: number;
    visibleEndMs: number;
    todayStartMs: number;
    upcomingEndMs: number;
  },
): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  // Claim identities before range filtering; anime/series aliases share episode identities.
  const seenEventKeys = new Set<string>();
  const inVisibleOrUpcoming = (ms: number) =>
    (ms >= range.visibleStartMs && ms <= range.visibleEndMs) ||
    (ms >= range.todayStartMs && ms <= range.upcomingEndMs);

  for (const schedule of schedules) {
    if (schedule.type === 'movie') {
      const releaseDate = parseLocalScheduleDate(schedule.releaseDate);
      if (!releaseDate) continue;
      const eventKey = JSON.stringify(['movie', schedule.id]);
      if (seenEventKeys.has(eventKey)) continue;
      seenEventKeys.add(eventKey);
      if (!inVisibleOrUpcoming(releaseDate.getTime())) continue;
      events.push({
        id: schedule.id,
        mediaId: schedule.id,
        mediaType: schedule.type,
        title: schedule.title,
        seriesTitle: schedule.title,
        date: releaseDate,
        poster: schedule.poster,
        type: 'movie',
      });
      continue;
    }

    for (const episode of schedule.episodes) {
      const date = parseLocalScheduleDate(episode.releaseDate);
      if (!date) continue;
      const eventKey = JSON.stringify(['episode', schedule.id, episode.id]);
      if (seenEventKeys.has(eventKey)) continue;
      seenEventKeys.add(eventKey);
      if (!inVisibleOrUpcoming(date.getTime())) continue;
      events.push({
        id: episode.id,
        mediaId: schedule.id,
        mediaType: schedule.type,
        title: getEpisodeTitle(episode.title, episode.episode),
        seriesTitle: schedule.title,
        season: episode.season,
        episode: episode.episode,
        date,
        poster: schedule.poster,
        type: 'episode',
      });
    }
  }

  return events;
}
