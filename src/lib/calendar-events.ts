import type { CalendarScheduleEvent } from '@/lib/api';
import { parseLocalScheduleDate } from '@/lib/schedule-dates';

export interface CalendarEvent {
  id: string;
  mediaId: string;
  mediaType: CalendarScheduleEvent['mediaType'];
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

export function toCalendarEvent(event: CalendarScheduleEvent): CalendarEvent | null {
  const date = parseLocalScheduleDate(event.releaseDate);
  if (!date) return null;
  return {
    ...event,
    date,
  };
}
