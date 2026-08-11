import { describe, expect, it, vi } from "vitest";
import { ensureHqCompany } from "../services/instance-bootstrap.js";

/**
 * HQ ships with the software, but only onto a genuinely empty instance.
 * Promoting one of somebody's existing companies would hand it cross-company
 * read over all the others — too consequential to guess at.
 */

function fakeDb(opts: { root?: { id: string } | null; companyCount: number; onInsert?: () => void }) {
  const selectCalls: string[] = [];
  return {
    calls: selectCalls,
    select: (shape: Record<string, unknown>) => ({
      from: () => {
        const isCountQuery = "count" in shape;
        if (isCountQuery) {
          selectCalls.push("count");
          return Promise.resolve([{ count: opts.companyCount }]) as never;
        }
        selectCalls.push("root");
        return {
          where: () => ({
            limit: () => ({
              then: (fn: (rows: unknown[]) => unknown) => fn(opts.root ? [opts.root] : []),
            }),
          }),
        } as never;
      },
    }),
    insert: () => ({
      values: () => ({
        returning: () => ({
          then: (fn: (rows: unknown[]) => unknown) => {
            opts.onInsert?.();
            return fn([{ id: "new-hq" }]);
          },
        }),
      }),
    }),
  } as never;
}

describe("ensureHqCompany", () => {
  it("creates HQ on an instance with no companies at all", async () => {
    const onInsert = vi.fn();
    const result = await ensureHqCompany(fakeDb({ root: null, companyCount: 0, onInsert }));
    expect(onInsert).toHaveBeenCalledOnce();
    expect(result).toEqual({ created: true, id: "new-hq" });
  });

  it("does nothing when a portfolio root already exists", async () => {
    const onInsert = vi.fn();
    const result = await ensureHqCompany(
      fakeDb({ root: { id: "existing-hq" }, companyCount: 5, onInsert }),
    );
    expect(onInsert).not.toHaveBeenCalled();
    expect(result).toEqual({ created: false, id: "existing-hq" });
  });

  it("leaves an established instance alone rather than promoting someone's company", async () => {
    // No root, but companies exist. Choosing one would give it read access
    // across all the others — a human decision, not a startup side effect.
    const onInsert = vi.fn();
    const result = await ensureHqCompany(fakeDb({ root: null, companyCount: 4, onInsert }));
    expect(onInsert).not.toHaveBeenCalled();
    expect(result).toEqual({ created: false, id: null });
  });
});
