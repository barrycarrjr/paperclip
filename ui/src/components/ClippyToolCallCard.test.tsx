// @vitest-environment node

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ClippyToolCallCard } from "./ClippyToolCallCard";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={typeof to === "string" ? to : ""} {...props}>
      {children}
    </a>
  ),
}));

describe("ClippyToolCallCard", () => {
  it("shows a plain label and a read badge for a running lookup", () => {
    const html = renderToStaticMarkup(
      <ClippyToolCallCard
        name="list_issues"
        input={{ status: "backlog" }}
        status="pending"
        mutating={false}
        startedAt={Date.now() - 4000}
      />,
    );
    expect(html).toContain("Look up issues");
    expect(html).toContain(">read<");
    expect(html).toContain("running…");
  });

  it("marks mutating calls as doing something real", () => {
    const html = renderToStaticMarkup(
      <ClippyToolCallCard name="create_issue" input={{}} status="pending" mutating />,
    );
    expect(html).toContain("does something real");
  });

  it("shows a result preview on the card face when completed", () => {
    const html = renderToStaticMarkup(
      <ClippyToolCallCard
        name="get_issue"
        input={{}}
        status="completed"
        result={{ ok: true, data: { id: "iss-9", title: "Fix printer" } }}
      />,
    );
    expect(html).toContain("Fix printer");
  });

  it("links a drafted call to its approval instead of a raw marker", () => {
    const html = renderToStaticMarkup(
      <ClippyToolCallCard
        name="email-tools__send_email"
        input={{}}
        status="completed"
        result={{ ok: true, data: { drafted: true, approvalId: "ap-42" } }}
      />,
    );
    expect(html).toContain("waiting for your approval");
    expect(html).toContain("/approvals/ap-42");
    expect(html).toContain("Open approval");
  });

  it("renders denied state", () => {
    const html = renderToStaticMarkup(
      <ClippyToolCallCard
        name="create_issue"
        input={{}}
        status="denied"
        result={{ ok: false, data: "User denied this action." }}
      />,
    );
    expect(html).toContain("denied");
  });

  it("shows no read/write badge for plugin tools (the flag is untrustworthy there)", () => {
    const html = renderToStaticMarkup(
      <ClippyToolCallCard
        name="3cx-tools__pbx_click_to_call"
        input={{ number: "555" }}
        status="pending"
        mutating={false}
      />,
    );
    expect(html).not.toContain(">read<");
    expect(html).not.toContain("does something real");
  });

  it("says 'no result' for a historical call with no outcome instead of claiming it runs", () => {
    const html = renderToStaticMarkup(
      <ClippyToolCallCard name="get_issue" input={{}} status="interrupted" />,
    );
    expect(html).toContain("no result");
    expect(html).not.toContain("running…");
  });

  it("keeps the input summary on the collapsed header", () => {
    const html = renderToStaticMarkup(
      <ClippyToolCallCard
        name="get_issue"
        input={{ issueId: "iss-9" }}
        status="completed"
        result={{ ok: true, data: "found" }}
      />,
    );
    expect(html).toContain("issueId=&quot;iss-9&quot;");
  });

  it("extracts the approval link from the marker text the server actually streams", () => {
    const marker = [
      "[paperclip:tool-draft] queued for human approval",
      "Tool: email-tools__send_email",
      "Approval ID: ap-77",
      "",
      "The user must approve this draft before it executes.",
    ].join("\n");
    const html = renderToStaticMarkup(
      <ClippyToolCallCard
        name="email-tools__send_email"
        input={{}}
        status="completed"
        result={{ ok: true, data: marker }}
      />,
    );
    expect(html).toContain("/approvals/ap-77");
  });
});
