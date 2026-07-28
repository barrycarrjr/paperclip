import { beforeEach, describe, expect, it, vi } from "vitest";

const bridgePerformAction = vi.fn();
const bridgeGetData = vi.fn();

vi.mock("./plugins", () => ({
  pluginsApi: {
    bridgePerformAction: (...args: unknown[]) => bridgePerformAction(...args),
    bridgeGetData: (...args: unknown[]) => bridgeGetData(...args),
  },
}));

const { makeHelpScoutBridgeApi } = await import("./helpScoutBridge");

beforeEach(() => {
  bridgePerformAction.mockReset();
  bridgeGetData.mockReset();
});

describe("createConversation", () => {
  it("sends the shape the plugin action expects", async () => {
    bridgePerformAction.mockResolvedValue({ data: { ok: true, id: "2913724936" } });
    const api = makeHelpScoutBridgeApi("plug-1", "co-1");

    const result = await api.createConversation("support", {
      mailboxId: "42",
      to: "customer@example.com",
      subject: "Your order",
      body: "It ships Tuesday.",
    });

    expect(result).toEqual({ ok: true, id: "2913724936" });
    const [pluginId, action, params, companyId] = bridgePerformAction.mock.calls[0];
    expect(pluginId).toBe("plug-1");
    expect(action).toBe("helpscout.create-conversation");
    expect(companyId).toBe("co-1");
    expect(params).toEqual({
      companyId: "co-1",
      accountKey: "support",
      mailboxId: "42",
      subject: "Your order",
      body: "It ships Tuesday.",
      // The plugin wants the recipient nested under `customer`, not a flat `to`.
      customer: {
        email: "customer@example.com",
        firstName: undefined,
        lastName: undefined,
      },
    });
  });

  it("passes the customer name through when we have one", async () => {
    bridgePerformAction.mockResolvedValue({ data: { ok: true, id: null } });
    const api = makeHelpScoutBridgeApi("plug-1", "co-1");

    await api.createConversation("support", {
      to: "customer@example.com",
      subject: "Hi",
      body: "Hello",
      firstName: "Ada",
      lastName: "Lovelace",
    });

    const params = bridgePerformAction.mock.calls[0][2] as { customer: unknown };
    expect(params.customer).toEqual({
      email: "customer@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
    });
  });

  it("surfaces a null id when Help Scout gave us no location header", async () => {
    bridgePerformAction.mockResolvedValue({ data: { ok: true, id: null } });
    const api = makeHelpScoutBridgeApi("plug-1", "co-1");

    const result = await api.createConversation("support", {
      to: "a@b.com",
      subject: "s",
      body: "b",
    });

    expect(result.id).toBeNull();
  });
});
