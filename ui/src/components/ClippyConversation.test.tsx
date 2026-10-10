// @vitest-environment jsdom

import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brandBanner } from "@/lib/status-colors";
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

/** What the conversation last handed the message list for an empty chat. */
const mockMessageList = { emptyState: null as unknown };

vi.mock("./ClippyMessageList", () => ({
  ClippyMessageList: ({ emptyState }: { emptyState?: unknown }) => {
    mockMessageList.emptyState = emptyState;
    return <div data-testid="messages" />;
  },
}));

function suggestionsShown(): string[] {
  return (mockMessageList.emptyState as { props: { suggestions: string[] } }).props.suggestions;
}
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

  it("warns when the chat belongs to another company, with a way to start one here", async () => {
    mockChatSession.session.companyId = "c2"; // Industry Bureau while route is HQ (c1)
    const onNewSession = vi.fn();
    await render({ sessionId: "s1", onNewSessionForCurrentCompany: onNewSession });

    // One line, but in the warning colours: a muted grey line was too easy to miss.
    const note = container.querySelector('[data-testid="company-mismatch-note"]');
    expect(note).not.toBeNull();
    for (const warningClass of brandBanner.warning.split(" ")) {
      expect(note?.classList.contains(warningClass)).toBe(true);
    }
    expect(note?.className).not.toContain("text-muted-foreground");
    // Inside a status region that is always there, so a screen reader
    // announces it when it appears.
    expect(note?.parentElement?.getAttribute("role")).toBe("status");
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

  it("does not flash the note in the frame before a company switch swaps the chat", async () => {
    mockChatSession.session.companyId = "c2"; // the old company's chat against the new page
    const inFirstFrame: boolean[] = [];
    function FirstFrameProbe() {
      // Layout effects run after the first commit, before any passive effect.
      useLayoutEffect(() => {
        inFirstFrame.push(Boolean(container.querySelector('[data-testid="company-mismatch-note"]')));
      }, []);
      return null;
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ClippyConversation sessionId="s1" onNewSessionForCurrentCompany={vi.fn()} />
          <FirstFrameProbe />
        </QueryClientProvider>,
      );
    });

    // ClippyContext swaps in the new company's chat in an effect; until then
    // the mismatch is not real.
    expect(inFirstFrame).toEqual([false]);
    // One that is still there afterwards is, and shows.
    expect(container.querySelector('[data-testid="company-mismatch-note"]')).not.toBeNull();
  });

  it("keeps a long company name from pushing the note's button out of the window", async () => {
    mockChatSession.session.companyId = "c2";
    await render({ sessionId: "s1", onNewSessionForCurrentCompany: vi.fn() });

    const button = container.querySelector('[data-testid="company-mismatch-note"] button');
    expect(button?.className).toContain("max-w-[45%]");
    expect(button?.querySelector("span")?.className).toContain("truncate");
    expect(button?.getAttribute("title")).toBe("Start one in HQ");
  });

  it("says nothing about the company when the chat belongs to the one being viewed", async () => {
    mockChatSession.session.companyId = "c1";
    await render({ sessionId: "s1", onNewSessionForCurrentCompany: vi.fn() });

    expect(container.querySelector('[data-testid="company-mismatch-note"]')).toBeNull();
  });

  it("suggests questions about the chat's own company when it is not the one being viewed", async () => {
    mockChatSession.session.companyId = "c2"; // Industry Bureau while route is HQ (c1)
    await render({ sessionId: "s1", suggestions: ["Summarize this issue", "Summarize open issues in HQ"] });

    expect(suggestionsShown()).toContain("Summarize open issues in Industry Bureau");
    expect(suggestionsShown()).not.toContain("Summarize this issue");
    expect(suggestionsShown()).not.toContain("Summarize open issues in HQ");
  });

  it("keeps the page's suggestions when the chat belongs to the company being viewed", async () => {
    mockChatSession.session.companyId = "c1";
    await render({ sessionId: "s1", suggestions: ["Summarize this issue"] });

    expect(suggestionsShown()).toEqual(["Summarize this issue"]);
  });
});
