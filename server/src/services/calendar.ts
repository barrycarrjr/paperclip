import { and, asc, desc, eq, isNotNull, lte, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { calendarEvents, calendarEventDeliveries } from "@paperclipai/db";
import type {
  CalendarEvent,
  CalendarEventDetail,
  CalendarEventDelivery,
  CalendarOccurrence,
  CreateCalendarEvent,
  UpdateCalendarEvent,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { type CalendarScheduleInput, computeNextRun } from "./calendar-schedule.js";
import { aggregateOccurrences } from "./calendar-sources.js";
import { sendEventSlackDm } from "./event-slack.js";
import { publishLiveEvent } from "./live-events.js";

const MS_PER_MINUTE = 60_000;

type CalendarActor = { userId: string | null; agentId: string | null };

type EventRow = typeof calendarEvents.$inferSelect;

/** The delivery channels that always fire in addition to the event's channels. */
const IMPLICIT_CHANNELS = ["in_app"] as const;

function toDbDate(value: Date | string | null | undefined, fallback: Date | null): Date | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

/** Project an event row (or a create/update patch) onto the schedule engine input. */
function toScheduleInput(input: {
  scheduleKind: string;
  anchorAt: Date | string | null;
  intervalUnit: string | null;
  intervalCount: number | null;
  timeOfDay: string | null;
  cronExpression: string | null;
  timezone: string;
  endAt: Date | string | null;
  maxOccurrences: number | null;
  leadTimeMinutes: number;
}): CalendarScheduleInput {
  return {
    scheduleKind: input.scheduleKind as CalendarScheduleInput["scheduleKind"],
    anchorAt: input.anchorAt,
    intervalUnit: input.intervalUnit as CalendarScheduleInput["intervalUnit"],
    intervalCount: input.intervalCount,
    timeOfDay: input.timeOfDay,
    cronExpression: input.cronExpression,
    timezone: input.timezone,
    endAt: input.endAt,
    maxOccurrences: input.maxOccurrences,
    leadTimeMinutes: input.leadTimeMinutes,
  };
}

/**
 * Guard recurrence coherence for a resolved (post-merge) schedule. The create
 * validator enforces this on full payloads, but a partial PATCH can leave the
 * event in an incoherent state, so we re-check here.
 */
function assertRecurrenceCoherent(input: CalendarScheduleInput): void {
  if (input.scheduleKind === "interval") {
    if (!input.intervalUnit || !input.intervalCount || !input.timeOfDay || !input.anchorAt) {
      throw unprocessable(
        "Interval events require an interval unit, interval count, time of day, and anchor",
      );
    }
    return;
  }
  if (input.scheduleKind === "once") {
    if (!input.anchorAt) {
      throw unprocessable("One-time events require an anchor date/time");
    }
    return;
  }
  if (input.scheduleKind === "cron") {
    if (!input.cronExpression) {
      throw unprocessable("Cron events require a cron expression");
    }
  }
}

export function calendarService(db: Db) {
  async function getById(id: string): Promise<CalendarEvent | null> {
    return db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, id))
      .then((rows) => (rows[0] ?? null) as CalendarEvent | null);
  }

  async function listRecentDeliveries(eventId: string, limit = 20): Promise<CalendarEventDelivery[]> {
    const rows = await db
      .select()
      .from(calendarEventDeliveries)
      .where(eq(calendarEventDeliveries.eventId, eventId))
      .orderBy(desc(calendarEventDeliveries.firedAt))
      .limit(limit);
    return rows as CalendarEventDelivery[];
  }

  /**
   * Deliver a single fire of an event to every channel. Each delivery row is
   * keyed by a `${eventId}:${scheduledFor}:${channel}` dedupe key and inserted
   * with `onConflictDoNothing`, so a re-fire at the same instant produces no
   * duplicate rows and no duplicate outbound side effects (only channels whose
   * insert actually created a row get sent/published).
   */
  async function dispatchEventFire(input: { event: EventRow; scheduledFor: Date }): Promise<void> {
    const { event, scheduledFor } = input;
    const now = new Date();
    const channels = Array.from(new Set<string>([...event.channels, ...IMPLICIT_CHANNELS]));
    const url = "/calendar";
    let insertedAny = false;

    for (const channel of channels) {
      const dedupeKey = `${event.id}:${scheduledFor.toISOString()}:${channel}`;
      const [inserted] = await db
        .insert(calendarEventDeliveries)
        .values({
          companyId: event.companyId,
          eventId: event.id,
          userId: event.userId,
          channel,
          status: "pending",
          title: event.title,
          body: event.body,
          url,
          scheduledFor,
          firedAt: now,
          dedupeKey,
        })
        .onConflictDoNothing({ target: calendarEventDeliveries.dedupeKey })
        .returning();

      // Another fire already created this delivery — skip all side effects.
      if (!inserted) continue;
      insertedAny = true;

      if (channel === "desktop") {
        // Leave 'pending' for the desktop tray to pick up and acknowledge.
        continue;
      }

      if (channel === "slack") {
        const message = event.body ? `${event.title}\n${event.body}` : event.title;
        const result = event.slackTarget
          ? await sendEventSlackDm(db, event.companyId, event.slackTarget, message)
          : { ok: false, error: "No Slack target configured" as string };
        await db
          .update(calendarEventDeliveries)
          .set(
            result.ok
              ? { status: "delivered", deliveredAt: new Date(), updatedAt: new Date() }
              : { status: "failed", failureReason: result.error ?? "Slack delivery failed", updatedAt: new Date() },
          )
          .where(eq(calendarEventDeliveries.id, inserted.id));
        continue;
      }

      if (channel === "in_app") {
        publishLiveEvent({
          companyId: event.companyId,
          type: "calendar.event.fired",
          payload: {
            eventId: event.id,
            companyId: event.companyId,
            title: event.title,
            body: event.body,
            userId: event.userId,
            scheduledFor: scheduledFor.toISOString(),
          },
        });
        await db
          .update(calendarEventDeliveries)
          .set({ status: "delivered", deliveredAt: new Date(), updatedAt: new Date() })
          .where(eq(calendarEventDeliveries.id, inserted.id));
        continue;
      }
    }

    // Only advance the fired counters when this fire actually created deliveries,
    // so a duplicate re-fire (all conflicts) is a no-op.
    if (insertedAny) {
      await db
        .update(calendarEvents)
        .set({
          lastFiredAt: scheduledFor,
          occurrenceCount: sql`${calendarEvents.occurrenceCount} + 1`,
          updatedAt: now,
        })
        .where(eq(calendarEvents.id, event.id));
    }
  }

  return {
    getById,

    create: async (
      companyId: string,
      input: CreateCalendarEvent,
      actor: CalendarActor,
    ): Promise<CalendarEvent> => {
      if (!actor.userId) {
        throw unprocessable("Calendar events require an owner user");
      }
      const ownerUserId = actor.userId;
      const anchorAt = toDbDate(input.anchorAt, null);
      const endAt = toDbDate(input.endAt, null);
      const scheduleInput = toScheduleInput({
        scheduleKind: input.scheduleKind,
        anchorAt,
        intervalUnit: input.intervalUnit ?? null,
        intervalCount: input.intervalCount ?? null,
        timeOfDay: input.timeOfDay ?? null,
        cronExpression: input.cronExpression ?? null,
        timezone: input.timezone,
        endAt,
        maxOccurrences: input.maxOccurrences ?? null,
        leadTimeMinutes: input.leadTimeMinutes,
      });
      const nextRunAt = computeNextRun(scheduleInput, new Date());

      const [created] = await db
        .insert(calendarEvents)
        .values({
          companyId,
          userId: ownerUserId,
          kind: input.kind,
          title: input.title,
          body: input.body ?? null,
          scheduleKind: input.scheduleKind,
          anchorAt,
          intervalUnit: input.intervalUnit ?? null,
          intervalCount: input.intervalCount ?? null,
          timeOfDay: input.timeOfDay ?? null,
          cronExpression: input.cronExpression ?? null,
          timezone: input.timezone,
          endAt,
          maxOccurrences: input.maxOccurrences ?? null,
          allDay: input.allDay,
          durationMinutes: input.durationMinutes ?? null,
          nextRunAt,
          notify: input.notify,
          channels: input.channels,
          leadTimeMinutes: input.leadTimeMinutes,
          slackTarget: input.slackTarget ?? null,
          createdByUserId: ownerUserId,
          createdByAgentId: actor.agentId,
          updatedByUserId: ownerUserId,
        })
        .returning();
      return created as CalendarEvent;
    },

    list: async (companyId: string): Promise<CalendarEvent[]> => {
      const rows = await db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.companyId, companyId))
        .orderBy(asc(calendarEvents.nextRunAt), desc(calendarEvents.createdAt));
      return rows as CalendarEvent[];
    },

    getDetail: async (id: string): Promise<CalendarEventDetail | null> => {
      const event = await getById(id);
      if (!event) return null;
      const recentDeliveries = await listRecentDeliveries(id, 20);
      return { ...event, recentDeliveries };
    },

    update: async (
      id: string,
      patch: UpdateCalendarEvent,
      actor: CalendarActor,
    ): Promise<CalendarEvent | null> => {
      const existing = await getById(id);
      if (!existing) return null;

      const nextAnchorAt = toDbDate(patch.anchorAt, existing.anchorAt);
      const nextEndAt = toDbDate(patch.endAt, existing.endAt);
      const nextScheduleKind = patch.scheduleKind === undefined ? existing.scheduleKind : patch.scheduleKind;
      const nextIntervalUnit = patch.intervalUnit === undefined ? existing.intervalUnit : patch.intervalUnit;
      const nextIntervalCount = patch.intervalCount === undefined ? existing.intervalCount : patch.intervalCount;
      const nextTimeOfDay = patch.timeOfDay === undefined ? existing.timeOfDay : patch.timeOfDay;
      const nextCronExpression = patch.cronExpression === undefined ? existing.cronExpression : patch.cronExpression;
      const nextTimezone = patch.timezone === undefined ? existing.timezone : patch.timezone;
      const nextMaxOccurrences = patch.maxOccurrences === undefined ? existing.maxOccurrences : patch.maxOccurrences;
      const nextLeadTimeMinutes = patch.leadTimeMinutes === undefined ? existing.leadTimeMinutes : patch.leadTimeMinutes;
      const nextStatus = patch.status === undefined ? existing.status : patch.status;

      const scheduleFieldChanged =
        patch.scheduleKind !== undefined ||
        patch.anchorAt !== undefined ||
        patch.intervalUnit !== undefined ||
        patch.intervalCount !== undefined ||
        patch.timeOfDay !== undefined ||
        patch.cronExpression !== undefined ||
        patch.timezone !== undefined ||
        patch.endAt !== undefined ||
        patch.maxOccurrences !== undefined ||
        patch.leadTimeMinutes !== undefined;

      const statusActivationChanged =
        patch.status !== undefined && (patch.status === "active") !== (existing.status === "active");

      const nextScheduleInput = toScheduleInput({
        scheduleKind: nextScheduleKind,
        anchorAt: nextAnchorAt,
        intervalUnit: nextIntervalUnit,
        intervalCount: nextIntervalCount,
        timeOfDay: nextTimeOfDay,
        cronExpression: nextCronExpression,
        timezone: nextTimezone,
        endAt: nextEndAt,
        maxOccurrences: nextMaxOccurrences,
        leadTimeMinutes: nextLeadTimeMinutes,
      });

      if (scheduleFieldChanged) {
        assertRecurrenceCoherent(nextScheduleInput);
      }

      let nextRunAt = existing.nextRunAt;
      if (scheduleFieldChanged || statusActivationChanged) {
        nextRunAt = nextStatus !== "active" ? null : computeNextRun(nextScheduleInput, new Date());
      }

      const [updated] = await db
        .update(calendarEvents)
        .set({
          kind: patch.kind === undefined ? existing.kind : patch.kind,
          title: patch.title === undefined ? existing.title : patch.title,
          body: patch.body === undefined ? existing.body : patch.body,
          status: nextStatus,
          scheduleKind: nextScheduleKind,
          anchorAt: nextAnchorAt,
          intervalUnit: nextIntervalUnit,
          intervalCount: nextIntervalCount,
          timeOfDay: nextTimeOfDay,
          cronExpression: nextCronExpression,
          timezone: nextTimezone,
          endAt: nextEndAt,
          maxOccurrences: nextMaxOccurrences,
          allDay: patch.allDay === undefined ? existing.allDay : patch.allDay,
          durationMinutes: patch.durationMinutes === undefined ? existing.durationMinutes : patch.durationMinutes,
          nextRunAt,
          notify: patch.notify === undefined ? existing.notify : patch.notify,
          channels: patch.channels === undefined ? existing.channels : patch.channels,
          leadTimeMinutes: nextLeadTimeMinutes,
          slackTarget: patch.slackTarget === undefined ? existing.slackTarget : patch.slackTarget,
          updatedByUserId: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(calendarEvents.id, id))
        .returning();
      return (updated as CalendarEvent | undefined) ?? null;
    },

    remove: async (id: string): Promise<boolean> => {
      const deleted = await db
        .delete(calendarEvents)
        .where(eq(calendarEvents.id, id))
        .returning({ id: calendarEvents.id });
      return deleted.length > 0;
    },

    fireNow: async (id: string): Promise<void> => {
      const event = await db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.id, id))
        .then((rows) => rows[0] ?? null);
      if (!event) return;
      await dispatchEventFire({ event, scheduledFor: new Date() });
    },

    tickDueEvents: async (now: Date = new Date()): Promise<{ fired: number }> => {
      const due = await db
        .select()
        .from(calendarEvents)
        .where(
          and(
            eq(calendarEvents.notify, true),
            eq(calendarEvents.status, "active"),
            isNotNull(calendarEvents.nextRunAt),
            lte(calendarEvents.nextRunAt, now),
          ),
        )
        .orderBy(asc(calendarEvents.nextRunAt));

      let fired = 0;
      for (const event of due) {
        const observedNextRunAt = event.nextRunAt;
        if (!observedNextRunAt) continue;

        const claimedNext = computeNextRun(toScheduleInput(event), now);
        const terminal = claimedNext === null;

        const claimed = await db
          .update(calendarEvents)
          .set({
            nextRunAt: terminal ? null : claimedNext,
            status: terminal ? "completed" : "active",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(calendarEvents.id, event.id),
              eq(calendarEvents.status, "active"),
              eq(calendarEvents.nextRunAt, observedNextRunAt),
            ),
          )
          .returning({ id: calendarEvents.id })
          .then((rows) => rows[0] ?? null);
        if (!claimed) continue;

        await dispatchEventFire({ event, scheduledFor: observedNextRunAt });
        fired += 1;
      }

      return { fired };
    },

    listOccurrences: async (
      companyId: string,
      from: Date,
      to: Date,
      opts?: { kinds?: string[] },
    ): Promise<CalendarOccurrence[]> => {
      return aggregateOccurrences(db, companyId, from, to, opts);
    },

    listPendingDesktopNotifications: async (
      limit = 20,
      userId?: string,
    ): Promise<Array<{ id: string; title: string; body: string | null; url: string | null; createdAt: Date }>> => {
      const conditions = [
        eq(calendarEventDeliveries.channel, "desktop"),
        eq(calendarEventDeliveries.status, "pending"),
      ];
      if (userId) {
        conditions.push(eq(calendarEventDeliveries.userId, userId));
      }
      const rows = await db
        .select({
          id: calendarEventDeliveries.id,
          title: calendarEventDeliveries.title,
          body: calendarEventDeliveries.body,
          url: calendarEventDeliveries.url,
          createdAt: calendarEventDeliveries.createdAt,
        })
        .from(calendarEventDeliveries)
        .where(and(...conditions))
        .orderBy(asc(calendarEventDeliveries.firedAt))
        .limit(limit);
      return rows;
    },

    ackDesktopNotifications: async (ids: string[]): Promise<string[]> => {
      if (ids.length === 0) return [];
      const updated = await db
        .update(calendarEventDeliveries)
        .set({ status: "delivered", deliveredAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            inArray(calendarEventDeliveries.id, ids),
            eq(calendarEventDeliveries.channel, "desktop"),
            eq(calendarEventDeliveries.status, "pending"),
          ),
        )
        .returning({ id: calendarEventDeliveries.id });
      return updated.map((row) => row.id);
    },

    dispatchEventFire,
  };
}
