import { afterEach, describe, expect, it } from "vitest";
import { protectedRoutineEnvNames } from "../services/routine-env-protection.js";

const previousBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
const previousVertex = process.env.CLAUDE_CODE_USE_VERTEX;

afterEach(() => {
  if (previousBedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
  else process.env.CLAUDE_CODE_USE_BEDROCK = previousBedrock;
  if (previousVertex === undefined) delete process.env.CLAUDE_CODE_USE_VERTEX;
  else process.env.CLAUDE_CODE_USE_VERTEX = previousVertex;
});

const CLOUD_NAMES = ["AWS_ACCESS_KEY_ID", "AWS_PROFILE", "GOOGLE_APPLICATION_CREDENTIALS", "CLOUD_ML_REGION"];

describe("protectedRoutineEnvNames", () => {
  it("protects the tools' own settings, the program and what loads into it, in any letter case", () => {
    const names = [
      "ANTHROPIC_BASE_URL",
      "claude_config_dir",
      "CODEX_HOME",
      "OpenAI_Base_Url",
      "GEMINI_CLI_HOME",
      "GOOGLE_GENAI_USE_VERTEXAI",
      "CURSOR_API_KEY",
      "XAI_API_KEY",
      "KIMI_API_KEY",
      "OPENCODE_CONFIG",
      "BUN_INSTALL",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
      "PAPERCLIP_API_URL",
      "USE_LOCAL_OAUTH",
      "AWS_BEARER_TOKEN_BEDROCK",
      "CLOUDSDK_AUTH_ACCESS_TOKEN",
      "CODE_ASSIST_ENDPOINT",
      "OPENROUTER_API_KEY",
      "QWEN_HOME",
      "https_proxy",
      "NODE_TLS_REJECT_UNAUTHORIZED",
      "SSL_CERT_FILE",
      "Path",
      "COMSPEC",
      "NODE_OPTIONS",
      "PYTHONPATH",
      "HOME",
      "USERPROFILE",
      "XDG_CONFIG_HOME",
      "AGENT_HOME",
      // Switchboard's list adds the one Claude token file name no prefix covers.
      "CCR_OAUTH_TOKEN_FILE",
    ];
    expect(protectedRoutineEnvNames([...names, "REGION", "DEPLOY_TOKEN", "AWS_ACCESS_KEY_ID"])).toEqual(names);
  });

  it("protects the cloud sign-in names only for a run on Bedrock or Vertex", () => {
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.CLAUDE_CODE_USE_VERTEX;
    expect(protectedRoutineEnvNames(CLOUD_NAMES, { baseEnv: {} })).toEqual([]);
    expect(protectedRoutineEnvNames(CLOUD_NAMES, { baseEnv: { CLAUDE_CODE_USE_BEDROCK: "1" } })).toEqual(CLOUD_NAMES);
    expect(protectedRoutineEnvNames(CLOUD_NAMES, { baseEnv: { claude_code_use_vertex: "true" } })).toEqual(CLOUD_NAMES);
    expect(protectedRoutineEnvNames(CLOUD_NAMES, { baseEnv: { CLAUDE_CODE_USE_BEDROCK: "0" } })).toEqual([]);

    // A run inherits the server's environment unless its own env says otherwise.
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    expect(protectedRoutineEnvNames(CLOUD_NAMES, { baseEnv: {} })).toEqual(CLOUD_NAMES);
    expect(protectedRoutineEnvNames(CLOUD_NAMES, { baseEnv: { CLAUDE_CODE_USE_BEDROCK: "" } })).toEqual([]);

    // Saving a stage checks only the names protected for every run.
    expect(protectedRoutineEnvNames(CLOUD_NAMES)).toEqual([]);
  });
});
