/**
 * Images sent with a channel plugin's chat turn, through the real host
 * services and database: the paired user's conversation gets them as
 * attachments, and the model is handed them with the message, exactly as an
 * image attached in the app's chat composer. Only the model is a fake.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authUsers,
  channelUserLinks,
  chatAttachments,
  chatMessages,
  companies,
  companyMemberships,
  createDb,
  plugins,
} from "@paperclipai/db";
import { resolveClippyAttachmentDir } from "../home-paths.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/** What the model was handed on each turn. */
const modelTurns = vi.hoisted(
  () => [] as Array<{ resolved: Map<string, { data: Buffer; mediaType: string; name: string }> }>,
);

vi.mock("../services/chat-providers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/chat-providers.js")>();
  const model = {
    name: "anthropic" as const,
    isConfigured: () => true,
    supportsModel: () => true,
    defaultModel: () => "test-vision-model",
    listModels: () => ["test-vision-model"],
    async *streamTurn(input: { resolvedAttachments?: Map<string, { data: Buffer; mediaType: string; name: string }> }) {
      modelTurns.push({ resolved: input.resolvedAttachments ?? new Map() });
      yield { type: "text_delta" as const, delta: "A sign-in error." };
      return { content: [{ type: "text" as const, text: "A sign-in error." }], stopReason: "end_turn" as const };
    },
  };
  return {
    ...actual,
    // Any other model is one no provider supports, like a retired one.
    getProviderForModel: (id: string) => (id === "test-vision-model" ? model : null),
    listAvailableModels: async () => [],
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping chat turn image tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const PAT_SLACK = { workspace: "main", externalUserId: "U0TESTUSR01" };

function createEventBusStub() {
  return {
    forPlugin() {
      return { emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() };
    },
  } as never;
}

describeEmbeddedPostgres("chat.turn images through the host", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home = "";
  const previousHome = process.env.PAPERCLIP_HOME;

  beforeAll(async () => {
    // Attachments are written under the instance home: keep them out of the real one.
    home = await mkdtemp(path.join(os.tmpdir(), "paperclip-chat-turn-images-"));
    process.env.PAPERCLIP_HOME = home;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-chat-turn-images-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  /** Pat, an owner of one company, with a Slack account paired to the plugin. */
  async function seedPairedUser() {
    const userId = `user-${randomUUID()}`;
    await db.insert(authUsers).values({
      id: userId,
      name: "Pat",
      email: `${userId}@example.com`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Headquarters",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      membershipRole: "owner",
      status: "active",
    });
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: `slack-tools-${pluginId.slice(0, 8)}`,
      packageName: "paperclip-plugin-slack-tools",
      version: "0.6.1",
      apiVersion: 1,
      categories: ["connector"],
      manifestJson: {
        id: "slack-tools",
        apiVersion: 1,
        version: "0.6.1",
        displayName: "Slack Tools",
        description: "Test plugin",
        author: "Paperclip",
        categories: ["connector"],
        capabilities: ["channels.pairing", "chat.turn"],
        entrypoints: { worker: "./dist/worker.js" },
      },
      status: "ready",
      installOrder: 1,
    });
    await db.insert(channelUserLinks).values({
      pluginId,
      userId,
      externalWorkspace: PAT_SLACK.workspace,
      externalUserId: PAT_SLACK.externalUserId,
    });
    return { userId, companyId, pluginId };
  }

  it("stores the image with the paired user's conversation and hands it to the model with the message", async () => {
    const { userId, companyId, pluginId } = await seedPairedUser();
    const services = buildHostServices(db, pluginId, "slack-tools", createEventBusStub());

    const result = await services.chat.turn({
      identity: PAT_SLACK,
      companyId,
      model: "test-vision-model",
      text: "what is this error?",
      images: [{ name: "screenshot.png", mediaType: "image/png", base64: PNG.toString("base64") }],
    });

    expect(result).toMatchObject({ replyText: "A sign-in error.", error: null, skippedImages: [] });
    const stored = await db.select().from(chatAttachments).where(eq(chatAttachments.sessionId, result.sessionId));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      boardUserId: userId,
      kind: "image",
      mediaType: "image/png",
      name: "screenshot.png",
      sizeBytes: PNG.length,
    });
    expect(stored[0]!.storagePath.startsWith(home)).toBe(true);
    expect((await readFile(stored[0]!.storagePath)).equals(PNG)).toBe(true);

    // The message carries the image the way one sent from the app's composer does.
    const [message] = await db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.sessionId, result.sessionId), eq(chatMessages.role, "user")));
    expect(message?.content).toEqual([
      { type: "text", text: "what is this error?" },
      {
        type: "image",
        attachmentId: stored[0]!.id,
        url: `/api/chat/attachments/${stored[0]!.id}/content`,
        mediaType: "image/png",
        name: "screenshot.png",
      },
    ]);
    // And the model is handed its bytes.
    expect(modelTurns.at(-1)?.resolved.get(stored[0]!.id)?.data.equals(PNG)).toBe(true);
  });

  it("removes the image again when the turn stops before saving the message", async () => {
    const { companyId, pluginId } = await seedPairedUser();
    const services = buildHostServices(db, pluginId, "slack-tools", createEventBusStub());

    const result = await services.chat.turn({
      identity: PAT_SLACK,
      companyId,
      model: "retired-model",
      text: "what is this error?",
      images: [{ name: "screenshot.png", mediaType: "image/png", base64: PNG.toString("base64") }],
    });

    expect(result.error).toContain('No provider supports model "retired-model"');
    expect(result.skippedImages).toEqual([
      { name: "screenshot.png", reason: "The turn stopped before the message was saved, so the image was not kept." },
    ]);
    expect(await db.select().from(chatAttachments).where(eq(chatAttachments.sessionId, result.sessionId))).toEqual([]);
    const dir = resolveClippyAttachmentDir(result.sessionId);
    expect(dir.startsWith(home)).toBe(true);
    expect(existsSync(dir) ? await readdir(dir) : []).toEqual([]);
  });
});
