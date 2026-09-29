// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentErrorNote } from "./AgentErrorNote";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const EXPIRED =
  "Claude run failed: subtype=success: Failed to authenticate: OAuth session expired and could not be refreshed";

describe("AgentErrorNote", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function links() {
    return Array.from(container.querySelectorAll("a")).map((a) => [
      a.textContent,
      a.getAttribute("href"),
    ]);
  }

  it("says what to do, links to the failed run and keeps the raw text behind Details", () => {
    act(() => {
      root.render(
        <AgentErrorNote
          lastError={EXPIRED}
          adapterType="claude_local"
          runLink={{ to: "/agents/chief-of-staff/runs/run-9", label: "See what went wrong" }}
        />,
      );
    });

    expect(container.textContent).toContain(
      "Try again. If it fails again, sign in again under Adapters.",
    );
    expect(links()).toEqual([
      ["Adapters", "/instance/settings/adapters"],
      ["See what went wrong", "/agents/chief-of-staff/runs/run-9"],
    ]);
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    expect(details!.querySelector("summary")!.textContent).toBe("Details");
    expect(details!.textContent).toContain(EXPIRED);
    // Once, and only inside the toggle.
    expect(container.textContent!.split(EXPIRED).length - 1).toBe(1);
  });

  it("still links to the run for an error it does not recognise, with no hint or toggle", () => {
    act(() => {
      root.render(
        <AgentErrorNote
          lastError="Tests failed"
          adapterType="claude_local"
          runLink={{ to: "/agents/dev/runs/run-1", label: "See what went wrong" }}
        />,
      );
    });

    expect(links()).toEqual([["See what went wrong", "/agents/dev/runs/run-1"]]);
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).not.toContain("Try again");
  });

  it("draws nothing when there is neither an explanation nor a run to link to", () => {
    act(() => {
      root.render(<AgentErrorNote lastError="Tests failed" adapterType="claude_local" />);
    });

    expect(container.innerHTML).toBe("");
  });
});
