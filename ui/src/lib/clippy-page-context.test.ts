import { describe, expect, it } from "vitest";
import {
  MAX_PAGE_CONTEXT_LENGTH,
  clippyGreetingName,
  describeClippyPage,
  suggestedClippyPrompts,
} from "./clippy-page-context";

describe("describeClippyPage", () => {
  it("names the company and the page for the chip, and keeps the address for the chat", () => {
    const context = describeClippyPage({
      pathname: "/HQ/issues/HQ-12",
      companyPrefix: "HQ",
      companyName: "HQ",
      breadcrumbs: [{ label: "Issues" }, { label: "HQ-12 Fix the login page" }],
    });
    expect(context).toEqual({
      label: "HQ | HQ-12 Fix the login page",
      value: "/HQ/issues/HQ-12 (company HQ, page Issues / HQ-12 Fix the login page)",
    });
  });

  it("still names the company on a page that sets no breadcrumbs", () => {
    expect(
      describeClippyPage({ pathname: "/HQ/dashboard", companyPrefix: "HQ", companyName: "HQ", breadcrumbs: [] }),
    ).toEqual({ label: "HQ", value: "/HQ/dashboard (company HQ)" });
  });

  it("offers no context on the Clippy page itself", () => {
    expect(
      describeClippyPage({
        pathname: "/HQ/clippy",
        companyPrefix: "HQ",
        companyName: "HQ",
        breadcrumbs: [{ label: "Clippy" }],
      }),
    ).toBeNull();
  });

  it("offers no context when there is nothing to name", () => {
    expect(describeClippyPage({ pathname: "/design-guide", breadcrumbs: [] })).toBeNull();
  });

  it("fits what the server accepts for a chat's page context", () => {
    const context = describeClippyPage({
      pathname: "/HQ/issues/HQ-1",
      companyPrefix: "HQ",
      companyName: "HQ",
      breadcrumbs: [{ label: "x".repeat(900) }],
    });
    expect(context!.value.length).toBe(MAX_PAGE_CONTEXT_LENGTH);
  });
});

describe("suggestedClippyPrompts", () => {
  it("suggests three questions about an open issue on an issue page", () => {
    const prompts = suggestedClippyPrompts({ pathname: "/HQ/issues/HQ-12", companyPrefix: "HQ", companyName: "HQ" });
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toBe("Summarize this issue");
  });

  it("tells a list of issues from one issue", () => {
    const prompts = suggestedClippyPrompts({ pathname: "/HQ/issues/active", companyPrefix: "HQ", companyName: "HQ" });
    expect(prompts).toContain("Which issues are blocked?");
    expect(prompts).toContain("Summarize open issues in HQ");
  });

  it("asks about agents on the agents pages", () => {
    expect(suggestedClippyPrompts({ pathname: "/HQ/agents", companyPrefix: "HQ", companyName: "HQ" })[0]).toBe(
      "Which agents are working right now?",
    );
    expect(suggestedClippyPrompts({ pathname: "/HQ/agents/a1", companyPrefix: "HQ", companyName: "HQ" })[0]).toBe(
      "What is this agent working on?",
    );
  });

  it("falls back to general questions on a page it does not know", () => {
    const prompts = suggestedClippyPrompts({ pathname: "/HQ/some-plugin-page", companyPrefix: "HQ", companyName: "Acme" });
    expect(prompts).toEqual([
      "What needs my attention today?",
      "Summarize open issues in Acme",
      "Remind me to follow up on something tomorrow",
    ]);
  });

  it("does not mistake a company prefix for a page", () => {
    // A company whose prefix happens to read like a section name.
    expect(suggestedClippyPrompts({ pathname: "/EMAIL/dashboard", companyPrefix: "EMAIL", companyName: "Email Co" })[0]).toBe(
      "What needs my attention today?",
    );
  });

  it("words the issues question without a company when there is none", () => {
    expect(suggestedClippyPrompts({ pathname: "/inbox" })).toHaveLength(3);
    expect(suggestedClippyPrompts({ pathname: "/" })).toContain("Summarize my open issues");
  });
});

describe("clippyGreetingName", () => {
  it("greets by first name", () => {
    expect(clippyGreetingName("Pat Example")).toBe("Pat");
    expect(clippyGreetingName("  Pat  ")).toBe("Pat");
  });

  it("does not greet the local instance's placeholder board user by name", () => {
    expect(clippyGreetingName("Board")).toBeNull();
    expect(clippyGreetingName("Local Board")).toBeNull();
  });

  it("does not greet by an email address or by nothing", () => {
    expect(clippyGreetingName("pat@example.com")).toBeNull();
    expect(clippyGreetingName("")).toBeNull();
    expect(clippyGreetingName(null)).toBeNull();
  });
});
