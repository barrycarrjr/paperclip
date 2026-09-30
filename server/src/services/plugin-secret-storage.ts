import { createHash } from "node:crypto";
import type { secretService } from "./secrets.js";

type Secrets = Pick<ReturnType<typeof secretService>, "getByName" | "create" | "resolveSecretValue">;
export const pluginStorageOwner = (pluginId: string) => `Encrypted storage owned by plugin:${pluginId}`;

/** Immutable, namespaced encrypted storage. No secret values enter activity or error payloads. */
export async function storePluginSecret(secrets: Secrets, pluginId: string,
  input: { companyId: string; key: string; value: string }) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.companyId ?? "") ||
      !/^[a-f0-9]{64}$/.test(input.key ?? "") || typeof input.value !== "string" ||
      input.value.length < 1 || Buffer.byteLength(input.value, "utf8") > 262144) {
    throw new Error("Invalid encrypted plugin storage request");
  }
  const name = `PLUGIN_${createHash("sha256").update(pluginId).digest("hex").slice(0, 16)}_${input.key}`;
  let existing = await secrets.getByName(input.companyId, name);
  if (!existing) {
    try {
      existing = await secrets.create(input.companyId, { name, value: input.value, provider: "local_encrypted",
        description: pluginStorageOwner(pluginId) });
    } catch {
      // Concurrent duplicate intake may have won. Never rotate or overwrite it.
      existing = await secrets.getByName(input.companyId, name);
      if (!existing) throw new Error("Encrypted plugin storage could not be saved");
    }
  }
  if (existing.description !== pluginStorageOwner(pluginId)) throw new Error("Encrypted storage ownership mismatch");
  const stored = await secrets.resolveSecretValue(input.companyId, existing.id, "latest");
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  if (digest(stored) !== digest(input.value)) throw new Error("Encrypted storage key already holds different material");
  return { secretRef: existing.id };
}
