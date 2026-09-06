import { describe, expect, it } from "vitest";
import {
  startWorkPlanRequestSchema,
  startWorkPlanResponseSchema,
  startWorkPlannerOutputSchema,
} from "./start-work.js";
import { stripDashes } from "./text.js";

const AGENT_ID = "0c2b1f5e-8a0c-4b1a-9f4c-3c7d1c1c9f55";
const REQUEST_KEY = "7a1d2e3f-4b5c-4d6e-8f90-a1b2c3d4e5f6";

function task(index: number, overrides: Record<string, unknown> = {}) {
  return {
    clientKey: `task-${index}`,
    title: `Task ${index}`,
    why: `Because ${index}`,
    priority: "medium",
    assigneeAgentId: AGENT_ID,
    needsPlugins: [],
    ...overrides,
  };
}

function plan(taskCount: number, overrides: Record<string, unknown> = {}) {
  return {
    summary: "A short plan.",
    soundsRecurring: false,
    recurringNote: null,
    tasks: Array.from({ length: taskCount }, (_, i) => task(i + 1)),
    ...overrides,
  };
}

describe("startWorkPlannerOutputSchema", () => {
  it("accepts a valid planner output", () => {
    const parsed = startWorkPlannerOutputSchema.parse(plan(3, {
      soundsRecurring: true,
      recurringNote: "Sounds weekly.",
      tasks: [
        task(1, { parentClientKey: null, needsPlugins: ["email"] }),
        task(2, { parentClientKey: "task-1", priority: null, assigneeAgentId: null }),
        task(3),
      ],
    }));

    expect(parsed.tasks).toHaveLength(3);
    expect(parsed.tasks[0].needsPlugins).toEqual(["email"]);
    expect(parsed.tasks[1].parentClientKey).toBe("task-1");
    expect(parsed.tasks[1].priority).toBeNull();
    expect(parsed.tasks[1].assigneeAgentId).toBeNull();
    expect(parsed.soundsRecurring).toBe(true);
    expect(parsed.recurringNote).toBe("Sounds weekly.");
  });

  it("fills in an omitted recurringNote and needsPlugins so a model that leaves them out is not sent a repair round", () => {
    const { recurringNote: _note, ...withoutNote } = plan(1);
    const { needsPlugins: _plugins, ...taskWithoutPlugins } = task(1);
    const parsed = startWorkPlannerOutputSchema.parse({
      ...withoutNote,
      tasks: [taskWithoutPlugins],
    });

    expect(parsed.recurringNote).toBeNull();
    expect(parsed.tasks[0].needsPlugins).toEqual([]);
  });

  it("rejects 13 tasks, a duplicate clientKey, a title over 240, a needsPlugins list over 10, and text under 3 or over 2000 characters", () => {
    expect(startWorkPlannerOutputSchema.safeParse(plan(12)).success).toBe(true);
    expect(startWorkPlannerOutputSchema.safeParse(plan(13)).success).toBe(false);
    expect(startWorkPlannerOutputSchema.safeParse(plan(0)).success).toBe(false);

    const duplicate = startWorkPlannerOutputSchema.safeParse(plan(2, {
      tasks: [task(1), task(2, { clientKey: "task-1" })],
    }));
    expect(duplicate.success).toBe(false);
    if (!duplicate.success) {
      expect(duplicate.error.issues.some((issue) => issue.path.join(".") === "tasks.1.clientKey")).toBe(true);
    }

    expect(startWorkPlannerOutputSchema.safeParse(plan(1, {
      tasks: [task(1, { title: "x".repeat(241) })],
    })).success).toBe(false);
    expect(startWorkPlannerOutputSchema.safeParse(plan(1, {
      tasks: [task(1, { title: "x".repeat(240) })],
    })).success).toBe(true);

    expect(startWorkPlannerOutputSchema.safeParse(plan(1, {
      tasks: [task(1, { needsPlugins: Array.from({ length: 11 }, (_, i) => `plugin-${i}`) })],
    })).success).toBe(false);
    expect(startWorkPlannerOutputSchema.safeParse(plan(1, {
      tasks: [task(1, { needsPlugins: Array.from({ length: 10 }, (_, i) => `plugin-${i}`) })],
    })).success).toBe(true);

    expect(startWorkPlanRequestSchema.safeParse({ text: "ab", requestKey: REQUEST_KEY }).success).toBe(false);
    expect(startWorkPlanRequestSchema.safeParse({ text: "  a  ", requestKey: REQUEST_KEY }).success).toBe(false);
    expect(startWorkPlanRequestSchema.safeParse({ text: "x".repeat(2001), requestKey: REQUEST_KEY }).success).toBe(false);
    expect(startWorkPlanRequestSchema.safeParse({ text: "abc", requestKey: REQUEST_KEY }).success).toBe(true);
    expect(startWorkPlanRequestSchema.safeParse({ text: "x".repeat(2000), requestKey: REQUEST_KEY }).success).toBe(true);
  });

  it("rejects fields the model must never be able to set", () => {
    // The planner schema has no way to express these; a later normalisation
    // step also strips them, but the schema is the first line.
    const parsed = startWorkPlannerOutputSchema.parse(plan(1, {
      tasks: [task(1, { hiddenInPreview: true, assigneeUserId: "u1", labels: ["x"] })],
    }));
    expect(parsed.tasks[0]).not.toHaveProperty("hiddenInPreview");
    expect(parsed.tasks[0]).not.toHaveProperty("assigneeUserId");
    expect(parsed.tasks[0]).not.toHaveProperty("labels");
  });
});

describe("startWorkPlanRequestSchema", () => {
  it("requires a uuid requestKey", () => {
    expect(startWorkPlanRequestSchema.safeParse({ text: "Do the thing", requestKey: "not-a-uuid" }).success).toBe(false);
    expect(startWorkPlanRequestSchema.safeParse({ text: "Do the thing" }).success).toBe(false);
  });
});

describe("startWorkPlanResponseSchema", () => {
  it("accepts a full response and passes extra interaction fields through", () => {
    const parsed = startWorkPlanResponseSchema.parse({
      issue: { id: AGENT_ID, identifier: "ACME-12", title: "Request: Do the thing" },
      interaction: {
        id: REQUEST_KEY,
        issueId: AGENT_ID,
        kind: "suggest_tasks",
        status: "pending",
        payload: { version: 1, tasks: [] },
        createdAt: "2026-09-06T00:00:00.000Z",
      },
      lead: { id: AGENT_ID, name: "CEO" },
      leftOut: [{ title: "Send a fax", reason: "The fax plugin isn't installed." }],
      warnings: [{ agentId: AGENT_ID, agentName: "CEO", reason: "Paused by budget." }],
      notes: { soundsRecurring: false, recurringNote: null, companyName: "Acme", isPortfolioRoot: false },
      guardrails: { outboundHold: true },
      planner: { modelUsed: "anthropic/claude-sonnet-4-5" },
      matchedCards: ["reviews"],
    });

    expect((parsed.interaction as Record<string, unknown>).payload).toEqual({ version: 1, tasks: [] });
    expect(parsed.lead?.name).toBe("CEO");
  });

  it("allows a null lead and a null model", () => {
    const parsed = startWorkPlanResponseSchema.safeParse({
      issue: { id: AGENT_ID, identifier: "ACME-12", title: "Request: Do the thing" },
      interaction: { id: REQUEST_KEY, issueId: AGENT_ID, kind: "suggest_tasks", status: "pending" },
      lead: null,
      leftOut: [],
      warnings: [],
      notes: { soundsRecurring: false, recurringNote: null, companyName: "Acme", isPortfolioRoot: true },
      guardrails: { outboundHold: false },
      planner: { modelUsed: null },
      matchedCards: [],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an interaction of another kind", () => {
    const parsed = startWorkPlanResponseSchema.safeParse({
      issue: { id: AGENT_ID, identifier: "ACME-12", title: "Request: Do the thing" },
      interaction: { id: REQUEST_KEY, issueId: AGENT_ID, kind: "ask_user_questions", status: "pending" },
      lead: null,
      leftOut: [],
      warnings: [],
      notes: { soundsRecurring: false, recurringNote: null, companyName: "Acme", isPortfolioRoot: false },
      guardrails: { outboundHold: false },
      planner: { modelUsed: null },
      matchedCards: [],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("stripDashes", () => {
  it("stripDashes replaces em and en dashes with a comma and space and leaves ordinary hyphens alone", () => {
    expect(stripDashes("Draft the plan—then review it")).toBe("Draft the plan, then review it");
    expect(stripDashes("Monday–Friday")).toBe("Monday, Friday");
    expect(stripDashes("well-known follow-up")).toBe("well-known follow-up");
    expect(stripDashes("no dashes here")).toBe("no dashes here");
  });

  it("does not leave a doubled space behind a dash that already had spaces around it", () => {
    expect(stripDashes("Draft the plan — then review it")).toBe("Draft the plan, then review it");
    expect(stripDashes("one – two — three")).toBe("one, two, three");
  });
});
