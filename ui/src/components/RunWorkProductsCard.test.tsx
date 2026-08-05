// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { IssueWorkProduct } from "@paperclipai/shared";

const mockWorkProducts: IssueWorkProduct[] = [];
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mockWorkProducts }),
}));

import { RunWorkProductsCard } from "./RunWorkProductsCard";

function workProduct(overrides: Partial<IssueWorkProduct> = {}): IssueWorkProduct {
  // No `as` cast on the return: the compiler must reject reviewState values
  // the server can never send (an earlier draft asserted an impossible one).
  const base: IssueWorkProduct = {
    id: "wp-1",
    companyId: "c-1",
    projectId: null,
    issueId: "iss-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "document",
    provider: "paperclip",
    externalId: null,
    title: "Quote for Dana",
    url: "https://example.com/quote",
    status: "draft",
    reviewState: "needs_board_review",
    isPrimary: false,
    healthStatus: "unknown",
    summary: "Three banners, pickup Thursday.",
    metadata: null,
    createdByRunId: "run-1",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return { ...base, ...overrides };
}

describe("RunWorkProductsCard", () => {
  it("renders nothing when the run made nothing", () => {
    mockWorkProducts.length = 0;
    expect(renderToStaticMarkup(<RunWorkProductsCard runId="run-1" />)).toBe("");
  });

  it("lists what the run made with review chips and links", () => {
    mockWorkProducts.length = 0;
    mockWorkProducts.push(workProduct());
    const html = renderToStaticMarkup(<RunWorkProductsCard runId="run-1" />);
    expect(html).toContain("Made by this run");
    expect(html).toContain("Quote for Dana");
    expect(html).toContain("https://example.com/quote");
    expect(html).toContain("awaiting review");
    expect(html).toContain("Three banners, pickup Thursday.");
  });
});
