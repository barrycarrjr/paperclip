import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
const access = vi.hoisted(() => ({ isInstanceAdmin: vi.fn(), getMembership: vi.fn(), hasPermission: vi.fn() }));
vi.mock("../services/access.js", () => ({ accessService: () => access }));

const run: ToolRunContext = { companyId: "company-a", agentId: "", runId: "run-1", userId: "user-a", chatSessionId: "chat-a" };
function setup() {
  const call = vi.fn().mockResolvedValue({ data: { ok: true } });
  const dispatcher = createPluginToolDispatcher({ db: {} as never, workerManager: { isRunning: () => true, call } as never });
  dispatcher.registerPluginTools("support", { id: "support", tools: [
    { name: "repair", requiredUserPermission: "support:repair", requiresUserConfirmation: true, parametersSchema: { type: "object" } },
    { name: "diagnose", requiredUserPermission: "support:diagnose", parametersSchema: { type: "object" } },
    { name: "send", requiredUserPermission: "support:respond", requiresUserConfirmation: true, parametersSchema: { type: "object" } },
    { name: "ordinary", parametersSchema: { type: "object" } },
  ] } as PaperclipPluginManifestV1);
  return { dispatcher, call };
}
beforeEach(() => {
  vi.resetAllMocks();
  access.isInstanceAdmin.mockResolvedValue(false);
  access.getMembership.mockResolvedValue({ status: "active", membershipRole: "member" });
  access.hasPermission.mockResolvedValue(true);
});
describe("host-issued plugin permission and consent", () => {
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
});
