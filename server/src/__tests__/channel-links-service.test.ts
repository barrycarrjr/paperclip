import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authUsers, channelUserLinks, createDb, plugins } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  CHANNEL_PAIRING_CODE_TTL_MS,
  CHANNEL_PAIRING_MAX_FAILED_CLAIMS,
  channelLinkService,
  normalizePairingCode,
  resetChannelPairingStateForTests,
} from "../services/channel-links.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const SLACK_PAT = { workspace: "T0001", externalUserId: "U0TESTUSR01" };

describe("pairing codes", () => {
  it("accept any case and separators", () => {
    expect(normalizePairingCode("k7qf-3mzd")).toBe("K7QF3MZD");
    expect(normalizePairingCode(" K7QF 3MZD ")).toBe("K7QF3MZD");
  });
});

describeEmbeddedPostgres("channel link service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let clock = Date.parse("2026-10-09T10:00:00.000Z");
  const now = () => clock;

  async function createUser(name: string) {
    const id = `user-${randomUUID()}`;
    await db.insert(authUsers).values({
      id,
      name,
      email: `${id}@example.com`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  }

  async function createPlugin(pluginKey: string, displayName: string) {
    return db
      .insert(plugins)
      .values({
        pluginKey: `${pluginKey}-${randomUUID().slice(0, 8)}`,
        packageName: pluginKey,
        version: "1.0.0",
        manifestJson: { id: pluginKey, displayName } as never,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-channel-links-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  beforeEach(() => {
    clock = Date.parse("2026-10-09T10:00:00.000Z");
    resetChannelPairingStateForTests();
  });

  afterEach(async () => {
    await db.delete(channelUserLinks);
    await db.delete(plugins);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("pairs a chat account to the user who enters its code, and only for that plugin", async () => {
    const links = channelLinkService(db, { now });
    const slack = await createPlugin("slack-tools", "Slack");
    const other = await createPlugin("teams-tools", "Teams");
    const pat = await createUser("Pat");

    const { code } = links.startPairing({ pluginId: slack.id, identity: SLACK_PAT, label: "Pat" });
    const preview = await links.previewPairing(pat, code.toLowerCase());
    expect(preview).toMatchObject({ pluginName: "Slack", externalUserId: "U0TESTUSR01", externalLabel: "Pat" });
    // Looking at a code does not connect anything.
    expect(await links.resolveUserId(slack.id, SLACK_PAT)).toBeNull();

    const { link, replacedUserId } = await links.claimPairing(pat, code);
    expect(replacedUserId).toBeNull();
    expect(link).toMatchObject({ pluginName: "Slack", externalWorkspace: "T0001", externalUserId: "U0TESTUSR01" });
    expect(await links.resolveUserId(slack.id, SLACK_PAT)).toBe(pat);
    // Another plugin cannot use a pairing it did not make.
    expect(await links.resolveUserId(other.id, SLACK_PAT)).toBeNull();
    // The code is single use.
    await expect(links.claimPairing(pat, code)).rejects.toThrow("not valid or has expired");

    expect(await links.listForUser(pat)).toHaveLength(1);
  });

  it("stops accepting a code after ten minutes, and when the account asks for a newer one", async () => {
    const links = channelLinkService(db, { now });
    const slack = await createPlugin("slack-tools", "Slack");
    const pat = await createUser("Pat");

    const first = links.startPairing({ pluginId: slack.id, identity: SLACK_PAT });
    const second = links.startPairing({ pluginId: slack.id, identity: SLACK_PAT });
    await expect(links.previewPairing(pat, first.code)).rejects.toThrow("not valid or has expired");

    clock += CHANNEL_PAIRING_CODE_TTL_MS + 1;
    await expect(links.claimPairing(pat, second.code)).rejects.toThrow("not valid or has expired");
    expect(await links.resolveUserId(slack.id, SLACK_PAT)).toBeNull();
  });

  it("pauses code entry after too many wrong codes", async () => {
    const links = channelLinkService(db, { now });
    const slack = await createPlugin("slack-tools", "Slack");
    const pat = await createUser("Pat");
    const { code } = links.startPairing({ pluginId: slack.id, identity: SLACK_PAT });

    for (let i = 0; i < CHANNEL_PAIRING_MAX_FAILED_CLAIMS; i += 1) {
      await expect(links.claimPairing(pat, "AAAA-AAAA")).rejects.toThrow("not valid or has expired");
    }
    // Even the right code is refused until the pause ends.
    await expect(links.claimPairing(pat, code)).rejects.toThrow("Too many wrong codes");
  });

  it("moves a chat account to whoever enters a newer code from it", async () => {
    const links = channelLinkService(db, { now });
    const slack = await createPlugin("slack-tools", "Slack");
    const pat = await createUser("Pat");
    const alex = await createUser("Alex");

    await links.claimPairing(pat, links.startPairing({ pluginId: slack.id, identity: SLACK_PAT }).code);
    const { replacedUserId } = await links.claimPairing(
      alex,
      links.startPairing({ pluginId: slack.id, identity: SLACK_PAT }).code,
    );

    expect(replacedUserId).toBe(pat);
    expect(await links.resolveUserId(slack.id, SLACK_PAT)).toBe(alex);
    expect(await links.listForUser(pat)).toHaveLength(0);
  });

  it("lets a user disconnect only their own accounts", async () => {
    const links = channelLinkService(db, { now });
    const slack = await createPlugin("slack-tools", "Slack");
    const pat = await createUser("Pat");
    const alex = await createUser("Alex");
    const { link } = await links.claimPairing(pat, links.startPairing({ pluginId: slack.id, identity: SLACK_PAT }).code);

    expect(await links.removeForUser(alex, link.id)).toBe(false);
    expect(await links.resolveUserId(slack.id, SLACK_PAT)).toBe(pat);
    expect(await links.removeForUser(pat, link.id)).toBe(true);
    expect(await links.resolveUserId(slack.id, SLACK_PAT)).toBeNull();
  });

  it("refuses an identity without a chat user id", () => {
    const links = channelLinkService(db, { now });
    expect(() => links.startPairing({ pluginId: randomUUID(), identity: { workspace: "T0001", externalUserId: " " } })).toThrow(
      "identity.externalUserId is required",
    );
  });
});
