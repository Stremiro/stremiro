import type { CalendarScheduleEvent } from '@/lib/api';

export interface CalendarEvent extends CalendarScheduleEvent {
  date: Temporal.PlainDate;
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
