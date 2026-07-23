/**
 * Plugin secrets host-side handler — resolves secret references through the
 * Paperclip secret provider system.
 *
 * When a plugin worker calls `ctx.secrets.resolve(secretRef)`, the JSON-RPC
 * request arrives at the host with `{ secretRef }`. This module provides the
 * concrete `HostServices.secrets` adapter that:
 *
 * 1. Parses the `secretRef` string to identify the secret.
 * 2. Looks up the secret record and its latest version in the database.
 * 3. Delegates to the configured `SecretProviderModule` to decrypt /
 *    resolve the raw value.
 * 4. Returns the resolved plaintext value to the worker.
 *
 * ## Secret Reference Format
 *
 * A `secretRef` is a **secret UUID** — the primary key (`id`) of a row in
 * the `company_secrets` table. Operators place these UUIDs into plugin
 * config values; plugin workers resolve them at execution time via
 * `ctx.secrets.resolve(secretId)`.
 *
 * ## Security Invariants
 *
 * - Resolved values are **never** logged, persisted, or included in error
 *   messages (per PLUGIN_SPEC.md §22).
 * - The handler is capability-gated: only plugins with `secrets.read-ref`
 *   declared in their manifest may call it (enforced by `host-client-factory`).
 * - The host handler itself does not cache resolved values. Each call goes
 *   through the secret provider to honour rotation.
 * - Rate limiting is split in two: a tight budget for refs outside the
 *   plugin's own config (UUID enumeration) and a generous backstop for refs
 *   inside it (a plugin stuck in a resolve loop). See the constants below.
 *
 * @see PLUGIN_SPEC.md §22 — Secrets
 * @see host-client-factory.ts — capability gating
 * @see services/secrets.ts — secretService used by agent env bindings
 */

import { eq, and, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySecrets, companySecretVersions, pluginConfig } from "@paperclipai/db";
import type { SecretProvider } from "@paperclipai/shared";
import { getSecretProvider } from "../secrets/provider-registry.js";
import { logger } from "../middleware/logger.js";
import { pluginRegistryService } from "./plugin-registry.js";
import {
  collectSecretRefPaths,
  isUuidSecretRef,
  readConfigValueAtPath,
} from "./json-schema-secret-refs.js";

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/**
 * Create a sanitised error that never leaks secret material.
 * Only the ref identifier is included; never the resolved value.
 */
function secretNotFound(secretRef: string): Error {
  const err = new Error(`Secret not found: ${secretRef}`);
  err.name = "SecretNotFoundError";
  return err;
}

function secretVersionNotFound(secretRef: string): Error {
  const err = new Error(`No version found for secret: ${secretRef}`);
  err.name = "SecretVersionNotFoundError";
  return err;
}

function invalidSecretRef(secretRef: string): Error {
  const err = new Error(`Invalid secret reference: ${secretRef}`);
  err.name = "InvalidSecretRefError";
  return err;
}

function rateLimitExceeded(): Error {
  const err = new Error("Rate limit exceeded for secret resolution");
  err.name = "RateLimitExceededError";
  return err;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Extract secret reference UUIDs from a plugin's configJson, scoped to only
 * the fields annotated with `format: "secret-ref"` in the schema.
 *
 * When no schema is provided, falls back to collecting all UUID-shaped strings
 * (backwards-compatible for plugins without a declared instanceConfigSchema).
 */
export function extractSecretRefsFromConfig(
  configJson: unknown,
  schema?: Record<string, unknown> | null,
): Set<string> {
  const refs = new Set<string>();
  if (configJson == null || typeof configJson !== "object") return refs;

  const secretPaths = collectSecretRefPaths(schema);

  // If schema declares secret-ref paths, extract only those values.
  if (secretPaths.size > 0) {
    for (const dotPath of secretPaths) {
      const current = readConfigValueAtPath(configJson as Record<string, unknown>, dotPath);
      if (typeof current === "string" && isUuidSecretRef(current)) {
        refs.add(current);
      }
    }
    return refs;
  }

  // Fallback: no schema or no secret-ref annotations — collect all UUIDs.
  // This preserves backwards compatibility for plugins that omit
  // instanceConfigSchema.
  function walkAll(value: unknown): void {
    if (typeof value === "string") {
      if (isUuidSecretRef(value)) refs.add(value);
    } else if (Array.isArray(value)) {
      for (const item of value) walkAll(item);
    } else if (value !== null && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) walkAll(v);
    }
  }

  walkAll(configJson);
  return refs;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Input shape for the `secrets.resolve` handler.
 *
 * Matches `WorkerToHostMethods["secrets.resolve"][0]` from `protocol.ts`.
 */
export interface PluginSecretsResolveParams {
  /** The secret reference string (a secret UUID). */
  secretRef: string;
}

/**
 * Options for creating the plugin secrets handler.
 */
export interface PluginSecretsHandlerOptions {
  /** Database connection. */
  db: Db;
  /**
   * The plugin ID using this handler.
   * Used for logging context only; never included in error payloads
   * that reach the plugin worker.
   */
  pluginId: string;
}

/**
 * The `HostServices.secrets` adapter for the plugin host-client factory.
 */
export interface PluginSecretsService {
  /**
   * Resolve a secret reference to its current plaintext value.
   *
   * @param params - Contains the `secretRef` (UUID of the secret)
   * @returns The resolved secret value
   * @throws {Error} If the secret is not found, has no versions, or
   *   the provider fails to resolve
   */
  resolve(params: PluginSecretsResolveParams): Promise<string>;
}

/** Simple sliding-window rate limiter for secret resolution attempts. */
function createRateLimiter(maxAttempts: number, windowMs: number) {
  const attempts = new Map<string, number[]>();

  return {
    check(key: string): boolean {
      const now = Date.now();
      const windowStart = now - windowMs;
      const existing = (attempts.get(key) ?? []).filter((ts) => ts > windowStart);
      if (existing.length >= maxAttempts) return false;
      existing.push(now);
      attempts.set(key, existing);
      return true;
    },
  };
}

/** Window both rate-limit buckets slide over. */
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Budget for attempts that name a secret this plugin is *not* configured to
 * use. Guessing UUIDs is the attack this bucket exists to stop, so it stays
 * tight. A plugin that asks for a ref outside its own config is either
 * misconfigured or probing.
 */
const UNKNOWN_REF_LIMIT = 30;

/**
 * Backstop for refs that *are* in this plugin's own config. These resolutions
 * are legitimate and can be frequent: a mail plugin resolves its IMAP password
 * on every connection, so an operator triaging a queue while background polls
 * run needs dozens a minute. Charging them against the enumeration budget above
 * is what made ordinary bursts fail with a bridge 502, so this ceiling only
 * catches a plugin stuck in a resolve loop. Sized off a real install whose
 * busiest minute wanted roughly 225 resolutions (several mailboxes polling,
 * IMAP idle notifications, and an operator clicking through a triage queue),
 * with headroom on top; a genuine runaway loop blows past it in a second.
 */
const KNOWN_REF_LIMIT = 1_200;

/**
 * Create a `HostServices.secrets` adapter for a specific plugin.
 *
 * The returned service looks up secrets by UUID, fetches the latest version
 * material, and delegates to the appropriate `SecretProviderModule` for
 * decryption.
 *
 * @example
 * ```ts
 * const secretsHandler = createPluginSecretsHandler({ db, pluginId });
 * const handlers = createHostClientHandlers({
 *   pluginId,
 *   capabilities: manifest.capabilities,
 *   services: {
 *     secrets: secretsHandler,
 *     // ...
 *   },
 * });
 * ```
 *
 * @param options - Database connection and plugin identity
 * @returns A `PluginSecretsService` suitable for `HostServices.secrets`
 */
export function createPluginSecretsHandler(
  options: PluginSecretsHandlerOptions,
): PluginSecretsService {
  const { db, pluginId } = options;
  const registry = pluginRegistryService(db);

  // Two separate budgets. Enumeration attempts (refs outside this plugin's own
  // config) are the thing worth throttling hard; resolutions of the plugin's
  // own configured refs only need a runaway-loop backstop.
  const unknownRefLimiter = createRateLimiter(UNKNOWN_REF_LIMIT, RATE_LIMIT_WINDOW_MS);
  const knownRefLimiter = createRateLimiter(KNOWN_REF_LIMIT, RATE_LIMIT_WINDOW_MS);

  /** Charge an off-config attempt and throw once the budget is spent. */
  function chargeUnknownRefAttempt(): void {
    if (!unknownRefLimiter.check(pluginId)) {
      throw rateLimitExceeded();
    }
  }

  // A plugin in a resolve loop keeps hitting the backstop, so warn at most once
  // per window rather than once per rejected call.
  let lastBackstopWarnAt = 0;

  let cachedAllowedRefs: Set<string> | null = null;
  let cachedAllowedRefsExpiry = 0;
  const CONFIG_CACHE_TTL_MS = 30_000; // 30 seconds, matches event bus TTL

  return {
    async resolve(params: PluginSecretsResolveParams): Promise<string> {
      const { secretRef } = params;

      // ---------------------------------------------------------------
      // 1. Validate the ref format
      // ---------------------------------------------------------------
      if (!secretRef || typeof secretRef !== "string" || secretRef.trim().length === 0) {
        chargeUnknownRefAttempt();
        throw invalidSecretRef(secretRef ?? "<empty>");
      }

      const trimmedRef = secretRef.trim();

      if (!isUuidSecretRef(trimmedRef)) {
        chargeUnknownRefAttempt();
        throw invalidSecretRef(trimmedRef);
      }

      // ---------------------------------------------------------------
      // 1b. Scope check — only allow secrets referenced in this plugin's config
      // ---------------------------------------------------------------
      const now = Date.now();
      if (!cachedAllowedRefs || now > cachedAllowedRefsExpiry) {
        const [configRow, plugin] = await Promise.all([
          db
            .select()
            .from(pluginConfig)
            .where(eq(pluginConfig.pluginId, pluginId))
            .then((rows) => rows[0] ?? null),
          registry.getById(pluginId),
        ]);

        const schema = (plugin?.manifestJson as unknown as Record<string, unknown> | null)
          ?.instanceConfigSchema as Record<string, unknown> | undefined;
        cachedAllowedRefs = extractSecretRefsFromConfig(configRow?.configJson, schema);
        cachedAllowedRefsExpiry = now + CONFIG_CACHE_TTL_MS;
      }

      if (!cachedAllowedRefs.has(trimmedRef)) {
        chargeUnknownRefAttempt();
        // Return "not found" to avoid leaking whether the secret exists
        throw secretNotFound(trimmedRef);
      }

      // ---------------------------------------------------------------
      // 1c. Runaway-loop backstop for in-config refs
      // ---------------------------------------------------------------
      if (!knownRefLimiter.check(pluginId)) {
        if (now - lastBackstopWarnAt > RATE_LIMIT_WINDOW_MS) {
          lastBackstopWarnAt = now;
          logger.warn(
            { pluginId, limit: KNOWN_REF_LIMIT, windowMs: RATE_LIMIT_WINDOW_MS },
            "plugin exceeded the secret resolution backstop for its own configured secrets",
          );
        }
        throw rateLimitExceeded();
      }

      // ---------------------------------------------------------------
      // 2. Look up the secret record by UUID
      // ---------------------------------------------------------------
      const secret = await db
        .select()
        .from(companySecrets)
        .where(eq(companySecrets.id, trimmedRef))
        .then((rows) => rows[0] ?? null);

      if (!secret) {
        throw secretNotFound(trimmedRef);
      }

      // ---------------------------------------------------------------
      // 3. Fetch the latest version's material
      // ---------------------------------------------------------------
      const versionRow = await db
        .select()
        .from(companySecretVersions)
        .where(
          and(
            eq(companySecretVersions.secretId, secret.id),
            eq(companySecretVersions.version, secret.latestVersion),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!versionRow) {
        throw secretVersionNotFound(trimmedRef);
      }

      // ---------------------------------------------------------------
      // 4. Resolve through the appropriate secret provider
      // ---------------------------------------------------------------
      const provider = getSecretProvider(secret.provider as SecretProvider);
      const resolved = await provider.resolveVersion({
        material: versionRow.material as Record<string, unknown>,
        externalRef: secret.externalRef,
      });

      return resolved;
    },
  };
}
