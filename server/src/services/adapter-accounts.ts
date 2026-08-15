/**
 * The accounts each adapter can sign a run in with.
 *
 * Every adapter here runs the same kind of work, so two accounts on one
 * adapter are interchangeable: either can do the job. That is what makes
 * automatic failover safe. When the account a run used reports its plan spent,
 * the work moves to the next account on that adapter's list and is retried
 * there, instead of stopping until the window reopens days later.
 *
 * An adapter opts in by declaring `accountCredentialEnvVar` on its module. The
 * server never learns anything provider-specific: it picks an account for the
 * adapter, sets that one variable on the child process, and the adapter signs
 * in exactly as it would with a single credential. An adapter that declares
 * nothing keeps its existing single sign-in, untouched.
 *
 * Credentials are encrypted with the same `local_encrypted` provider the
 * company secrets service uses, so the file on disk holds ciphertext and the
 * protection is the master key, exactly as it is for a secret in the database.
 * They are deliberately NOT kept in the host environment: the one credential
 * that lives that way (the Windows user environment) is the subject of a
 * three-day outage recorded in adapters/registry.ts, and adding more would
 * multiply it while also requiring a terminal and a restart to change anything.
 *
 * This is its own file rather than a key inside adapter-settings.json because
 * that file's reader falls back to defaults when its shape is unfamiliar, which
 * would silently discard the account list. A store holding credentials must not
 * have a "quietly reset itself" path.
 *
 * @module server/services/adapter-accounts
 */

import fs from "node:fs";
import path from "node:path";
import { resolvePaperclipHomeDir } from "../home-paths.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import type { StoredSecretVersionMaterial } from "../secrets/types.js";
import {
  EMPTY_ADAPTER_ACCOUNT_STATE,
  type AdapterAccountSlot,
  type AdapterAccountState,
} from "./adapter-account-router.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ service: "adapter-accounts" });

/** One account as it sits on disk. The credential is never stored in the clear. */
interface StoredAdapterAccount {
  slot: string;
  label: string;
  enabled: boolean;
  createdAt: string;
  /** The account's credential, in the secrets provider's own encrypted format. */
  material: StoredSecretVersionMaterial;
}

/** One adapter's accounts, plus which one runs and what is spent. */
interface StoredAdapterEntry {
  accounts: StoredAdapterAccount[];
  activeSlot: string;
  lastSwitch: { at: number; from: string; to: string } | null;
  exhaustedUntil: Record<string, number>;
}

interface StoredAccountsFile {
  version: 1;
  /** Keyed by adapter type: claude_local, codex_local, and so on. */
  adapters: Record<string, StoredAdapterEntry>;
}

const EMPTY_ENTRY: StoredAdapterEntry = {
  accounts: [],
  activeSlot: "",
  lastSwitch: null,
  exhaustedUntil: {},
};

const EMPTY_FILE: StoredAccountsFile = { version: 1, adapters: {} };

/** What callers outside this module see: an account without its credential. */
export interface AdapterAccountSummary {
  adapterType: string;
  slot: string;
  label: string;
  enabled: boolean;
  createdAt: string;
  /** True for the account new runs on this adapter sign in with. */
  active: boolean;
  /** ISO time this account is known to have nothing left until, if any. */
  exhaustedUntil: string | null;
}

function storePath(): string {
  return path.join(resolvePaperclipHomeDir(), "adapter-accounts.json");
}

/** Where the Claude-only first version of this store lived. */
function legacyClaudeStorePath(): string {
  return path.join(resolvePaperclipHomeDir(), "claude-accounts.json");
}

let cache: { path: string; file: StoredAccountsFile } | null = null;
/** Decrypted credentials, keyed "<adapterType> <slot>". Never written anywhere. */
let tokenCache: { path: string; tokens: Map<string, string> } | null = null;

function tokenKey(adapterType: string, slot: string): string {
  return `${adapterType} ${slot}`;
}

function parseEntry(raw: unknown): StoredAdapterEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<StoredAdapterEntry>;
  if (!Array.isArray(candidate.accounts)) return null;
  return {
    accounts: candidate.accounts,
    activeSlot: typeof candidate.activeSlot === "string" ? candidate.activeSlot : "",
    lastSwitch: candidate.lastSwitch ?? null,
    exhaustedUntil:
      candidate.exhaustedUntil && typeof candidate.exhaustedUntil === "object"
        ? candidate.exhaustedUntil
        : {},
  };
}

/**
 * Fold the Claude-only store into the per-adapter one.
 *
 * The first version of this feature kept a flat file that could only ever hold
 * Claude accounts. Anyone who added accounts under it would otherwise find them
 * gone after an upgrade, with agents quietly falling back to the machine's
 * single sign-in and nothing saying why.
 */
function readLegacyClaudeEntry(): StoredAdapterEntry | null {
  try {
    const raw = fs.readFileSync(legacyClaudeStorePath(), "utf-8");
    const entry = parseEntry(JSON.parse(raw));
    if (entry && entry.accounts.length > 0) {
      log.info({ accounts: entry.accounts.length }, "migrating the Claude-only account store");
      return entry;
    }
  } catch {
    // Absent or unreadable: nothing to migrate, which is the normal case.
  }
  return null;
}

function readFile(): StoredAccountsFile {
  const file = storePath();
  if (cache?.path === file) return cache.file;
  let parsed: StoredAccountsFile = EMPTY_FILE;
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const candidate = JSON.parse(raw) as Partial<StoredAccountsFile>;
    if (candidate?.adapters && typeof candidate.adapters === "object") {
      const adapters: Record<string, StoredAdapterEntry> = {};
      for (const [type, entry] of Object.entries(candidate.adapters)) {
        const parsedEntry = parseEntry(entry);
        if (parsedEntry) adapters[type] = parsedEntry;
      }
      parsed = { version: 1, adapters };
    } else if (raw.trim().length > 0) {
      // Present but unreadable. Say so rather than silently starting empty: an
      // account list that quietly disappears looks like a routing bug.
      log.error({ path: file }, "adapter accounts file is present but not in a shape we understand");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      log.error({ err, path: file }, "could not read the adapter accounts file");
    } else {
      const legacy = readLegacyClaudeEntry();
      if (legacy) parsed = { version: 1, adapters: { claude_local: legacy } };
    }
  }
  cache = { path: file, file: parsed };
  return parsed;
}

function writeFile(next: StoredAccountsFile): void {
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

function entryFor(adapterType: string): StoredAdapterEntry {
  return readFile().adapters[adapterType] ?? EMPTY_ENTRY;
}

function writeEntry(adapterType: string, entry: StoredAdapterEntry): void {
  const current = readFile();
  writeFile({ ...current, adapters: { ...current.adapters, [adapterType]: entry } });
}

/**
 * Decrypt every stored credential.
 *
 * An account whose credential will not decrypt (a rotated or missing master
 * key) is dropped with a loud log rather than throwing, so one damaged entry
 * cannot take out account routing altogether. With none left, callers fall back
 * to the adapter's existing single sign-in, which is the pre-accounts
 * behaviour.
 */
async function loadTokens(): Promise<Map<string, string>> {
  const file = storePath();
  if (tokenCache?.path === file) return tokenCache.tokens;
  const stored = readFile();
  const tokens = new Map<string, string>();
  for (const [adapterType, entry] of Object.entries(stored.adapters)) {
    for (const account of entry.accounts) {
      try {
        const token = await localEncryptedProvider.resolveVersion({
          material: account.material,
          externalRef: null,
        });
        if (token.trim().length > 0) tokens.set(tokenKey(adapterType, account.slot), token);
      } catch (err) {
        log.error(
          { err, adapterType, slot: account.slot, label: account.label },
          "could not decrypt an adapter account credential; skipping that account",
        );
      }
    }
  }
  tokenCache = { path: file, tokens };
  return tokens;
}

/** One adapter's full routing state, credentials included. Server-internal only. */
export async function readAdapterAccountState(adapterType: string): Promise<AdapterAccountState> {
  const entry = entryFor(adapterType);
  if (entry.accounts.length === 0) return EMPTY_ADAPTER_ACCOUNT_STATE;
  const tokens = await loadTokens();
  const slots: AdapterAccountSlot[] = entry.accounts
    .filter((account) => tokens.has(tokenKey(adapterType, account.slot)))
    .map((account) => ({
      slot: account.slot,
      token: tokens.get(tokenKey(adapterType, account.slot)) ?? "",
      label: account.label,
      enabled: account.enabled,
    }));
  return {
    slots,
    activeSlot: entry.activeSlot,
    lastSwitch: entry.lastSwitch,
    exhaustedUntil: entry.exhaustedUntil,
  };
}

/** Persist the routing state a decision produced. Leaves the accounts alone. */
export function saveAdapterAccountRouting(
  adapterType: string,
  state: {
    activeSlot: string;
    lastSwitch: { at: number; from: string; to: string } | null;
    exhaustedUntil: Record<string, number>;
  },
): void {
  writeEntry(adapterType, {
    ...entryFor(adapterType),
    activeSlot: state.activeSlot,
    lastSwitch: state.lastSwitch,
    exhaustedUntil: state.exhaustedUntil,
  });
}

function nextSlotId(entry: StoredAdapterEntry): string {
  for (let candidate = 1; candidate < 1000; candidate += 1) {
    const slot = String(candidate);
    if (!entry.accounts.some((account) => account.slot === slot)) return slot;
  }
  throw new Error("too many accounts on one adapter");
}

/**
 * Add an account to an adapter, or replace the credential on one it already
 * has.
 *
 * Replacing by slot is how a credential is rotated when it expires; adding is
 * what the "+" on the adapters page does. The first account added becomes
 * active, so a fresh install starts routing without a second step.
 */
export async function upsertAdapterAccount(input: {
  adapterType: string;
  token: string;
  label: string;
  slot?: string | null;
}): Promise<AdapterAccountSummary> {
  const token = input.token.trim();
  if (!token) throw new Error("an account needs a credential");
  const entry = entryFor(input.adapterType);
  const encrypted = await localEncryptedProvider.createVersion({ value: token, externalRef: null });
  const slot = input.slot?.trim() || nextSlotId(entry);
  const existing = entry.accounts.find((account) => account.slot === slot);
  const label = input.label.trim() || existing?.label || `Account ${slot}`;
  const account: StoredAdapterAccount = {
    slot,
    label,
    enabled: existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    material: encrypted.material,
  };
  const accounts = existing
    ? entry.accounts.map((candidate) => (candidate.slot === slot ? account : candidate))
    : [...entry.accounts, account];
  // A replaced credential means the account may well have room again, so clear
  // any recorded exhaustion rather than making the operator wait it out.
  const exhaustedUntil = { ...entry.exhaustedUntil };
  delete exhaustedUntil[slot];
  writeEntry(input.adapterType, {
    ...entry,
    accounts,
    activeSlot: entry.activeSlot || slot,
    exhaustedUntil,
  });
  return toSummary(input.adapterType, account, entryFor(input.adapterType));
}

export function removeAdapterAccount(adapterType: string, slot: string): boolean {
  const entry = entryFor(adapterType);
  const accounts = entry.accounts.filter((account) => account.slot !== slot);
  if (accounts.length === entry.accounts.length) return false;
  const exhaustedUntil = { ...entry.exhaustedUntil };
  delete exhaustedUntil[slot];
  writeEntry(adapterType, {
    ...entry,
    accounts,
    activeSlot: entry.activeSlot === slot ? accounts[0]?.slot ?? "" : entry.activeSlot,
    lastSwitch:
      entry.lastSwitch?.from === slot || entry.lastSwitch?.to === slot ? null : entry.lastSwitch,
    exhaustedUntil,
  });
  return true;
}

export function setAdapterAccountEnabled(
  adapterType: string,
  slot: string,
  enabled: boolean,
): boolean {
  const entry = entryFor(adapterType);
  if (!entry.accounts.some((account) => account.slot === slot)) return false;
  writeEntry(adapterType, {
    ...entry,
    accounts: entry.accounts.map((account) =>
      account.slot === slot ? { ...account, enabled } : account,
    ),
  });
  return true;
}

/** Make an account the one new runs on this adapter sign in with. */
export function setActiveAdapterAccount(adapterType: string, slot: string): boolean {
  const entry = entryFor(adapterType);
  if (!entry.accounts.some((account) => account.slot === slot)) return false;
  const exhaustedUntil = { ...entry.exhaustedUntil };
  delete exhaustedUntil[slot];
  writeEntry(adapterType, { ...entry, activeSlot: slot, exhaustedUntil });
  return true;
}

function toSummary(
  adapterType: string,
  account: StoredAdapterAccount,
  entry: StoredAdapterEntry,
): AdapterAccountSummary {
  const until = entry.exhaustedUntil[account.slot] ?? 0;
  return {
    adapterType,
    slot: account.slot,
    label: account.label,
    enabled: account.enabled,
    createdAt: account.createdAt,
    active: entry.activeSlot === account.slot,
    exhaustedUntil: until > Date.now() ? new Date(until).toISOString() : null,
  };
}

/** One adapter's account list for the UI. Never includes a credential. */
export function listAdapterAccounts(adapterType: string): AdapterAccountSummary[] {
  const entry = entryFor(adapterType);
  return entry.accounts.map((account) => toSummary(adapterType, account, entry));
}

/** Every adapter's accounts, so the page can be rendered in one request. */
export function listAllAdapterAccounts(): Record<string, AdapterAccountSummary[]> {
  const stored = readFile();
  const out: Record<string, AdapterAccountSummary[]> = {};
  for (const [adapterType, entry] of Object.entries(stored.adapters)) {
    out[adapterType] = entry.accounts.map((account) => toSummary(adapterType, account, entry));
  }
  return out;
}

/** Drop caches so the next read hits disk. For tests. */
export function resetAdapterAccountCaches(): void {
  cache = null;
  tokenCache = null;
}
