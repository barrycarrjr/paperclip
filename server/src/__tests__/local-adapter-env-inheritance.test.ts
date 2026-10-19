import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

// Pi captures os.homedir() during import. Mutate the real environment reference
// before any adapter import; replacing process.env later does not move that home.
const fixture = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const checkout = fs.realpathSync(fileURLToPath(new URL("../../../", import.meta.url)));
  const inside = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const tempParent = fs.realpathSync(os.tmpdir());
  if (tempParent === checkout || inside(checkout, tempParent)) throw new Error("Test temp parent is inside checkout");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tempParent, "ae-")));
  const marker = `local-adapter-env:${path.basename(root)}`;
  fs.writeFileSync(path.join(root, "OWNER.txt"), marker, { flag: "wx" });
  const owned = (relative: string) => {
    const target = path.resolve(root, relative);
    if (!inside(root, target) || inside(checkout, target)) throw new Error("Test path is not owned and external");
    return target;
  };
  const home = owned("user");
  const dirs = {
    HOME: home, USERPROFILE: home,
    PAPERCLIP_HOME: owned("pc"), PAPERCLIP_LOG_DIR: owned("logs"), RUN_LOG_BASE_PATH: owned("runs"),
    TEMP: owned("tmp"), TMP: owned("tmp"), TMPDIR: owned("tmp"),
    XDG_CONFIG_HOME: owned("config"), XDG_DATA_HOME: owned("data"), XDG_CACHE_HOME: owned("cache"),
    CLAUDE_CONFIG_DIR: owned("claude"), CODEX_HOME: owned("agent"),
    APPDATA: owned("appdata"), LOCALAPPDATA: owned("localappdata"),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  const settings = {
    ...dirs,
    PAPERCLIP_CONFIG: owned("missing-config.json"), PAPERCLIP_INSTANCE_ID: path.basename(root),
    PAPERCLIP_SECRETS_MASTER_KEY_FILE: owned("missing-master.key"),
    PAPERCLIP_MODEL_CATALOG_URL: "off", PAPERCLIP_MODEL_CLI_DISCOVERY: "off",
  };
  const nativeEnv = process.env;
  const savedEnv = { ...nativeEnv };
  for (const key of Object.keys(nativeEnv)) {
    if (/^(PAPERCLIP_|GIT_|AWS_|XDG_|CLAUDE_CODE_)/i.test(key) ||
        /^(DATABASE_URL|DATABASE_MIGRATION_URL|BETTER_AUTH_SECRET|NODE_OPTIONS|CLAUDECODE|HOMEDRIVE|HOMEPATH)$/i.test(key) ||
        /(TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|COOKIE|CREDENTIAL)/i.test(key)) delete nativeEnv[key];
  }
  Object.assign(nativeEnv, settings);
  if (fs.existsSync(settings.PAPERCLIP_CONFIG) || fs.existsSync(settings.PAPERCLIP_SECRETS_MASTER_KEY_FILE) ||
      path.resolve(os.homedir()) !== home || fs.realpathSync(root) !== root ||
      fs.readFileSync(path.join(root, "OWNER.txt"), "utf8") !== marker) {
    throw new Error("Test isolation failed before adapter import");
  }

  // Synthetic caller folders only. Never inspect the launching user's skills.
  const caller = owned("caller");
  const maintainer = owned("sources/.agents/skills/maint-demo");
  const other = owned("sources/other-demo");
  fs.mkdirSync(maintainer, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(maintainer, "SKILL.md"), "Synthetic maintainer sentinel\n");
  fs.writeFileSync(path.join(other, "SKILL.md"), "Synthetic unrelated sentinel\n");
  let linkSkipReason = "";
  for (const relative of [".claude/skills", ".pi/agent/skills"]) {
    const skills = path.join(caller, relative);
    fs.mkdirSync(skills, { recursive: true });
    fs.writeFileSync(path.join(skills, "sentinel.txt"), "Keep synthetic caller unchanged\n");
    for (const [name, source] of [["maint-demo", maintainer], ["other-demo", other]]) {
      try {
        fs.symlinkSync(source, path.join(skills, name), process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes(code ?? "")) throw error;
        linkSkipReason = `Synthetic caller link safety branch unsupported: ${code}`;
      }
    }
  }
  const snapshot = (dir: string): unknown => fs.readdirSync(dir).sort().map((name): unknown => {
    const target = path.join(dir, name);
    const stat = fs.lstatSync(target);
    return [name, stat.isSymbolicLink() ? ["link", fs.readlinkSync(target)] :
      stat.isDirectory() ? snapshot(target) : fs.readFileSync(target, "utf8")];
  });
  const callerBefore = JSON.stringify(snapshot(caller));
  const assertCallerUntouched = () => {
    if (JSON.stringify(snapshot(caller)) !== callerBefore) throw new Error("Synthetic caller home was modified");
  };
  return {
    home, nativeEnv, safeEnv: { ...nativeEnv }, linkSkipReason, assertCallerUntouched,
    cleanup: () => {
      try {
        assertCallerUntouched();
        // Delete only this exact owned target. A rejected guard leaves it intact.
        if (!inside(tempParent, root) || inside(checkout, root) || fs.lstatSync(root).isSymbolicLink() ||
            fs.realpathSync(root) !== root || fs.readFileSync(path.join(root, "OWNER.txt"), "utf8") !== marker) {
          throw new Error("Refusing unowned test cleanup");
        }
        fs.rmSync(root, { recursive: true, force: false });
      } finally {
        process.env = nativeEnv;
        for (const key of Object.keys(nativeEnv)) if (!(key in savedEnv)) delete nativeEnv[key];
        Object.assign(nativeEnv, savedEnv);
      }
    },
  };
});

const { launch, resolveCommand } = vi.hoisted(() => ({
  launch: vi.fn(),
  resolveCommand: vi.fn(),
}));
vi.mock("@paperclipai/adapter-utils/server-utils", async () => ({
  ...await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>("@paperclipai/adapter-utils/server-utils"),
  runChildProcess: launch,
  ensureCommandResolvable: resolveCommand,
  resolveCommandForLogs: async (command: string) => command,
}));

import { execute as executeHermes } from "@paperclipai/hermes-paperclip-adapter/server";
import { execute as executePi, testEnvironment as testPi } from "@paperclipai/adapter-pi-local/server";
import { execute as executeOpenCode, testEnvironment as testOpenCode } from "@paperclipai/adapter-opencode-local/server";
import { execute as executeAider, testEnvironment as testAider } from "@paperclipai/adapter-aider-local/server";
import { discoverPiModels, resetPiModelsCacheForTests } from "../../../packages/adapters/pi-local/src/server/models.js";
import { discoverOpenCodeModels, resetOpenCodeModelsCacheForTests } from "../../../packages/adapters/opencode-local/src/server/models.js";
import { defaultPathForPlatform } from "@paperclipai/adapter-utils/server-utils";

const credentialKeys = ["BETTER_AUTH_SECRET", "DATABASE_URL", "DATABASE_MIGRATION_URL"];
let installed = false;

beforeEach(() => {
  expect(path.resolve(os.homedir())).toBe(fixture.home);
  process.env = {
    ...fixture.safeEnv,
    HOME: fixture.home,
    USERPROFILE: fixture.home,
    BETTER_AUTH_SECRET: "fake-parent-value",
    DATABASE_URL: "fake-parent-value",
    DATABASE_MIGRATION_URL: "fake-parent-value",
    OPENAI_API_KEY: "fake-provider-key",
    SYNTHETIC_INHERITED_MARKER: "fixture-inherited",
    PAPERCLIP_AGENT_JWT_SECRET: "fake-parent-signing-input",
  };
  installed = false;
  resetPiModelsCacheForTests();
  resetOpenCodeModelsCacheForTests();
  // Keep discovery's user-account lookup inside the synthetic home as well.
  vi.spyOn(os, "userInfo").mockImplementation(() => { throw new Error("synthetic UID has no home entry"); });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ models: [{ name: "fixture" }] }) })));
  resolveCommand.mockImplementation(async (command: string) => {
    if (command === "fixture-aider" && !installed) throw new Error("synthetic command missing");
  });
  launch.mockImplementation(async (_id: string, command: string, args: string[]) => {
    let stdout = "Done.";
    if (args.includes("--list-models")) stdout = "provider  model\nexample   fixture\n";
    else if (args[0] === "models") stdout = "example/fixture\n";
    else if (args.includes("--version")) stdout = "Python 3.12.1";
    else if (args.includes("-c")) stdout = path.join(os.tmpdir(), "synthetic-python");
    else if (command === "pipx") installed = true;
    else if (command === "fixture-pi") stdout = JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "hello" }, toolResults: [] });
    else if (command === "fixture-opencode") stdout = JSON.stringify({ type: "text", part: { text: "hello" } });
    return { exitCode: 0, signal: null, timedOut: false, stdout, stderr: "", pid: 123, startedAt: null };
  });
});

afterEach(() => {
  process.env = fixture.nativeEnv;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

afterAll(() => fixture.cleanup());

it("keeps synthetic caller skills and links untouched", (test) => {
  if (fixture.linkSkipReason) test.skip(fixture.linkSkipReason);
  fixture.assertCallerUntouched();
});

function context(command: string, env: Record<string, string>): AdapterExecutionContext {
  return {
    runId: "synthetic-env-run",
    agent: { id: "synthetic-agent", companyId: "synthetic-company", name: "Example", adapterType: "process", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command, cwd: os.tmpdir(), model: "example/fixture", provider: "auto", env, dangerouslySkipPermissions: false, paperclipSkillSync: { enabled: false } },
    context: {},
    authToken: "fake-run-token",
    onLog: async () => {},
  };
}

const paths = [
  ["Hermes execution", async (env: Record<string, string>) => executeHermes(context("fixture-hermes", env))],
  ["Pi discovery", async (env: Record<string, string>) => discoverPiModels({ command: "fixture-pi", cwd: os.tmpdir(), env })],
  ["Pi diagnostics", async (env: Record<string, string>) => testPi({ companyId: "synthetic-company", adapterType: "pi_local", config: context("fixture-pi", env).config })],
  ["Pi execution and discovery", async (env: Record<string, string>) => executePi(context("fixture-pi", env))],
  ["OpenCode discovery", async (env: Record<string, string>) => discoverOpenCodeModels({ command: "fixture-opencode", cwd: os.tmpdir(), env })],
  ["OpenCode diagnostics", async (env: Record<string, string>) => testOpenCode({ companyId: "synthetic-company", adapterType: "opencode_local", config: context("fixture-opencode", env).config })],
  ["OpenCode execution and discovery", async (env: Record<string, string>) => executeOpenCode(context("fixture-opencode", env))],
  ["Aider execution preparation", async (env: Record<string, string>) => executeAider(context("fixture-aider", env))],
  ["Aider diagnostic preparation", async (env: Record<string, string>) => testAider({ companyId: "synthetic-company", adapterType: "aider_local", config: context("fixture-aider", env).config })],
] as const;

describe.each(paths)("%s inherited environment", (_name, invoke) => {
  it.each(["inherited", "explicit", "same", "empty"])("keeps provenance for %s values through actual launch arguments", async (mode) => {
    const value = mode === "same" ? "fake-parent-value" : mode === "empty" ? "" : "fake-agent-value";
    const env = Object.freeze(mode === "inherited" ? {} : Object.fromEntries(credentialKeys.map(key => [key, value])));
    await invoke(env);
    expect(launch).toHaveBeenCalled();
    expect(launch.mock.calls.filter(([, , , options]) => options.env.SYNTHETIC_INHERITED_MARKER === "fixture-inherited").length).toBeGreaterThan(0);
    for (const [, , , options] of launch.mock.calls) {
      for (const key of credentialKeys) {
        if (mode === "inherited") expect(options.env).not.toHaveProperty(key);
        else expect(options.env[key]).toBe(value);
        expect(process.env[key]).toBe("fake-parent-value");
      }
      if (options.env.SYNTHETIC_INHERITED_MARKER === "fixture-inherited") {
        expect(options.env.HOME).toBe(process.env.HOME);
        expect(options.env.USERPROFILE).toBe(process.env.USERPROFILE);
        expect(options.env.OPENAI_API_KEY).toBe("fake-provider-key");
        const parentPath = process.env.PATH ?? process.env.Path;
        expect((options.env.PATH ?? options.env.Path).endsWith(parentPath)).toBe(true);
      }
      if (_name.includes("execution")) expect(options.env.PAPERCLIP_API_KEY).toBe("fake-run-token");
      expect(env).toEqual(mode === "inherited" ? {} : Object.fromEntries(credentialKeys.map(key => [key, value])));
    }
    if ((_name.includes("diagnostics") || _name.includes("and discovery")) && !_name.startsWith("Aider")) {
      expect(launch.mock.calls.some(([, , args]) => args.includes("--list-models") || args[0] === "models")).toBe(true);
      expect(launch.mock.calls.some(([, , args]) => args.includes("--mode") || args[0] === "run")).toBe(true);
    }
    if (_name.startsWith("Aider")) expect(launch.mock.calls.some(([, command]) => command === "pipx")).toBe(true);
  });

  it("retains provider auth and home with the computed PATH fallback", async () => {
    for (const key of Object.keys(process.env)) if (key.toUpperCase() === "PATH") delete process.env[key];
    await invoke(Object.freeze({}));
    // Inspect the merged paths that used to be forwarded to the launcher.
    const mergedCalls = launch.mock.calls.filter(([, , , options]) => options.env.SYNTHETIC_INHERITED_MARKER === "fixture-inherited");
    expect(mergedCalls.length).toBeGreaterThan(0);
    for (const [, , , options] of mergedCalls) {
      expect(options.env.HOME).toBe(process.env.HOME);
      expect(options.env.USERPROFILE).toBe(process.env.USERPROFILE);
      expect(options.env.OPENAI_API_KEY).toBe("fake-provider-key");
      // Discovery can leave PATH to runChildProcess; Pi execution prepends skill bins.
      const childPath = options.env.PATH ?? options.env.Path;
      if (_name === "Pi discovery" || _name === "Hermes execution") expect(childPath).toBeUndefined();
      else expect(childPath.endsWith(defaultPathForPlatform())).toBe(true);
      expect(options.env).not.toHaveProperty("PAPERCLIP_AGENT_JWT_SECRET");
    }
  });

  it.skipIf(process.platform !== "win32")("filters inherited Windows case variants before an explicit mixed-case binding", async () => {
    for (const key of credentialKeys) delete process.env[key];
    Object.assign(process.env, { database_url: "fake-parent-value", Database_Url: "fake-parent-value", better_auth_secret: "fake-parent-value", Database_Migration_Url: "fake-parent-value" });
    const env = Object.freeze({ Database_Url: "fake-parent-value" });
    await invoke(env);
    for (const [, , , options] of launch.mock.calls) {
      expect(options.env.Database_Url).toBe("fake-parent-value");
      expect(options.env).not.toHaveProperty("database_url");
      expect(options.env).not.toHaveProperty("better_auth_secret");
      expect(options.env).not.toHaveProperty("Database_Migration_Url");
    }
    expect(process.env.database_url).toBe("fake-parent-value");
  });
});
