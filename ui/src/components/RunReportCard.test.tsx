// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RunReportCard, runReportText } from "./RunReportCard";

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div>{children}</div>,
}));

describe("runReportText", () => {
  it("prefers summary, falls back to a string result", () => {
    expect(runReportText({ summary: "Did the thing." })).toBe("Did the thing.");
    expect(runReportText({ summary: "  ", result: "Fallback text" })).toBe("Fallback text");
    expect(runReportText({ result: 42 })).toBeNull();
    expect(runReportText(null)).toBeNull();
    expect(runReportText("not an object")).toBeNull();
  });
});

describe("RunReportCard", () => {
  it("leads with the agent's own words", () => {
    const html = renderToStaticMarkup(
      <RunReportCard summary="Replied to 3 emails, flagged one refund." isLive={false} />,
    );
    expect(html).toContain("The agent&#x27;s report");
    expect(html).toContain("Replied to 3 emails, flagged one refund.");
  });

  it("is honest while the run is still going", () => {
    const html = renderToStaticMarkup(<RunReportCard summary={null} isLive />);
    expect(html).toContain("writes its report when the run finishes");
  });

  it("renders nothing for a finished run with no report", () => {
    expect(renderToStaticMarkup(<RunReportCard summary={null} isLive={false} />)).toBe("");
  });
});
