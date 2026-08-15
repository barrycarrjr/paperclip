import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  accountCredentialEnvVarFor,
  resolveActiveAccount,
  resolveActiveAccountCredential,
} from "../active-account.js";
import {
  resetAdapterAccountCaches,
  setActiveAdapterAccount,
  upsertAdapterAccount,
} from "../adapter-accounts.js";

/**
 * Four places ask "which account is this adapter running on": the agent run,
 * the chat turn, the usage figures and the sign-in badge. They have to give
 * the same answer, or the Adapters page describes an account nothing is using
 * while runs quietly use another. This is the one implementation they share.
 */
describe("active account resolution", () => {
  let homeDir: string;
  const priorHome = process.env.PAPERCLIP_HOME;
  const priorMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-active-account-"));
    process.env.PAPERCLIP_HOME = homeDir;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = Buffer.alloc(32, 11).toString("base64");
    resetAdapterAccountCaches();
  });

  afterEach(() => {
    resetAdapterAccountCaches();
    if (priorHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = priorHome;
    if (priorMasterKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY = priorMasterKey;
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("knows which variable an adapter's credential travels in", () => {
    expect(accountCredentialEnvVarFor("claude_local")).toBe("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("returns nothing for an adapter that has not opted in", async () => {
    expect(accountCredentialEnvVarFor("codex_local")).toBeNull();
    await upsertAdapterAccount({ adapterType: "codex_local", token: "codex-one", label: "Codex" });
    // Stored accounts are not enough: without a declared variable there is
    // nowhere to put the credential, so the machine's sign-in stands.
    expect(await resolveActiveAccount("codex_local")).toBeNull();
    expect(await resolveActiveAccountCredential("codex_local")).toBeUndefined();
  });

  it("returns nothing for an adapter that does not exist", async () => {
    expect(accountCredentialEnvVarFor("not_a_real_adapter")).toBeNull();
    expect(await resolveActiveAccount("not_a_real_adapter")).toBeNull();
  });

  it("returns the active account, not merely the first one", async () => {
    await upsertAdapterAccount({ adapterType: "claude_local", token: "token-one", label: "Main" });
    await upsertAdapterAccount({ adapterType: "claude_local", token: "token-two", label: "Backup" });
    setActiveAdapterAccount("claude_local", "2");
    resetAdapterAccountCaches();

    const resolved = await resolveActiveAccount("claude_local");
    expect(resolved).toMatchObject({
      slot: "2",
      label: "Backup",
      envVar: "CLAUDE_CODE_OAUTH_TOKEN",
      credential: "token-two",
    });
    expect(await resolveActiveAccountCredential("claude_local")).toBe("token-two");
  });

  it("says nothing when no accounts are configured, leaving the sign-in alone", async () => {
    expect(await resolveActiveAccount("claude_local")).toBeNull();
    expect(await resolveActiveAccountCredential("claude_local")).toBeUndefined();
  });
});
