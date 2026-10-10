import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companySecrets, companySecretVersions } from "@paperclipai/db";
import type { AgentEnvConfig, EnvBinding, SecretProvider } from "@paperclipai/shared";
import { envBindingSchema, SECRET_NAME_MAX_LENGTH } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { getSecretProvider, listSecretProviders } from "../secrets/provider-registry.js";

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_ENV_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;
const REDACTED_SENTINEL = "***REDACTED***";
const SECRET_KEY_MAX_LENGTH = 120;
const SECRET_KEY_UNIQUE_INDEX = "company_secrets_company_key_uq";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type SecretReadDb = Pick<Db | DbTransaction, "select">;

type CanonicalEnvBinding =
  | { type: "plain"; value: string }
  | {
      type: "secret_ref";
      secretId?: string;
      secretName?: string;
      version: number | "latest";
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isSensitiveEnvKey(key: string) {
  return SENSITIVE_ENV_KEY_RE.test(key);
}

// Takes the same short time however long the name. The name is cut before any
// pattern runs on it (no name the API accepts is longer, so their keys are
// unchanged), and the dashes at either end are counted off instead of being
// matched by /-+$/, which starts again from every dash of a long run.
export function normalizeSecretKey(input: string) {
  const key = input
    .slice(0, SECRET_NAME_MAX_LENGTH)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-");
  let start = 0;
  let end = key.length;
  while (start < end && key[start] === "-") start += 1;
  while (end > start && key[end - 1] === "-") end -= 1;
  return key.slice(start, end).slice(0, SECRET_KEY_MAX_LENGTH);
}

function isSecretKeyConflict(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  const err = error as { code?: string; constraint?: string; constraint_name?: string };
  return err.code === "23505" && (err.constraint ?? err.constraint_name) === SECRET_KEY_UNIQUE_INDEX;
}

function canonicalizeBinding(binding: EnvBinding): CanonicalEnvBinding {
  if (typeof binding === "string") {
    return {
    type: "plain", value: binding };
  }
  if (binding.type === "plain") {
    return { type: "plain", value: String(binding.value) };
  }
  return {
    type: "secret_ref",
    ...(binding.secretId ? { secretId: binding.secretId } : {}),
    ...(binding.secretName ? { secretName: binding.secretName } : {}),
    version: binding.version ?? "latest",
  };
}

function collectSecretEnvKeys(adapterConfig: Record<string, unknown>) {
  const env = asRecord(adapterConfig.env);
  if (!env) return [];

  const refs: Array<{ secretId: string; envKey: string }> = [];
  for (const [envKey, rawBinding] of Object.entries(env)) {
    const parsed = envBindingSchema.safeParse(rawBinding);
    if (!parsed.success || typeof parsed.data === "string") continue;
    const binding = canonicalizeBinding(parsed.data);
    if (binding.type === "secret_ref" && binding.secretId) {
      refs.push({ secretId: binding.secretId, envKey });
    }
  }
  return refs;
}

export function secretService(db: Db) {
  type NormalizeEnvOptions = {
    strictMode?: boolean;
    fieldPath?: string;
  };

  async function getById(id: string, source: SecretReadDb = db) {
    return source
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getByName(companyId: string, name: string) {
    return db
      .select()
      .from(companySecrets)
      .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.name, name)))
      .then((rows) => rows[0] ?? null);
  }

  async function getByKey(companyId: string, key: string) {
    return db
      .select()
      .from(companySecrets)
      .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.key, key)))
      .then((rows) => rows[0] ?? null);
  }

  // A secret's key must be unique in its company, but nothing here shows it,
  // lets anyone set it, or reads it, so it must never be the reason a create
  // fails. The key a name maps to can already be held: a renamed secret keeps
  // the key it was created with, and migration 0102 gave older secrets keys
  // built from their names. The new secret's own id then makes its key unique.
  // keyWithId is that form, for when the key is taken after this check.
  async function deriveSecretKey(companyId: string, name: string, secretId: string) {
    const base = normalizeSecretKey(name);
    const keyWithId = base ? `${base}-${secretId}` : secretId;
    if (!base) return { key: keyWithId, keyWithId };
    const holder = await getByKey(companyId, base);
    return { key: holder ? keyWithId : base, keyWithId };
  }

  async function getSecretVersion(secretId: string, version: number) {
    return db
      .select()
      .from(companySecretVersions)
      .where(
        and(
          eq(companySecretVersions.secretId, secretId),
          eq(companySecretVersions.version, version),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function assertSecretInCompany(companyId: string, secretId: string, source: SecretReadDb = db) {
    const secret = await getById(secretId, source);
    if (!secret) throw notFound("Secret not found");
    if (secret.companyId !== companyId) throw unprocessable("Secret must belong to same company");
    return secret;
  }

  async function resolveSecretIdForBinding(
    companyId: string,
    binding: { secretId?: string; secretName?: string },
  ): Promise<string> {
    if (binding.secretId) return binding.secretId;
    const name = binding.secretName ?? "";
    if (!name) throw unprocessable("secret_ref must include secretId or secretName");
    const found = await getByName(companyId, name);
    if (!found) {
      throw unprocessable(
        `Secret not found in company: ${name}. Ask the board to create it before binding.`,
      );
    }
    return found.id;
  }

  async function resolveSecretValue(
    companyId: string,
    secretId: string,
    version: number | "latest",
  ): Promise<string> {
    const secret = await assertSecretInCompany(companyId, secretId);
    const resolvedVersion = version === "latest" ? secret.latestVersion : version;
    const versionRow = await getSecretVersion(secret.id, resolvedVersion);
    if (!versionRow) throw notFound("Secret version not found");
    const provider = getSecretProvider(secret.provider as SecretProvider);
    return provider.resolveVersion({
      material: versionRow.material as Record<string, unknown>,
      externalRef: secret.externalRef,
    });
  }

  async function normalizeEnvConfig(
    companyId: string,
    envValue: unknown,
    opts?: NormalizeEnvOptions,
  ): Promise<AgentEnvConfig> {
    const record = asRecord(envValue);
    if (!record) throw unprocessable(`${opts?.fieldPath ?? "env"} must be an object`);

    const normalized: AgentEnvConfig = {};
    for (const [key, rawBinding] of Object.entries(record)) {
      if (!ENV_KEY_RE.test(key)) {
        throw unprocessable(`Invalid environment variable name: ${key}`);
      }

      const parsed = envBindingSchema.safeParse(rawBinding);
      if (!parsed.success) {
        throw unprocessable(`Invalid environment binding for key: ${key}`);
      }

      const binding = canonicalizeBinding(parsed.data as EnvBinding);
      if (binding.type === "plain") {
        if (opts?.strictMode && isSensitiveEnvKey(key) && binding.value.trim().length > 0) {
          throw unprocessable(
            `Strict secret mode requires secret references for sensitive key: ${key}`,
          );
        }
        if (binding.value === REDACTED_SENTINEL) {
          throw unprocessable(`Refusing to persist redacted placeholder for key: ${key}`);
        }
        normalized[key] = binding;
        continue;
      }

      const resolvedSecretId = await resolveSecretIdForBinding(companyId, binding);
      if (binding.secretId) {
        await assertSecretInCompany(companyId, resolvedSecretId);
      }
      normalized[key] = {
        type: "secret_ref",
        secretId: resolvedSecretId,
        version: binding.version,
      };
    }
    return normalized;
  }

  async function normalizeAdapterConfigForPersistenceInternal(
    companyId: string,
    adapterConfig: Record<string, unknown>,
    opts?: { strictMode?: boolean },
  ) {
    const normalized = { ...adapterConfig };
    if (!Object.prototype.hasOwnProperty.call(adapterConfig, "env")) {
      return normalized;
    }
    normalized.env = await normalizeEnvConfig(companyId, adapterConfig.env, opts);
    return normalized;
  }

  async function listAgentReferencesBySecretId(companyId: string) {
    const agentRows = await db
      .select({
        id: agents.id,
        name: agents.name,
        adapterConfig: agents.adapterConfig,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    const references = new Map<
      string,
      Array<{ agentId: string; agentName: string; envKeys: string[] }>
    >();

    for (const agent of agentRows) {
      const refs = collectSecretEnvKeys(agent.adapterConfig ?? {});
      const envKeysBySecretId = new Map<string, string[]>();
      for (const ref of refs) {
        envKeysBySecretId.set(ref.secretId, [
          ...(envKeysBySecretId.get(ref.secretId) ?? []),
          ref.envKey,
        ]);
      }

      for (const [secretId, envKeys] of envKeysBySecretId) {
        references.set(secretId, [
          ...(references.get(secretId) ?? []),
          {
            agentId: agent.id,
            agentName: agent.name,
            envKeys: Array.from(new Set(envKeys)).sort(),
          },
        ]);
      }
    }

    return references;
  }

  return {
    listProviders: () => listSecretProviders(),

    list: (companyId: string) =>
      db
        .select()
        .from(companySecrets)
        .where(eq(companySecrets.companyId, companyId))
        .orderBy(desc(companySecrets.createdAt)),

    listWithAgentReferences: async (companyId: string) => {
      const [secrets, references] = await Promise.all([
        db
          .select()
          .from(companySecrets)
          .where(eq(companySecrets.companyId, companyId))
          .orderBy(desc(companySecrets.createdAt)),
        listAgentReferencesBySecretId(companyId),
      ]);

      return secrets.map((secret) => ({
        ...secret,
        agentReferences: references.get(secret.id) ?? [],
      }));
    },

    getById,
    getByName,
    resolveSecretIdForBinding,
    resolveSecretValue,

    create: async (
      companyId: string,
      input: {
        name: string;
        provider: SecretProvider;
        value: string;
        description?: string | null;
        externalRef?: string | null;
      },
      actor?: { userId?: string | null; agentId?: string | null },
    ) => {
      const existing = await getByName(companyId, input.name);
      if (existing) throw conflict(`Secret already exists: ${input.name}`);
      const secretId = randomUUID();
      const { key, keyWithId } = await deriveSecretKey(companyId, input.name, secretId);

      const provider = getSecretProvider(input.provider);
      const prepared = await provider.createVersion({
        value: input.value,
        externalRef: input.externalRef ?? null,
      });

      const insertSecret = (secretKey: string) => db.transaction(async (tx) => {
        const secret = await tx
          .insert(companySecrets)
          .values({
            id: secretId,
            companyId,
            key: secretKey,
            name: input.name,
            provider: input.provider,
            externalRef: prepared.externalRef,
            latestVersion: 1,
            description: input.description ?? null,
            createdByAgentId: actor?.agentId ?? null,
            createdByUserId: actor?.userId ?? null,
          })
          .returning()
          .then((rows) => rows[0]);

        await tx.insert(companySecretVersions).values({
          secretId: secret.id,
          version: 1,
          material: prepared.material,
          valueSha256: prepared.valueSha256,
          createdByAgentId: actor?.agentId ?? null,
          createdByUserId: actor?.userId ?? null,
        });

        return secret;
      });

      try {
        return await insertSecret(key);
      } catch (error) {
        // Two names that map to the same free key, created at the same moment,
        // both pass the check in deriveSecretKey, and the second insert breaks
        // the unique key index. No other secret can hold a key ending in this
        // secret's id, so one retry is enough.
        if (key === keyWithId || !isSecretKeyConflict(error)) throw error;
        return insertSecret(keyWithId);
      }
    },

    rotate: async (
      secretId: string,
      input: { value: string; externalRef?: string | null },
      actor?: { userId?: string | null; agentId?: string | null },
    ) => {
      const secret = await getById(secretId);
      if (!secret) throw notFound("Secret not found");
      const provider = getSecretProvider(secret.provider as SecretProvider);
      const nextVersion = secret.latestVersion + 1;
      const prepared = await provider.createVersion({
        value: input.value,
        externalRef: input.externalRef ?? secret.externalRef ?? null,
      });

      return db.transaction(async (tx) => {
        await tx.insert(companySecretVersions).values({
          secretId: secret.id,
          version: nextVersion,
          material: prepared.material,
          valueSha256: prepared.valueSha256,
          createdByAgentId: actor?.agentId ?? null,
          createdByUserId: actor?.userId ?? null,
        });

        const updated = await tx
          .update(companySecrets)
          .set({
            latestVersion: nextVersion,
            externalRef: prepared.externalRef,
            updatedAt: new Date(),
          })
          .where(eq(companySecrets.id, secret.id))
          .returning()
          .then((rows) => rows[0] ?? null);

        if (!updated) throw notFound("Secret not found");
        return updated;
      });
    },

    update: async (
      secretId: string,
      patch: { name?: string; description?: string | null; externalRef?: string | null },
    ) => {
      const secret = await getById(secretId);
      if (!secret) throw notFound("Secret not found");

      if (patch.name && patch.name !== secret.name) {
        const duplicate = await getByName(secret.companyId, patch.name);
        if (duplicate && duplicate.id !== secret.id) {
          throw conflict(`Secret already exists: ${patch.name}`);
        }
      }

      return db
        .update(companySecrets)
        .set({
          name: patch.name ?? secret.name,
          description:
            patch.description === undefined ? secret.description : patch.description,
          externalRef:
            patch.externalRef === undefined ? secret.externalRef : patch.externalRef,
          updatedAt: new Date(),
        })
        .where(eq(companySecrets.id, secret.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    remove: async (secretId: string) => {
      const secret = await getById(secretId);
      if (!secret) return null;
      await db.delete(companySecrets).where(eq(companySecrets.id, secretId));
      return secret;
    },

    normalizeAdapterConfigForPersistence: async (
      companyId: string,
      adapterConfig: Record<string, unknown>,
      opts?: { strictMode?: boolean },
    ) => normalizeAdapterConfigForPersistenceInternal(companyId, adapterConfig, opts),

    normalizeEnvBindingsForPersistence: async (
      companyId: string,
      envValue: unknown,
      opts?: NormalizeEnvOptions,
    ) => normalizeEnvConfig(companyId, envValue, opts),

    normalizeHireApprovalPayloadForPersistence: async (
      companyId: string,
      payload: Record<string, unknown>,
      opts?: { strictMode?: boolean },
    ) => {
      const normalized = { ...payload };
      const adapterConfig = asRecord(payload.adapterConfig);
      if (adapterConfig) {
        normalized.adapterConfig = await normalizeAdapterConfigForPersistenceInternal(
          companyId,
          adapterConfig,
          opts,
        );
      }
      return normalized;
    },

    // Upstream also writes each reference to company_secret_bindings here. No
    // migration creates that table in this fork and nothing reads it, so only
    // upstream's check is kept: every secret the env references must belong
    // to the company, read through the caller's transaction when given one.
    syncEnvBindingsForTarget: async (
      companyId: string,
      target: { targetType: string; targetId: string; pathPrefix?: string },
      envValue: unknown,
      options?: { db?: SecretReadDb },
    ) => {
      const record = asRecord(envValue) ?? {};
      const pathPrefix = target.pathPrefix ?? "env";
      const refs: Array<{ secretId: string; configPath: string; versionSelector: number | "latest" }> = [];
      for (const [key, rawBinding] of Object.entries(record)) {
        const parsed = envBindingSchema.safeParse(rawBinding);
        if (!parsed.success) continue;
        const binding = canonicalizeBinding(parsed.data as EnvBinding);
        if (binding.type !== "secret_ref") continue;
        const secretId = await resolveSecretIdForBinding(companyId, binding);
        await assertSecretInCompany(companyId, secretId, options?.db ?? db);
        refs.push({ secretId, configPath: `${pathPrefix}.${key}`, versionSelector: binding.version });
      }
      return refs;
    },
    resolveEnvBindings: async (companyId: string, envValue: unknown): Promise<{ env: Record<string, string>; secretKeys: Set<string> }> => {
      const record = asRecord(envValue);
      if (!record) return { env: {} as Record<string, string>, secretKeys: new Set<string>() };
      const resolved: Record<string, string> = {};
      const secretKeys = new Set<string>();

      for (const [key, rawBinding] of Object.entries(record)) {
        if (!ENV_KEY_RE.test(key)) {
          throw unprocessable(`Invalid environment variable name: ${key}`);
        }
        const parsed = envBindingSchema.safeParse(rawBinding);
        if (!parsed.success) {
          throw unprocessable(`Invalid environment binding for key: ${key}`);
        }
        const binding = canonicalizeBinding(parsed.data as EnvBinding);
        if (binding.type === "plain") {
          resolved[key] = binding.value;
        } else {
          const secretId = await resolveSecretIdForBinding(companyId, binding);
          resolved[key] = await resolveSecretValue(companyId, secretId, binding.version);
          secretKeys.add(key);
        }
      }
      return { env: resolved, secretKeys };
    },

    resolveAdapterConfigForRuntime: async (companyId: string, adapterConfig: Record<string, unknown>): Promise<{ config: Record<string, unknown>; secretKeys: Set<string> }> => {
      const resolved = { ...adapterConfig };
      const secretKeys = new Set<string>();
      if (!Object.prototype.hasOwnProperty.call(adapterConfig, "env")) {
        return { config: resolved, secretKeys };
      }
      const record = asRecord(adapterConfig.env);
      if (!record) {
        resolved.env = {};
        return { config: resolved, secretKeys };
      }
      const env: Record<string, string> = {};
      for (const [key, rawBinding] of Object.entries(record)) {
        if (!ENV_KEY_RE.test(key)) {
          throw unprocessable(`Invalid environment variable name: ${key}`);
        }
        const parsed = envBindingSchema.safeParse(rawBinding);
        if (!parsed.success) {
          throw unprocessable(`Invalid environment binding for key: ${key}`);
        }
        const binding = canonicalizeBinding(parsed.data as EnvBinding);
        if (binding.type === "plain") {
          env[key] = binding.value;
        } else {
          const secretId = await resolveSecretIdForBinding(companyId, binding);
          env[key] = await resolveSecretValue(companyId, secretId, binding.version);
          secretKeys.add(key);
        }
      }
      resolved.env = env;
      return { config: resolved, secretKeys };
    },
  };
}
