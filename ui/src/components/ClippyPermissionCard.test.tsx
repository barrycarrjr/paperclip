// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClippyPermissionCard } from "./ClippyPermissionCard";

describe("ClippyPermissionCard", () => {
  it("leads with a plain-language sentence, not raw JSON", () => {
    const html = renderToStaticMarkup(
      <ClippyPermissionCard
        toolName="create_issue"
        input={{ title: "Order more toner" }}
        onApprove={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(html).toContain("Clippy wants to: create an issue");
    expect(html).toContain("This creates a new issue called &quot;Order more toner&quot;.");
    expect(html).toContain("does something real");
    // Raw input stays behind the technical-details toggle.
    expect(html).toContain("Technical details");
    expect(html).not.toContain("Order more toner&quot;\n}");
  });

  it("shows the auto-cancel countdown when an expiry is known", () => {
    const html = renderToStaticMarkup(
      <ClippyPermissionCard
        toolName="broadcast_directive"
        input={{ message: "Stand down" }}
        expiresAt={Date.now() + 252_000}
        onApprove={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(html).toContain("Cancels itself in");
    expect(html).toContain("if you don&#x27;t answer");
  });

  it("disables the buttons and says so after the expiry passes", () => {
    const html = renderToStaticMarkup(
      <ClippyPermissionCard
        toolName="create_issue"
        input={{}}
        expiresAt={Date.now() - 1000}
        onApprove={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(html).toContain("Timed out. Treated as denied.");
    expect(html).toContain("disabled");
  });
});
