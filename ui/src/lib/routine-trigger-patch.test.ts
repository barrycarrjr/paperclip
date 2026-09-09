import { describe, expect, it } from "vitest";
import type { RoutineTrigger } from "@paperclipai/shared";
import { buildRoutineTriggerDraft, buildRoutineTriggerPatch } from "./routine-trigger-patch";

function makeScheduleTrigger(overrides: Partial<RoutineTrigger> = {}): RoutineTrigger {
  return {
    id: "trigger-1",
    companyId: "company-1",
    routineId: "routine-1",
    kind: "schedule",
    label: "Daily",
    enabled: true,
    cronExpression: "0 10 * * *",
    timezone: "UTC",
    nextRunAt: null,
    lastFiredAt: null,
    publicId: null,
    secretId: null,
    signingMode: null,
    replayWindowSec: null,
    lastRotatedAt: null,
    lastResult: null,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    createdAt: new Date("2026-03-20T00:00:00.000Z"),
    updatedAt: new Date("2026-03-20T00:00:00.000Z"),
    ...overrides,
  };
}

describe("buildRoutineTriggerDraft", () => {
  it("starts from the zone saved on the trigger, not the browser looking at it", () => {
    const draft = buildRoutineTriggerDraft(
      makeScheduleTrigger({ timezone: "America/New_York" }),
      "Asia/Tokyo",
    );

    expect(draft.timezone).toBe("America/New_York");
  });

  it("uses the browser's zone only when the trigger has none saved", () => {
    const draft = buildRoutineTriggerDraft(makeScheduleTrigger({ timezone: null }), "Asia/Tokyo");

    expect(draft.timezone).toBe("Asia/Tokyo");
  });
});

describe("buildRoutineTriggerPatch", () => {
  it("preserves an existing schedule trigger timezone when saving edits", () => {
    const patch = buildRoutineTriggerPatch(
      makeScheduleTrigger({ timezone: "UTC" }),
      {
        label: "Daily label edit",
        cronExpression: "0 10 * * *",
        timezone: "UTC",
        signingMode: "bearer",
        replayWindowSec: "300",
      },
      "America/Chicago",
    );

    expect(patch).toEqual({
      label: "Daily label edit",
      cronExpression: "0 10 * * *",
      timezone: "UTC",
    });
  });

  it("falls back to the local timezone when a schedule trigger has none", () => {
    const patch = buildRoutineTriggerPatch(
      makeScheduleTrigger({ timezone: null }),
      {
        label: "",
        cronExpression: "15 9 * * 1-5",
        timezone: "",
        signingMode: "bearer",
        replayWindowSec: "300",
      },
      "America/Chicago",
    );

    expect(patch).toEqual({
      label: null,
      cronExpression: "15 9 * * 1-5",
      timezone: "America/Chicago",
    });
  });

  it("saves a zone the person picked", () => {
    const trigger = makeScheduleTrigger({ timezone: "America/New_York" });
    const draft = { ...buildRoutineTriggerDraft(trigger, "Asia/Tokyo"), timezone: "Europe/London" };

    expect(buildRoutineTriggerPatch(trigger, draft, "Asia/Tokyo").timezone).toBe("Europe/London");
  });

  it("cannot move an existing automation's firing time when nobody touched the zone", () => {
    // The whole point of the change: someone in Tokyo opens an automation that
    // was set up to run at 9am New York time, renames it, and saves. The saved
    // zone has to survive that untouched, or the automation starts firing at a
    // different hour.
    const trigger = makeScheduleTrigger({
      cronExpression: "0 9 * * *",
      timezone: "America/New_York",
    });
    const browserZone = "Asia/Tokyo";

    const draft = buildRoutineTriggerDraft(trigger, browserZone);
    draft.label = "Renamed by somebody in Tokyo";

    const patch = buildRoutineTriggerPatch(trigger, draft, browserZone);

    expect(patch.timezone).toBe("America/New_York");
    expect(patch.timezone).not.toBe(browserZone);
    expect(patch.cronExpression).toBe(trigger.cronExpression);
  });
});
