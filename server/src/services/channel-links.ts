/**
 * Pairing chat app accounts (a Slack user, for example) to Paperclip users.
 *
 * The flow, end to end:
 * 1. Someone messages a channel plugin's bot. The plugin does not know them,
 *    so it asks the host for a pairing code for that chat account and sends
 *    the code back to them in the chat.
 * 2. They sign in to Paperclip and enter the code in their profile. The
 *    profile shows which chat account the code belongs to before they
 *    confirm.
 * 3. The host links that chat account to the signed-in user. From then on the
 *    plugin hands the host the chat account's identity and the host looks up
 *    the user; the plugin itself can never name a user.
 *
 * Entering the code proves the same person controls both accounts: the code
 * only ever reached that chat account, and only a signed-in user can enter it.
 *
 * Codes live in memory for ten minutes. A server restart drops the pending
 * ones, and the person just asks the bot again.
 */
import { randomInt } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { channelUserLinks, plugins } from "@paperclipai/db";
import type { ChannelPairingPreview, ChannelUserLink } from "@paperclipai/shared";
import { badRequest, HttpError, notFound } from "../errors.js";

export const CHANNEL_PAIRING_CODE_TTL_MS = 10 * 60_000;
/** Wrong codes a user may enter in a row before entry is paused. */
export const CHANNEL_PAIRING_MAX_FAILED_CLAIMS = 10;
export const CHANNEL_PAIRING_FAILED_CLAIM_WINDOW_MS = 10 * 60_000;

// No 0/O or 1/I, so a code read off a phone cannot be mistyped that way.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const MAX_IDENTITY_PART_LENGTH = 200;
const MAX_LABEL_LENGTH = 200;

export interface ChannelIdentity {
  /** The chat app's workspace or team id; null when the app has none. */
  workspace: string | null;
  /** The chat app's own id for the person. */
  externalUserId: string;
}

interface NormalizedIdentity {
  workspace: string;
  externalUserId: string;
}

interface PendingPairing {
  code: string;
  pluginId: string;
  identity: NormalizedIdentity;
  label: string | null;
  expiresAt: number;
}

// One store for the process: the plugin host services (one per plugin) start
// pairings and the profile routes finish them.
const pendingByCode = new Map<string, PendingPairing>();
const failedClaimsByUser = new Map<string, { count: number; windowStartedAt: number }>();

/** Throws when the identity is missing or unusable; returns it trimmed. */
export function normalizeChannelIdentity(identity: unknown): NormalizedIdentity {
  const record = identity && typeof identity === "object" ? (identity as Record<string, unknown>) : null;
  const externalUserId = typeof record?.externalUserId === "string" ? record.externalUserId.trim() : "";
  const workspace = typeof record?.workspace === "string" ? record.workspace.trim() : "";
  if (!externalUserId) throw new Error("identity.externalUserId is required");
  if (externalUserId.length > MAX_IDENTITY_PART_LENGTH || workspace.length > MAX_IDENTITY_PART_LENGTH) {
    throw new Error("identity is too long");
  }
  return { workspace, externalUserId };
}

/** Upper case, separators dropped: "k7qf-3mzd" and "K7QF 3MZD" are the same code. */
export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function generateCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

function sameIdentity(a: NormalizedIdentity, b: NormalizedIdentity) {
  return a.workspace === b.workspace && a.externalUserId === b.externalUserId;
}

function pluginDisplayName(row: { pluginKey: string; manifestJson: unknown }): string {
  const manifest = row.manifestJson as { displayName?: unknown } | null;
  return typeof manifest?.displayName === "string" && manifest.displayName.trim()
    ? manifest.displayName.trim()
    : row.pluginKey;
}

export function channelLinkService(db: Db, options: { now?: () => number } = {}) {
  const now = options.now ?? (() => Date.now());

  function purgeExpired() {
    const at = now();
    for (const [code, pending] of pendingByCode) {
      if (pending.expiresAt <= at) pendingByCode.delete(code);
    }
  }

  /**
   * A fresh code for this chat account. Any earlier code the same account was
   * given stops working, so only the latest message's code can be used.
   */
  function startPairing(input: { pluginId: string; identity: ChannelIdentity; label?: string | null }) {
    const identity = normalizeChannelIdentity(input.identity);
    purgeExpired();
    for (const [code, pending] of pendingByCode) {
      if (pending.pluginId === input.pluginId && sameIdentity(pending.identity, identity)) {
        pendingByCode.delete(code);
      }
    }
    let code = generateCode();
    while (pendingByCode.has(code)) code = generateCode();
    const label = typeof input.label === "string" && input.label.trim()
      ? input.label.trim().slice(0, MAX_LABEL_LENGTH)
      : null;
    const expiresAt = now() + CHANNEL_PAIRING_CODE_TTL_MS;
    pendingByCode.set(code, { code, pluginId: input.pluginId, identity, label, expiresAt });
    return { code: formatPairingCode(code), expiresAt: new Date(expiresAt).toISOString() };
  }

  function assertClaimAllowed(userId: string) {
    const entry = failedClaimsByUser.get(userId);
    if (!entry) return;
    if (now() - entry.windowStartedAt > CHANNEL_PAIRING_FAILED_CLAIM_WINDOW_MS) {
      failedClaimsByUser.delete(userId);
      return;
    }
    if (entry.count >= CHANNEL_PAIRING_MAX_FAILED_CLAIMS) {
      throw new HttpError(429, "Too many wrong codes. Wait ten minutes, then ask the chat app for a new code.");
    }
  }

  function recordFailedClaim(userId: string) {
    const entry = failedClaimsByUser.get(userId);
    if (!entry || now() - entry.windowStartedAt > CHANNEL_PAIRING_FAILED_CLAIM_WINDOW_MS) {
      failedClaimsByUser.set(userId, { count: 1, windowStartedAt: now() });
    } else {
      entry.count += 1;
    }
  }

  function findPending(userId: string, rawCode: string): PendingPairing {
    assertClaimAllowed(userId);
    purgeExpired();
    const pending = pendingByCode.get(normalizePairingCode(rawCode));
    if (!pending) {
      recordFailedClaim(userId);
      throw notFound("That code is not valid or has expired. Send the chat app another message to get a new one.");
    }
    return pending;
  }

  async function loadPlugin(pluginId: string) {
    const row = await db
      .select({ id: plugins.id, pluginKey: plugins.pluginKey, manifestJson: plugins.manifestJson })
      .from(plugins)
      .where(eq(plugins.id, pluginId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("The chat app that issued this code is no longer installed.");
    return row;
  }

  /** What the code would connect, without connecting it. */
  async function previewPairing(userId: string, rawCode: string): Promise<ChannelPairingPreview> {
    const pending = findPending(userId, rawCode);
    const plugin = await loadPlugin(pending.pluginId);
    return {
      pluginKey: plugin.pluginKey,
      pluginName: pluginDisplayName(plugin),
      externalWorkspace: pending.identity.workspace,
      externalUserId: pending.identity.externalUserId,
      externalLabel: pending.label,
      expiresAt: new Date(pending.expiresAt).toISOString(),
    };
  }

  /**
   * Connect the code's chat account to this user. A chat account belongs to
   * one user at a time, so pairing it again (from a fresh code that reached
   * that same account) moves it to whoever entered the new code.
   */
  async function claimPairing(userId: string, rawCode: string): Promise<{ link: ChannelUserLink; replacedUserId: string | null }> {
    const pending = findPending(userId, rawCode);
    const plugin = await loadPlugin(pending.pluginId);
    pendingByCode.delete(pending.code);
    failedClaimsByUser.delete(userId);

    const existing = await db
      .select({ userId: channelUserLinks.userId })
      .from(channelUserLinks)
      .where(
        and(
          eq(channelUserLinks.pluginId, pending.pluginId),
          eq(channelUserLinks.externalWorkspace, pending.identity.workspace),
          eq(channelUserLinks.externalUserId, pending.identity.externalUserId),
        ),
      )
      .then((rows) => rows[0] ?? null);

    const row = await db
      .insert(channelUserLinks)
      .values({
        pluginId: pending.pluginId,
        userId,
        externalWorkspace: pending.identity.workspace,
        externalUserId: pending.identity.externalUserId,
        externalLabel: pending.label,
      })
      .onConflictDoUpdate({
        target: [channelUserLinks.pluginId, channelUserLinks.externalWorkspace, channelUserLinks.externalUserId],
        set: { userId, externalLabel: pending.label, createdAt: new Date(), lastUsedAt: null },
      })
      .returning()
      .then((rows) => rows[0]!);

    return {
      link: toLink(row, plugin),
      replacedUserId: existing && existing.userId !== userId ? existing.userId : null,
    };
  }

  /** The user this plugin's chat account is paired to, or null. */
  async function resolveUserId(pluginId: string, identity: ChannelIdentity): Promise<string | null> {
    const normalized = normalizeChannelIdentity(identity);
    const row = await db
      .select({ id: channelUserLinks.id, userId: channelUserLinks.userId })
      .from(channelUserLinks)
      .where(
        and(
          eq(channelUserLinks.pluginId, pluginId),
          eq(channelUserLinks.externalWorkspace, normalized.workspace),
          eq(channelUserLinks.externalUserId, normalized.externalUserId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    await db
      .update(channelUserLinks)
      .set({ lastUsedAt: new Date() })
      .where(eq(channelUserLinks.id, row.id));
    return row.userId;
  }

  async function listForUser(userId: string): Promise<ChannelUserLink[]> {
    const rows = await db
      .select({
        link: channelUserLinks,
        pluginKey: plugins.pluginKey,
        manifestJson: plugins.manifestJson,
      })
      .from(channelUserLinks)
      .innerJoin(plugins, eq(plugins.id, channelUserLinks.pluginId))
      .where(eq(channelUserLinks.userId, userId))
      .orderBy(asc(channelUserLinks.createdAt));
    return rows.map((row) => toLink(row.link, row));
  }

  async function removeForUser(userId: string, linkId: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(linkId)) throw badRequest("Unknown connection id");
    const deleted = await db
      .delete(channelUserLinks)
      .where(and(eq(channelUserLinks.id, linkId), eq(channelUserLinks.userId, userId)))
      .returning({ id: channelUserLinks.id });
    return deleted.length > 0;
  }

  return { startPairing, previewPairing, claimPairing, resolveUserId, listForUser, removeForUser };
}

function toLink(
  row: typeof channelUserLinks.$inferSelect,
  plugin: { pluginKey: string; manifestJson: unknown },
): ChannelUserLink {
  return {
    id: row.id,
    pluginKey: plugin.pluginKey,
    pluginName: pluginDisplayName(plugin),
    externalWorkspace: row.externalWorkspace,
    externalUserId: row.externalUserId,
    externalLabel: row.externalLabel ?? null,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}

/** Test hook: forget every pending code and failed-entry count. */
export function resetChannelPairingStateForTests() {
  pendingByCode.clear();
  failedClaimsByUser.clear();
}
