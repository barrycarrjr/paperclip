import { z } from "zod";
import {
  CALENDAR_CHANNELS,
  CALENDAR_EVENT_KINDS,
  CALENDAR_EVENT_STATUSES,
  CALENDAR_INTERVAL_UNITS,
  CALENDAR_SCHEDULE_KINDS,
} from "../constants.js";

const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const isoDateTimeSchema = z.string().trim().datetime({ offset: true });

interface CalendarRecurrenceInput {
  scheduleKind: (typeof CALENDAR_SCHEDULE_KINDS)[number];
  anchorAt?: string | null;
  intervalUnit?: (typeof CALENDAR_INTERVAL_UNITS)[number] | null;
  intervalCount?: number | null;
  timeOfDay?: string | null;
  cronExpression?: string | null;
}

function refineCalendarRecurrence(value: CalendarRecurrenceInput, ctx: z.RefinementCtx): void {
  if (value.scheduleKind === "once") {
    if (!value.anchorAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["anchorAt"],
        message: "One-time events require an anchor date/time",
      });
    }
    return;
  }

  if (value.scheduleKind === "interval") {
    if (!value.intervalUnit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["intervalUnit"],
        message: "Interval events require an interval unit",
      });
    }
    if (value.intervalCount == null || value.intervalCount < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["intervalCount"],
        message: "Interval events require an interval count of at least 1",
      });
    }
    if (!value.timeOfDay) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timeOfDay"],
        message: "Interval events require a time of day",
      });
    }
    if (!value.anchorAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["anchorAt"],
        message: "Interval events require an anchor date/time",
      });
    }
    return;
  }

  if (value.scheduleKind === "cron") {
    if (!value.cronExpression) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cronExpression"],
        message: "Cron events require a cron expression",
      });
    }
  }
}

const calendarRecurrenceObject = z.object({
  scheduleKind: z.enum(CALENDAR_SCHEDULE_KINDS),
  anchorAt: isoDateTimeSchema.optional().nullable(),
  intervalUnit: z.enum(CALENDAR_INTERVAL_UNITS).optional().nullable(),
  intervalCount: z.number().int().min(1).optional().nullable(),
  timeOfDay: z.string().trim().regex(TIME_OF_DAY_RE, "Time of day must be in HH:MM format").optional().nullable(),
  cronExpression: z.string().trim().min(1).optional().nullable(),
  endAt: isoDateTimeSchema.optional().nullable(),
  maxOccurrences: z.number().int().min(1).optional().nullable(),
});

export const calendarRecurrenceSchema = calendarRecurrenceObject.superRefine(refineCalendarRecurrence);
export type CalendarRecurrence = z.infer<typeof calendarRecurrenceSchema>;

const createEventBaseSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().optional().nullable(),
    kind: z.enum(CALENDAR_EVENT_KINDS).optional().default("reminder"),
    timezone: z.string().trim().min(1).optional().default("UTC"),
    allDay: z.boolean().optional().default(false),
    durationMinutes: z.number().int().min(0).optional().nullable(),
    notify: z.boolean().optional().default(true),
    channels: z.array(z.enum(CALENDAR_CHANNELS)).min(1).optional().default(["desktop"]),
    leadTimeMinutes: z.number().int().min(0).optional().default(0),
    slackTarget: z.string().trim().min(1).optional().nullable(),
  })
  .merge(calendarRecurrenceObject);

export const createEventSchema = createEventBaseSchema.superRefine((value, ctx) => {
  if (value.channels.includes("slack") && !value.slackTarget) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["slackTarget"],
      message: "A Slack target is required when the Slack channel is selected",
    });
  }
  refineCalendarRecurrence(value, ctx);
});

export type CreateCalendarEvent = z.infer<typeof createEventSchema>;

export const updateEventSchema = createEventBaseSchema.partial().extend({
  status: z.enum(CALENDAR_EVENT_STATUSES).optional(),
});

export type UpdateCalendarEvent = z.infer<typeof updateEventSchema>;
