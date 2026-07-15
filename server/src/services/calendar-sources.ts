import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { calendarEvents } from "@paperclipai/db";
import type { CalendarOccurrence } from "@paperclipai/shared";
import { type CalendarScheduleInput, expandOccurrences } from "./calendar-schedule.js";

const MS_PER_MINUTE = 60_000;

/**
 * A calendar source expands stored schedules into concrete occurrences for a
 * time window. `paperclip` reads the local `calendar_events` table; `google` and
 * `outlook` are seams for future external-calendar integrations.
 */
export interface CalendarSource {
  id: "paperclip" | "google" | "outlook";
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
 * The ordered list of calendar sources to aggregate for a company. Today only
 * the Paperclip source is wired; Google/Outlook sources will be appended here.
 */
export function getCalendarSources(db: Db): CalendarSource[] {
  return [paperclipCalendarSource(db)];
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
