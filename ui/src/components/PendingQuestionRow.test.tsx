// @vitest-environment node

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PendingCompanyInteraction } from "../api/issues";
import { PendingQuestionRow } from "./PendingQuestionRow";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={typeof to === "string" ? to : ""} {...props}>
      {children}
    </a>
  ),
}));

function interaction(overrides: Partial<PendingCompanyInteraction> = {}): PendingCompanyInteraction {
  return {
    id: "int-1",
    companyId: "c-1",
    issueId: "iss-1",
    kind: "ask_user_questions",
    status: "pending",
    continuationPolicy: "wake_assignee",
    createdAt: new Date(Date.now() - 18 * 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
    title: "Which calendar should I use?",
    payload: { questions: [] },
    issueIdentifier: "PRINT-224",
    issueTitle: "Set up the booking flow",
    createdByAgentId: "ag-1",
    ...overrides,
  } as PendingCompanyInteraction;
}

describe("PendingQuestionRow", () => {
  it("deep-links to the answering card on the issue thread", () => {
    const html = renderToStaticMarkup(
      <PendingQuestionRow interaction={interaction()} agentName="Priya" />,
    );
    expect(html).toContain("/issues/PRINT-224#interaction-int-1");
    expect(html).toContain("Priya");
    expect(html).toContain("is asking a question");
    expect(html).toContain("Which calendar should I use?");
    expect(html).toContain("Answer");
  });

  it("prefixes the link for portfolio pages and survives a missing agent name", () => {
    const html = renderToStaticMarkup(
      <PendingQuestionRow
        interaction={interaction({ kind: "request_confirmation", title: null })}
        hrefPrefix="/ACME"
      />,
    );
    expect(html).toContain("/ACME/issues/PRINT-224#interaction-int-1");
    expect(html).toContain("An agent");
    expect(html).toContain("wants a go-ahead");
    expect(html).toContain("Decide");
  });
});
