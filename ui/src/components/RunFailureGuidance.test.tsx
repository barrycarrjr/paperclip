// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeRunFailureCause } from "@paperclipai/shared";
import { RunFailureGuidance } from "./RunFailureGuidance";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const expiredLogin = describeRunFailureCause("claude_auth_required")!;
const ranOutOfTime = describeRunFailureCause("timeout")!;

describe("RunFailureGuidance", () => {
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

  function button(match: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes(match),
    );
    if (!found) throw new Error(`no button containing ${match}`);
    return found;
  }

  it("names the cause instead of leaving the operator to read the error", () => {
    render(
      <RunFailureGuidance
        cause={expiredLogin}
        agentLabel="Steward"
        pauseState="available"
        onPause={() => {}}
      />,
    );
    expect(container.textContent).toContain("Steward cannot sign in to Claude Code");
  });

  it("falls back to a plain noun where the page does not know the name", () => {
    render(<RunFailureGuidance cause={expiredLogin} pauseState="available" onPause={() => {}} />);
    expect(container.textContent).toContain("This agent cannot sign in");
  });

  it("says plainly that retrying cannot work yet", () => {
    // The whole complaint: Retry looked like the thing to do, and it was the
    // one action guaranteed to fail.
    render(<RunFailureGuidance cause={expiredLogin} pauseState="available" onPause={() => {}} />);
    expect(container.textContent).toContain("Retrying now fails the same way");
  });

  it("does not discourage retrying when retrying is a reasonable answer", () => {
    render(<RunFailureGuidance cause={ranOutOfTime} pauseState="available" onPause={() => {}} />);
    expect(container.textContent).not.toContain("Retrying now fails the same way");
  });

  it("offers stopping the agent right where the failure is", () => {
    const onPause = vi.fn();
    render(<RunFailureGuidance cause={expiredLogin} pauseState="available" onPause={onPause} />);

    act(() => button("Pause this agent").click());

    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it("stops offering to pause an agent that is already paused", () => {
    render(<RunFailureGuidance cause={expiredLogin} pauseState="paused" onPause={() => {}} />);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.textContent).toContain("will not try again until you resume it");
  });

  it("cannot be pressed twice while the pause is in flight", () => {
    const onPause = vi.fn();
    render(<RunFailureGuidance cause={expiredLogin} pauseState="pending" onPause={onPause} />);
    expect(button("Pausing").disabled).toBe(true);
  });

  it("points at the other way out, which is doing nothing", () => {
    render(<RunFailureGuidance cause={expiredLogin} pauseState="available" onPause={() => {}} />);
    expect(container.textContent).toContain("Seen it, not retrying");
  });
});
