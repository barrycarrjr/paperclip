/**
 * The Claude subscriptions this machine can sign runs in with.
 *
 * Holds the account list and the routing state that
 * {@link ./claude-account-router.ts} decides over: which account is active,
 * when we last moved, and which accounts are known to have nothing left.
 *
 * Tokens are encrypted with the same `local_encrypted` provider the company
 * secrets service uses, so the file on disk holds ciphertext and the protection
 * is the master key, exactly as it is for a secret in the database. They are
 * deliberately NOT kept in the host environment: the one place a Claude token
 * already lives that way (the Windows user environment) is the subject of a
 * three-day outage recorded in adapters/registry.ts, and adding more of them
 * would multiply that failure while also requiring a terminal and a restart to
 * change anything.
 *
 * This is its own file rather than a key inside adapter-settings.json because
 * that file's reader falls back to defaults when its shape is unfamiliar, which
 * would silently discard the account list. A store holding credentials must not
 * have a "quietly reset itself" path.
 *
 * @module server/services/claude-accounts
 */

import fs from "node:fs";
import path from "node:path";
import { resolvePaperclipHomeDir } from "../home-paths.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import type { StoredSecretVersionMaterial } from "../secrets/types.js";
import {
  EMPTY_CLAUDE_ACCOUNT_STATE,
  type ClaudeAccountSlot,
  type ClaudeAccountState,
} from "./claude-account-router.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ service: "claude-accounts" });

/** One account as it sits on disk. The token is never stored in the clear. */
interface StoredClaudeAccount {
  slot: string;
  label: string;
  enabled: boolean;
  createdAt: string;
  /** Encrypted `sk-ant-oat01-...` token, in the secrets provider's own format. */
  material: StoredSecretVersionMaterial;
}

interface StoredClaudeAccountsFile {
  version: 1;
  accounts: StoredClaudeAccount[];
  activeSlot: string;
  lastSwitch: { at: number; from: string; to: string } | null;
  exhaustedUntil: Record<string, number>;
}

const EMPTY_FILE: StoredClaudeAccountsFile = {
  version: 1,
  accounts: [],
  activeSlot: "",
  lastSwitch: null,
  exhaustedUntil: {},
};

/** What callers outside this module see: an account without its token. */
export interface ClaudeAccountSummary {
  slot: string;
  label: string;
  enabled: boolean;
  createdAt: string;
  active: boolean;
  /** ISO time this account is known to have nothing left until, if any. */
  exhaustedUntil: string | null;
}

function storePath(): string {
  return path.join(resolvePaperclipHomeDir(), "claude-accounts.json");
}

let cache: { path: string; file: StoredClaudeAccountsFile } | null = null;
/** Decrypted tokens, keyed by slot. Never written anywhere. */
let tokenCache: { path: string; tokens: Map<string, string> } | null = null;

function readFile(): StoredClaudeAccountsFile {
  const file = storePath();
  if (cache?.path === file) return cache.file;
  let parsed: StoredClaudeAccountsFile = EMPTY_FILE;
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const candidate = JSON.parse(raw) as Partial<StoredClaudeAccountsFile>;
    if (Array.isArray(candidate?.accounts)) {
      parsed = {
        version: 1,
        accounts: candidate.accounts,
        activeSlot: typeof candidate.activeSlot === "string" ? candidate.activeSlot : "",
        lastSwitch: candidate.lastSwitch ?? null,
        exhaustedUntil:
          candidate.exhaustedUntil && typeof candidate.exhaustedUntil === "object"
            ? candidate.exhaustedUntil
            : {},
      };
    } else if (raw.trim().length > 0) {
      // Present but unreadable. Say so rather than silently starting empty:
      // an account list that quietly disappears looks like a routing bug.
      log.error({ path: file }, "claude accounts file is present but not in a shape we understand");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      log.error({ err, path: file }, "could not read the claude accounts file");
    }
  }
  cache = { path: file, file: parsed };
  return parsed;
}

function writeFile(next: StoredClaudeAccountsFile): void {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), { encoding: "utf-8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort; Windows ACLs do not map onto this cleanly.
  }
  cache = { path: file, file: next };
  tokenCache = null;
}

/**
 * Decrypt every account's token.
 *
 * An account whose token will not decrypt (a rotated or missing master key) is
 * dropped with a loud log rather than throwing, so one damaged entry cannot
 * take out account routing altogether. With no accounts left, callers fall back
 * to the machine's existing single sign-in, which is the pre-accounts
 * behaviour.
 */
async function loadTokens(): Promise<Map<string, string>> {
  const file = storePath();
  if (tokenCache?.path === file) return tokenCache.tokens;
  const stored = readFile();
  const tokens = new Map<string, string>();
  for (const account of stored.accounts) {
    try {
      const token = await localEncryptedProvider.resolveVersion({
        material: account.material,
        externalRef: null,
      });
      if (token.trim().length > 0) tokens.set(account.slot, token);
    } catch (err) {
      log.error(
        { err, slot: account.slot, label: account.label },
        "could not decrypt a Claude account token; skipping that account",
      );
    }
  }
  tokenCache = { path: file, tokens };
  return tokens;
}

/** The full routing state, tokens included. Server-internal only. */
export async function readClaudeAccountState(): Promise<ClaudeAccountState> {
  const stored = readFile();
  if (stored.accounts.length === 0) return EMPTY_CLAUDE_ACCOUNT_STATE;
  const tokens = await loadTokens();
  const slots: ClaudeAccountSlot[] = stored.accounts
    .filter((account) => tokens.has(account.slot))
    .map((account) => ({
      slot: account.slot,
      token: tokens.get(account.slot) ?? "",
      label: account.label,
      enabled: account.enabled,
    }));
  return {
    slots,
    activeSlot: stored.activeSlot,
    lastSwitch: stored.lastSwitch,
    exhaustedUntil: stored.exhaustedUntil,
  };
}

/** Persist the routing state a decision produced. Leaves the accounts alone. */
export function saveClaudeAccountRouting(state: {
  activeSlot: string;
  lastSwitch: { at: number; from: string; to: string } | null;
  exhaustedUntil: Record<string, number>;
}): void {
  const stored = readFile();
  writeFile({
    ...stored,
    activeSlot: state.activeSlot,
    lastSwitch: state.lastSwitch,
    exhaustedUntil: state.exhaustedUntil,
  });
}

function nextSlotId(stored: StoredClaudeAccountsFile): string {
  for (let candidate = 1; candidate < 1000; candidate += 1) {
    const slot = String(candidate);
    if (!stored.accounts.some((account) => account.slot === slot)) return slot;
  }
  throw new Error("too many Claude accounts");
}

/**
 * Add an account, or replace the token on one that already exists.
 *
 * Replacing by slot is how a token is rotated when it expires; adding is what
 * the "+" on the adapters page does. The first account added becomes active,
 * so a fresh install starts routing without a second step.
 */
export async function upsertClaudeAccount(input: {
  token: string;
  label: string;
  slot?: string | null;
}): Promise<ClaudeAccountSummary> {
  const token = input.token.trim();
  if (!token) throw new Error("a Claude account needs a token");
  const stored = readFile();
  const encrypted = await localEncryptedProvider.createVersion({ value: token, externalRef: null });
  const slot = input.slot?.trim() || nextSlotId(stored);
  const existing = stored.accounts.find((account) => account.slot === slot);
  const label = input.label.trim() || existing?.label || `Account ${slot}`;
  const account: StoredClaudeAccount = {
    slot,
    label,
    enabled: existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    material: encrypted.material,
  };
  const accounts = existing
    ? stored.accounts.map((entry) => (entry.slot === slot ? account : entry))
    : [...stored.accounts, account];
  // A replaced token means the account may well have room again, so clear any
  // recorded exhaustion rather than making the operator wait it out.
  const exhaustedUntil = { ...stored.exhaustedUntil };
  delete exhaustedUntil[slot];
  writeFile({
    ...stored,
    accounts,
    activeSlot: stored.activeSlot || slot,
    exhaustedUntil,
  });
  return toSummary(account, readFile());
}

export function removeClaudeAccount(slot: string): boolean {
  const stored = readFile();
  const accounts = stored.accounts.filter((account) => account.slot !== slot);
  if (accounts.length === stored.accounts.length) return false;
  const exhaustedUntil = { ...stored.exhaustedUntil };
  delete exhaustedUntil[slot];
  writeFile({
    ...stored,
    accounts,
    activeSlot: stored.activeSlot === slot ? accounts[0]?.slot ?? "" : stored.activeSlot,
    lastSwitch: stored.lastSwitch?.from === slot || stored.lastSwitch?.to === slot ? null : stored.lastSwitch,
    exhaustedUntil,
  });
  return true;
}

export function setClaudeAccountEnabled(slot: string, enabled: boolean): boolean {
  const stored = readFile();
  const target = stored.accounts.find((account) => account.slot === slot);
  if (!target) return false;
  writeFile({
    ...stored,
    accounts: stored.accounts.map((account) =>
      account.slot === slot ? { ...account, enabled } : account,
    ),
  });
  return true;
}

/** Make an account the one new runs sign in with. */
export function setActiveClaudeAccount(slot: string): boolean {
  const stored = readFile();
  if (!stored.accounts.some((account) => account.slot === slot)) return false;
  const exhaustedUntil = { ...stored.exhaustedUntil };
  delete exhaustedUntil[slot];
  writeFile({ ...stored, activeSlot: slot, exhaustedUntil });
  return true;
}

function toSummary(
  account: StoredClaudeAccount,
  stored: StoredClaudeAccountsFile,
): ClaudeAccountSummary {
  const until = stored.exhaustedUntil[account.slot] ?? 0;
  return {
    slot: account.slot,
    label: account.label,
    enabled: account.enabled,
    createdAt: account.createdAt,
    active: stored.activeSlot === account.slot,
    exhaustedUntil: until > Date.now() ? new Date(until).toISOString() : null,
  };
}

/** The account list for the UI. Never includes a token. */
export function listClaudeAccounts(): ClaudeAccountSummary[] {
  const stored = readFile();
  return stored.accounts.map((account) => toSummary(account, stored));
}

/** Drop caches so the next read hits disk. For tests. */
export function resetClaudeAccountCaches(): void {
  cache = null;
  tokenCache = null;
}
