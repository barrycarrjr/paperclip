import { describe, expect, it, vi } from "vitest";
import { bulkFailureMessage, isBulkResolvable, resolveApprovalsInBulk } from "./approval-bulk";

describe("isBulkResolvable", () => {
  it("allows undecided approvals and leaves budget overrides to their own flow", () => {
    expect(isBulkResolvable({ type: "outbound_tool_draft", status: "pending" })).toBe(true);
    expect(isBulkResolvable({ type: "outbound_tool_draft", status: "revision_requested" })).toBe(true);
    expect(isBulkResolvable({ type: "outbound_tool_draft", status: "approved" })).toBe(false);
    expect(isBulkResolvable({ type: "outbound_tool_draft", status: "rejected" })).toBe(false);
    expect(isBulkResolvable({ type: "budget_override_required", status: "pending" })).toBe(false);
  });
});

describe("resolveApprovalsInBulk", () => {
  it("carries on past a failure and reports which ids failed", async () => {
    const api = {
      approve: vi.fn(async (id: string) => {
        if (id === "b") throw new Error("Approval is not pending");
        return { id } as never;
      }),
      reject: vi.fn(),
    };

    const result = await resolveApprovalsInBulk(["a", "b", "c"], "approve", api);

    expect(api.approve).toHaveBeenCalledTimes(3);
    expect(api.reject).not.toHaveBeenCalled();
    expect(result.succeeded).toEqual(["a", "c"]);
    expect(result.failed).toEqual([{ id: "b", message: "Approval is not pending" }]);
    expect(bulkFailureMessage(result, "approve")).toBe("Could not approve 1 of 3: Approval is not pending");
  });

  it("uses reject for a bulk reject and reports nothing when all succeed", async () => {
    const api = { approve: vi.fn(), reject: vi.fn(async (id: string) => ({ id }) as never) };

    const result = await resolveApprovalsInBulk(["a", "b"], "reject", api);

    expect(api.reject).toHaveBeenCalledTimes(2);
    expect(api.approve).not.toHaveBeenCalled();
    expect(bulkFailureMessage(result, "reject")).toBeNull();
  });
});
