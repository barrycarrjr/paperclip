// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue, IssueExecutionState } from "@paperclipai/shared";
import { SignOffGateBanner, pendingSignOffForUser } from "./SignOffGateBanner";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function state(overrides: Partial<IssueExecutionState> = {}): IssueExecutionState {
  return {
    status: "pending",
    currentStageId: "stage-1",
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: { type: "user", userId: "user-1" },
    returnAssignee: { type: "agent", agentId: "agent-1" },
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    ...overrides,
  };
}

function issue(executionState: IssueExecutionState | null): Pick<Issue, "executionState"> {
  return { executionState };
}

describe("pendingSignOffForUser", () => {
  it("finds a stage waiting on this person", () => {
    expect(pendingSignOffForUser(issue(state()), "user-1")).toEqual({
      stageType: "review",
      instructions: null,
    });
  });

  it("stays quiet when the stage belongs to someone else", () => {
    // The server rejects anyone but the named participant, so a control here
    // would be a button that always fails.
    expect(pendingSignOffForUser(issue(state()), "someone-else")).toBeNull();
  });

  it("stays quiet when an agent holds the stage", () => {
    expect(
      pendingSignOffForUser(issue(state({ currentParticipant: { type: "agent", agentId: "a-1" } })), "user-1"),
    ).toBeNull();
  });

  it("stays quiet when the stage is not pending, or there is no stage", () => {
    expect(pendingSignOffForUser(issue(state({ status: "changes_requested" })), "user-1")).toBeNull();
    expect(pendingSignOffForUser(issue(null), "user-1")).toBeNull();
  });

  it("shows on a board with no signed-in person", () => {
    // local_implicit boards have no session user; the queue scopes these rows
    // the same way.
    expect(pendingSignOffForUser(issue(state()), null)).not.toBeNull();
  });

  it("carries the reviewer instructions and the stage kind through", () => {
    expect(
      pendingSignOffForUser(
        issue(state({ currentStageType: "approval", reviewRequest: { instructions: "Check the totals" } })),
        "user-1",
      ),
    ).toEqual({ stageType: "approval", instructions: "Check the totals" });
  });
});

describe("SignOffGateBanner", () => {
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

  function render(node: React.ReactNode) {
    act(() => root.render(node));
  }

  function buttonNamed(label: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === label,
    );
    if (!found) throw new Error(`no button labelled ${label}`);
    return found;
  }

  it("renders nothing when nothing is waiting on you", () => {
    render(<SignOffGateBanner issue={issue(null)} currentUserId="user-1" onDecide={() => {}} />);
    expect(container.textContent).toBe("");
  });

  it("will not let you decide without saying why", () => {
    // The server requires a comment on both outcomes, so an enabled button
    // with an empty box would just produce an error.
    render(<SignOffGateBanner issue={issue(state())} currentUserId="user-1" onDecide={() => {}} />);
    expect(buttonNamed("Approve and finish").disabled).toBe(true);
    expect(buttonNamed("Request changes").disabled).toBe(true);
  });

  it("approves with the comment attached", () => {
    const onDecide = vi.fn();
    render(<SignOffGateBanner issue={issue(state())} currentUserId="user-1" onDecide={onDecide} />);

    const textarea = container.querySelector("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setter.call(textarea, "  Looks right to me  ");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    act(() => buttonNamed("Approve and finish").click());
    expect(onDecide).toHaveBeenCalledWith({ status: "done", comment: "Looks right to me" });
  });

  it("sends work back with in_progress rather than done", () => {
    const onDecide = vi.fn();
    render(<SignOffGateBanner issue={issue(state())} currentUserId="user-1" onDecide={onDecide} />);

    const textarea = container.querySelector("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setter.call(textarea, "Totals are wrong");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    act(() => buttonNamed("Request changes").click());
    expect(onDecide).toHaveBeenCalledWith({ status: "in_progress", comment: "Totals are wrong" });
  });

  it("says approval rather than review on an approval stage", () => {
    render(
      <SignOffGateBanner
        issue={issue(state({ currentStageType: "approval" }))}
        currentUserId="user-1"
        onDecide={() => {}}
      />,
    );
    expect(container.textContent).toContain("waiting for your approval");
    expect(buttonNamed("Approve")).toBeTruthy();
  });

  it("shows the reviewer instructions and any error", () => {
    render(
      <SignOffGateBanner
        issue={issue(state({ reviewRequest: { instructions: "Check the totals" } }))}
        currentUserId="user-1"
        onDecide={() => {}}
        error="Approving a review or approval stage requires a comment"
      />,
    );
    expect(container.textContent).toContain("Check the totals");
    expect(container.textContent).toContain("requires a comment");
  });

  it("holds both buttons while a decision is in flight", () => {
    render(
      <SignOffGateBanner issue={issue(state())} currentUserId="user-1" onDecide={() => {}} isPending />,
    );
    expect(buttonNamed("Approve and finish").disabled).toBe(true);
    expect(buttonNamed("Request changes").disabled).toBe(true);
  });
});
