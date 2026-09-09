// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tabs } from "@/components/ui/tabs";
import { PageTabBar } from "./PageTabBar";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let onAPhone = false;

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: onAPhone }),
}));

const items = [
  { value: "issues", label: "Tasks" },
  { value: "projects", label: "Projects" },
];

describe("PageTabBar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    onAPhone = false;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render() {
    act(() => {
      root.render(
        <Tabs value="issues" onValueChange={() => {}}>
          <PageTabBar
            label="Work section"
            items={items}
            value="issues"
            onValueChange={() => {}}
          />
        </Tabs>,
      );
    });
  }

  it("says what the dropdown on a phone is for", () => {
    // On a phone the tab strip is replaced by a plain dropdown. Without a
    // name a screen reader announces it as a combo box and nothing else, and
    // there is no visible heading beside it to fill the gap, so the person
    // hearing it has no idea what changing it would do.
    onAPhone = true;
    render();

    const dropdown = container.querySelector("select");
    expect(dropdown, "expected a dropdown at phone width").not.toBeNull();
    expect(dropdown!.getAttribute("aria-label")).toBe("Work section");
    expect([...dropdown!.options].map((option) => option.text)).toEqual(["Tasks", "Projects"]);
  });

  it("says what the tab strip on a wide screen is for", () => {
    render();

    expect(container.querySelector("select")).toBeNull();
    const strip = container.querySelector('[data-slot="tabs-list"]');
    expect(strip, "expected a tab strip at desktop width").not.toBeNull();
    expect(strip!.getAttribute("aria-label")).toBe("Work section");
  });
});
