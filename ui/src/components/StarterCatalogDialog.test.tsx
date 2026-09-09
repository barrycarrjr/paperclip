// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  STARTER_CARDS,
  STARTER_CATEGORIES,
  type Agent,
  type Issue,
  type StartWorkPlanResponse,
} from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StarterCatalogDialog } from "./StarterCatalogDialog";
import { queryKeys } from "../lib/queryKeys";
import { ThemeProvider } from "../context/ThemeContext";
import { TooltipProvider } from "./ui/tooltip";
import { ApiError } from "../api/client";
import type { CurrentBoardAccess } from "../api/access";
import type { StarterBlocker, StarterCardStatus } from "../api/starterCatalog";
import type { SuggestTasksInteraction } from "../lib/issue-thread-interactions";

const mockStarterCatalogApi = vi.hoisted(() => ({
  list: vi.fn(),
  search: vi.fn(),
  activate: vi.fn(),
}));

const mockStartWorkApi = vi.hoisted(() => ({
  plan: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  acceptInteraction: vi.fn(),
  rejectInteraction: vi.fn(),
  get: vi.fn(),
  listInteractions: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockOpenNewIssue = vi.hoisted(() => vi.fn());

vi.mock("../api/starterCatalog", () => ({
  starterCatalogApi: mockStarterCatalogApi,
}));

vi.mock("../api/startWork", () => ({
  startWorkApi: mockStartWorkApi,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ openNewIssue: mockOpenNewIssue }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
}));

// The real dialog portals through radix and needs pointer-event plumbing
// jsdom does not have; the panel's own behaviour is what these tests pin.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children, ...props }: ComponentProps<"div">) => <div {...props}>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
// Held so a test can change what the access call answers after the panel is
// already on screen, the way a role change mid-session would.
let queryClient: QueryClient | null = null;

const NO_SHOW_TITLE = "Call back anyone who missed an appointment";
const REVIEWS_TITLE = "Reply to every Google review within a day";
const REQUEST_TEXT = "Get more Google reviews";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const writerAccess: CurrentBoardAccess = {
  user: null,
  userId: "user-board",
  isInstanceAdmin: false,
  companyIds: ["company-1"],
  memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
  source: "session",
  keyId: null,
};

const viewerAccess: CurrentBoardAccess = {
  ...writerAccess,
  memberships: [{ companyId: "company-1", membershipRole: "viewer", status: "active" }],
};

const agents = [
  { id: "agent-ceo", name: "Ada" },
  { id: "agent-ops", name: "Bao" },
] as Agent[];

function cardStatuses(
  overrides: Record<string, Partial<Omit<StarterCardStatus, "card">>> = {},
): StarterCardStatus[] {
  return STARTER_CARDS.map((card) => ({
    card,
    ready: true,
    fixable: false,
    blockers: [],
    existingRoutineId: null,
    ...overrides[card.id],
  }));
}

function planInteraction(overrides: Partial<SuggestTasksInteraction> = {}): SuggestTasksInteraction {
  return {
    id: "interaction-plan",
    companyId: "company-1",
    issueId: "issue-container",
    kind: "suggest_tasks",
    title: `Plan for: ${REQUEST_TEXT}`,
    summary: "Two tasks. Nothing is created until you accept.",
    status: "pending",
    continuationPolicy: "wake_assignee_on_accept",
    createdByAgentId: null,
    createdByUserId: "user-board",
    resolvedByAgentId: null,
    resolvedByUserId: null,
    createdAt: new Date("2026-09-06T09:00:00.000Z"),
    updatedAt: new Date("2026-09-06T09:00:00.000Z"),
    resolvedAt: null,
    payload: {
      version: 1,
      tasks: [
        {
          clientKey: "ask",
          title: "Ask recent customers for a review",
          description: `Email the last month of customers with the review link.\n\nFrom the request "${REQUEST_TEXT}" (PAP-42).`,
          priority: "high",
          assigneeAgentId: "agent-ceo",
        },
        {
          clientKey: "reply",
          title: "Reply to every new review",
          description: `Answer each review within a day.\n\nFrom the request "${REQUEST_TEXT}" (PAP-42).`,
          priority: "medium",
          assigneeAgentId: "agent-ops",
        },
      ],
    },
    result: null,
    ...overrides,
  };
}

function planResponse(overrides: Partial<StartWorkPlanResponse> = {}): StartWorkPlanResponse {
  return {
    issue: { id: "issue-container", identifier: "PAP-42", title: `Request: ${REQUEST_TEXT}` },
    interaction: planInteraction(),
    lead: { id: "agent-ceo", name: "Ada" },
    leftOut: [],
    warnings: [],
    notes: {
      soundsRecurring: false,
      recurringNote: null,
      companyName: "Paperclip",
      isPortfolioRoot: false,
    },
    guardrails: { outboundHold: true },
    planner: { modelUsed: "claude-sonnet-4-6" },
    matchedCards: [],
    ...overrides,
  };
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function teardown() {
  if (root) {
    act(() => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
  queryClient = null;
}

async function renderDialog(options: {
  cards?: StarterCardStatus[];
  access?: CurrentBoardAccess;
  /** "pending" never answers, "failed" answers with an error. */
  accessCall?: "pending" | "failed";
  onClose?: () => void;
} = {}) {
  mockStarterCatalogApi.list.mockResolvedValue({
    categories: STARTER_CATEGORIES.map((c) => ({ id: c.id, title: c.title, blurb: c.blurb })),
    cards: options.cards ?? cardStatuses(),
  });
  if (options.accessCall === "pending") {
    mockAccessApi.getCurrentBoardAccess.mockImplementation(() => new Promise(() => undefined));
  } else if (options.accessCall === "failed") {
    mockAccessApi.getCurrentBoardAccess.mockRejectedValue(new ApiError("Request failed: 500", 500, null));
  } else {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue(options.access ?? writerAccess);
  }
  mockAgentsApi.list.mockResolvedValue(agents);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient = client;

  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <ThemeProvider>
            <StarterCatalogDialog
              companyId="company-1"
              open
              onClose={options.onClose ?? (() => undefined)}
            />
          </ThemeProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
  return container;
}

function typeInto(input: HTMLInputElement, value: string) {
  // React listens for the native input event, and only notices a value it
  // did not set itself, hence the prototype setter rather than input.value.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pressEnter(input: HTMLInputElement) {
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
  });
}

function queryBox(host: HTMLElement): HTMLInputElement {
  const input = host.querySelector('input[aria-label="What do you want done?"]');
  expect(input).toBeTruthy();
  return input as HTMLInputElement;
}

function buttonLabelled(host: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === label,
  );
}

function click(element: HTMLElement | undefined) {
  expect(element).toBeTruthy();
  act(() => {
    element?.click();
  });
}

/** Type a request, press Enter, wait for the plan to render. */
async function draftPlan(host: HTMLElement, text = REQUEST_TEXT) {
  typeInto(queryBox(host), text);
  await flush();
  pressEnter(queryBox(host));
  await flush();
}

function expectPlainWords(host: HTMLElement) {
  let text = host.textContent ?? "";
  // The starter cards' own prose comes from the shared catalog and is
  // checked by that package's tests (one card still carries an em dash
  // there, outside this component). Only this panel's words are judged here.
  for (const card of STARTER_CARDS) {
    for (const prose of [card.title, card.what, card.when]) {
      text = text.split(prose).join("");
    }
  }
  expect(text).not.toMatch(/interaction/i);
  expect(text).not.toMatch(/delegation/i);
  expect(text).not.toMatch(/[—–]/);
}

beforeEach(() => {
  mockStarterCatalogApi.list.mockReset();
  mockStarterCatalogApi.search.mockReset();
  mockStarterCatalogApi.activate.mockReset();
  mockStartWorkApi.plan.mockReset();
  mockIssuesApi.acceptInteraction.mockReset();
  mockIssuesApi.rejectInteraction.mockReset();
  mockIssuesApi.get.mockReset();
  mockIssuesApi.listInteractions.mockReset();
  mockAccessApi.getCurrentBoardAccess.mockReset();
  mockAgentsApi.list.mockReset();
  mockOpenNewIssue.mockReset();
});

afterEach(() => {
  teardown();
});

describe("StarterCatalogDialog", () => {
  it("typing book does not show the rebook card, typing review shows the reviews card (shared ranking)", async () => {
    const host = await renderDialog();
    expect(host.textContent).toContain(NO_SHOW_TITLE);
    expect(host.textContent).toContain(REVIEWS_TITLE);

    // "book" is a substring of the no-show card's "rebook" term. The old
    // local filter matched it; the shared ranking must not.
    typeInto(queryBox(host), "book");
    await flush();
    expect(host.textContent).not.toContain(NO_SHOW_TITLE);
    expect(host.textContent).toContain("Nothing here matches that yet.");

    typeInto(queryBox(host), "review");
    await flush();
    expect(host.textContent).toContain(REVIEWS_TITLE);
    expect(host.textContent).not.toContain(NO_SHOW_TITLE);
    expect(host.textContent).not.toContain("Nothing here matches that yet.");

    // Clearing the box brings the whole catalog back.
    typeInto(queryBox(host), "");
    await flush();
    expect(host.textContent).toContain(NO_SHOW_TITLE);
    expect(host.textContent).toContain(REVIEWS_TITLE);
  });

  it("typing never calls starterCatalogApi.activate", async () => {
    mockStartWorkApi.plan.mockResolvedValue(planResponse());
    const host = await renderDialog();
    const input = queryBox(host);

    typeInto(input, "google reviews");
    await flush();
    pressEnter(input);
    await flush();

    expect(mockStarterCatalogApi.activate).not.toHaveBeenCalled();
  });

  it("blocker copy contains no em or en dash", async () => {
    const blockers: StarterBlocker[] = [
      { pluginKey: "help-scout", kind: "missing", detail: "" },
      { pluginKey: "slack-tools", kind: "disabled", detail: "" },
    ];
    const host = await renderDialog({
      cards: cardStatuses({
        "daily-support-numbers": { ready: false, fixable: false, blockers },
      }),
    });

    // Only the blocker lines are this component's own words; the card prose
    // around them comes from the shared catalog and is checked there.
    const blockerLines = [...host.querySelectorAll("li")]
      .map((el) => el.textContent ?? "")
      .filter((text) => text.includes("help-scout") || text.includes("slack-tools"));
    expect(blockerLines).toEqual([
      "help-scout isn't installed. Install it on the Plugins page first",
      "slack-tools is switched off. Turning this on will switch it back on",
    ]);
    for (const line of blockerLines) {
      expect(line).not.toMatch(/[—–]/);
    }
  });

  it("Enter submits once with the dialog companyId, a uuid requestKey, and never calls starterCatalogApi.activate", async () => {
    mockStartWorkApi.plan.mockResolvedValue(planResponse());
    const host = await renderDialog();

    await draftPlan(host);

    expect(mockStartWorkApi.plan).toHaveBeenCalledTimes(1);
    const [companyId, body] = mockStartWorkApi.plan.mock.calls[0] as [string, { text: string; requestKey: string }];
    expect(companyId).toBe("company-1");
    expect(body.text).toBe(REQUEST_TEXT);
    expect(body.requestKey).toMatch(UUID_RE);
    expect(mockStarterCatalogApi.activate).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Lead: Ada.");
  });

  it("a second Enter while drafting does not send a second request; retrying the same text after an error reuses the same requestKey", async () => {
    let failFirst: ((err: unknown) => void) | null = null;
    mockStartWorkApi.plan.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { failFirst = reject; }),
    );
    const host = await renderDialog();

    typeInto(queryBox(host), REQUEST_TEXT);
    await flush();
    pressEnter(queryBox(host));
    await flush();
    expect(host.textContent).toContain("Drafting your plan. This can take up to a minute.");
    expect(queryBox(host).disabled).toBe(true);

    pressEnter(queryBox(host));
    await flush();
    expect(mockStartWorkApi.plan).toHaveBeenCalledTimes(1);

    // The request dies; the words stay so the person can try again.
    await act(async () => {
      failFirst?.(new ApiError("Request failed: 500", 500, null));
    });
    await flush();
    expect(host.textContent).toContain("Request failed: 500");
    expect(queryBox(host).value).toBe(REQUEST_TEXT);

    mockStartWorkApi.plan.mockResolvedValueOnce(planResponse());
    pressEnter(queryBox(host));
    await flush();
    expect(mockStartWorkApi.plan).toHaveBeenCalledTimes(2);
    const first = mockStartWorkApi.plan.mock.calls[0]?.[1] as { requestKey: string };
    const second = mockStartWorkApi.plan.mock.calls[1]?.[1] as { requestKey: string };
    expect(second.requestKey).toBe(first.requestKey);
  });

  it("renders the header for outboundHold true and false, the model line only when modelUsed is set, the nobody variant when lead is null, and one line per budget warning", async () => {
    mockStartWorkApi.plan.mockResolvedValue(planResponse({
      warnings: [
        { agentId: "agent-ceo", agentName: "Ada", reason: "monthly budget exhausted" },
        { agentId: "agent-ops", agentName: "Bao", reason: "monthly budget exhausted" },
      ],
    }));
    let host = await renderDialog();
    await draftPlan(host);

    let text = host.textContent ?? "";
    expect(text).toContain("Lead: Ada. The lead tracks the whole request; each task goes to the agent named on it.");
    expect(text).toContain("Starts the moment you accept, and runs once.");
    expect(text).toContain("Creates 2 tasks in Paperclip under PAP-42.");
    expect(text).toContain("Drafted by claude-sonnet-4-6. Drafting used one AI call; it is not charged to any agent budget.");
    expect(text).toContain("Emails, messages, calls and public posts the agents draft will wait for your approval first.");
    expect(text).toContain("Ada is paused by budget. Its task will be created but will not start until the budget is raised.");
    expect(text).toContain("Bao is paused by budget. Its task will be created but will not start until the budget is raised.");
    expect(text).not.toContain("approval hold is switched off");
    // The identifier is a real link to the request issue.
    expect(host.querySelector('a[href="/issues/PAP-42"]')).toBeTruthy();

    teardown();
    mockStartWorkApi.plan.mockResolvedValue(planResponse({
      lead: null,
      guardrails: { outboundHold: false },
      planner: { modelUsed: null },
    }));
    host = await renderDialog();
    await draftPlan(host);

    text = host.textContent ?? "";
    expect(text).toContain("No agent is free to lead this right now. After you accept, open PAP-42 and assign it.");
    expect(text).not.toContain("Lead: ");
    expect(text).toContain("The approval hold is switched off, so emails, messages, calls and public posts the agents make will go out without asking you. Change this under Instance settings.");
    expect(text).not.toContain("Drafted by");
    expect(text).not.toContain("is paused by budget");
  });

  it("shows the recurring note with a link to /routines and the portfolio line only when notes.isPortfolioRoot", async () => {
    mockStartWorkApi.plan.mockResolvedValue(planResponse({
      notes: {
        soundsRecurring: true,
        recurringNote: "You said every week.",
        companyName: "Paperclip",
        isPortfolioRoot: false,
      },
    }));
    let host = await renderDialog();
    await draftPlan(host);

    let text = host.textContent ?? "";
    expect(text).toContain("You said every week. This sounds like something to repeat. This step creates one-off tasks only. To make it repeat, set it up on the Automations page afterwards.");
    expect(host.querySelector('a[href="/routines"]')?.textContent).toBe("Automations page");
    expect(text).not.toContain("Portfolio directives");
    expect(host.querySelector('a[href="/portfolio-directives"]')).toBeNull();

    teardown();
    mockStartWorkApi.plan.mockResolvedValue(planResponse({
      notes: {
        soundsRecurring: false,
        recurringNote: null,
        companyName: "Paperclip",
        isPortfolioRoot: true,
      },
    }));
    host = await renderDialog();
    await draftPlan(host);

    text = host.textContent ?? "";
    expect(text).not.toContain("This sounds like something to repeat.");
    expect(host.querySelector('a[href="/routines"]')).toBeNull();
    expect(text).toContain("This plan is for Paperclip only. To send this to every company, use Portfolio directives.");
    expect(host.querySelector('a[href="/portfolio-directives"]')?.textContent).toBe("Portfolio directives");
  });

  it("renders the Left out list and the plan card with Accept drafts and Reject", async () => {
    mockStartWorkApi.plan.mockResolvedValue(planResponse({
      leftOut: [
        { title: "Post the best reviews to Instagram", reason: "instagram isn't installed. Install it on the Plugins page first" },
      ],
    }));
    const host = await renderDialog();
    await draftPlan(host);

    const text = host.textContent ?? "";
    expect(text).toContain("Left out, and why");
    expect(text).toContain("Post the best reviews to Instagram: instagram isn't installed. Install it on the Plugins page first");
    // The left-out task is prose only: nothing to tick.
    expect(host.querySelectorAll('[role="checkbox"]')).toHaveLength(2);
    expect(text).toContain("Ask recent customers for a review");
    expect(text).toContain("Reply to every new review");
    expect(buttonLabelled(host, "Accept drafts")).toBeTruthy();
    expect(buttonLabelled(host, "Reject")).toBeTruthy();
    expect(text).toContain("You can also decide this later from your Overview or from PAP-42.");
  });

  it("a matching starter card stays visible with Turn this on and drafting does not activate it", async () => {
    const reviewsCard = STARTER_CARDS.find((card) => card.title === REVIEWS_TITLE);
    expect(reviewsCard).toBeTruthy();
    mockStartWorkApi.plan.mockResolvedValue(planResponse({ matchedCards: [reviewsCard!.id] }));
    const host = await renderDialog();
    await draftPlan(host, REVIEWS_TITLE);

    expect(host.textContent).toContain("Ready-made starters that match");
    expect(host.textContent).toContain(REVIEWS_TITLE);
    // Only the matched card shows above the plan; the rest of the catalog
    // waits until the plan is decided.
    expect(host.textContent).not.toContain(NO_SHOW_TITLE);
    expect(buttonLabelled(host, "Turn this on")).toBeTruthy();
    expect(mockStarterCatalogApi.activate).not.toHaveBeenCalled();
    expect(mockStartWorkApi.plan).toHaveBeenCalledTimes(1);
  });

  it("accept calls issuesApi.acceptInteraction with the ticked keys, refetches the container, and shows the receipt with the real owner name", async () => {
    mockStartWorkApi.plan.mockResolvedValue(planResponse());
    mockIssuesApi.acceptInteraction.mockResolvedValue(planInteraction({
      status: "accepted",
      resolvedByUserId: "user-board",
      result: {
        version: 1,
        createdTasks: [
          { clientKey: "ask", issueId: "issue-ask", identifier: "PAP-43", title: "Ask recent customers for a review" },
        ],
        skippedClientKeys: ["reply"],
      },
    }));
    mockIssuesApi.get.mockResolvedValue({
      id: "issue-container",
      identifier: "PAP-42",
      assigneeAgentId: "agent-ceo",
    } as Issue);
    const host = await renderDialog();
    await draftPlan(host);

    // Untick the second task, then accept what is left.
    const boxes = [...host.querySelectorAll('[role="checkbox"]')] as HTMLButtonElement[];
    expect(boxes).toHaveLength(2);
    click(boxes[1]);
    await flush();
    expect(host.textContent).toContain("1 will be skipped if you accept.");
    click(buttonLabelled(host, "Accept selected drafts"));
    await flush();

    expect(mockIssuesApi.acceptInteraction).toHaveBeenCalledWith(
      "issue-container",
      "interaction-plan",
      { selectedClientKeys: ["ask"] },
    );
    expect(mockIssuesApi.get).toHaveBeenCalledWith("issue-container");
    const text = host.textContent ?? "";
    expect(text).toContain("Plan accepted");
    expect(text).toContain("Created 1 task under PAP-42");
    // The server queues the wake and does not wait for it, so the receipt says
    // who holds it and when it gets looked at, never that it was woken.
    expect(text).toContain("Handed to Ada. It will pick this up on its next run.");
    expect(text).not.toContain("has been woken");
    expect(text).toContain("Left out by you: 1");
    // Back to the empty box with the catalog behind it.
    expect(queryBox(host).value).toBe("");
    expect(buttonLabelled(host, "Accept drafts")).toBeUndefined();
    expect(host.textContent).toContain(NO_SHOW_TITLE);
    expect(mockStarterCatalogApi.activate).not.toHaveBeenCalled();
  });

  it("a container with no assignee after accept shows the open-and-assign step", async () => {
    mockStartWorkApi.plan.mockResolvedValue(planResponse({ lead: null }));
    mockIssuesApi.acceptInteraction.mockResolvedValue(planInteraction({
      status: "accepted",
      result: {
        version: 1,
        createdTasks: [
          { clientKey: "ask", issueId: "issue-ask", identifier: "PAP-43", title: "Ask recent customers for a review" },
          { clientKey: "reply", issueId: "issue-reply", identifier: "PAP-44", title: "Reply to every new review" },
        ],
      },
    }));
    mockIssuesApi.get.mockResolvedValue({
      id: "issue-container",
      identifier: "PAP-42",
      assigneeAgentId: null,
    } as Issue);
    const host = await renderDialog();
    await draftPlan(host);

    click(buttonLabelled(host, "Accept drafts"));
    await flush();

    const text = host.textContent ?? "";
    expect(text).toContain("Created 2 tasks under PAP-42");
    expect(text).toContain("Nobody was handed the request; open PAP-42 and assign it");
    expect(text).not.toContain("has been woken");
    expect(text).not.toContain("Left out by you");
  });

  it("a lead that is paused by budget gets the budget sentence in the receipt instead of a promise it will run", async () => {
    mockStartWorkApi.plan.mockResolvedValue(planResponse({
      warnings: [{ agentId: "agent-ceo", agentName: "Ada", reason: "monthly budget exhausted" }],
    }));
    mockIssuesApi.acceptInteraction.mockResolvedValue(planInteraction({
      status: "accepted",
      result: {
        version: 1,
        createdTasks: [
          { clientKey: "ask", issueId: "issue-ask", identifier: "PAP-43", title: "Ask recent customers for a review" },
          { clientKey: "reply", issueId: "issue-reply", identifier: "PAP-44", title: "Reply to every new review" },
        ],
      },
    }));
    mockIssuesApi.get.mockResolvedValue({
      id: "issue-container",
      identifier: "PAP-42",
      assigneeAgentId: "agent-ceo",
    } as Issue);
    const host = await renderDialog();
    await draftPlan(host);

    click(buttonLabelled(host, "Accept drafts"));
    await flush();

    const text = host.textContent ?? "";
    expect(text).toContain("Plan accepted");
    expect(text).toContain("Handed to Ada. Ada is paused by budget, so it will not start until the budget is raised.");
    expect(text).not.toContain("It will pick this up on its next run.");
    expect(text).not.toContain("has been woken");
  });

  it("a failed read of the container after a successful accept still shows Plan accepted, with the owner left unconfirmed", async () => {
    mockStartWorkApi.plan.mockResolvedValue(planResponse());
    mockIssuesApi.acceptInteraction.mockResolvedValue(planInteraction({
      status: "accepted",
      result: {
        version: 1,
        createdTasks: [
          { clientKey: "ask", issueId: "issue-ask", identifier: "PAP-43", title: "Ask recent customers for a review" },
          { clientKey: "reply", issueId: "issue-reply", identifier: "PAP-44", title: "Reply to every new review" },
        ],
      },
    }));
    // The accept went through; only the read that names the owner failed.
    mockIssuesApi.get.mockRejectedValue(new ApiError("Request failed: 500", 500, null));
    const host = await renderDialog();
    await draftPlan(host);

    click(buttonLabelled(host, "Accept drafts"));
    await flush();

    const text = host.textContent ?? "";
    expect(text).toContain("Plan accepted");
    expect(text).toContain("Created 2 tasks under PAP-42");
    expect(text).toContain("Nobody could be confirmed; open PAP-42 to check who has it");
    expect(text).not.toContain("Request failed: 500");
    // The card is gone: pressing Accept again would only be refused.
    expect(buttonLabelled(host, "Accept drafts")).toBeUndefined();
    expect(host.textContent).toContain(NO_SHOW_TITLE);
  });

  it("reject calls issuesApi.rejectInteraction, shows the cancelled receipt, and returns to the empty box", async () => {
    mockStartWorkApi.plan.mockResolvedValue(planResponse());
    mockIssuesApi.rejectInteraction.mockResolvedValue(planInteraction({ status: "rejected" }));
    const host = await renderDialog();
    await draftPlan(host);

    click(buttonLabelled(host, "Reject"));
    await flush();
    click(buttonLabelled(host, "Save rejection"));
    await flush();

    expect(mockIssuesApi.rejectInteraction).toHaveBeenCalledWith("issue-container", "interaction-plan", undefined);
    expect(queryBox(host).value).toBe("");
    expect(buttonLabelled(host, "Accept drafts")).toBeUndefined();
    expect(host.textContent).not.toContain("Lead: Ada.");
    expect(host.textContent).toContain(NO_SHOW_TITLE);
    expect(host.textContent).toContain(REVIEWS_TITLE);

    // Rejecting cancels the request issue on the server, so the panel says so
    // rather than emptying itself in silence.
    expect(host.textContent).toContain("Plan rejected");
    expect(host.textContent).toContain("Request PAP-42 was cancelled. Nothing was started.");
    expect(host.querySelector('a[href="/issues/PAP-42"]')).toBeTruthy();

    // A fresh request after a reject gets a fresh key: the old one would
    // hand back the rejected plan.
    mockStartWorkApi.plan.mockResolvedValue(planResponse());
    await draftPlan(host);
    const first = mockStartWorkApi.plan.mock.calls[0]?.[1] as { requestKey: string };
    const second = mockStartWorkApi.plan.mock.calls[1]?.[1] as { requestKey: string };
    expect(second.requestKey).not.toBe(first.requestKey);
  });

  it("a 409 on accept shows Someone already decided this plan and refetches the card", async () => {
    mockStartWorkApi.plan.mockResolvedValue(planResponse());
    mockIssuesApi.acceptInteraction.mockRejectedValue(
      new ApiError("Interaction has already been resolved", 409, null),
    );
    mockIssuesApi.listInteractions.mockResolvedValue([
      planInteraction({
        status: "accepted",
        resolvedByUserId: "user-other",
        resolvedAt: new Date("2026-09-06T09:05:00.000Z"),
        result: {
          version: 1,
          createdTasks: [
            { clientKey: "ask", issueId: "issue-ask", identifier: "PAP-43", title: "Ask recent customers for a review" },
            { clientKey: "reply", issueId: "issue-reply", identifier: "PAP-44", title: "Reply to every new review" },
          ],
        },
      }),
    ]);
    const host = await renderDialog();
    await draftPlan(host);

    click(buttonLabelled(host, "Accept drafts"));
    await flush();

    expect(mockIssuesApi.listInteractions).toHaveBeenCalledWith("issue-container");
    expect(mockIssuesApi.get).not.toHaveBeenCalled();
    const text = host.textContent ?? "";
    expect(text).toContain("Someone already decided this plan");
    // The server's wording never reaches the screen.
    expect(text).not.toContain("Interaction has already been resolved");
    expect(text).toContain("Accepted");
    expect(buttonLabelled(host, "Accept drafts")).toBeUndefined();
  });

  it("a 409 that is not the already-decided one shows what the server said, and keeps the card", async () => {
    mockStartWorkApi.plan.mockResolvedValue(planResponse());
    // A task went to an agent nobody has approved yet. Nothing was decided by
    // anybody, so blaming another person would be a lie.
    mockIssuesApi.acceptInteraction.mockRejectedValue(
      new ApiError("Cannot assign work to pending approval agents", 409, null),
    );
    mockIssuesApi.listInteractions.mockResolvedValue([planInteraction()]);
    const host = await renderDialog();
    await draftPlan(host);

    click(buttonLabelled(host, "Accept drafts"));
    await flush();

    const text = host.textContent ?? "";
    expect(text).toContain("Cannot assign work to pending approval agents");
    expect(text).not.toContain("Someone already decided this plan");
    // The plan is still there to accept once the agent is approved.
    expect(buttonLabelled(host, "Accept drafts")).toBeTruthy();
  });

  it("a 503 shows the server text and Create it as one issue instead opens NewIssue with the typed text and the companyId", async () => {
    const message = "No AI model is set up yet, so a plan cannot be drafted. Add one under Instance settings, then try again. Nothing was created.";
    mockStartWorkApi.plan.mockRejectedValue(new ApiError(message, 503, null));
    const onClose = vi.fn();
    const host = await renderDialog({ onClose });
    // The box is a single-line input, so the title and the description are
    // the same words here; the first-line rule only bites on pasted text.
    await draftPlan(host);

    expect(host.textContent).toContain(message);
    expect(buttonLabelled(host, "Accept drafts")).toBeUndefined();
    click(buttonLabelled(host, "Create it as one issue instead"));
    await flush();

    expect(mockOpenNewIssue).toHaveBeenCalledWith({
      title: REQUEST_TEXT,
      description: REQUEST_TEXT,
      companyId: "company-1",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a 422 shows the server text, keeps the typed text, and renders no card", async () => {
    const message = "Could not turn that into a plan. Try saying it a different way, with the outcome you want. Nothing was created.";
    mockStartWorkApi.plan.mockRejectedValue(new ApiError(message, 422, null));
    const host = await renderDialog();
    await draftPlan(host);

    expect(host.textContent).toContain(message);
    expect(queryBox(host).value).toBe(REQUEST_TEXT);
    expect(queryBox(host).disabled).toBe(false);
    expect(buttonLabelled(host, "Accept drafts")).toBeUndefined();
    expect(buttonLabelled(host, "Reject")).toBeUndefined();
    expect(host.querySelectorAll('[role="checkbox"]')).toHaveLength(0);
  });

  it("while the access check is still running the panel says so and the buttons are switched off", async () => {
    const host = await renderDialog({ accessCall: "pending" });

    expect(host.textContent).toContain("Checking your access...");
    // The button is on screen and switched off, not missing, and the panel
    // never claims the person cannot start work here.
    const draftButton = buttonLabelled(host, "Draft a plan");
    expect(draftButton).toBeTruthy();
    expect(draftButton?.disabled).toBe(true);
    expect(host.textContent).not.toContain("You can browse this company, but only members who can create work can start it.");
    expect(host.textContent).not.toContain("Could not check your access.");

    // Typing and pressing Enter asks for nothing until the answer is in.
    await draftPlan(host);
    expect(mockStartWorkApi.plan).not.toHaveBeenCalled();
  });

  it("a failed access check says so instead of saying the person cannot start work here", async () => {
    const host = await renderDialog({ accessCall: "failed" });

    expect(host.textContent).toContain("Could not check your access. Close and try again.");
    expect(host.textContent).not.toContain("You can browse this company, but only members who can create work can start it.");
    expect(host.textContent).not.toContain("Checking your access...");
    expect(buttonLabelled(host, "Draft a plan")).toBeUndefined();
    expect(buttonLabelled(host, "Turn this on")).toBeUndefined();
    // The server's own wording never reaches the screen.
    expect(host.textContent).not.toContain("Request failed: 500");
  });

  it("a plan already on screen when the role drops to viewer cannot be accepted or rejected from the card", async () => {
    mockStartWorkApi.plan.mockResolvedValue(planResponse());
    const host = await renderDialog();
    await draftPlan(host);
    expect(buttonLabelled(host, "Accept drafts")?.disabled).toBe(false);

    // The same panel, the same plan, after the access answer changes to a
    // viewer. This is the only way the card is ever rendered for a viewer, and
    // it is what pins the card's own buttons rather than the empty screen.
    act(() => {
      queryClient?.setQueryData(queryKeys.access.currentBoardAccess, viewerAccess);
    });
    await flush();

    const acceptButton = buttonLabelled(host, "Accept drafts");
    const rejectButton = buttonLabelled(host, "Reject");
    expect(acceptButton).toBeTruthy();
    expect(rejectButton).toBeTruthy();
    expect(acceptButton?.disabled).toBe(true);
    expect(rejectButton?.disabled).toBe(true);
    expect(host.textContent).toContain(
      "Your role in this company can read this plan but not accept or reject it. Ask an admin for a role that can create work.",
    );
    expect(host.textContent).not.toContain("You can also decide this later from your Overview");

    click(acceptButton);
    await flush();
    expect(mockIssuesApi.acceptInteraction).not.toHaveBeenCalled();
    expect(mockIssuesApi.rejectInteraction).not.toHaveBeenCalled();
  });

  it("a viewer sees no Draft a plan, no Turn this on, and no accept button, and sees the browse-only sentence", async () => {
    mockStartWorkApi.plan.mockResolvedValue(planResponse());
    const host = await renderDialog({ access: viewerAccess });

    expect(host.textContent).toContain("You can browse this company, but only members who can create work can start it.");
    expect(buttonLabelled(host, "Draft a plan")).toBeUndefined();
    expect(buttonLabelled(host, "Turn this on")).toBeUndefined();
    expect(host.textContent).toContain(NO_SHOW_TITLE);

    // Enter filters the cards and nothing more.
    await draftPlan(host, "review");
    expect(mockStartWorkApi.plan).not.toHaveBeenCalled();
    expect(mockStarterCatalogApi.activate).not.toHaveBeenCalled();
    expect(host.textContent).toContain(REVIEWS_TITLE);
    expect(buttonLabelled(host, "Accept drafts")).toBeUndefined();
    expect(buttonLabelled(host, "Turn this on")).toBeUndefined();
  });

  it("no rendered text contains the word interaction or an em or en dash", async () => {
    const reviewsCard = STARTER_CARDS.find((card) => card.title === REVIEWS_TITLE);
    mockStartWorkApi.plan.mockResolvedValue(planResponse({
      lead: null,
      leftOut: [{ title: "Post the best reviews to Instagram", reason: "instagram isn't installed. Install it on the Plugins page first" }],
      warnings: [{ agentId: "agent-ops", agentName: "Bao", reason: "budget" }],
      notes: { soundsRecurring: true, recurringNote: "You said every week.", companyName: "Paperclip", isPortfolioRoot: true },
      guardrails: { outboundHold: false },
      matchedCards: [reviewsCard!.id],
    }));
    mockIssuesApi.acceptInteraction.mockResolvedValue(planInteraction({
      status: "accepted",
      result: {
        version: 1,
        createdTasks: [
          { clientKey: "ask", issueId: "issue-ask", identifier: "PAP-43", title: "Ask recent customers for a review" },
        ],
        skippedClientKeys: ["reply"],
      },
    }));
    mockIssuesApi.get.mockResolvedValue({ id: "issue-container", identifier: "PAP-42", assigneeAgentId: null } as Issue);

    // Empty box, then the full plan with every header line, then the receipt.
    let host = await renderDialog();
    expectPlainWords(host);
    await draftPlan(host);
    expect(buttonLabelled(host, "Accept drafts")).toBeTruthy();
    expectPlainWords(host);
    click(buttonLabelled(host, "Reject"));
    await flush();
    expectPlainWords(host);
    click(buttonLabelled(host, "Accept drafts"));
    await flush();
    expect(host.textContent).toContain("Plan accepted");
    expectPlainWords(host);

    // The two refusals and the viewer's view.
    teardown();
    mockStartWorkApi.plan.mockRejectedValue(new ApiError("No AI model is set up yet. Nothing was created.", 503, null));
    host = await renderDialog();
    await draftPlan(host);
    expect(buttonLabelled(host, "Create it as one issue instead")).toBeTruthy();
    expectPlainWords(host);

    teardown();
    mockStartWorkApi.plan.mockRejectedValue(new ApiError("Could not turn that into a plan. Nothing was created.", 422, null));
    host = await renderDialog();
    await draftPlan(host);
    expectPlainWords(host);

    teardown();
    host = await renderDialog({ access: viewerAccess });
    expectPlainWords(host);
  });
});
