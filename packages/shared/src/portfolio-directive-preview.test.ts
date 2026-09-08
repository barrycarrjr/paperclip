import { describe, expect, it } from "vitest";
import { directivePreviewSummaryLines } from "./portfolio-directive-preview.js";

function facts(overrides: Partial<Parameters<typeof directivePreviewSummaryLines>[0]> = {}) {
  return {
    willReceive: [{ companyName: "Acme" }, { companyName: "Globex" }],
    skipped: [],
    guardrails: { outboundHold: true },
    ...overrides,
  };
}

describe("directivePreviewSummaryLines", () => {
  it("names how many companies get it, says nothing exists until each lead acts, and holds outbound work for approval", () => {
    expect(directivePreviewSummaryLines(facts())).toEqual([
      "Goes to 2 companies, named below with the lead who receives it.",
      "Creates one request in each of them. Nothing else exists until each lead acts on it.",
      "Emails, messages, calls and public posts the agents draft will wait for your approval first.",
      "Nothing has been sent yet. Nothing happens until you send it.",
    ]);
  });

  it("uses the singular for one company and one left-out company", () => {
    const lines = directivePreviewSummaryLines(
      facts({ willReceive: [{ companyName: "Acme" }], skipped: [{ companyName: "Globex" }] }),
    );
    expect(lines[0]).toBe("Goes to 1 company, named below with the lead who receives it.");
    expect(lines[2]).toBe("1 company is left out. The reasons are below.");
  });

  it("counts the companies left out when there is more than one", () => {
    const lines = directivePreviewSummaryLines(
      facts({ skipped: [{ companyName: "Globex" }, { companyName: "Initech" }] }),
    );
    expect(lines).toContain("2 companies are left out. The reasons are below.");
  });

  it("says the approval hold is off in the same words the Start work planner uses", () => {
    const lines = directivePreviewSummaryLines(facts({ guardrails: { outboundHold: false } }));
    expect(lines).toContain(
      "The approval hold is switched off, so emails, messages, calls and public posts the agents make will go out without asking you. Change this under Instance settings.",
    );
  });

  it("says plainly that nothing would be sent when no company would receive it", () => {
    const lines = directivePreviewSummaryLines(
      facts({ willReceive: [], skipped: [{ companyName: "Acme" }] }),
    );
    expect(lines[0]).toBe("No company will receive this, so nothing would be sent.");
    expect(lines.join(" ")).not.toContain("Creates one request");
  });

  it("never uses a dash character that is not a plain hyphen", () => {
    const everyLine = [
      ...directivePreviewSummaryLines(facts()),
      ...directivePreviewSummaryLines(facts({ willReceive: [], guardrails: { outboundHold: false } })),
    ].join(" ");
    expect(everyLine).not.toMatch(/[–—]/);
  });
});
