// @vitest-environment node

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AttentionRow as AttentionRowData } from "@paperclipai/shared";
import { AttentionRow, formatWaited } from "./AttentionRow";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={typeof to === "string" ? to : ""} {...props}>
      {children}
    </a>
  ),
}));

const NOW = 1_785_000_000_000;

function row(overrides: Partial<AttentionRowData> = {}): AttentionRowData {
  return {
    key: "question:iss-1",
    kind: "question",
    companyId: "c-1",
    title: "Which supplier?",
    detail: "Pool house pre-build checklist",
    askedBy: null,
    blocking: "waiting",
    blockedSinceMs: NOW - 90 * 60_000,
    count: 1,
    consequence: "The agent carried on; your answer steers what it does next.",
    href: "/issues/PER-10#interaction-abc",
    createdAtMs: NOW - 90 * 60_000,
    updatedAtMs: NOW - 90 * 60_000,
    ...overrides,
  };
}

describe("formatWaited", () => {
  it("reads in the largest sensible unit", () => {
    expect(formatWaited(NOW - 30_000, NOW)).toBe("just now");
    expect(formatWaited(NOW - 12 * 60_000, NOW)).toBe("12m");
    expect(formatWaited(NOW - 3 * 3600_000, NOW)).toBe("3h");
    expect(formatWaited(NOW - 50 * 3600_000, NOW)).toBe("2d");
  });
  it("is silent when nothing is waiting", () => {
    expect(formatWaited(null, NOW)).toBeNull();
  });
});

describe("AttentionRow", () => {
  it("shows the ask, the context, the consequence and where to act", () => {
    const html = renderToStaticMarkup(<AttentionRow row={row()} nowMs={NOW} />);
    expect(html).toContain("Which supplier?");
    expect(html).toContain("Pool house pre-build checklist");
    expect(html).toContain("steers what it does next");
    expect(html).toContain("/issues/PER-10#interaction-abc");
    expect(html).toContain("Answer");
    expect(html).toContain("waiting 1h");
  });

  it("calls out a stopped agent with how long it has been halted", () => {
    const html = renderToStaticMarkup(
      <AttentionRow row={row({ blocking: "stopped", blockedSinceMs: NOW - 3 * 3600_000 })} nowMs={NOW} />,
    );
    expect(html).toContain("stopped 3h");
    // "waiting" wording is for the non-blocking tier only.
    expect(html).not.toContain("waiting 3h");
  });

  it("collapses repeats into a count instead of extra rows", () => {
    const html = renderToStaticMarkup(
      <AttentionRow row={row({ count: 3, title: "3 questions on PER-10" })} nowMs={NOW} />,
    );
    expect(html).toContain("3 questions on PER-10");
    expect(html).toContain(">3<");
  });

  it("labels each kind with its own action word", () => {
    const approval = renderToStaticMarkup(
      <AttentionRow row={row({ kind: "approval", title: "Board Approval: buy printer" })} nowMs={NOW} />,
    );
    expect(approval).toContain("Decide");
    const failure = renderToStaticMarkup(
      <AttentionRow row={row({ kind: "run_failure", title: "Sadie failed 5 times" })} nowMs={NOW} />,
    );
    expect(failure).toContain("Open run");
  });

  it("prefixes links on portfolio surfaces", () => {
    const html = renderToStaticMarkup(
      <AttentionRow row={row()} hrefPrefix="/ACME" nowMs={NOW} />,
    );
    expect(html).toContain("/ACME/issues/PER-10#interaction-abc");
  });
});
