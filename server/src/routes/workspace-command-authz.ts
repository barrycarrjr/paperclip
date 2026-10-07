import type { Request } from "express";
import { forbidden } from "../errors.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function prefixPath(prefix: string, key: string) {
  return prefix.length > 0 ? `${prefix}.${key}` : key;
}

function collectWorkspaceStrategyCommandPaths(raw: unknown, prefix: string): string[] {
  if (!isRecord(raw)) return [];
  const paths: string[] = [];
  if (hasOwn(raw, "provisionCommand")) {
    paths.push(prefixPath(prefix, "provisionCommand"));
  }
  if (hasOwn(raw, "teardownCommand")) {
    paths.push(prefixPath(prefix, "teardownCommand"));
  }
  return paths;
}

function collectExecutionWorkspaceConfigCommandPaths(raw: unknown, prefix: string): string[] {
  if (!isRecord(raw)) return [];
  const paths: string[] = [];
  if (hasOwn(raw, "provisionCommand")) {
    paths.push(prefixPath(prefix, "provisionCommand"));
  }
  if (hasOwn(raw, "teardownCommand")) {
    paths.push(prefixPath(prefix, "teardownCommand"));
  }
  if (hasOwn(raw, "cleanupCommand")) {
    paths.push(prefixPath(prefix, "cleanupCommand"));
  }
  return paths;
}

export function assertNoAgentHostWorkspaceCommandMutation(req: Request, paths: string[]) {
  if (req.actor.type !== "agent" || paths.length === 0) return;
  throw forbidden(
    `Agent keys cannot modify host-executed workspace commands (${paths.join(", ")}).`,
  );
}

// Adapter settings that decide what a local adapter runs on the host.
const AGENT_ADAPTER_HOST_EXECUTION_KEYS = [
  "command",
  "hermesCommand",
  "args",
  "extraArgs",
  "filesystemSandboxCommand",
] as const;

function isSecretRefBinding(value: unknown) {
  return isRecord(value) && value.type === "secret_ref";
}

/**
 * Paths in an adapterConfig that an agent key must not set on another agent:
 * the host command and its arguments, any env value that is not a secret_ref
 * (a plain NODE_OPTIONS or PATH runs code too), and any process adapter config.
 * secret_ref env bindings stay allowed, because secret values are board-created.
 */
export function collectAgentAdapterHostExecutionPaths(
  adapterType: string,
  adapterConfig: unknown,
): string[] {
  if (!isRecord(adapterConfig)) return [];
  if (adapterType === "process") {
    return Object.keys(adapterConfig).map((key) => prefixPath("adapterConfig", key));
  }
  const paths: string[] = AGENT_ADAPTER_HOST_EXECUTION_KEYS
    .filter((key) => hasOwn(adapterConfig, key))
    .map((key) => prefixPath("adapterConfig", key));
  if (hasOwn(adapterConfig, "env")) {
    const env = adapterConfig.env;
    if (!isRecord(env)) {
      paths.push("adapterConfig.env");
    } else {
      for (const [key, value] of Object.entries(env)) {
        if (!isSecretRefBinding(value)) paths.push(prefixPath("adapterConfig.env", key));
      }
    }
  }
  return paths;
}

export function assertNoAgentHostExecutionMutation(req: Request, paths: string[]) {
  if (req.actor.type !== "agent" || paths.length === 0) return;
  throw forbidden(
    `Agent keys cannot set what an agent runs on the host (${paths.join(", ")}); ask a board member. Env vars can still be bound to secrets with secret_ref.`,
  );
}

export function collectAgentAdapterWorkspaceCommandPaths(adapterConfig: unknown): string[] {
  if (!isRecord(adapterConfig)) return [];
  return collectWorkspaceStrategyCommandPaths(
    adapterConfig.workspaceStrategy,
    "adapterConfig.workspaceStrategy",
  );
}

export function collectProjectExecutionWorkspaceCommandPaths(policy: unknown): string[] {
  if (!isRecord(policy)) return [];
  return collectWorkspaceStrategyCommandPaths(
    policy.workspaceStrategy,
    "executionWorkspacePolicy.workspaceStrategy",
  );
}

export function collectProjectWorkspaceCommandPaths(
  workspacePatch: unknown,
  prefix = "",
): string[] {
  if (!isRecord(workspacePatch)) return [];
  return hasOwn(workspacePatch, "cleanupCommand")
    ? [prefixPath(prefix, "cleanupCommand")]
    : [];
}

export function collectIssueWorkspaceCommandPaths(input: {
  executionWorkspaceSettings?: unknown;
  assigneeAdapterOverrides?: unknown;
}): string[] {
  const paths: string[] = [];
  if (isRecord(input.executionWorkspaceSettings)) {
    paths.push(
      ...collectWorkspaceStrategyCommandPaths(
        input.executionWorkspaceSettings.workspaceStrategy,
        "executionWorkspaceSettings.workspaceStrategy",
      ),
    );
  }
  if (isRecord(input.assigneeAdapterOverrides)) {
    const adapterConfig = input.assigneeAdapterOverrides.adapterConfig;
    if (isRecord(adapterConfig)) {
      paths.push(
        ...collectWorkspaceStrategyCommandPaths(
          adapterConfig.workspaceStrategy,
          "assigneeAdapterOverrides.adapterConfig.workspaceStrategy",
        ),
      );
    }
  }
  return paths;
}

export function collectExecutionWorkspaceCommandPaths(input: {
  config?: unknown;
  metadata?: unknown;
}): string[] {
  const paths: string[] = [];
  if (input.config !== undefined) {
    paths.push(...collectExecutionWorkspaceConfigCommandPaths(input.config, "config"));
  }
  if (isRecord(input.metadata) && hasOwn(input.metadata, "config")) {
    paths.push(...collectExecutionWorkspaceConfigCommandPaths(input.metadata.config, "metadata.config"));
  }
  return paths;
}
