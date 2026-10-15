import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1, PluginOperationPolicy } from "@paperclipai/shared";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import type { DraftGate } from "../services/tool-draft-gate.js";
const access = vi.hoisted(() => ({ isInstanceAdmin: vi.fn(), getMembership: vi.fn(), hasPermission: vi.fn() }));
const logActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../services/access.js", () => ({ accessService: () => access }));
vi.mock("../services/activity-log.js", () => ({
  logActivity,
  deterministicActivityId: (...parts: string[]) => parts.join(":"),
}));

const run: ToolRunContext = { companyId: "company-a", agentId: "", runId: "run-1", userId: "user-a", chatSessionId: "chat-a" };
function setup(
  draftGate?: DraftGate,
  operationPolicy?: PluginOperationPolicy,
  idempotencyStore?: unknown,
) {
  const call = vi.fn().mockResolvedValue({ data: { ok: true } });
  const dispatcher = createPluginToolDispatcher({
    db: {} as never,
    draftGate,
    idempotencyStore: idempotencyStore as never,
    workerManager: { isRunning: () => true, call } as never,
  });
  dispatcher.registerPluginTools("support", { id: "support", tools: [
    { name: "repair", requiredUserPermission: "support:repair", requiresUserConfirmation: true, writes: true, actionType: "change_files", parametersSchema: { type: "object" } },
    { name: "diagnose", requiredUserPermission: "support:diagnose", parametersSchema: { type: "object" } },
    { name: "send", requiredUserPermission: "support:respond", requiresUserConfirmation: true, parametersSchema: { type: "object" } },
    { name: "ordinary", parametersSchema: { type: "object" } },
  ], operations: [
    {
      key: "mutate",
      displayName: "Mutate",
      description: "Change a file.",
      audience: "both",
      writes: true,
      actionType: "change_files",
      parametersSchema: { type: "object" },
    },
  ] } as PaperclipPluginManifestV1, "support", operationPolicy);
  return { dispatcher, call };
}
beforeEach(() => {
  vi.resetAllMocks();
  access.isInstanceAdmin.mockResolvedValue(false);
  access.getMembership.mockResolvedValue({ status: "active", membershipRole: "member" });
  access.hasPermission.mockResolvedValue(true);
});
describe("host-issued plugin permission and consent", () => {
  it("audits governed actions refused before dispatch", async () => {
    const policy = { actionType: "change_files", mode: "go_ahead", source: "agent" } as const;
    const draftGate: DraftGate = {
      isGated: () => true,
      resolveActionPolicy: vi.fn().mockResolvedValue(policy),
      intercept: vi.fn().mockResolvedValue({ intercepted: false, actionPolicy: policy }),
    };
    const { dispatcher, call } = setup(draftGate);
    const agentRun = { ...run, agentId: "agent-1", userId: null };

    await expect(dispatcher.executeTool("support:repair", {}, agentRun)).rejects.toThrow("signed-in person");

    expect(call).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent_action.refused",
      agentId: "agent-1",
      details: expect.objectContaining({ actionType: "change_files", policySource: "agent" }),
    }));
  });

  it("audits a missing inline confirmation as refused", async () => {
    const policy = { actionType: "change_files", mode: "go_ahead", source: "company" } as const;
    const draftGate: DraftGate = {
      isGated: () => true,
      resolveActionPolicy: vi.fn().mockResolvedValue(policy),
      intercept: vi.fn().mockResolvedValue({ intercepted: false, actionPolicy: policy }),
    };
    const { dispatcher, call } = setup(draftGate);

    await dispatcher.executeTool("support:repair", {}, { ...run, agentId: "agent-1" }, {
      requestUserConfirmation: async () => false,
    });

    expect(call).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent_action.refused",
      details: expect.objectContaining({ actionType: "change_files", policySource: "company" }),
    }));
  });

  it("audits an inline confirmation transport failure as failed", async () => {
    const policy = { actionType: "change_files", mode: "go_ahead", source: "company" } as const;
    const draftGate: DraftGate = {
      isGated: () => true,
      resolveActionPolicy: vi.fn().mockResolvedValue(policy),
      intercept: vi.fn().mockResolvedValue({ intercepted: false, actionPolicy: policy }),
    };
    const { dispatcher, call } = setup(draftGate);

    await expect(dispatcher.executeTool(
      "support:repair",
      {},
      { ...run, agentId: "agent-1" },
      { requestUserConfirmation: async () => { throw new Error("confirmation session closed"); } },
    )).rejects.toThrow("confirmation session closed");

    expect(call).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent_action.failed",
      details: expect.objectContaining({
        actionType: "change_files",
        error: "confirmation session closed",
      }),
    }));
  });

  it("audits a failed policy lookup using the declared action type", async () => {
    const draftGate: DraftGate = {
      isGated: () => true,
      resolveActionPolicy: vi.fn().mockRejectedValue(new Error("policy store unavailable")),
      intercept: vi.fn(),
    };
    const { dispatcher, call } = setup(draftGate);

    await expect(
      dispatcher.executeTool("support:repair", {}, { ...run, agentId: "agent-1" }),
    ).rejects.toThrow("policy store unavailable");

    expect(call).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent_action.failed",
      details: expect.objectContaining({ actionType: "change_files", policySource: "unclassified" }),
    }));
  });

  it("audits a draft creation failure", async () => {
    const policy = { actionType: "change_files", mode: "ask_first", source: "company" } as const;
    const draftGate: DraftGate = {
      isGated: () => true,
      resolveActionPolicy: vi.fn().mockResolvedValue(policy),
      intercept: vi.fn().mockRejectedValue(new Error("approval store unavailable")),
    };
    const { dispatcher, call } = setup(draftGate);

    await expect(
      dispatcher.executeTool("support:repair", {}, { ...run, agentId: "agent-1" }, {
        requestUserConfirmation: async () => true,
      }),
    ).rejects.toThrow("approval store unavailable");

    expect(call).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent_action.failed",
      details: expect.objectContaining({ actionType: "change_files", policySource: "company" }),
    }));
  });

  it("does not hide an audit persistence failure after a governed action", async () => {
    const policy = { actionType: "change_files", mode: "go_ahead", source: "company" } as const;
    const draftGate: DraftGate = {
      isGated: () => true,
      resolveActionPolicy: vi.fn().mockResolvedValue(policy),
      intercept: vi.fn().mockResolvedValue({ intercepted: false, actionPolicy: policy }),
    };
    const { dispatcher, call } = setup(draftGate);
    logActivity.mockImplementation(async (_db, event) => {
      if (event.action === "agent_action.allowed") throw new Error("activity store unavailable");
    });

    await expect(
      dispatcher.executeTool("support:repair", {}, { ...run, agentId: "agent-1" }, {
        requestUserConfirmation: async () => true,
      }),
    ).rejects.toThrow("may have completed; do not retry");

    expect(call).toHaveBeenCalledTimes(1);
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent_action.execution_started",
    }));
  });

  it("does not run a direct governed action when its durable start cannot be recorded", async () => {
    const policy = { actionType: "change_files", mode: "go_ahead", source: "company" } as const;
    const draftGate: DraftGate = {
      isGated: () => true,
      resolveActionPolicy: vi.fn().mockResolvedValue(policy),
      intercept: vi.fn().mockResolvedValue({ intercepted: false, actionPolicy: policy }),
    };
    const { dispatcher, call } = setup(draftGate);
    logActivity.mockImplementation(async (_db, event) => {
      if (event.action === "agent_action.execution_started") {
        throw new Error("activity store unavailable");
      }
    });

    await expect(
      dispatcher.executeTool("support:mutate", {}, { ...run, agentId: "agent-1" }),
    ).rejects.toThrow("action was not run");

    expect(call).not.toHaveBeenCalled();
  });

  it("does not let plugin result data forge a refused action audit", async () => {
    const policy = { actionType: "change_files", mode: "go_ahead", source: "company" } as const;
    const draftGate: DraftGate = {
      isGated: () => true,
      resolveActionPolicy: vi.fn().mockResolvedValue(policy),
      intercept: vi.fn().mockResolvedValue({ intercepted: false, actionPolicy: policy }),
    };
    const { dispatcher, call } = setup(draftGate);
    call.mockResolvedValueOnce({ data: { agentActionOutcome: "refused" } });

    await dispatcher.executeTool("support:mutate", {}, { ...run, agentId: "agent-1" });

    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent_action.allowed",
    }));
    expect(logActivity).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent_action.refused",
    }));
  });

  it("audits the host-generated duplicate-in-flight result as refused", async () => {
    const policy = { actionType: "change_files", mode: "go_ahead", source: "company" } as const;
    const draftGate: DraftGate = {
      isGated: () => true,
      resolveActionPolicy: vi.fn().mockResolvedValue(policy),
      intercept: vi.fn().mockResolvedValue({ intercepted: false, actionPolicy: policy }),
    };
    const idempotencyStore = {
      claim: vi.fn().mockResolvedValue({
        kind: "in_flight",
        startedAt: new Date("2026-10-15T12:00:00.000Z"),
      }),
    };
    const { dispatcher, call } = setup(draftGate, undefined, idempotencyStore);

    const result = await dispatcher.executeTool(
      "support:mutate",
      {},
      { ...run, agentId: "agent-1" },
    );

    expect(result.result.error).toContain("already running");
    expect(call).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent_action.refused",
    }));
  });

  it("audits a plugin mutation-switch result as refused", async () => {
    const policy = { actionType: "change_files", mode: "go_ahead", source: "company" } as const;
    const draftGate: DraftGate = {
      isGated: () => true,
      resolveActionPolicy: vi.fn().mockResolvedValue(policy),
      intercept: vi.fn().mockResolvedValue({ intercepted: false, actionPolicy: policy }),
    };
    const { dispatcher, call } = setup(draftGate);
    call.mockResolvedValueOnce({ error: "[EDISABLED] Mutations are disabled" });

    await dispatcher.executeTool("support:mutate", {}, { ...run, agentId: "agent-1" });

    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent_action.refused",
      details: expect.objectContaining({ error: "[EDISABLED] Mutations are disabled" }),
    }));
    expect(logActivity).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent_action.failed",
    }));
  });

  it("attributes an operation-required approval to the operation policy", async () => {
    const draftGate: DraftGate = {
      isGated: () => true,
      resolveActionPolicy: vi.fn().mockRejectedValue(new Error("policy store unavailable")),
      intercept: vi.fn(),
    };
    const { dispatcher, call } = setup(draftGate, { mutate: { requiresApproval: true } });

    await expect(dispatcher.executeTool(
      "support:mutate",
      {},
      { ...run, agentId: "agent-1", userId: null },
    )).rejects.toThrow("policy store unavailable");

    expect(call).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent_action.failed",
      details: expect.objectContaining({ actionType: "change_files", policySource: "operation" }),
    }));
  });

  it("checks reply permission independently and rechecks it after message approval", async () => {
    const { dispatcher,call } = setup();
    access.hasPermission.mockImplementation(async (_company,_type,_user,permission) => permission === "support:repair");
    const prompt = vi.fn().mockResolvedValue(true);
    await expect(dispatcher.executeTool("support:send",{ body: "Reviewed message" },run,{ requestUserConfirmation: prompt })).rejects.toThrow("support:respond");
    expect(prompt).not.toHaveBeenCalled();
    access.hasPermission.mockResolvedValue(true);
    await expect(dispatcher.executeTool("support:send",{ body: "Reviewed message" },run,{ requestUserConfirmation: async () => { access.hasPermission.mockResolvedValue(false); return true; } })).rejects.toThrow("support:respond");
    expect(call).not.toHaveBeenCalled();
  });
  it("ignores fabricated approval, including general approval bypass flags", async () => {
    const { dispatcher, call } = setup();
    const result = await dispatcher.executeTool("support:repair", {}, { ...run, userConfirmed: true, userPermission: "support:repair" }, { bypassDraftGate: true });
    expect(result.result.error).toContain("inline confirmation");
    expect(call).not.toHaveBeenCalled();
  });
  it("uses an approved draft as confirmation while rechecking the original user's permission", async () => {
    const { dispatcher, call } = setup();

    await dispatcher.executeTool("support:repair", {}, run, {
      bypassDraftGate: true,
      approvedDraftConfirmation: true,
    });

    expect(access.hasPermission).toHaveBeenCalledTimes(2);
    expect(access.hasPermission).toHaveBeenLastCalledWith(
      "company-a",
      "user",
      "user-a",
      "support:repair",
    );
    expect(call).toHaveBeenCalledWith("support", "executeTool", expect.objectContaining({
      runContext: expect.objectContaining({
        userConfirmed: true,
        userPermission: "support:repair",
      }),
    }), undefined);
  });
  it("does not accept an approved-draft confirmation outside draft replay", async () => {
    const { dispatcher, call } = setup();

    const result = await dispatcher.executeTool("support:repair", {}, run, {
      approvedDraftConfirmation: true,
    });

    expect(result.result.error).toContain("inline confirmation");
    expect(call).not.toHaveBeenCalled();
  });
  it("blocks agents, viewers, inactive membership and missing grants before prompting", async () => {
    const { dispatcher, call } = setup();
    const prompt = vi.fn().mockResolvedValue(true);
    await expect(dispatcher.executeTool("support:repair", {}, { ...run, userId: null }, { requestUserConfirmation: prompt })).rejects.toThrow("signed-in person");
    for (const membership of [null, { status: "inactive", membershipRole: "member" }, { status: "active", membershipRole: "viewer" }]) {
      access.getMembership.mockResolvedValue(membership);
      await expect(dispatcher.executeTool("support:repair", {}, run, { requestUserConfirmation: prompt })).rejects.toThrow("support:repair");
    }
    access.getMembership.mockResolvedValue({ status: "active", membershipRole: "member" });
    access.hasPermission.mockResolvedValue(false);
    await expect(dispatcher.executeTool("support:repair", {}, run, { requestUserConfirmation: prompt })).rejects.toThrow("support:repair");
    expect(prompt).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
  });
  it("rechecks permissions after approval and prevents changes to the displayed proposal", async () => {
    const { dispatcher, call } = setup();
    const params = { script: "original" };
    await dispatcher.executeTool("support:repair", params, run, { requestUserConfirmation: async (_name, displayed) => {
      expect(displayed).toEqual(params);
      params.script = "different";
      (displayed as typeof params).script = "also different";
      return true;
    } });
    expect(call.mock.calls[0][2]).toMatchObject({ parameters: { script: "original" }, runContext: { userConfirmed: true, userPermission: "support:repair", userId: "user-a" } });
    expect(access.hasPermission).toHaveBeenLastCalledWith("company-a", "user", "user-a", "support:repair");
    call.mockClear();
    await expect(dispatcher.executeTool("support:repair", {}, run, { requestUserConfirmation: async () => { access.hasPermission.mockResolvedValue(false); return true; } })).rejects.toThrow("support:repair");
    expect(call).not.toHaveBeenCalled();
  });
  it("denial never dispatches; ordinary tools cannot carry forged host stamps", async () => {
    const { dispatcher, call } = setup();
    await dispatcher.executeTool("support:repair", {}, run, { requestUserConfirmation: async () => false });
    expect(call).not.toHaveBeenCalled();
    await dispatcher.executeTool("support:ordinary", {}, { ...run, userConfirmed: true, userPermission: "support:repair" });
    expect(call.mock.calls[0][2].runContext).toMatchObject({ userConfirmed: false, userPermission: undefined });
  });
  it("permits explicit company grants and trusted local operator but not a forged local user name", async () => {
    const { dispatcher, call } = setup();
    await dispatcher.executeTool("support:diagnose", {}, run);
    expect(call.mock.calls[0][2].runContext.userPermission).toBe("support:diagnose");
    access.getMembership.mockResolvedValue(null);
    await expect(dispatcher.executeTool("support:diagnose", {}, { ...run, userId: "local-board" })).rejects.toThrow();
    await dispatcher.executeTool("support:diagnose", {}, { ...run, userId: "local-board" }, { localTrustedUser: true });
    access.isInstanceAdmin.mockResolvedValue(true);
    await dispatcher.executeTool("support:diagnose", {}, run);
    expect(call).toHaveBeenCalledTimes(3);
  });
  it("drops a hostScope an agent puts in its parameters, so it cannot pose as an instance admin", async () => {
    // hostScope is the host's stamp on a call from a plugin's own page, and a
    // plugin may act on hostScope.isInstanceAdmin. An agent's parameters are
    // its own.
    const { dispatcher, call } = setup();
    const agentRun: ToolRunContext = { companyId: "company-a", agentId: "agent-1", runId: "run-1", userId: null };
    await dispatcher.executeTool(
      "support:ordinary",
      { note: "kept", hostScope: { companyId: "company-a", userId: "admin-1", isInstanceAdmin: true } },
      agentRun,
    );
    expect(call.mock.calls[0][2].parameters).toEqual({ note: "kept" });
  });
});

describe("external MCP action preflight", () => {
  function setupExternal(
    server: Record<string, unknown> | null,
    toolName = "post_comment",
    mutationHint = false,
  ) {
    const policy = {
      actionType: "post_publicly",
      mode: "go_ahead",
      source: "company",
    } as const;
    const draftGate: DraftGate = {
      isGated: () => true,
      resolveActionPolicy: vi.fn().mockResolvedValue(policy),
      intercept: vi.fn().mockResolvedValue({ intercepted: false, actionPolicy: policy }),
    };
    const manager = {
      getServerByKey: vi.fn().mockResolvedValue(server),
      callTool: vi.fn().mockResolvedValue({ content: [], isError: false }),
    };
    const dispatcher = createPluginToolDispatcher({
      db: {} as never,
      draftGate,
      externalMcpToolSource: {
        parseNamespacedName: vi.fn().mockReturnValue({ serverKey: "social", toolName }),
        listToolsForCompany: vi.fn().mockResolvedValue([{
          namespacedName: `mcp:social:${toolName}`,
          mutationHint,
        }]),
      } as never,
      externalMcpServerManager: manager as never,
    });
    return { dispatcher, draftGate, manager };
  }

  it("audits an opaque external action when policy resolution fails", async () => {
    const draftGate: DraftGate = {
      isGated: () => true,
      resolveActionPolicy: vi.fn().mockRejectedValue(new Error("policy store unavailable")),
      intercept: vi.fn(),
    };
    const manager = {
      getServerByKey: vi.fn(),
      callTool: vi.fn(),
    };
    const dispatcher = createPluginToolDispatcher({
      db: {} as never,
      draftGate,
      externalMcpToolSource: {
        parseNamespacedName: vi.fn(),
        listToolsForCompany: vi.fn(),
      } as never,
      externalMcpServerManager: manager as never,
    });

    await expect(dispatcher.executeTool(
      "mcp:vendor:process",
      {},
      { ...run, agentId: "agent-1" },
    )).rejects.toThrow("policy store unavailable");

    expect(manager.getServerByKey).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent_action.failed",
      details: expect.objectContaining({ actionType: null, policySource: "unclassified" }),
    }));
  });

  it("refuses unauthorized servers before creating an approval", async () => {
    const { dispatcher, draftGate, manager } = setupExternal({
      id: "server-1",
      key: "social",
      allowedCompanies: ["company-b"],
      allowMutations: true,
      writeAllowList: [],
      toolAllowList: [],
      toolDenyList: [],
    });

    await expect(
      dispatcher.executeTool("mcp:social:post_comment", {}, { ...run, agentId: "agent-1" }),
    ).rejects.toThrow("ECOMPANY_NOT_ALLOWED");

    expect(draftGate.intercept).not.toHaveBeenCalled();
    expect(manager.callTool).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent_action.refused",
      details: expect.objectContaining({ actionType: "post_publicly" }),
    }));
  });

  it("logs missing external servers as failed before creating an approval", async () => {
    const { dispatcher, draftGate, manager } = setupExternal(null);

    await expect(
      dispatcher.executeTool("mcp:social:post_comment", {}, { ...run, agentId: "agent-1" }),
    ).rejects.toThrow('MCP server "social" not found');

    expect(draftGate.intercept).not.toHaveBeenCalled();
    expect(manager.callTool).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent_action.failed",
      details: expect.objectContaining({ actionType: "post_publicly" }),
    }));
  });

  it("refuses an exact mutation verb when external mutations are disabled", async () => {
    const { dispatcher, draftGate, manager } = setupExternal({
      id: "server-1",
      key: "social",
      allowedCompanies: ["company-a"],
      allowMutations: false,
      writeAllowList: [],
      toolAllowList: [],
      toolDenyList: [],
    }, "publish");

    await expect(
      dispatcher.executeTool("mcp:social:publish", {}, { ...run, agentId: "agent-1" }),
    ).rejects.toThrow("EDISABLED");

    expect(draftGate.intercept).not.toHaveBeenCalled();
    expect(manager.callTool).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent_action.refused",
      details: expect.objectContaining({ actionType: "post_publicly" }),
    }));
  });

  it("refuses a neutral mutation annotation before creating an approval", async () => {
    const { dispatcher, draftGate, manager } = setupExternal({
      id: "server-1",
      key: "social",
      allowedCompanies: ["company-a"],
      allowMutations: false,
      writeAllowList: [],
      toolAllowList: [],
      toolDenyList: [],
    }, "process", true);

    await expect(
      dispatcher.executeTool("mcp:social:process", {}, { ...run, agentId: "agent-1" }),
    ).rejects.toThrow("EDISABLED");

    expect(draftGate.intercept).not.toHaveBeenCalled();
    expect(manager.callTool).not.toHaveBeenCalled();
  });

  it("audits a manager-discovered mutation when preflight discovery was unavailable", async () => {
    const draftGate: DraftGate = {
      isGated: () => true,
      resolveActionPolicy: vi.fn().mockResolvedValue(null),
      intercept: vi.fn().mockResolvedValue({ intercepted: false, actionPolicy: null }),
    };
    const manager = {
      getServerByKey: vi.fn().mockResolvedValue({
        id: "server-1",
        key: "social",
        allowedCompanies: ["company-a"],
        allowMutations: false,
        writeAllowList: [],
        toolAllowList: [],
        toolDenyList: [],
      }),
      callTool: vi.fn().mockRejectedValue(new Error("[EDISABLED] Mutations are disabled")),
    };
    const dispatcher = createPluginToolDispatcher({
      db: {} as never,
      draftGate,
      externalMcpToolSource: {
        parseNamespacedName: vi.fn().mockReturnValue({ serverKey: "social", toolName: "process" }),
        listToolsForCompany: vi.fn().mockResolvedValue([]),
      } as never,
      externalMcpServerManager: manager as never,
    });

    await expect(
      dispatcher.executeTool("mcp:social:process", {}, { ...run, agentId: "agent-1" }),
    ).rejects.toThrow("EDISABLED");

    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent_action.refused",
      details: expect.objectContaining({ actionType: "post_publicly", policySource: "unclassified" }),
    }));
  });

  it("asks first when external discovery misses an opaque tool and mutations are enabled", async () => {
    const policy = {
      actionType: null,
      mode: "ask_first",
      source: "unclassified",
    } as const;
    const intercept = vi.fn().mockImplementation(async (
      _name: string,
      _parameters: unknown,
      _runContext: ToolRunContext,
      options: { resolvedActionPolicy: typeof policy },
    ) => ({
      intercepted: true,
      actionPolicy: options.resolvedActionPolicy,
      result: { content: "Approval requested" },
    }));
    const draftGate: DraftGate = {
      isGated: () => true,
      resolveActionPolicy: vi.fn().mockResolvedValue(null),
      intercept,
    };
    const manager = {
      getServerByKey: vi.fn().mockResolvedValue({
        id: "server-1",
        key: "vendor",
        allowedCompanies: ["company-a"],
        allowMutations: true,
        writeAllowList: [],
        toolAllowList: [],
        toolDenyList: [],
      }),
      callTool: vi.fn().mockResolvedValue({ content: [], isError: false }),
    };
    const listToolsForCompany = vi.fn().mockResolvedValue([]);
    const dispatcher = createPluginToolDispatcher({
      db: {} as never,
      draftGate,
      externalMcpToolSource: {
        parseNamespacedName: vi.fn().mockReturnValue({
          serverKey: "vendor",
          toolName: "process_order",
        }),
        listToolsForCompany,
      } as never,
      externalMcpServerManager: manager as never,
    });

    await expect(
      dispatcher.executeTool(
        "mcp:vendor:process_order",
        {},
        { ...run, agentId: "agent-1" },
      ),
    ).resolves.toEqual(expect.objectContaining({
      result: expect.objectContaining({ content: "Approval requested" }),
    }));

    expect(listToolsForCompany).toHaveBeenCalledWith("company-a");
    expect(intercept).toHaveBeenCalledWith(
      "mcp:vendor:process_order",
      {},
      expect.objectContaining({ agentId: "agent-1" }),
      expect.objectContaining({ resolvedActionPolicy: policy }),
    );
    expect(manager.callTool).not.toHaveBeenCalled();
  });

  it("leaves terminal audit ownership to an approved draft replay", async () => {
    const { dispatcher, manager } = setupExternal({
      id: "server-1",
      key: "social",
      allowedCompanies: ["company-a"],
      allowMutations: true,
      writeAllowList: [],
      toolAllowList: [],
      toolDenyList: [],
    }, "process", true);
    manager.callTool.mockRejectedValue(new Error(
      '[EDISABLED] mutation tool "process" is gated by allowMutations on server "social"',
    ));

    await expect(dispatcher.executeTool(
      "mcp:social:process",
      {},
      { ...run, agentId: "agent-1" },
      { bypassDraftGate: true },
    )).rejects.toThrow("EDISABLED");

    expect(logActivity).not.toHaveBeenCalled();
  });
});
