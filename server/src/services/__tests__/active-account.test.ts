import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  accountCredentialEnvVarFor,
  resolveActiveAccount,
  resolveActiveAccountCredential,
  resolveAdapterAccountEnv,
  resolvedEnvForExecution,
  switchboardChoiceLogFields,
  switchboardProviderFor,
  type ResolvedAccountEnv,
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

const laneToken = "sk-ant-oat01-FAKE-lane-secret-that-must-never-surface";

/** A Switchboard answer whose lane carried a token, as heartbeat receives it. */
const switchboardResolved: ResolvedAccountEnv = {
  source: "switchboard",
  env: {
    CLAUDE_CONFIG_DIR: "C:\\Users\\me\\.claude-two",
    CLAUDE_CODE_OAUTH_TOKEN: laneToken,
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "",
    CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "",
    CCR_OAUTH_TOKEN_FILE: "",
  },
  slot: null,
  label: "Account 2",
  reason: "Subscription has capacity",
};

/**
 * The run log says which account Switchboard chose; it must never say how to
 * sign in as it. The lane token travels inside resolved.env, so the log line
 * is built from this helper's fixed field list rather than from the resolved
 * object, and this test pins that list so a later edit cannot widen it into
 * the secret.
 */
describe("the switchboard choice log line", () => {
  it("carries label and reason only, never the environment", () => {
    const fields = switchboardChoiceLogFields("agent-1", "claude_local", switchboardResolved);
    expect(Object.keys(fields)).toEqual(["agentId", "adapterType", "account", "reason"]);
    expect(JSON.stringify(fields)).not.toContain(laneToken);
    expect(fields).toEqual({
      agentId: "agent-1",
      adapterType: "claude_local",
      account: "Account 2",
      reason: "Subscription has capacity",
    });
  });
});

/**
 * Where the run executes decides whether the lane token may ride along. The
 * ssh transport writes the run's environment into the command line it sends,
 * so a remote target gets the pre-token Switchboard environment back: the
 * folder pointer with the token blanked, exactly what every remote run got
 * before lane tokens existed. Local runs keep the token, and an account from
 * Paperclip's own list is never touched.
 */
describe("what a run's execution target may receive", () => {
  it("hands a local target the environment untouched", () => {
    expect(resolvedEnvForExecution(switchboardResolved, false)).toBe(switchboardResolved.env);
  });

  it("blanks only the token for a remote target", () => {
    expect(resolvedEnvForExecution(switchboardResolved, true)).toEqual({
      CLAUDE_CONFIG_DIR: "C:\\Users\\me\\.claude-two",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "",
      CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "",
      CCR_OAUTH_TOKEN_FILE: "",
    });
    // The original is not mutated: the local merge already used it.
    expect(switchboardResolved.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(laneToken);
  });

  it("changes nothing for a remote target when the lane had no token", () => {
    const tokenless: ResolvedAccountEnv = {
      ...switchboardResolved,
      env: { ...switchboardResolved.env, CLAUDE_CODE_OAUTH_TOKEN: "" },
    };
    expect(resolvedEnvForExecution(tokenless, true)).toEqual(tokenless.env);
  });

  it("leaves an account from Paperclip's own list alone even on a remote target", () => {
    const own: ResolvedAccountEnv = {
      source: "paperclip",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "token-one" },
      slot: "1",
      label: "Main",
      reason: null,
    };
    // The operator added this credential for runs to use, remote runs
    // included, and that is how it behaved before lane tokens existed.
    expect(resolvedEnvForExecution(own, true)).toBe(own.env);
  });
});
