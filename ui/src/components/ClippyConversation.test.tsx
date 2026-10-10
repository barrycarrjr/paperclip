// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClippyConversation } from "./ClippyConversation";

const mockChatSession = {
  session: {
    id: "s1",
    title: "why am I having so much trouble with mme-261",
    permissionMode: "ask",
    effort: "auto",
    model: "claude-opus-5",
    companyId: null as string | null,
  },
  transcript: [],
  streaming: false,
  pendingPermissions: [],
  liveToolCalls: [],
  lastEventAt: null,
  send: vi.fn(),
  abortAndSend: vi.fn(),
  decidePermission: vi.fn(),
  patchSession: vi.fn(),
  abort: vi.fn(),
};

vi.mock("../hooks/useChatSession", () => ({
  // Like the real hook: a new chat (no id yet) has no session record.
  useChatSession: (sessionId: string | null) => (sessionId ? mockChatSession : { ...mockChatSession, session: null }),
}));

const mockCompanyContext = {
  companies: [
    { id: "c1", name: "HQ", issuePrefix: "HQ", brandColor: "#ff0000" },
    { id: "c2", name: "Industry Bureau", issuePrefix: "IND", brandColor: "#00ff00" },
  ],
  selectedCompanyId: "c1",
};

vi.mock("../context/CompanyContext", () => ({
  useCompanyOptional: () => mockCompanyContext,
}));

vi.mock("@/lib/router", () => ({
  useParams: () => ({ companyPrefix: "HQ" }),
}));

vi.mock("./ClippyMessageList", () => ({ ClippyMessageList: () => <div data-testid="messages" /> }));
vi.mock("./ClippyComposer", () => ({ ClippyComposer: () => <div data-testid="composer" /> }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(props: Parameters<typeof ClippyConversation>[0]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ClippyConversation {...props} />
      </QueryClientProvider>,
    );
  });
}

function listButton(): HTMLElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === "Show the chat list",
  );
}

describe("ClippyConversation", () => {
  beforeEach(() => {
    mockChatSession.session.companyId = null;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("offers a way back to the chat list, on small screens only", async () => {
    const onOpenSessionList = vi.fn();
    await render({ sessionId: "s1", onOpenSessionList });

    const button = listButton();
    expect(button).toBeDefined();
    expect(button?.className).toContain("md:hidden");

    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onOpenSessionList).toHaveBeenCalledTimes(1);
  });

  it("shows no such button where the list is always on screen", async () => {
    await render({ sessionId: "s1" });

    expect(listButton()).toBeUndefined();
  });

  it("keeps a long chat title from pushing the header wider than the screen", async () => {
    await render({ sessionId: "s1", onOpenSessionList: vi.fn() });

    const title = [...container.querySelectorAll("span")].find((span) =>
      span.textContent?.includes("mme-261"),
    );
    expect(title?.className).toContain("truncate");
    expect(title?.className).toContain("min-w-0");
  });

  it("offers the list from a new chat too, so a phone is never stuck", async () => {
    const onOpenSessionList = vi.fn();
    await render({ sessionId: null, onOpenSessionList });

    expect(container.textContent).toContain("New chat");
    expect(listButton()?.className).toContain("md:hidden");
  });

  it("leaves its own title row out where the window above it has one", async () => {
    await render({ sessionId: "s1", showHeader: false, onOpenSessionList: vi.fn() });

    expect(listButton()).toBeUndefined();
    expect(container.querySelector('[data-testid="session-company-badge"]')).toBeNull();
  });

  it("displays the company badge matching the chat's pinned company", async () => {
    mockChatSession.session.companyId = "c2";
    await render({ sessionId: "s1" });

    const badge = container.querySelector('[data-testid="session-company-badge"]');
    expect(badge).toBeDefined();
    expect(badge?.textContent).toContain("Industry Bureau");
  });

  it("says quietly when the chat belongs to another company, with a way to start one here", async () => {
    mockChatSession.session.companyId = "c2"; // Industry Bureau while route is HQ (c1)
    const onNewSession = vi.fn();
    await render({ sessionId: "s1", onNewSessionForCurrentCompany: onNewSession });

    // One muted line rather than the amber warning banner it replaced.
    expect(container.querySelector('[data-testid="company-mismatch-banner"]')).toBeNull();
    const note = container.querySelector('[data-testid="company-mismatch-note"]');
    expect(note).not.toBeNull();
    expect(note?.className).toContain("text-muted-foreground");
    expect(note?.textContent).toContain("This chat is in Industry Bureau.");

    const startHere = [...note!.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Start one in HQ"),
    );
    expect(startHere).toBeDefined();
    act(() => {
      startHere?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onNewSession).toHaveBeenCalledTimes(1);
  });

  it("says nothing about the company when the chat belongs to the one being viewed", async () => {
    mockChatSession.session.companyId = "c1";
    await render({ sessionId: "s1", onNewSessionForCurrentCompany: vi.fn() });

    expect(container.querySelector('[data-testid="company-mismatch-note"]')).toBeNull();
  });
});
