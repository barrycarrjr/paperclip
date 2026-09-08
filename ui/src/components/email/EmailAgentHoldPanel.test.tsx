// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailHandoffSummary, TakeOverHandoffResult } from "@/api/emailHandoffs";
import { EmailAgentHoldPanel } from "./EmailAgentHoldPanel";
import { EmailAgentHoldList } from "./EmailAgentHoldList";
import { EmailTakeOverNotice } from "./EmailTakeOverNotice";

const mockApi = vi.hoisted(() => ({ takeOver: vi.fn() }));
vi.mock("@/api/emailHandoffs", () => ({ emailHandoffsApi: mockApi }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function hold(overrides: Partial<EmailHandoffSummary> = {}): EmailHandoffSummary {
  return {
    id: "d1",
    issueId: "i1",
    companyId: "c1",
    pluginId: "email-tools",
    sourceKey: "email:v1:msgid:email-tools:personal:%3Cabc%40example.com%3E",
    mailbox: "personal",
    folder: "INBOX",
    messageId: "<abc@example.com>",
    status: "in_progress",
    delegatedByUserId: null,
    delegatedToAgentId: "a1",
    delegatedAt: "2026-09-08T09:00:00.000Z",
    acknowledgedAt: null,
    resolvedAt: null,
    resolutionNote: null,
    handedBackReason: null,
    previousDelegationId: null,
    replyState: "none",
    replyError: null,
    version: 3,
    createdAt: "2026-09-08T09:00:00.000Z",
    updatedAt: "2026-09-08T09:00:00.000Z",
    issue: { id: "i1", identifier: "ACME-4", title: "Email from a customer", status: "in_progress" },
    agent: { id: "a1", name: "Ada" },
    ...overrides,
  };
}

function goodResult(overrides: Partial<TakeOverHandoffResult> = {}): TakeOverHandoffResult {
  return {
    delegation: hold() as unknown as TakeOverHandoffResult["delegation"],
    run: { state: "stopped", runId: "r1" },
    workItem: { state: "updated", unassignedAgent: true, statusChangedTo: "todo", error: null },
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

function render(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
}

function button(text: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes(text),
  );
  if (!match) throw new Error(`No button containing "${text}". Saw: ${container.textContent}`);
  return match as HTMLButtonElement;
}

function click(text: string) {
  act(() => {
    button(text).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function typeReason(value: string) {
  const area = container.querySelector("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(area, value);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockApi.takeOver.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("EmailAgentHoldPanel", () => {
  it("says who has the message, what stage it is at, and links to the work", () => {
    render(<EmailAgentHoldPanel companyId="c1" hold={hold()} onTakenOver={vi.fn()} />);

    expect(container.textContent).toContain("With Ada");
    expect(container.textContent).toContain("Being worked on");
    expect(container.textContent).toContain("ACME-4: Email from a customer");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/issues/ACME-4");
  });

  it("says so plainly when the work item is gone rather than showing a dead link", () => {
    render(<EmailAgentHoldPanel companyId="c1" hold={hold({ issue: null })} onTakenOver={vi.fn()} />);
    expect(container.textContent).toContain("The work this created can no longer be found");
    expect(container.querySelector("a")).toBe(null);
  });

  it("spells out the consequences before the person confirms", () => {
    render(<EmailAgentHoldPanel companyId="c1" hold={hold()} onTakenOver={vi.fn()} />);
    expect(container.textContent).not.toContain("If you take this back:");

    click("Take it back");

    expect(container.textContent).toContain("If you take this back:");
    expect(container.textContent).toContain("Ada stops. If it has a run going, that run is stopped.");
    expect(container.textContent).toContain("goes back to the to-do list");
    expect(container.textContent).toContain("Nothing is sent to whoever emailed you");
  });

  it("will not take a message back without a reason", () => {
    render(<EmailAgentHoldPanel companyId="c1" hold={hold()} onTakenOver={vi.fn()} />);
    click("Take it back");

    expect(button("Take it back from Ada").disabled).toBe(true);
    typeReason("  ");
    expect(button("Take it back from Ada").disabled).toBe(true);

    typeReason("I want to answer this myself");
    expect(button("Take it back from Ada").disabled).toBe(false);
  });

  it("sends the reason and the version it was looking at", async () => {
    mockApi.takeOver.mockResolvedValue(goodResult());
    const onTakenOver = vi.fn();
    render(<EmailAgentHoldPanel companyId="c1" hold={hold()} onTakenOver={onTakenOver} />);

    click("Take it back");
    typeReason("I want to answer this myself");
    click("Take it back from Ada");
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockApi.takeOver).toHaveBeenCalledWith("c1", "i1", "d1", {
      reason: "I want to answer this myself",
      expectedVersion: 3,
    });
    expect(onTakenOver).toHaveBeenCalledWith(goodResult(), "Ada");
  });

  it("says the agent still has it when the request fails", async () => {
    mockApi.takeOver.mockRejectedValue(
      new Error("This delegation changed while you were looking at it."),
    );
    const onTakenOver = vi.fn();
    render(<EmailAgentHoldPanel companyId="c1" hold={hold()} onTakenOver={onTakenOver} />);

    click("Take it back");
    typeReason("Mine now");
    click("Take it back from Ada");
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("This delegation changed while you were looking at it.");
    expect(onTakenOver).not.toHaveBeenCalled();
  });

  it("names an agent that has been removed rather than leaving a blank", () => {
    render(<EmailAgentHoldPanel companyId="c1" hold={hold({ agent: null })} onTakenOver={vi.fn()} />);
    expect(container.textContent).toContain("With An agent we can no longer name");
  });
});

describe("EmailAgentHoldList", () => {
  it("says nothing is held rather than showing an empty box", () => {
    render(
      <EmailAgentHoldList
        companyId="c1"
        holds={[]}
        loading={false}
        error={null}
        onTakenOver={vi.fn()}
      />,
    );
    expect(container.textContent).toContain("No agent is holding any mail right now");
  });

  it("separates 'nothing held' from 'could not check'", () => {
    render(
      <EmailAgentHoldList
        companyId="c1"
        holds={[]}
        loading={false}
        error={new Error("The server did not answer.")}
        onTakenOver={vi.fn()}
      />,
    );
    expect(container.textContent).toContain("Could not check what agents are holding");
    expect(container.textContent).toContain("The server did not answer.");
    expect(container.textContent).not.toContain("No agent is holding any mail");
  });

  it("shows one panel per held message, with where it came from", () => {
    render(
      <EmailAgentHoldList
        companyId="c1"
        holds={[hold(), hold({ id: "d2", issueId: "i2", folder: "Archive", agent: { id: "a2", name: "Grace" } })]}
        loading={false}
        error={null}
        onTakenOver={vi.fn()}
      />,
    );
    expect(container.textContent).toContain("With Ada");
    expect(container.textContent).toContain("With Grace");
    expect(container.textContent).toContain("personal / INBOX");
    expect(container.textContent).toContain("personal / Archive");
  });
});

describe("EmailTakeOverNotice", () => {
  it("reports what happened when it all worked", () => {
    render(
      <EmailTakeOverNotice result={goodResult()} agentName="Ada" onDismiss={vi.fn()} />,
    );
    expect(container.textContent).toContain("You have the message back");
    expect(container.textContent).toContain("Ada has been stopped.");
  });

  it("shows a failure to stop the agent as a warning, not a success", () => {
    render(
      <EmailTakeOverNotice
        result={goodResult({ run: { state: "failed", error: "No answer.", runId: "r1" } })}
        agentName="Ada"
        onDismiss={vi.fn()}
      />,
    );
    expect(container.textContent).toContain("but not everything worked");
    expect(container.textContent).toContain("Ada may still be working");
    expect(container.querySelector('[role="status"]')?.className).toContain("destructive");
  });

  it("stays until it is dismissed", () => {
    const onDismiss = vi.fn();
    render(<EmailTakeOverNotice result={goodResult()} agentName="Ada" onDismiss={onDismiss} />);
    act(() => {
      container
        .querySelector('button[aria-label="Dismiss"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onDismiss).toHaveBeenCalled();
  });
});
