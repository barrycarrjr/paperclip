import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

// Only the model is a stand-in, so a draft starts no program and calls no API.
vi.mock("../services/chat-providers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/chat-providers.js")>();
  const standIn = {
    name: "adapter" as const,
    isConfigured: () => true,
    supportsModel: () => true,
    defaultModel: () => "",
    listModels: () => [],
    async *streamTurn() {
      yield { type: "text_delta" as const, delta: "Thanks, the invoice is paid." };
      return {
        content: [{ type: "text" as const, text: "Thanks, the invoice is paid." }],
        stopReason: "end_turn" as const,
      };
    },
  };
  return { ...actual, getProviderForModel: () => standIn };
});

const { emailDraftRoutes } = await import("../routes/email-drafts.js");
const { errorHandler } = await import("../middleware/index.js");

const SERVER_MODEL = "adapter:claude_local:claude-opus-5-5";

function createApp(isInstanceAdmin: boolean) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "user-1",
      source: "session",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "member", status: "active" }],
      isInstanceAdmin,
    };
    next();
  });
  app.use("/api", emailDraftRoutes());
  app.use(errorHandler);
  return app;
}

const body = { subject: "Invoice", from: "a@example.com", bodyText: "Is it paid?", model: SERVER_MODEL };

describe("email drafts on a model that runs on this server", () => {
  it("are refused to anyone but an instance admin, as in Clippy", async () => {
    const res = await request(createApp(false)).post("/api/email-drafts/reply").send(body);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only instance admins can use models that run on this server.");
  });

  it("still work for an instance admin", async () => {
    const res = await request(createApp(true)).post("/api/email-drafts/reply").send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ draft: "Thanks, the invoice is paid.", model: SERVER_MODEL });
  });
});
