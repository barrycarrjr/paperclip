/**
 * Which names a routine's env (a pipeline stage's secrets and values) may not
 * set.
 *
 * A stage's env is written by a person editing the pipeline and handed to the
 * stage's agent when its automation runs. It may give the agent values for its
 * work, but it must not change whose account the run signs in with, send the
 * run's traffic somewhere else, swap the program that runs, or load code into
 * it. Used when a run starts (the names are dropped) and when a stage's env is
 * saved (the names are refused, so they are not dropped without a word).
 *
 * Names match in any letter case, because Windows treats environment names
 * that way.
 *
 * @module server/services/routine-env-protection
 */

import { accountCredentialEnvVarFor } from "./active-account.js";
import { signInEnvVarNames } from "./switchboard.js";

/** Every name starting with one of these is protected. */
const PROTECTED_PREFIXES = [
  // Each AI tool's own settings: its sign-in tokens, API keys, config folders,
  // and base URLs that would send the run's credential to another server.
  "ANTHROPIC_",
  "CLAUDE_",
  "CODEX_",
  "OPENAI_",
  "GEMINI_",
  "GOOGLE_GENAI_",
  "CURSOR_",
  "XAI_",
  "KIMI_",
  "OPENCODE_",
  // Runtime and loader settings that swap the program or load code into it.
  "BUN_",
  "LD_",
  "DYLD_",
  // What Paperclip sets for the run itself: its id, task, address and key.
  "PAPERCLIP_",
] as const;

/** These exact names are protected. */
const PROTECTED_NAMES = new Set([
  // Sign-in switches, tokens and endpoints of AI tools that no prefix covers.
  "USE_LOCAL_OAUTH",
  "USE_STAGING_OAUTH",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLOUDSDK_AUTH_ACCESS_TOKEN",
  "GOOGLE_GEMINI_BASE_URL",
  "GOOGLE_VERTEX_BASE_URL",
  "CODE_ASSIST_ENDPOINT",
  "OPENROUTER_API_KEY",
  "MOONSHOT_API_KEY",
  "ZAI_API_KEY",
  "MINIMAX_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "QWEN_HOME",
  // Proxies and trusted certificates, which could route the run's traffic,
  // its credential included, through someone else's server.
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  // Which program runs, and what loads into it.
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "COMSPEC",
  "NODE_OPTIONS",
  "PYTHONPATH",
  "PYTHONHOME",
  // Home and config folders, where the tools keep their stored sign-in.
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "AGENT_HOME",
]);

/**
 * Cloud sign-in names. Protected only when the run reaches its AI tool through
 * Bedrock or Vertex, because then they are the agent's sign-in; otherwise they
 * are ordinary values a stage may give the agent for its work.
 */
const CLOUD_SIGN_IN_NAMES = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_ROLE_ARN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "CLOUD_ML_REGION",
]);

const CLOUD_SIGN_IN_SWITCHES = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"] as const;

/** A switch counts as on unless it is empty or says no. */
function switchIsOn(value: unknown) {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && !["0", "false", "no", "off"].includes(normalized);
}

/**
 * Whether a run with this env reaches its AI tool through Bedrock or Vertex.
 * A switch the env sets, even to off, wins over the server's own environment,
 * which the run otherwise inherits.
 */
function runUsesCloudSignIn(baseEnv: Record<string, unknown>) {
  return CLOUD_SIGN_IN_SWITCHES.some((name) => {
    const ownKey = Object.keys(baseEnv).find((key) => key.toUpperCase() === name);
    return switchIsOn(ownKey !== undefined ? baseEnv[ownKey] : process.env[name]);
  });
}

export interface RoutineEnvProtectionOptions {
  /** The agent's adapter: the account variable it declares is protected too. */
  adapterType?: string | null;
  /**
   * The env the run has before the stage's is merged in (the agent's and the
   * project's). Given when a run starts, so the cloud sign-in names are
   * protected for a run on Bedrock or Vertex. Left out when a stage is saved,
   * where only the names protected for every run apply.
   */
  baseEnv?: Record<string, unknown> | null;
}

/** The names among `names` that a stage's env may not set. */
export function protectedRoutineEnvNames(
  names: Iterable<string>,
  options: RoutineEnvProtectionOptions = {},
): string[] {
  const exact = new Set(PROTECTED_NAMES);
  // Every sign-in variable Switchboard knows, which adds CCR_OAUTH_TOKEN_FILE.
  for (const name of signInEnvVarNames()) exact.add(name.toUpperCase());
  const declared = options.adapterType ? accountCredentialEnvVarFor(options.adapterType) : null;
  if (declared) exact.add(declared.toUpperCase());
  if (options.baseEnv && runUsesCloudSignIn(options.baseEnv)) {
    for (const name of CLOUD_SIGN_IN_NAMES) exact.add(name);
  }
  return [...names].filter((name) => {
    const upper = name.toUpperCase();
    return exact.has(upper) || PROTECTED_PREFIXES.some((prefix) => upper.startsWith(prefix));
  });
}
