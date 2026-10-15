import { describe, expect, it } from "vitest";
import { AGENT_ROLE_LABELS, acceptInviteSchema, createAgentSchema, updateAgentSchema } from "./index.js";

describe("dynamic adapter type validation schemas", () => {
  it("accepts external adapter types in create/update agent schemas", () => {
    expect(
      createAgentSchema.parse({
        name: "External Agent",
        adapterType: "external_adapter",
      }).adapterType,
    ).toBe("external_adapter");

    expect(
      updateAgentSchema.parse({
        adapterType: "external_adapter",
      }).adapterType,
    ).toBe("external_adapter");
  });

  it("still rejects blank adapter types", () => {
    expect(() =>
      createAgentSchema.parse({
        name: "Blank Adapter",
        adapterType: "   ",
      }),
    ).toThrow();
  });

  it("accepts external adapter types in invite acceptance schema", () => {
    expect(
      acceptInviteSchema.parse({
        requestType: "agent",
        agentName: "External Joiner",
        adapterType: "external_adapter",
      }).adapterType,
    ).toBe("external_adapter");
  });

  it("accepts the security agent role and exposes its UI label", () => {
    expect(
      createAgentSchema.parse({
        name: "Security Engineer",
        role: "security",
        adapterType: "codex_local",
      }).role,
    ).toBe("security");

    expect(AGENT_ROLE_LABELS.security).toBe("Security");
  });

  it("accepts a valid automatic reviewer and rejects an invalid reviewer ID", () => {
    const reviewerId = "8a5367a7-2fb8-4891-85cd-174af1e99651";
    expect(updateAgentSchema.parse({ defaultReviewerAgentId: reviewerId }).defaultReviewerAgentId)
      .toBe(reviewerId);
    expect(() => updateAgentSchema.parse({ defaultReviewerAgentId: "reviewer" })).toThrow();
  });
});
