import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { calendarEvents, routines, routineTriggers } from "@paperclipai/db";
import type { CalendarOccurrence } from "@paperclipai/shared";
import { type CalendarScheduleInput, expandOccurrences } from "./calendar-schedule.js";
import { getZonedMinuteParts } from "./cron.js";

const MS_PER_MINUTE = 60_000;

/** Kind reported for a scheduled routine, distinct from the reminder kinds. */
const ROUTINE_OCCURRENCE_KIND = "routine";

/**
 * A calendar source expands stored schedules into concrete occurrences for a
 * time window. `paperclip` reads the local `calendar_events` table; `google` and
 * `outlook` are seams for future external-calendar integrations.
 */
export interface CalendarSource {
  id: "paperclip" | "routine" | "google" | "outlook";
  listOccurrences(
    companyId: string,
    from: Date,
    to: Date,
    opts?: { kinds?: string[] },
  ): Promise<CalendarOccurrence[]>;
}

/** Project a stored event row onto the pure schedule engine's input shape. */
function toScheduleInput(event: typeof calendarEvents.$inferSelect): CalendarScheduleInput {
  return {
    scheduleKind: event.scheduleKind as CalendarScheduleInput["scheduleKind"],
    anchorAt: event.anchorAt,
    intervalUnit: event.intervalUnit as CalendarScheduleInput["intervalUnit"],
    intervalCount: event.intervalCount,
    timeOfDay: event.timeOfDay,
    cronExpression: event.cronExpression,
    timezone: event.timezone,
    endAt: event.endAt,
    maxOccurrences: event.maxOccurrences,
    leadTimeMinutes: event.leadTimeMinutes,
  };
}

/**
 * The built-in source backed by Paperclip's own `calendar_events` table. Selects
 * active events for the company (optionally filtered to a set of kinds) and
 * expands each into occurrences within `[from, to]`.
 */
export function paperclipCalendarSource(db: Db): CalendarSource {
  return {
    id: "paperclip",
    async listOccurrences(companyId, from, to, opts) {
      const kinds = opts?.kinds?.filter((kind) => kind.trim().length > 0) ?? [];
      const conditions = [eq(calendarEvents.companyId, companyId), eq(calendarEvents.status, "active")];
      if (kinds.length > 0) {
        conditions.push(inArray(calendarEvents.kind, kinds));
      }

      const events = await db
        .select()
        .from(calendarEvents)
        .where(and(...conditions));

      const occurrences: CalendarOccurrence[] = [];
      for (const event of events) {
        const { occurrences: instants } = expandOccurrences(toScheduleInput(event), from, to);
        for (const instant of instants) {
          const end = event.allDay
            ? null
            : event.durationMinutes != null
              ? new Date(instant.getTime() + event.durationMinutes * MS_PER_MINUTE).toISOString()
              : null;
          occurrences.push({
            eventId: event.id,
            companyId: event.companyId,
            source: event.source,
            kind: event.kind,
            title: event.title,
            body: event.body,
            start: instant.toISOString(),
            end,
            allDay: event.allDay,
            ownerUserId: event.userId,
            status: event.status,
            notify: event.notify,
            channels: event.channels,
          });
        }
      }
      return occurrences;
    },
  };
}

/**
 * Reduce a schedule's firings to one entry per day, keeping the first time and
 * how many there were.
 *
 * A routine that runs four times a day is four entries a day on a month grid,
 * and a handful of those bury every reminder behind "+20 more". At month scale
 * the useful fact is "this runs today, this often", not each individual time.
 * The count rides along so the entry can say so.
 *
 * Days are cut in the schedule's own timezone, because that is the day the
 * operator means when they say a routine runs "daily".
 */
export function collapseToOneEntryPerDay(
  instants: Date[],
  timezone: string,
): Map<string, { first: Date; count: number }> {
  const byDay = new Map<string, { first: Date; count: number }>();

  for (const instant of instants) {
    const parts = getZonedMinuteParts(instant, timezone);
    const key = `${parts.year}-${parts.month}-${parts.day}`;
    const existing = byDay.get(key);
    if (existing) {
      existing.count += 1;
      if (instant < existing.first) existing.first = instant;
    } else {
      byDay.set(key, { first: instant, count: 1 });
    }
  }

  return byDay;
}

/**
 * Scheduled agent work, shown alongside reminders so the calendar answers
 * "what is happening this month" rather than only "what am I being reminded
 * about".
 *
 * Only `schedule` triggers can land on a calendar: a webhook or api trigger
 * fires when something outside calls in, so it has no future date to draw.
 * A trigger is skipped unless it is switched on AND its routine is active,
 * because a paused routine will not run however good its cron looks.
 *
 * `eventId` carries the ROUTINE id, not the trigger id, so the board can send
 * a click straight to the routine. Two triggers on one routine therefore share
 * an eventId; the calendar keys its entries on eventId plus start, and two
 * schedules firing at the same instant on the same routine are the same thing
 * happening once as far as a reader is concerned.
 */
export function routineCalendarSource(db: Db): CalendarSource {
  return {
    id: "routine",
    async listOccurrences(companyId, from, to, opts) {
      // `kinds` filters reminder kinds (reminder/appointment/deadline). A
      // caller narrowing to those is asking for reminders, so routines stay
      // out rather than ignoring the filter.
      const kinds = opts?.kinds?.filter((kind) => kind.trim().length > 0) ?? [];
      if (kinds.length > 0 && !kinds.includes(ROUTINE_OCCURRENCE_KIND)) return [];

      const rows = await db
        .select({
          routineId: routines.id,
          companyId: routines.companyId,
          title: routines.title,
          description: routines.description,
          assigneeAgentId: routines.assigneeAgentId,
          triggerLabel: routineTriggers.label,
          cronExpression: routineTriggers.cronExpression,
          timezone: routineTriggers.timezone,
        })
        .from(routineTriggers)
        .innerJoin(routines, eq(routineTriggers.routineId, routines.id))
        .where(
          and(
            eq(routineTriggers.companyId, companyId),
            eq(routineTriggers.kind, "schedule"),
            eq(routineTriggers.enabled, true),
            eq(routines.status, "active"),
            isNotNull(routineTriggers.cronExpression),
          ),
        );

      const occurrences: CalendarOccurrence[] = [];
      for (const row of rows) {
        if (!row.cronExpression) continue;

        // A trigger may leave the timezone unset; the scheduler treats that as
        // UTC, so the drawing has to agree or the calendar would show a
        // different time than the one that actually fires.
        const timezone = row.timezone ?? "UTC";

        const { occurrences: instants } = expandOccurrences(
          {
            scheduleKind: "cron",
            anchorAt: null,
            intervalUnit: null,
            intervalCount: null,
            timeOfDay: null,
            cronExpression: row.cronExpression,
            timezone,
            endAt: null,
            maxOccurrences: null,
            leadTimeMinutes: 0,
          },
          from,
          to,
        );

        for (const [, day] of collapseToOneEntryPerDay(instants, timezone)) {
          const baseTitle = row.triggerLabel?.trim()
            ? `${row.title} (${row.triggerLabel.trim()})`
            : row.title;

          occurrences.push({
            eventId: row.routineId,
            companyId: row.companyId,
            source: "routine",
            kind: ROUTINE_OCCURRENCE_KIND,
            title: day.count > 1 ? `${baseTitle} ×${day.count}` : baseTitle,
            body: row.description,
            start: day.first.toISOString(),
            end: null,
            allDay: false,
            // Routines are owned by the company, not a board user. Using the
            // assignee keeps the field meaningful where there is one, and the
            // UI never offers edit or delete on a routine entry either way.
            ownerUserId: row.assigneeAgentId ?? "",
            status: "active",
            notify: false,
            channels: [],
          });
        }
      }
      return occurrences;
    },
  };
}

/**
 * The ordered list of calendar sources to aggregate for a company. Google and
 * Outlook sources will be appended here.
 */
export function getCalendarSources(db: Db): CalendarSource[] {
  return [paperclipCalendarSource(db), routineCalendarSource(db)];
}

/**
 * Run every calendar source over `[from, to]`, concatenate the results, and
 * return them sorted ascending by start instant.
 */
export async function aggregateOccurrences(
  db: Db,
  companyId: string,
  from: Date,
  to: Date,
  opts?: { kinds?: string[] },
): Promise<CalendarOccurrence[]> {
  const sources = getCalendarSources(db);
  const results = await Promise.all(
    sources.map((source) => source.listOccurrences(companyId, from, to, opts)),
  );
  return results.flat().sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}
