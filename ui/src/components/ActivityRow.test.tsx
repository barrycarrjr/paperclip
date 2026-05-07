// @vitest-environment node

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ActivityEvent } from "@paperclipai/shared";
import { ActivityRow } from "./ActivityRow";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={typeof to === "string" ? to : ""} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("./Identity", () => ({
  Identity: ({ name }: { name: string }) => <span>{name}</span>,
}));

function buildEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: "evt-1",
    companyId: "c-1",
    actorType: "user",
    actorId: "u-1",
    entityType: "issue",
    entityId: "issue-1",
    action: "issue.updated",
    details: null,
    createdAt: new Date("2026-05-07T12:00:00Z"),
    ...overrides,
  } as ActivityEvent;
}

function countNestedAnchors(html: string): number {
  // Count occurrences of an opening <a inside an already-open <a, by scanning.
  let depth = 0;
  let nested = 0;
  const re = /<\/?a\b[^>]*>/g;
  for (const match of html.matchAll(re)) {
    const isClose = match[0].startsWith("</");
    if (isClose) {
      if (depth > 0) depth--;
    } else {
      if (depth > 0) nested++;
      depth++;
    }
  }
  return nested;
}

describe("ActivityRow", () => {
  it("does not nest anchor tags when an issue link row also contains issue reference pills", () => {
    const event = buildEvent({
      action: "issue.referenced",
      details: {
        addedReferencedIssues: [
          { id: "issue-2", identifier: "PER-2", title: "Other task" },
        ],
        removedReferencedIssues: [
          { id: "issue-3", identifier: "PER-3", title: "Removed task" },
        ],
      },
    });
    const html = renderToStaticMarkup(
      <ActivityRow
        event={event}
        agentMap={new Map()}
        userProfileMap={new Map()}
        entityNameMap={new Map([["issue:issue-1", "PER-1"]])}
        entityTitleMap={new Map([["issue:issue-1", "Primary task"]])}
      />,
    );

    expect(countNestedAnchors(html)).toBe(0);
    expect(html).toContain('href="/issues/PER-1"');
    expect(html).toContain('href="/issues/PER-2"');
    expect(html).toContain('href="/issues/PER-3"');
  });

  it("renders a non-link wrapper when the activity has no navigable entity", () => {
    const event = buildEvent({ entityType: "unknown", entityId: "x" });
    const html = renderToStaticMarkup(
      <ActivityRow
        event={event}
        agentMap={new Map()}
        userProfileMap={new Map()}
        entityNameMap={new Map()}
        entityTitleMap={new Map()}
      />,
    );

    expect(html).not.toContain("<a");
  });
});
