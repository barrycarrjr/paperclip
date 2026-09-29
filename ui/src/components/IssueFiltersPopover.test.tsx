// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueFiltersPopover } from "./IssueFiltersPopover";
import { defaultIssueFilterState } from "../lib/issue-filters";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div data-testid="popover-content" className={className}>
      {children}
    </div>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({ checked }: { checked?: boolean }) => <input type="checkbox" checked={checked} readOnly />,
}));

vi.mock("./StatusIcon", () => ({
  StatusIcon: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("./PriorityIcon", () => ({
  PriorityIcon: ({ priority }: { priority: string }) => <span>{priority}</span>,
}));

describe("IssueFiltersPopover", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("uses a scrollable popover and a three-column desktop grid", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <IssueFiltersPopover
          state={defaultIssueFilterState}
          onChange={vi.fn()}
          activeFilterCount={0}
          agents={[{ id: "agent-1", name: "Agent One" }]}
          projects={[{ id: "project-1", name: "Project One" }]}
          labels={[{ id: "label-1", name: "Bug", color: "#ff0000" }]}
          workspaces={[{ id: "workspace-1", name: "Workspace One" }]}
          enableRoutineVisibilityFilter
        />,
      );
    });

    const popoverContent = container.querySelector("[data-testid='popover-content']");
    expect(popoverContent).not.toBeNull();
    expect(popoverContent?.className).toContain("overflow-y-auto");
    expect(popoverContent?.className).toContain("max-h-[min(80vh,42rem)]");

    const layoutGrid = Array.from(popoverContent?.querySelectorAll("div") ?? []).find((element) =>
      element.className.includes("md:grid-cols-3"),
    );
    expect(layoutGrid?.className).toContain("grid-cols-1");
    expect(popoverContent?.textContent).toContain("Live runs only");
  });

  function quickFilterButton(label: string) {
    return Array.from(container.querySelectorAll("button")).find((button) => button.textContent === label);
  }

  it("does not mark All while finished work is hidden, and choosing it brings finished work back", () => {
    const root = createRoot(container);
    const onChange = vi.fn();
    const onShowFinished = vi.fn();

    act(() => {
      root.render(
        <IssueFiltersPopover
          state={defaultIssueFilterState}
          onChange={onChange}
          activeFilterCount={0}
          finishedHidden
          onShowFinished={onShowFinished}
        />,
      );
    });

    const allButton = quickFilterButton("All");
    expect(allButton?.className).not.toContain("bg-primary");

    act(() => {
      allButton?.click();
    });
    expect(onChange).toHaveBeenCalledWith({ statuses: [] });
    expect(onShowFinished).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });

  it("marks All when nothing is hidden, and choosing it again does not ask to show finished work", () => {
    const root = createRoot(container);
    const onShowFinished = vi.fn();

    act(() => {
      root.render(
        <IssueFiltersPopover
          state={defaultIssueFilterState}
          onChange={vi.fn()}
          activeFilterCount={0}
          onShowFinished={onShowFinished}
        />,
      );
    });

    const allButton = quickFilterButton("All");
    expect(allButton?.className).toContain("bg-primary");

    act(() => {
      allButton?.click();
    });
    expect(onShowFinished).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });
});
