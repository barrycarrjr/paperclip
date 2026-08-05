// @vitest-environment node

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RunDocumentRevision } from "../api/heartbeats";

const mockRevisions: RunDocumentRevision[] = [];
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mockRevisions }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={typeof to === "string" ? to : ""} {...props}>
      {children}
    </a>
  ),
}));

import { RunDocumentsCard } from "./RunDocumentsCard";

function revision(overrides: Partial<RunDocumentRevision> = {}): RunDocumentRevision {
  return {
    revisionId: "rev-1",
    documentId: "doc-1",
    issueId: "iss-1",
    issueIdentifier: "PRINT-218",
    issueTitle: "Overnight support sweep",
    key: "continuation-summary",
    title: null,
    revisionNumber: 4,
    changeSummary: "Two replies sent, refund case flagged for Barry.",
    createdAt: new Date(Date.now() - 6 * 60_000).toISOString(),
    ...overrides,
  };
}

describe("RunDocumentsCard", () => {
  it("renders nothing when the run wrote no documents", () => {
    mockRevisions.length = 0;
    expect(renderToStaticMarkup(<RunDocumentsCard runId="run-1" />)).toBe("");
  });

  it("links the handoff notes to the issue's document anchor", () => {
    mockRevisions.length = 0;
    mockRevisions.push(revision());
    const html = renderToStaticMarkup(<RunDocumentsCard runId="run-1" />);
    expect(html).toContain("Notes updated by this run");
    expect(html).toContain("Handoff notes");
    expect(html).toContain("/issues/PRINT-218#document-continuation-summary");
    expect(html).toContain("Two replies sent, refund case flagged for Barry.");
  });

  it("collapses several revisions of the same document into one row", () => {
    mockRevisions.length = 0;
    mockRevisions.push(revision({ revisionId: "rev-2", revisionNumber: 5 }), revision());
    const html = renderToStaticMarkup(<RunDocumentsCard runId="run-1" />);
    expect((html.match(/Handoff notes/g) ?? []).length).toBe(1);
    expect(html).toContain(">1<");
  });
});
