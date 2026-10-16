import { describe, expect, it } from "vitest";
import { pluginActivityId } from "../services/plugin-host-services.js";

describe("plugin activity idempotency", () => {
  it("keeps retries stable and scopes caller keys by plugin and company", () => {
    const first = pluginActivityId("handoff-pipeline", "company-a", "event-1");

    expect(pluginActivityId("handoff-pipeline", "company-a", "event-1")).toBe(first);
    expect(pluginActivityId("another-plugin", "company-a", "event-1")).not.toBe(first);
    expect(pluginActivityId("handoff-pipeline", "company-b", "event-1")).not.toBe(first);
  });
});
