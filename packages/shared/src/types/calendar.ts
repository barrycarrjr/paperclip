import type {
  CALENDAR_CHANNELS,
  CALENDAR_DELIVERY_CHANNELS,
  CALENDAR_EVENT_KINDS,
  CALENDAR_EVENT_STATUSES,
  CALENDAR_INTERVAL_UNITS,
  CALENDAR_SCHEDULE_KINDS,
  CALENDAR_SOURCES,
} from "../constants.js";

export type CalendarEventKind = (typeof CALENDAR_EVENT_KINDS)[number];
export type CalendarChannel = (typeof CALENDAR_CHANNELS)[number];
export type CalendarDeliveryChannel = (typeof CALENDAR_DELIVERY_CHANNELS)[number];
export type CalendarScheduleKind = (typeof CALENDAR_SCHEDULE_KINDS)[number];
export type CalendarIntervalUnit = (typeof CALENDAR_INTERVAL_UNITS)[number];
export type CalendarSource = (typeof CALENDAR_SOURCES)[number];
export type CalendarEventStatus = (typeof CALENDAR_EVENT_STATUSES)[number];

export interface CalendarEvent {
  id: string;
  companyId: string;
  userId: string;
  kind: string;
  title: string;
  body: string | null;
  status: string;
  scheduleKind: string;
  anchorAt: Date | null;
  intervalUnit: string | null;
  intervalCount: number | null;
  timeOfDay: string | null;
  cronExpression: string | null;
  timezone: string;
  endAt: Date | null;
  maxOccurrences: number | null;
  allDay: boolean;
  durationMinutes: number | null;
  nextRunAt: Date | null;
  lastFiredAt: Date | null;
  occurrenceCount: number;
  notify: boolean;
  channels: string[];
  leadTimeMinutes: number;
  slackTarget: string | null;
  source: string;
  externalId: string | null;
  externalCalendarId: string | null;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CalendarEventDelivery {
  id: string;
  companyId: string;
  eventId: string;
  userId: string;
  channel: string;
  status: string;
  title: string;
  body: string | null;
  url: string | null;
  scheduledFor: Date;
  firedAt: Date;
  deliveredAt: Date | null;
  failureReason: string | null;
  dedupeKey: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Normalized, view-facing shape produced by expanding a {@link CalendarEvent}
 * into concrete occurrences the calendar surface renders. `start`/`end` are
 * ISO-8601 strings so the shape is transport-safe across the API boundary.
 */
export interface CalendarOccurrence {
  eventId: string;
  companyId: string;
  source: string;
  kind: string;
  title: string;
  body?: string | null;
  start: string;
  end?: string | null;
  allDay: boolean;
  ownerUserId: string;
  status: string;
  notify: boolean;
  channels: string[];
}

export interface CalendarEventListItem extends CalendarEvent {
  lastDelivery: CalendarEventDelivery | null;
}

export interface CalendarEventDetail extends CalendarEvent {
  recentDeliveries: CalendarEventDelivery[];
}
