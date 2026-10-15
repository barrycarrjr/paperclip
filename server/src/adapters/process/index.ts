import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const processAdapter: ServerAdapterModule = {
  type: "process",
  description: "Executes an arbitrary shell command — escape hatch for cron-like jobs, custom scripts, or wrapping tools that don't fit a real adapter yet.",
  execute,
  testEnvironment,
  models: [],
  agentConfigurationDoc: `# process agent configuration

Adapter: process

Core fields:
- command (string, required): command to execute
- args (string[] | string, optional): command arguments
- cwd (string, optional): absolute working directory
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Runtime context:
- PAPERCLIP_WAKE_PAYLOAD_JSON: structured issue and comment wake payload, including correction intent
- PAPERCLIP_APPROVED_RULES_JSON: board-approved standing rules with provenance metadata
`,
};
