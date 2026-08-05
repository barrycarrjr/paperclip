// @vitest-environment node

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PendingReviewGate } from "../api/issues";
import { ReviewGateRow } from "./ReviewGateRow";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={typeof to === "string" ? to : ""} {...props}>
      {children}
    </a>
  ),
}));

function gate(overrides: Partial<PendingReviewGate> = {}): PendingReviewGate {
  return {
    issueId: "iss-1",
    companyId: "c-1",
    identifier: "PRINT-214",
    title: "Refund policy page rewrite",
    priority: "medium",
    stageType: "review",
    participantUserId: "u-1",
    reviewInstructions: null,
    updatedAt: new Date(Date.now() - 80 * 60_000).toISOString(),
    ...overrides,
  };
}

describe("ReviewGateRow", () => {
  it("says the work wants a review and links to the issue", () => {
    const html = renderToStaticMarkup(<ReviewGateRow gate={gate()} />);
    expect(html).toContain("/issues/PRINT-214");
    expect(html).toContain("finished work and wants your review");
    expect(html).toContain("Refund policy page rewrite");
    expect(html).toContain("last activity");
    expect(html).toContain("Review");
  });

  it("distinguishes approval gates and prefixes portfolio links", () => {
    const html = renderToStaticMarkup(
      <ReviewGateRow
        gate={gate({ stageType: "approval", reviewInstructions: "Check the totals" })}
        hrefPrefix="/ACME"
      />,
    );
    expect(html).toContain("/ACME/issues/PRINT-214");
    expect(html).toContain("needs your approval to move forward");
    expect(html).toContain("Check the totals");
    expect(html).toContain("Approve");
  });
});
