import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { storePluginSecret, pluginStorageOwner } from "../services/plugin-secret-storage.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const key = createHash("sha256").update("example-message").digest("hex");
function fixture() {
  const rows = new Map<string, any>(); const values = new Map<string, string>();
  const svc = {
    getByName: async (company: string, name: string) => rows.get(`${company}:${name}`) ?? null,
    create: async (company: string, input: any) => {
      const id = `${company}:${input.name}`;
      if (rows.has(id)) throw new Error("Conflict");
      const row = { id, companyId: company, ...input }; delete row.value;
      rows.set(id, row); values.set(id, input.value); return row;
    },
    resolveSecretValue: async (company: string, id: string) => {
      if (rows.get(id)?.companyId !== company) throw new Error("Wrong company");
      return values.get(id)!;
    },
  };
  return { svc: svc as any, rows, values };
}
describe("immutable encrypted plugin storage", () => {
  it("returns references, deduplicates and separates companies/plugins without overwriting material", async () => {
    const { svc, rows } = fixture(); const input = { companyId, key, value: "synthetic protected source" };
    const first = await storePluginSecret(svc, "plugin-a", input);
    expect(await storePluginSecret(svc, "plugin-a", input)).toEqual(first);
    expect(JSON.stringify(first)).not.toContain(input.value);
    await expect(storePluginSecret(svc, "plugin-a", { ...input, value: "changed source" })).rejects.toThrow("different material");
    expect(await storePluginSecret(svc, "plugin-b", input)).not.toEqual(first);
    expect(await storePluginSecret(svc, "plugin-a", { ...input, companyId: "22222222-2222-4222-8222-222222222222" })).not.toEqual(first);
    expect(rows.size).toBe(3);
    expect(rows.get(first.secretRef).description).toBe(pluginStorageOwner("plugin-a"));
  });
  it("rejects invalid scope, key and oversized material without leaking values", async () => {
    const { svc, rows } = fixture();
    for (const input of [{ companyId: "other", key, value: "example" }, { companyId, key: "../unsafe", value: "example" },
      { companyId, key, value: "" }, { companyId, key, value: "x".repeat(262145) }]) {
      await expect(storePluginSecret(svc, "plugin-a", input)).rejects.toThrow("Invalid encrypted");
    }
    expect(rows.size).toBe(0);
  });
});
