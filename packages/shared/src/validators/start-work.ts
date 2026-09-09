import { z } from "zod";
import { ISSUE_PRIORITIES, ISSUE_THREAD_INTERACTION_STATUSES } from "../constants.js";
import { MAX_START_WORK_TASKS } from "../start-work.js";
import type { SuggestTasksInteraction } from "../types/issue.js";

/**
 * What the browser sends to draft a plan. `companyId` is the route parameter,
 * never part of the body, so a body cannot point the plan at another company.
 * `requestKey` is minted once per typed request and is what makes a repeat
 * submit land on the same container issue.
 */
export const startWorkPlanRequestSchema = z.object({
  text: z.string().trim().min(3).max(2000),
  requestKey: z.string().uuid(),
});

export type StartWorkPlanRequest = z.infer<typeof startWorkPlanRequestSchema>;

/**
 * The JSON the planner model must return. This is the only shape the model
 * can express, on purpose: nothing here maps to `hiddenInPreview`, `parentId`,
 * `projectId`, `goalId`, `billingCode`, `labels` or `assigneeUserId`, so the
 * model cannot smuggle a task past the reviewer or onto a target it was not
 * asked about. The server turns this into the suggest_tasks payload after
 * checking every assignee and plugin against what this company can run.
 */
export const startWorkPlannerTaskSchema = z.object({
  clientKey: z.string().trim().min(1).max(120),
  parentClientKey: z.string().trim().min(1).max(120).nullable().optional(),
  title: z.string().trim().min(1).max(240),
  why: z.string().trim().min(1).max(2000),
  priority: z.enum(ISSUE_PRIORITIES).nullable(),
  assigneeAgentId: z.string().uuid().nullable(),
  needsPlugins: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
});

export type StartWorkPlannerTask = z.infer<typeof startWorkPlannerTaskSchema>;

export const startWorkPlannerOutputSchema = z.object({
  summary: z.string().trim().max(1000),
  soundsRecurring: z.boolean(),
  recurringNote: z.string().trim().max(300).nullable().default(null),
  tasks: z.array(startWorkPlannerTaskSchema).min(1).max(MAX_START_WORK_TASKS),
}).superRefine((value, ctx) => {
  const seenClientKeys = new Set<string>();
  for (const [index, task] of value.tasks.entries()) {
    if (seenClientKeys.has(task.clientKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "clientKey must be unique within one plan",
        path: ["tasks", index, "clientKey"],
      });
      continue;
    }
    seenClientKeys.add(task.clientKey);
  }
});

export type StartWorkPlannerOutput = z.infer<typeof startWorkPlannerOutputSchema>;

/**
 * The plan route's response body. Every line the dialog shows in its header
 * comes from a field here, so the browser never invents a fact about who
 * leads, what was drafted, or what the company can run.
 *
 * `interaction` is the full suggest_tasks row the card renders. Only the
 * fields the client needs to identify and route it are pinned; the rest
 * passes through so the row stays whatever the interaction service returns.
 */
export const startWorkPlanResponseSchema = z.object({
  issue: z.object({
    id: z.string().uuid(),
    identifier: z.string().trim().min(1),
    title: z.string().trim().min(1),
  }),
  interaction: z.object({
    id: z.string().uuid(),
    issueId: z.string().uuid(),
    kind: z.literal("suggest_tasks"),
    status: z.enum(ISSUE_THREAD_INTERACTION_STATUSES),
  }).passthrough(),
  lead: z.object({
    id: z.string().uuid(),
    name: z.string().trim().min(1),
  }).nullable(),
  leftOut: z.array(z.object({
    title: z.string().trim().min(1),
    reason: z.string().trim().min(1),
  })),
  warnings: z.array(z.object({
    agentId: z.string().uuid(),
    agentName: z.string().trim().min(1),
    reason: z.string().trim().min(1),
  })),
  notes: z.object({
    soundsRecurring: z.boolean(),
    recurringNote: z.string().nullable(),
    companyName: z.string(),
    isPortfolioRoot: z.boolean(),
  }),
  guardrails: z.object({
    outboundHold: z.boolean(),
  }),
  planner: z.object({
    modelUsed: z.string().nullable(),
  }),
  matchedCards: z.array(z.string()),
});

/**
 * The typed view of the response. The zod schema keeps `interaction` open so
 * it can validate any row; the TypeScript type narrows it to the shape the
 * card component already accepts.
 */
export type StartWorkPlanResponse = Omit<
  z.infer<typeof startWorkPlanResponseSchema>,
  "interaction"
> & { interaction: SuggestTasksInteraction };
