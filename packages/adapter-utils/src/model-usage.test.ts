import { describe, expect, it } from "vitest";
import { allocateModelCostCents, readModelUsage, sumModelUsage } from "./model-usage.js";
const row = { inputTokens: 5, outputTokens: 3, cachedInputTokens: 2, cacheCreationInputTokens: 7, costUsd: 0.004 };
describe("provider model totals", () => {
  it("preserves model counts and includes cache writes once in aggregate input", () => {
    const map = readModelUsage({ primary: row, reviewer: { ...row, costUsd: 0.006 } })!;
    expect(map.primary).toEqual(row);
    expect(sumModelUsage(map)).toEqual({ inputTokens: 24, outputTokens: 6, cachedInputTokens: 4 });
    expect(allocateModelCostCents(map, 1)).toEqual({ primary: 0, reviewer: 1 });
    expect(allocateModelCostCents(map, 0)).toEqual({ primary: 0, reviewer: 0 });
  });
  it("uses stable ties and preserves rounded aggregate cents rather than rounding every row", () => {
    const map = readModelUsage({ z: row, a: row, b: row })!;
    expect(allocateModelCostCents(map, 1)).toEqual({ a: 1, b: 0, z: 0 });
    expect(allocateModelCostCents(map, 2)).toEqual({ a: 1, b: 1, z: 0 });
    for (const total of [3, 7, 101, 2_147_483_647]) {
      expect(Object.values(allocateModelCostCents(map, total)!).reduce((sum, n) => sum + n, 0)).toBe(total);
    }
  });
  it.each([undefined, {}, [], { x: { ...row, inputTokens: -1 } }, { x: { ...row, costUsd: Infinity } },
    { x: { ...row, cachedInputTokens: undefined } }, { x: { ...row, outputTokens: 1.5 } },
    { x: row, y: { ...row, costUsd: "0.1" } }])("rejects incomplete/malformed whole reports %j", value => {
    expect(readModelUsage(value)).toBeNull();
  });
  it("does not invent a positive model allocation from zero cost weights or an invalid bill", () => {
    expect(allocateModelCostCents({ a: { ...row, costUsd: 0 } }, 1)).toBeNull();
    expect(allocateModelCostCents({ a: row }, Infinity)).toBeNull();
    expect(allocateModelCostCents({ a: row }, 1.1)).toBeNull();
  });
});
