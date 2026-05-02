/**
 * External MCP secrets — resolves the server-record's env / header bindings
 * to plaintext at spawn / request time, by routing through the existing
 * `secretService.resolveEnvBindings`. Same flow projects + agents use.
 *
 * Invariants:
 *  - Resolved values never appear in logs or error messages.
 *  - Each binding's secret is looked up against the **calling company's**
 *    vault by name (or by UUID), so the same MCP server config can serve
 *    multiple companies — each company supplies its own secret per name.
 *  - Caller's companyId must be in the server's `allowedCompanies` (or the
 *    list contains the portfolio-wide token).
 *  - Unknown / missing secrets surface a structured error with the binding
 *    name only (never the secret value).
 */

import type { Db } from "@paperclipai/db";
import {
  isCompanyAllowed,
  type ExternalMcpServerRecord,
} from "@paperclipai/shared";
import { secretService } from "./secrets.js";

export interface ExternalMcpResolveOptions {
  /**
   * Company calling into this MCP server. Must satisfy
   * `isCompanyAllowed(server.allowedCompanies, callerCompanyId)`.
   */
  callerCompanyId: string;
}

export interface ExternalMcpResolvedSecrets {
  env: Record<string, string>;
  headers: Record<string, string>;
  /** Keys whose value originated from a secret ref. Used by callers to scrub logs. */
  secretEnvKeys: Set<string>;
  secretHeaderKeys: Set<string>;
}

export class ExternalMcpAuthorizationError extends Error {
  readonly code = "ECOMPANY_NOT_ALLOWED";
  constructor(message: string) {
    super(message);
    this.name = "ExternalMcpAuthorizationError";
  }
}

export class ExternalMcpSecretResolutionError extends Error {
  readonly code = "ESECRET_RESOLUTION_FAILED";
  /** The binding name (env var / header) that failed. Never a value. */
  readonly bindingName: string;
  constructor(bindingName: string, message: string) {
    super(message);
    this.name = "ExternalMcpSecretResolutionError";
    this.bindingName = bindingName;
  }
}

function assertCompanyAllowed(server: ExternalMcpServerRecord, companyId: string): void {
  if (!isCompanyAllowed(server.allowedCompanies, companyId)) {
    throw new ExternalMcpAuthorizationError(
      `Company ${companyId} is not in allowedCompanies for MCP server "${server.key}"`,
    );
  }
}

/**
 * Names every secret-ref binding in the record so the caller can scrub
 * resolved values from logs without re-parsing.
 */
function collectSecretRefKeys(rec: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const [key, binding] of Object.entries(rec)) {
    if (
      binding &&
      typeof binding === "object" &&
      "type" in binding &&
      (binding as { type?: unknown }).type === "secret_ref"
    ) {
      out.add(key);
    }
  }
  return out;
}

export function externalMcpSecretsService(db: Db) {
  const secrets = secretService(db);

  return {
    async resolveBindings(
      server: ExternalMcpServerRecord,
      opts: ExternalMcpResolveOptions,
    ): Promise<ExternalMcpResolvedSecrets> {
      assertCompanyAllowed(server, opts.callerCompanyId);

      const secretEnvKeys = collectSecretRefKeys(server.envBindings);
      const secretHeaderKeys = collectSecretRefKeys(server.headerBindings);

      let envResult: { env: Record<string, string> };
      try {
        envResult = await secrets.resolveEnvBindings(
          opts.callerCompanyId,
          server.envBindings,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "env resolution failed";
        const offending = Array.from(secretEnvKeys).join(", ") || "(unknown)";
        throw new ExternalMcpSecretResolutionError(offending, `env binding(s) [${offending}] failed to resolve: ${message}`);
      }

      let headerResult: { env: Record<string, string> };
      try {
        headerResult = await secrets.resolveEnvBindings(
          opts.callerCompanyId,
          server.headerBindings,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "header resolution failed";
        const offending = Array.from(secretHeaderKeys).join(", ") || "(unknown)";
        throw new ExternalMcpSecretResolutionError(offending, `header binding(s) [${offending}] failed to resolve: ${message}`);
      }

      return {
        env: envResult.env,
        headers: headerResult.env,
        secretEnvKeys,
        secretHeaderKeys,
      };
    },

    assertCompanyAllowed,
  };
}

export type ExternalMcpSecretsService = ReturnType<typeof externalMcpSecretsService>;
