// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ModelLifecycleBadge } from "./ModelLifecycleBadge";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ container: HTMLDivElement; root: Root }> = [];

function render(node: React.ReactNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  act(() => {
    root.render(node);
  });
  return container;
}

function tags(el: HTMLElement): Array<{ kind: string | null; text: string | null }> {
  return [...el.querySelectorAll("[data-model-tag]")].map((node) => ({
    kind: node.getAttribute("data-model-tag"),
    text: node.textContent,
  }));
}

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("ModelLifecycleBadge", () => {
  it("draws nothing for a plain current model, or a list entry with no lifecycle facts", () => {
    expect(render(<ModelLifecycleBadge model={{ status: "current" }} />).innerHTML).toBe("");
    expect(render(<ModelLifecycleBadge model={{}} />).innerHTML).toBe("");
  });

  it("tags a new model New", () => {
    expect(tags(render(<ModelLifecycleBadge model={{ status: "current", isNew: true }} />))).toEqual([
      { kind: "new", text: "New" },
    ]);
  });

  it("tags the provider's default as used by default", () => {
    expect(tags(render(<ModelLifecycleBadge model={{ isDefault: true }} />))).toEqual([
      { kind: "default", text: "Used by default" },
    ]);
  });

  it("dates a retiring model in the warning tone", () => {
    const el = render(
      <ModelLifecycleBadge
        model={{ status: "deprecated", retiresAt: `${new Date().getFullYear()}-10-14T12:00:00.000Z` }}
      />,
    );
    expect(tags(el)).toEqual([{ kind: "retiring", text: "Retires Oct 14" }]);
    expect(el.querySelector('[data-model-tag="retiring"]')?.className).toContain("amber");
  });

  it("marks a saved model the provider no longer lists as Not available", () => {
    const el = render(<ModelLifecycleBadge unavailable model={{ isDefault: true }} />);
    expect(tags(el)).toEqual([{ kind: "unavailable", text: "Not available" }]);
    expect(el.querySelector("[data-model-tag]")?.getAttribute("title")).toBe(
      "Not in the models this provider offers right now",
    );
  });
});
