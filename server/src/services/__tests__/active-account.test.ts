import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  accountCredentialEnvVarFor,
  resolveActiveAccount,
  resolveActiveAccountCredential,
  resolveAdapterAccountEnv,
  switchboardProviderFor,
} from "../active-account.js";
import { resetSwitchboardCache } from "../switchboard.js";
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

/**
 * Where a run's sign-in comes from when Paperclip has no account of its own.
 *
 * The order matters more than any single case: an account added here must
 * always win, because the operator added it on purpose, and Switchboard must
 * only ever fill the gap where Paperclip would otherwise use whichever sign-in
 * the server happened to inherit when it started.
 */
describe("choosing where a run's sign-in comes from", () => {
  let homeDir: string;
  const priorHome = process.env.PAPERCLIP_HOME;
  const priorMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  const priorEnabled = process.env.SWITCHBOARD_ENABLED;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-account-env-"));
    process.env.PAPERCLIP_HOME = homeDir;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = Buffer.alloc(32, 12).toString("base64");
    // Switched off so these cases never depend on whether the machine running
    // the suite happens to have Switchboard installed.
    process.env.SWITCHBOARD_ENABLED = "false";
    resetAdapterAccountCaches();
    resetSwitchboardCache();
  });

  afterEach(() => {
    resetAdapterAccountCaches();
    resetSwitchboardCache();
    if (priorHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = priorHome;
    if (priorMasterKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY = priorMasterKey;
    if (priorEnabled === undefined) delete process.env.SWITCHBOARD_ENABLED;
    else process.env.SWITCHBOARD_ENABLED = priorEnabled;
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("knows which tool switchboard would be asked about", () => {
    expect(switchboardProviderFor("claude_local")).toBe("claude");
    expect(switchboardProviderFor("codex_local")).toBe("codex");
    expect(switchboardProviderFor("gemini_local")).toBe("gemini");
  });

  it("asks about no tool for an adapter that has not opted in", () => {
    expect(switchboardProviderFor("cursor")).toBeNull();
    expect(switchboardProviderFor("not_a_real_adapter")).toBeNull();
  });

  it("uses the account added here, and says so", async () => {
    await upsertAdapterAccount({ adapterType: "claude_local", token: "token-one", label: "Main" });
    resetAdapterAccountCaches();

    const resolved = await resolveAdapterAccountEnv("claude_local");
    expect(resolved).toMatchObject({ source: "paperclip", slot: "1", label: "Main" });
    expect(resolved?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "token-one" });
  });

  it("changes nothing when there is no account here and no switchboard to ask", async () => {
    expect(await resolveAdapterAccountEnv("claude_local")).toBeNull();
  });

  it("changes nothing for an adapter with neither accounts nor a switchboard tool", async () => {
    expect(await resolveAdapterAccountEnv("cursor")).toBeNull();
    expect(await resolveAdapterAccountEnv("not_a_real_adapter")).toBeNull();
  });
});
