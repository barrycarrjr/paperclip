// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStatusBadge } from "./AgentStatusBadge";
import type { TeamWorkState } from "../lib/team-current-work";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("AgentStatusBadge", () => {
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

  function render(status: string, workState: TeamWorkState | null) {
    act(() => {
      root.render(<AgentStatusBadge status={status} workState={workState} />);
    });
    return container.textContent;
  }

  it("says Needs you, not idle, for an agent waiting on an answer", () => {
    expect(render("idle", "needs_you")).toBe("Needs you");
  });

  it("says Ready for review, not idle, for an agent that handed work back", () => {
    expect(render("idle", "needs_review")).toBe("Ready for review");
  });

  it.each<[TeamWorkState | null]>([[null], ["waiting"], ["quiet"], ["working"], ["paused"]])(
    "keeps the stored status when the reading is %s",
    (state) => {
      expect(render("idle", state)).toBe("idle");
    },
  );

  it("keeps the stored error status for an agent in the error state", () => {
    expect(render("error", "error")).toBe("error");
  });
});
