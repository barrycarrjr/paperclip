// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { PageSection } from "./PageSection";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(ui: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(ui);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

describe("PageSection", () => {
  it("renders as a landmark with its title as a heading", () => {
    const el = render(<PageSection title="Sub-issues">body</PageSection>);

    const section = el.querySelector("section");
    expect(section).not.toBeNull();
    expect(section!.querySelector("h3")?.textContent).toBe("Sub-issues");
    expect(section!.textContent).toContain("body");
  });

  it("puts actions in the header band alongside the title", () => {
    const el = render(
      <PageSection title="Attachments" actions={<button type="button">Upload</button>}>
        body
      </PageSection>,
    );

    const header = el.querySelector("section > div")!;
    expect(header.querySelector("h3")?.textContent).toBe("Attachments");
    expect(header.querySelector("button")?.textContent).toBe("Upload");
  });

  it("lets a crowded header band wrap instead of overflowing", () => {
    const el = render(
      <PageSection title="Documents" actions={<button type="button">Upload</button>}>
        body
      </PageSection>,
    );

    const heading = el.querySelector("h3")!;
    expect(heading.parentElement!.className).toContain("flex-wrap");
    expect(heading.nextElementSibling!.className).toContain("flex-wrap");
  });

  it("omits the header band entirely when there is no title or action", () => {
    const el = render(<PageSection>body</PageSection>);

    expect(el.querySelector("h3")).toBeNull();
    // Only the body wrapper remains as a direct child.
    expect(el.querySelector("section")!.children).toHaveLength(1);
  });

  it("drops its own padding in flush mode so the child controls its edges", () => {
    const flush = render(<PageSection flush>body</PageSection>);
    const flushBody = flush.querySelector("section")!.lastElementChild!;
    expect(flushBody.className).not.toContain("p-4");

    act(() => {
      root?.unmount();
    });
    container?.remove();

    const padded = render(<PageSection>body</PageSection>);
    const paddedBody = padded.querySelector("section")!.lastElementChild!;
    expect(paddedBody.className).toContain("p-4");
  });
});
