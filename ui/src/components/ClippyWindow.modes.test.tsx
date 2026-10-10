// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClippyProvider } from "../context/ClippyContext";
import { ClippyLauncher } from "./ClippyLauncher";
import { ClippyWindow } from "./ClippyWindow";

const companyState = vi.hoisted(() => ({
  companies: [
    { id: "company-1", name: "HQ", issuePrefix: "HQ", isPortfolioRoot: true, brandColor: "#2563eb" },
    { id: "company-2", name: "Acme", issuePrefix: "ACM", isPortfolioRoot: false, brandColor: null },
  ] as Array<Record<string, unknown>>,
  selectedCompanyId: "company-1" as string | null,
}));

const mockChatApi = vi.hoisted(() => ({
  listSessions: vi.fn(),
  getSession: vi.fn(),
  createSession: vi.fn(),
  patchSession: vi.fn(),
  deleteSession: vi.fn(),
}));

/** What the conversation pane was asked to show, and how often it drew. */
const conversation = vi.hoisted(() => ({ shown: [] as Array<string | null>, renders: 0 }));

/** Stable, like the real hook's memoised answer. */
const pageInfo = vi.hoisted(() => ({ pageContext: null, suggestions: [] as string[] }));

const pending = vi.hoisted(() => ({ count: 0, first: null as string | null }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
  useCompanyOptional: () => companyState,
}));

vi.mock("@/lib/router", () => ({
  useParams: () => ({ companyPrefix: "HQ" }),
  useLocation: () => ({ pathname: "/HQ/dashboard", search: "", hash: "", state: null }),
}));

vi.mock("../api/chat", () => ({ chatApi: mockChatApi }));

vi.mock("./ClippyConversation", () => ({
  ClippyConversation: ({ sessionId }: { sessionId: string | null }) => {
    conversation.shown.push(sessionId);
    conversation.renders += 1;
    return <div data-testid="conversation">{sessionId ?? "new chat"}</div>;
  },
}));

vi.mock("../hooks/useClippyPage", () => ({
  useClippyPage: () => pageInfo,
  useClippyGreetingName: () => null,
}));

vi.mock("../lib/clippy-stream-manager", () => ({
  clippyStreamManager: {
    subscribe: () => () => {},
    getSnapshot: () => ({ streaming: false }),
    subscribeGlobal: () => () => {},
    getPendingActionCount: () => pending.count,
    firstSessionWithPendingAction: () => pending.first,
    disposeSession: () => {},
  },
}));

// Radix menus open on pointer events jsdom does not fully have. These keep
// the items and what they do, which is what is under test here.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
  }: {
    children: ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" role="menuitem" disabled={disabled} onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuSub: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

const SESSIONS = [
  {
    id: "chat-irs",
    companyId: "company-1",
    title: "Remind me to send the IRS letter",
    model: "adapter:claude_local:claude-sonnet-5-5",
    archivedAt: null as string | null,
    updatedAt: TWO_HOURS_AGO,
  },
  {
    id: "chat-acme",
    companyId: "company-2",
    title: "Summarize open issues in Acme",
    model: "adapter:claude_local:claude-opus-5",
    archivedAt: null as string | null,
    updatedAt: TWO_HOURS_AGO,
  },
  {
    id: "chat-old",
    companyId: "company-1",
    title: "Last year's tax filing",
    model: "adapter:claude_local:claude-opus-5",
    archivedAt: TWO_HOURS_AGO as string | null,
    updatedAt: TWO_HOURS_AGO,
  },
];

let container: HTMLDivElement;
let root: Root | null = null;
let queryClient: QueryClient;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderClippy({ isPhone = false, onClippyPage = false } = {}) {
  if (root) act(() => root!.unmount());
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <ClippyProvider isPhone={isPhone} onClippyPage={onClippyPage}>
          <ClippyLauncher />
          <ClippyWindow />
        </ClippyProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
}

function clippyWindow(): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-clippy-mode]");
}

function findButton(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label")?.startsWith(label) ||
      candidate.textContent?.trim() === label ||
      // A chat row is named by its title.
      candidate.getAttribute("title") === label,
  );
}

async function click(label: string) {
  const button = findButton(label);
  expect(button, `no "${label}" button`).toBeDefined();
  await act(async () => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

async function switchLayout(name: "Floating" | "Sidebar" | "Full screen") {
  const item = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((candidate) =>
    candidate.textContent?.startsWith(name),
  );
  expect(item, `no "${name}" layout`).toBeDefined();
  await act(async () => {
    item!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

function header(): HTMLElement {
  const found = container.querySelector<HTMLElement>("[data-clippy-header]");
  expect(found, "no window header").not.toBeNull();
  return found!;
}

function pointer(type: string, x: number, y: number) {
  return new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 7, button: 0 });
}

async function press(element: HTMLElement, key: string) {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

describe("the Clippy window", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    window.localStorage.clear();
    conversation.shown = [];
    conversation.renders = 0;
    pending.count = 0;
    pending.first = null;
    for (const fn of Object.values(mockChatApi)) fn.mockReset();
    // Like the server: "active" leaves archived chats out, "all" has them.
    mockChatApi.listSessions.mockImplementation((filters?: { status?: string }) => {
      const status = filters?.status ?? "active";
      const sessions =
        status === "all"
          ? SESSIONS
          : status === "archived"
            ? SESSIONS.filter((s) => s.archivedAt)
            : SESSIONS.filter((s) => !s.archivedAt);
      return Promise.resolve({ sessions });
    });
    mockChatApi.getSession.mockImplementation((id: string) =>
      Promise.resolve({ session: SESSIONS.find((s) => s.id === id) ?? { id, title: id, companyId: "company-1" } }),
    );
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container.remove();
    window.localStorage.clear();
    document.documentElement.style.removeProperty("--clippy-dock-width");
  });

  it("opens from the launcher pill as a floating window that leaves the page usable", async () => {
    await renderClippy();
    expect(clippyWindow()).toBeNull();
    expect(findButton("Ask Clippy")?.textContent).toContain("Ask Clippy anything");

    await click("Ask Clippy");

    const opened = clippyWindow();
    expect(opened?.dataset.clippyMode).toBe("floating");
    // A window, not a modal: no backdrop and nothing marks the page inert.
    expect(opened?.getAttribute("role")).toBe("dialog");
    expect(opened?.hasAttribute("aria-modal")).toBe(false);
    expect(opened?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(opened?.style.right).toBe("16px");
    expect(opened?.style.bottom).toBe("16px");
    expect(findButton("Ask Clippy")?.hidden).toBe(true);
  });

  it("switches between floating, sidebar and full screen, and keeps the choice", async () => {
    await renderClippy();
    await click("Ask Clippy");
    expect(clippyWindow()?.dataset.clippyMode).toBe("floating");

    await switchLayout("Sidebar");
    let shown = clippyWindow();
    expect(shown?.dataset.clippyMode).toBe("sidebar");
    expect(shown?.getAttribute("role")).toBe("complementary");
    // The page makes room for the docked panel.
    expect(document.documentElement.style.getPropertyValue("--clippy-dock-width")).toBe("420px");
    expect(window.localStorage.getItem("paperclip.clippy.mode")).toBe("sidebar");

    await switchLayout("Full screen");
    shown = clippyWindow();
    expect(shown?.dataset.clippyMode).toBe("fullscreen");
    expect(shown?.getAttribute("aria-modal")).toBe("true");
    // Every chat beside the conversation, as on the Clippy page.
    expect(container.querySelector('aside[aria-label="Chats"]')).not.toBeNull();
    expect(document.documentElement.style.getPropertyValue("--clippy-dock-width")).toBe("0px");
    expect(window.localStorage.getItem("paperclip.clippy.mode")).toBe("fullscreen");

    // The conversation was never replaced while the layout changed.
    expect(new Set(conversation.shown.filter(Boolean))).toEqual(new Set(["chat-irs"]));

    // A reload keeps the layout: the next open is full screen again.
    await renderClippy();
    expect(clippyWindow()).toBeNull();
    await click("Ask Clippy");
    expect(clippyWindow()?.dataset.clippyMode).toBe("fullscreen");
  });

  it("comes back docked after a reload when it was left open as a sidebar", async () => {
    await renderClippy();
    await click("Ask Clippy");
    await switchLayout("Sidebar");

    await renderClippy();

    expect(clippyWindow()?.dataset.clippyMode).toBe("sidebar");
    // It reopened by itself, so it must not take focus from the page.
    expect(clippyWindow()?.contains(document.activeElement)).toBe(false);
  });

  it("steps out of the way on the full Clippy page, and comes back as it was on the next page", async () => {
    window.localStorage.setItem("paperclip.clippy.mode", "sidebar");
    window.localStorage.setItem("paperclip.clippy.sidebarOpen", "true");

    await renderClippy({ onClippyPage: true });
    expect(clippyWindow()).toBeNull();
    expect(findButton("Ask Clippy")?.hidden).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--clippy-dock-width")).toBe("");

    await renderClippy({ onClippyPage: false });
    expect(clippyWindow()?.dataset.clippyMode).toBe("sidebar");
  });

  it("gives a phone full screen whatever layout was chosen", async () => {
    window.localStorage.setItem("paperclip.clippy.mode", "sidebar");
    await renderClippy({ isPhone: true });
    await click("Ask Clippy");

    expect(clippyWindow()?.dataset.clippyMode).toBe("fullscreen");
    expect(findButton("Layout")).toBeUndefined();
    // No room for the list beside the conversation; the menu is the list.
    expect(container.querySelector('aside[aria-label="Chats"]')).toBeNull();
    expect(findButton("Show chats")).toBeDefined();
  });

  it("lists recent chats in the menu with their company and age, not their model", async () => {
    await renderClippy();
    await click("Ask Clippy");
    await click("Show chats");

    const menu = container.querySelector('[role="region"][aria-label="Chats"]');
    expect(menu).not.toBeNull();
    expect(menu!.textContent).toContain("Remind me to send the IRS letter");
    expect(menu!.textContent).toContain("HQ · 2h ago");
    expect(menu!.textContent).toContain("Acme · 2h ago");
    expect(menu!.textContent).not.toContain("adapter:");
    // Archived chats are for the full screen list, not the recent menu.
    expect(menu!.textContent).not.toContain("Last year's tax filing");
    expect(menu!.textContent).toContain("All chats");

    // Picking another company's chat opens it and closes the menu.
    await click("Summarize open issues in Acme");
    expect(container.querySelector('[role="region"][aria-label="Chats"]')).toBeNull();
    expect(conversation.shown.at(-1)).toBe("chat-acme");
  });

  it("keeps focus in the window when the chat already open is picked again", async () => {
    await renderClippy();
    await click("Ask Clippy");
    await click("Show chats");

    await click("Remind me to send the IRS letter");

    expect(container.querySelector('[role="region"][aria-label="Chats"]')).toBeNull();
    expect(clippyWindow()?.contains(document.activeElement)).toBe(true);
  });

  it("closes the chat menu, not Clippy, on Escape", async () => {
    await renderClippy();
    await click("Ask Clippy");
    await click("Show chats");
    const menu = container.querySelector('[role="region"][aria-label="Chats"]')!;

    await press(menu as HTMLElement, "Escape");

    expect(container.querySelector('[role="region"][aria-label="Chats"]')).toBeNull();
    expect(clippyWindow()).not.toBeNull();
  });

  it("goes to every chat in full screen from the menu's All chats", async () => {
    await renderClippy();
    await click("Ask Clippy");
    await click("Show chats");
    await click("All chats");

    expect(clippyWindow()?.dataset.clippyMode).toBe("fullscreen");
    expect(container.querySelector('aside[aria-label="Chats"]')).not.toBeNull();
  });

  it("keeps an archived chat picked in full screen open when the list refreshes", async () => {
    // The open chat was checked against the active chats only, so the next
    // refresh of the list swapped an archived chat for the latest active one.
    window.localStorage.setItem("paperclip.clippy.mode", "fullscreen");
    window.localStorage.setItem("paperclip.clippy.filters", JSON.stringify({ status: "all" }));
    await renderClippy();
    await click("Ask Clippy");

    await click("Last year's tax filing");
    expect(conversation.shown.at(-1)).toBe("chat-old");

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["clippy", "sessions"] });
    });
    await flush();
    expect(conversation.shown.at(-1)).toBe("chat-old");
  });

  it("shows how many actions wait on the person, and takes them to the chat that is waiting", async () => {
    // The launcher carries this count, and it is hidden while Clippy is open.
    pending.count = 2;
    pending.first = "chat-acme";
    await renderClippy();
    await click("Ask Clippy");

    const badge = findButton("2 actions waiting on you");
    expect(badge?.textContent).toBe("2 waiting");

    await click("2 actions waiting on you");
    expect(conversation.shown.at(-1)).toBe("chat-acme");
  });

  it("does not re-render the conversation on every pointer move while it is dragged", async () => {
    await renderClippy();
    await click("Ask Clippy");
    const before = conversation.renders;

    await act(async () => {
      header().dispatchEvent(pointer("pointerdown", 500, 300));
    });
    for (let step = 1; step <= 5; step += 1) {
      await act(async () => {
        header().dispatchEvent(pointer("pointermove", 500 - step * 10, 300 - step * 10));
      });
    }
    expect(clippyWindow()?.style.right).toBe("66px");
    await act(async () => {
      header().dispatchEvent(pointer("pointerup", 450, 250));
    });

    expect(conversation.renders).toBe(before);
    expect(JSON.parse(window.localStorage.getItem("paperclip.clippy.floatingRect")!)).toMatchObject({
      right: 66,
      bottom: 66,
    });
  });

  it("captures the pointer while dragging, so letting go over an iframe still ends the drag", async () => {
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const setCapture = vi.fn();
    const releaseCapture = vi.fn();
    proto.setPointerCapture = setCapture;
    proto.releasePointerCapture = releaseCapture;
    proto.hasPointerCapture = () => true;
    try {
      await renderClippy();
      await click("Ask Clippy");

      await act(async () => {
        header().dispatchEvent(pointer("pointerdown", 500, 300));
      });
      expect(setCapture).toHaveBeenCalledWith(7);
      await act(async () => {
        header().dispatchEvent(pointer("pointermove", 480, 300));
      });
      await act(async () => {
        header().dispatchEvent(pointer("pointerup", 480, 300));
      });
      expect(releaseCapture).toHaveBeenCalledWith(7);

      // The drag is over: moving on does not drag the window along.
      const after = clippyWindow()?.style.right;
      await act(async () => {
        header().dispatchEvent(pointer("pointermove", 300, 300));
      });
      expect(clippyWindow()?.style.right).toBe(after);
    } finally {
      delete proto.setPointerCapture;
      delete proto.releasePointerCapture;
      delete proto.hasPointerCapture;
    }
  });

  it("moves with the arrow keys on its header and resizes with them on its corner", async () => {
    await renderClippy();
    await click("Ask Clippy");
    const opened = clippyWindow()!;

    expect(header().tabIndex).toBe(0);
    await press(header(), "ArrowLeft");
    expect(opened.style.right).toBe("40px");
    await press(header(), "ArrowUp");
    expect(opened.style.bottom).toBe("40px");

    const corner = container.querySelector<HTMLElement>('[role="separator"][aria-label^="Resize Clippy"]')!;
    expect(corner.tabIndex).toBe(0);
    const width = parseInt(opened.style.width, 10);
    const height = parseInt(opened.style.height, 10);
    await press(corner, "ArrowLeft");
    expect(parseInt(opened.style.width, 10)).toBe(width + 24);
    await press(corner, "ArrowDown");
    expect(parseInt(opened.style.height, 10)).toBe(height - 24);
  });
});
