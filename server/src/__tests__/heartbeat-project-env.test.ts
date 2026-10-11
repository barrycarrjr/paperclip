import { describe, expect, it, vi } from "vitest";
import { buildSkillMentionHref, isUuidLike } from "@paperclipai/shared";
import { notFound } from "../errors.js";

// An adapter that declares its own account variable, one no tool list names,
// so a test can tell that the declared variable is protected on its own.
vi.mock("../services/active-account.js", async () => {
  const actual = await vi.importActual<typeof import("../services/active-account.js")>(
    "../services/active-account.js",
  );
  return {
    ...actual,
    accountCredentialEnvVarFor: (adapterType: string) =>
      adapterType === "declaring_local" ? "DECLARED_SIGN_IN_TOKEN" : actual.accountCredentialEnvVarFor(adapterType),
  };
});

import {
  applyRunScopedMentionedSkillKeys,
  extractMentionedSkillIdsFromSources,
  resolveExecutionRunAdapterConfig,
  withoutProtectedRoutineEnv,
} from "../services/heartbeat.ts";

/** Resolves plain values as they are and each secret reference to "resolved:<key>", marking it secret. */
function fakeEnvResolver() {
  return vi.fn(async (_companyId: string, envValue: unknown) => {
    const env: Record<string, string> = {};
    const secretKeys = new Set<string>();
    for (const [key, binding] of Object.entries(envValue as Record<string, unknown>)) {
      if (typeof binding === "string") {
        env[key] = binding;
      } else if ((binding as { type?: string }).type === "plain") {
        env[key] = String((binding as { value: unknown }).value);
      } else {
        env[key] = `resolved:${key}`;
        secretKeys.add(key);
      }
    }
    return { env, secretKeys };
  });
}

describe("resolveExecutionRunAdapterConfig", () => {
  it("overlays project env on top of agent env and unions secret keys", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: {
        env: {
          SHARED_KEY: "agent",
          AGENT_ONLY: "agent-only",
        },
        other: "value",
      },
      secretKeys: new Set(["AGENT_SECRET"]),
    });
    const resolveEnvBindings = vi.fn().mockResolvedValue({
      env: {
        SHARED_KEY: "project",
        PROJECT_ONLY: "project-only",
      },
      secretKeys: new Set(["PROJECT_SECRET"]),
    });

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      executionRunConfig: { env: { SHARED_KEY: "agent" } },
      projectEnv: { SHARED_KEY: "project" },
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
      } as any,
    });

    expect(result.resolvedConfig).toMatchObject({
      other: "value",
      env: {
        SHARED_KEY: "project",
        AGENT_ONLY: "agent-only",
        PROJECT_ONLY: "project-only",
      },
    });
    expect(Array.from(result.secretKeys).sort()).toEqual(["AGENT_SECRET", "PROJECT_SECRET"]);
  });

  it("skips project env resolution when the project has no bindings", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { env: { AGENT_ONLY: "agent-only" } },
      secretKeys: new Set<string>(),
    });
    const resolveEnvBindings = vi.fn();

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      executionRunConfig: { env: { AGENT_ONLY: "agent-only" } },
      projectEnv: null,
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
      } as any,
    });

    expect(result.resolvedConfig.env).toEqual({ AGENT_ONLY: "agent-only" });
    expect(resolveEnvBindings).not.toHaveBeenCalled();
  });

  it("overlays a stage's env last and adds its secret keys for masking", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { env: { SHARED_KEY: "agent", AGENT_ONLY: "agent-only" } },
      secretKeys: new Set(["AGENT_SECRET"]),
    });
    const resolveEnvBindings = fakeEnvResolver();

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      executionRunConfig: { env: { SHARED_KEY: "agent" } },
      projectEnv: { SHARED_KEY: "project", PROJECT_ONLY: "project-only" },
      routineEnv: {
        SHARED_KEY: { type: "plain", value: "stage" },
        DEPLOY_TOKEN: { type: "secret_ref", secretId: "secret-1", version: "latest" },
      },
      secretsSvc: { resolveAdapterConfigForRuntime, resolveEnvBindings } as any,
    });

    expect(result.resolvedConfig.env).toEqual({
      SHARED_KEY: "stage",
      AGENT_ONLY: "agent-only",
      PROJECT_ONLY: "project-only",
      DEPLOY_TOKEN: "resolved:DEPLOY_TOKEN",
    });
    expect(Array.from(result.secretKeys).sort()).toEqual(["AGENT_SECRET", "DEPLOY_TOKEN"]);
  });

  it("never lets a stage's env set a sign-in variable or a PAPERCLIP_ name", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { env: { ANTHROPIC_API_KEY: "agent-key", CLAUDE_CONFIG_DIR: "/agent/claude" } },
      secretKeys: new Set<string>(),
    });
    const resolveEnvBindings = fakeEnvResolver();
    const tokenRef = { type: "secret_ref", secretId: "secret-1", version: "latest" };

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      executionRunConfig: {},
      projectEnv: null,
      adapterType: "declaring_local",
      routineEnv: {
        REGION: "eu-west-1",
        ANTHROPIC_API_KEY: "stage-key",
        anthropic_auth_token: "stage-key",
        CLAUDE_CONFIG_DIR: "/stage/claude",
        CLAUDE_CODE_OAUTH_TOKEN: tokenRef,
        CODEX_HOME: "/stage/codex",
        OPENAI_API_KEY: tokenRef,
        GEMINI_API_KEY: "stage-key",
        DECLARED_SIGN_IN_TOKEN: "stage-token",
        PAPERCLIP_API_KEY: tokenRef,
        PAPERCLIP_RUN_ID: "stage-run",
        Paperclip_Task_Id: "stage-task",
      },
      secretsSvc: { resolveAdapterConfigForRuntime, resolveEnvBindings } as any,
    });

    expect(result.resolvedConfig.env).toEqual({
      ANTHROPIC_API_KEY: "agent-key",
      CLAUDE_CONFIG_DIR: "/agent/claude",
      REGION: "eu-west-1",
    });
    // Dropped names are never resolved, so a secret behind one is not read.
    expect(resolveEnvBindings).toHaveBeenCalledTimes(1);
    expect(Object.keys(resolveEnvBindings.mock.calls[0]![1] as Record<string, unknown>)).toEqual(["REGION"]);
    expect(result.secretKeys.size).toBe(0);
  });

  it("drops the account variable the agent's adapter declares, and only for that adapter", () => {
    const env = { DECLARED_SIGN_IN_TOKEN: "stage-token", REGION: "eu-west-1" };
    expect(withoutProtectedRoutineEnv(env, { adapterType: "declaring_local" })).toEqual({ REGION: "eu-west-1" });
    expect(withoutProtectedRoutineEnv(env, { adapterType: "codex_local" })).toEqual(env);
    expect(withoutProtectedRoutineEnv({ PAPERCLIP_AGENT_ID: "x" }, { adapterType: "codex_local" })).toBeNull();
  });

  it("drops a stage's cloud sign-in names when the agent's own env runs on Bedrock", async () => {
    const stageEnv = { AWS_ACCESS_KEY_ID: "stage-key", REGION: "eu-west-1" };
    const run = (agentEnv: Record<string, string>) =>
      resolveExecutionRunAdapterConfig({
        companyId: "company-1",
        executionRunConfig: {},
        projectEnv: null,
        routineEnv: stageEnv,
        secretsSvc: {
          resolveAdapterConfigForRuntime: vi.fn().mockResolvedValue({ config: { env: agentEnv }, secretKeys: new Set() }),
          resolveEnvBindings: fakeEnvResolver(),
        } as any,
      });

    expect((await run({ CLAUDE_CODE_USE_BEDROCK: "1" })).resolvedConfig.env).toEqual({
      CLAUDE_CODE_USE_BEDROCK: "1",
      REGION: "eu-west-1",
    });
    expect((await run({ CLAUDE_CODE_USE_BEDROCK: "0" })).resolvedConfig.env).toEqual({
      CLAUDE_CODE_USE_BEDROCK: "0",
      ...stageEnv,
    });
  });

  it("names the variable and the stage when a secret the stage gives is gone", async () => {
    const resolveEnvBindings = vi.fn(async (_companyId: string, envValue: Record<string, unknown>) => {
      if ("DEPLOY_TOKEN" in envValue) throw notFound("Secret not found");
      return { env: { REGION: "eu-west-1" }, secretKeys: new Set<string>() };
    });
    const describeRoutineEnvSource = vi.fn(async () => 'stage "Deploy" in pipeline "Releases"');

    await expect(resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      executionRunConfig: {},
      projectEnv: null,
      routineEnv: {
        REGION: "eu-west-1",
        DEPLOY_TOKEN: { type: "secret_ref", secretId: "secret-1", version: "latest" },
      },
      describeRoutineEnvSource,
      secretsSvc: {
        resolveAdapterConfigForRuntime: vi.fn().mockResolvedValue({ config: {}, secretKeys: new Set() }),
        resolveEnvBindings,
      } as any,
    })).rejects.toThrow(
      'This run could not start: the secret behind DEPLOY_TOKEN, set by stage "Deploy" in pipeline "Releases", ' +
        "no longer exists. Tasks already started keep the stage's settings from when they started.",
    );
  });

  it("keeps a stage's env out of the env it hands on for runtime services", async () => {
    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      executionRunConfig: {},
      projectEnv: null,
      routineEnv: { SHARED_KEY: "stage", DEPLOY_TOKEN: { type: "secret_ref", secretId: "secret-1", version: "latest" } },
      secretsSvc: {
        resolveAdapterConfigForRuntime: vi.fn().mockResolvedValue({
          config: { env: { SHARED_KEY: "agent", AGENT_ONLY: "agent-only" } },
          secretKeys: new Set(),
        }),
        resolveEnvBindings: fakeEnvResolver(),
      } as any,
    });

    expect(result.resolvedConfig.env).toMatchObject({ SHARED_KEY: "stage", DEPLOY_TOKEN: "resolved:DEPLOY_TOKEN" });
    expect(result.envWithoutRoutineEnv).toEqual({ SHARED_KEY: "agent", AGENT_ONLY: "agent-only" });
  });
});

describe("extractMentionedSkillIdsFromSources", () => {
  it("collects explicit skill mention ids across issue sources", () => {
    const releaseHref = buildSkillMentionHref("skill-1", "release-changelog");
    const browserHref = buildSkillMentionHref("skill-2", "agent-browser");

    expect(
      extractMentionedSkillIdsFromSources([
        `Please use [/release-changelog](${releaseHref})`,
        `And also [/agent-browser](${browserHref})`,
        `Duplicate mention [/release-changelog](${releaseHref})`,
      ]),
    ).toEqual(["skill-1", "skill-2"]);
  });

  // Regression: malformed mentions like `skill://paperclip-create-agent` (slug
  // as host instead of `skill://<uuid>?s=<slug>`) used to flow into a Postgres
  // uuid-typed `inArray` query and crash run startup with
  // `invalid input syntax for type uuid`. The resolver now filters extracted
  // ids through `isUuidLike` before the query.
  it("filters slug-form skill mentions out before they reach a uuid query", () => {
    const validUuid = "b405cd52-ddfb-490a-a769-7a34a0f26ea8";
    const validHref = buildSkillMentionHref(validUuid, "real-skill");
    const malformedHref = "skill://paperclip-create-agent";

    const extracted = extractMentionedSkillIdsFromSources([
      `Real mention [/real-skill](${validHref})`,
      `Malformed mention [/paperclip-create-agent](${malformedHref})`,
    ]);
    expect(extracted).toContain(validUuid);
    expect(extracted).toContain("paperclip-create-agent");

    const safeForUuidQuery = extracted.filter(isUuidLike);
    expect(safeForUuidQuery).toEqual([validUuid]);
  });
});

describe("applyRunScopedMentionedSkillKeys", () => {
  it("adds mentioned skills without mutating the original config", () => {
    const originalConfig = {
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: ["paperclipai/paperclip/paperclip"],
      },
    };

    const updatedConfig = applyRunScopedMentionedSkillKeys(originalConfig, [
      "company/company-1/release-changelog",
      "paperclipai/paperclip/paperclip",
      "company/company-1/release-changelog",
    ]);

    expect(updatedConfig).toEqual({
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: [
          "paperclipai/paperclip/paperclip",
          "company/company-1/release-changelog",
        ],
      },
    });
    expect(originalConfig).toEqual({
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: ["paperclipai/paperclip/paperclip"],
      },
    });
  });
});
