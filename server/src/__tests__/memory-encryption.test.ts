import { afterAll, beforeAll, describe, expect, it } from "vitest";

const priorMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;

beforeAll(() => {
  process.env.PAPERCLIP_SECRETS_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
});

afterAll(() => {
  if (priorMasterKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  else process.env.PAPERCLIP_SECRETS_MASTER_KEY = priorMasterKey;
});

describe("text-at-rest encryption", () => {
  it("round-trips and never stores the plaintext", async () => {
    const { encryptTextAtRest, decryptTextAtRest, isEncryptedTextAtRest } = await import(
      "../secrets/local-encrypted-provider.js"
    );
    const plain = "Preferred courier is DHL, account 12345";
    const stored = encryptTextAtRest(plain);
    expect(stored.startsWith("enc1:")).toBe(true);
    expect(isEncryptedTextAtRest(stored)).toBe(true);
    expect(stored).not.toContain("DHL");
    expect(Buffer.from(stored.slice(5), "base64").toString("utf8")).not.toContain("DHL");
    expect(decryptTextAtRest(stored)).toBe(plain);
    // Fresh IV each time: two encryptions of the same text differ.
    expect(encryptTextAtRest(plain)).not.toBe(stored);
  });

  it("passes legacy plaintext rows through unchanged", async () => {
    const { decryptTextAtRest, isEncryptedTextAtRest } = await import(
      "../secrets/local-encrypted-provider.js"
    );
    expect(isEncryptedTextAtRest("just a note")).toBe(false);
    expect(decryptTextAtRest("just a note")).toBe("just a note");
  });

  it("rejects tampered material", async () => {
    const { encryptTextAtRest, decryptTextAtRest } = await import(
      "../secrets/local-encrypted-provider.js"
    );
    const stored = encryptTextAtRest("secret");
    const material = JSON.parse(Buffer.from(stored.slice(5), "base64").toString("utf8"));
    material.ciphertext = Buffer.from("xx").toString("base64");
    const tampered = `enc1:${Buffer.from(JSON.stringify(material)).toString("base64")}`;
    expect(() => decryptTextAtRest(tampered)).toThrow();
    expect(() => decryptTextAtRest("enc1:not-json")).toThrow();
  });
});

describe("memoryService encrypts content at rest", () => {
  function fakeDb() {
    const rows: Array<Record<string, unknown>> = [];
    let lastInsert: Record<string, unknown> | null = null;
    let lastSet: Record<string, unknown> | null = null;
    const db = {
      insert() {
        return {
          values(v: Record<string, unknown>) {
            lastInsert = v;
            const row = { id: "mem-1", description: null, updatedAt: new Date(), ...v };
            rows.push(row);
            return {
              returning: () => Promise.resolve([row]),
              onConflictDoUpdate: () => ({ returning: () => Promise.resolve([row]) }),
            };
          },
        };
      },
      update() {
        return {
          set(v: Record<string, unknown>) {
            lastSet = v;
            return {
              where: () => ({
                returning: () => Promise.resolve([{ ...rows[0], ...v }]),
              }),
            };
          },
        };
      },
      select() {
        return {
          from() {
            const chain = {
              where: () => chain,
              orderBy: () => chain,
              limit: () => Promise.resolve(rows),
              then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
            };
            return chain;
          },
        };
      },
      delete() {
        return { where: () => ({ returning: () => Promise.resolve([rows[0]]) }) };
      },
    };
    return { db, rows, getInsert: () => lastInsert, getSet: () => lastSet };
  }

  it("writes ciphertext and reads plaintext back", async () => {
    const { memoryService } = await import("../services/memories.js");
    const fake = fakeDb();
    const svc = memoryService(fake.db as never);
    const created = await svc.create(
      "company-1",
      { kind: "project", name: "Courier", content: "Use DHL account 12345" },
      { agentId: null, userId: "user-1" },
    );
    expect(created.content).toBe("Use DHL account 12345");
    const stored = fake.getInsert()!.content as string;
    expect(stored.startsWith("enc1:")).toBe(true);
    expect(stored).not.toContain("DHL");

    const listed = await svc.list("company-1");
    expect(listed[0].content).toBe("Use DHL account 12345");

    const found = await svc.list("company-1", { q: "dhl" });
    expect(found).toHaveLength(1);
    const missed = await svc.list("company-1", { q: "fedex" });
    expect(missed).toHaveLength(0);

    const updated = await svc.update("mem-1", { content: "Use FedEx now" });
    expect(updated!.content).toBe("Use FedEx now");
    const setContent = fake.getSet()!.content as string;
    expect(setContent.startsWith("enc1:")).toBe(true);
    expect(setContent).not.toContain("FedEx");
  });
});
