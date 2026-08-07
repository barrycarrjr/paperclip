// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeSignInScope } from "./ClaudeSignInScope";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("ClaudeSignInScope", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(node: ReactNode) {
    act(() => root.render(node));
  }

  it("says the failure is the machine's when the agent shares its sign-in", () => {
    render(<ClaudeSignInScope usesOwnToken={false} otherAgentsAffected={0} />);
    expect(container.textContent).toContain("the computer's Claude login");
    expect(container.textContent).toContain("Fixing it once there fixes all of them");
  });

  it("names how many others are stuck, which is the thing nobody could see", () => {
    render(<ClaudeSignInScope usesOwnToken={false} otherAgentsAffected={9} />);
    expect(container.textContent).toContain("9 other agents cannot sign in either");
  });

  it("counts one other agent in the singular", () => {
    render(<ClaudeSignInScope usesOwnToken={false} otherAgentsAffected={1} />);
    expect(container.textContent).toContain("1 other agent cannot sign in either");
    expect(container.textContent).not.toContain("1 other agents");
  });

  it("stays quiet about others when this agent is the only one stuck", () => {
    render(<ClaudeSignInScope usesOwnToken={false} otherAgentsAffected={0} />);
    expect(container.textContent).not.toContain("cannot sign in either");
  });

  it("points at the machine-wide fix and warns what pasting here does instead", () => {
    // The operator's actual trap: pasting on this page fixes one agent and
    // quietly stops it following any later fix made in the right place.
    render(<ClaudeSignInScope usesOwnToken={false} otherAgentsAffected={4} />);
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/instance/settings/adapters");
    expect(container.textContent).toContain("only this one agent");
    expect(container.textContent).toContain("stops it following any later fix");
  });

  it("does not blame the machine when the agent has its own token", () => {
    // Here the machine's sign-in genuinely is not the problem, and sending the
    // operator to fix it would waste the trip.
    render(<ClaudeSignInScope usesOwnToken otherAgentsAffected={4} />);
    expect(container.textContent).toContain("its own saved Claude token");
    expect(container.textContent).toContain("not what is wrong here");
    expect(container.querySelector("a")).toBeNull();
  });
});
