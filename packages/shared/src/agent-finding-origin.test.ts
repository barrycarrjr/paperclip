import { describe, expect, it } from "vitest";
import { ISSUE_ORIGIN_KINDS } from "./constants.js";
import {
  AGENT_FINDING_KEY_MAX_LENGTH,
  AGENT_FINDING_ORIGIN_KIND,
  isAgentFindingOriginKind,
} from "./agent-finding-origin.js";
import { EMAIL_HANDOFF_ORIGIN_KIND } from "./email-handoff-origin.js";
import { clientDeclarableIssueOriginSchema, createIssueSchema, updateIssueSchema } from "./validators/issue.js";

describe("agent finding origin", () => {
  it("is a feature-local kind, like email_handoff", () => {
    expect(AGENT_FINDING_ORIGIN_KIND).toBe("agent_finding");
    expect((ISSUE_ORIGIN_KINDS as readonly string[]).includes(AGENT_FINDING_ORIGIN_KIND)).toBe(false);
  });

  it("can be declared by a client with a key", () => {
    const parsed = clientDeclarableIssueOriginSchema.safeParse({
      kind: AGENT_FINDING_ORIGIN_KIND,
      id: "  agent-error:eb7fabd63c2be400  ",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.id).toBe("agent-error:eb7fabd63c2be400");
  });

  it("survives the create schema, where an unknown field would be dropped", () => {
    const parsed = createIssueSchema.parse({
      title: "Steward proposal: secret-scan: key in config",
      origin: { kind: AGENT_FINDING_ORIGIN_KIND, id: "secret:abc123" },
    });
    expect(parsed.origin).toEqual({ kind: AGENT_FINDING_ORIGIN_KIND, id: "secret:abc123" });
  });

  it("is not offered on update, where nothing would store it", () => {
    const parsed = updateIssueSchema.parse({
      title: "Renamed",
      origin: { kind: AGENT_FINDING_ORIGIN_KIND, id: "secret:abc123" },
    });
    expect(parsed).toEqual({ title: "Renamed" });
    expect("origin" in updateIssueSchema.shape).toBe(false);
  });

  it("refuses an empty or oversized key", () => {
    expect(clientDeclarableIssueOriginSchema.safeParse({ kind: AGENT_FINDING_ORIGIN_KIND, id: "   " }).success).toBe(false);
    expect(
      clientDeclarableIssueOriginSchema.safeParse({
        kind: AGENT_FINDING_ORIGIN_KIND,
        id: "k".repeat(AGENT_FINDING_KEY_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it("still keeps every server-only kind out of client hands", () => {
    for (const kind of ["routine_execution", "harness_liveness_escalation", "stranded_issue_recovery", "manual", "chat"]) {
      expect(clientDeclarableIssueOriginSchema.safeParse({ kind, id: "x" }).success).toBe(false);
    }
    expect(clientDeclarableIssueOriginSchema.safeParse({ kind: EMAIL_HANDOFF_ORIGIN_KIND, id: "x" }).success).toBe(true);
  });

  it("isAgentFindingOriginKind matches only the exact kind", () => {
    expect(isAgentFindingOriginKind("agent_finding")).toBe(true);
    expect(isAgentFindingOriginKind("email_handoff")).toBe(false);
    expect(isAgentFindingOriginKind(null)).toBe(false);
    expect(isAgentFindingOriginKind(undefined)).toBe(false);
  });
});
