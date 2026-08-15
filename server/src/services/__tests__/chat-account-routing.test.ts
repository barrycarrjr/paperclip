import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  recordAccountExhausted,
  resolveActiveAccountEnv,
} from "../chat-providers.js";
import {
  listAdapterAccounts,
  readAdapterAccountState,
  resetAdapterAccountCaches,
  upsertAdapterAccount,
} from "../adapter-accounts.js";

/**
 * Clippy signs in through the chat path, not the agent-run path.
 *
 * That is how it went wrong the first time: account routing was wired into the
 * heartbeat and nowhere else, so Clippy kept using the machine's original
 * sign-in and reported a weekly limit the configured accounts did not have.
 * These cover the chat side of the same contract.
 */
describe("chat account routing", () => {
  let homeDir: string;
  const priorHome = process.env.PAPERCLIP_HOME;
  const priorMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-chat-accounts-"));
    process.env.PAPERCLIP_HOME = homeDir;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
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

  it("hands the active account's credential to the chat turn", async () => {
    await upsertAdapterAccount({
      adapterType: "claude_local",
      token: "token-one",
      label: "Main",
    });

    const resolved = await resolveActiveAccountEnv("claude_local");
    expect(resolved?.slot).toBe("1");
    // The variable name comes from the adapter, not from anything in the chat
    // layer, which is what keeps this working for a second adapter.
    expect(resolved?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "token-one" });
  });

  it("follows the active account rather than the first one added", async () => {
    await upsertAdapterAccount({ adapterType: "claude_local", token: "token-one", label: "Main" });
    await upsertAdapterAccount({ adapterType: "claude_local", token: "token-two", label: "Backup" });

    await recordAccountExhausted({
      adapterType: "claude_local",
      slot: "1",
      resultJson: { planResetsAt: "2026-08-17T07:00:00.000Z" },
    });

    const resolved = await resolveActiveAccountEnv("claude_local");
    expect(resolved?.slot).toBe("2");
    expect(resolved?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("token-two");
  });

  it("leaves an adapter with no accounts on its existing sign-in", async () => {
    expect(await resolveActiveAccountEnv("claude_local")).toBeNull();
  });

  it("returns nothing for an adapter that has not opted in", async () => {
    await upsertAdapterAccount({ adapterType: "codex_local", token: "codex-one", label: "Codex" });
    // The account is stored, but codex_local declares no credential variable,
    // so the chat layer has nothing to set and must not guess.
    expect(await resolveActiveAccountEnv("codex_local")).toBeNull();
  });

  it("records the spent account and its reset, so the list matches an agent run", async () => {
    await upsertAdapterAccount({ adapterType: "claude_local", token: "token-one", label: "Main" });
    await upsertAdapterAccount({ adapterType: "claude_local", token: "token-two", label: "Backup" });

    await recordAccountExhausted({
      adapterType: "claude_local",
      slot: "1",
      resultJson: { planResetsAt: "2026-08-17T07:00:00.000Z" },
    });

    const state = await readAdapterAccountState("claude_local");
    expect(state.activeSlot).toBe("2");
    expect(state.exhaustedUntil["1"]).toBe(Date.parse("2026-08-17T07:00:00.000Z"));
    expect(listAdapterAccounts("claude_local").find((a) => a.slot === "1")?.exhaustedUntil).toBe(
      "2026-08-17T07:00:00.000Z",
    );
  });

  it("does not leak a credential into the account list the UI reads", async () => {
    await upsertAdapterAccount({
      adapterType: "claude_local",
      token: "sk-ant-oat01-should-never-appear",
      label: "Main",
    });
    expect(JSON.stringify(listAdapterAccounts("claude_local"))).not.toContain("sk-ant");
  });
});
