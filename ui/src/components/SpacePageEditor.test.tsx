// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Space, SpacePage, UpdateSpacePage } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import {
  KEPT_DRAFT_MAX_AGE_MS,
  keptSpacePageDraftKey,
  SPACE_PAGE_AUTOSAVE_DELAY_MS,
  SpacePageEditor,
  type KeptSpacePageDraft,
} from "./SpacePageEditor";

const mockSpacesApi = vi.hoisted(() => ({
  getPage: vi.fn(),
  updatePage: vi.fn(),
  restoreRevision: vi.fn(),
}));

vi.mock("../api/spaces", () => ({ spacesApi: mockSpacesApi }));

// History stands in as one button that restores version 1, as its own would.
vi.mock("./SpacePageHistory", () => ({
  SpacePageHistory: ({
    open,
    canRestore,
    onRestore,
  }: {
    open: boolean;
    canRestore: boolean;
    onRestore: (version: { id: string; revisionNumber: number }) => Promise<unknown>;
  }) =>
    open ? (
      <div data-testid="history" data-can-restore={String(canRestore)}>
        <button type="button" onClick={() => void onRestore({ id: "rev-1", revisionNumber: 1 }).catch(() => undefined)}>
          Restore version 1
        </button>
      </div>
    ) : null,
}));

// A textarea stands in for the rich editor, so each tab's editor can be typed into.
vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea data-testid="markdown-editor" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div data-testid="markdown-body">{children}</div>,
}));

vi.mock("./InfoPopoverButton", () => ({
  InfoPopoverButton: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** Browser storage as a page sees it, with keys that can be walked. */
class MemoryStorage {
  private entries = new Map<string, string>();
  get length() {
    return this.entries.size;
  }
  key(index: number) {
    return Array.from(this.entries.keys())[index] ?? null;
  }
  getItem(key: string) {
    return this.entries.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.entries.set(key, String(value));
  }
  removeItem(key: string) {
    this.entries.delete(key);
  }
  clear() {
    this.entries.clear();
  }
}

const SPACE: Space = {
  id: "space-1",
  companyId: "company-1",
  name: "Handbook",
  urlKey: "handbook",
  description: null,
  sortOrder: 0,
  archivedAt: null,
  createdByAgentId: null,
  createdByUserId: "user-1",
  createdAt: new Date("2026-10-11T09:00:00.000Z"),
  updatedAt: new Date("2026-10-11T09:00:00.000Z"),
};

function page(overrides: Partial<SpacePage> = {}): SpacePage {
  return {
    id: "page-1",
    companyId: "company-1",
    spaceId: "space-1",
    parentPageId: null,
    documentId: "document-1",
    sortOrder: 0,
    title: "Refunds",
    latestRevisionId: "rev-1",
    latestRevisionNumber: 1,
    updatedByAgentId: null,
    updatedByUserId: "user-1",
    createdAt: new Date("2026-10-11T09:00:00.000Z"),
    updatedAt: new Date("2026-10-11T09:00:00.000Z"),
    format: "markdown",
    body: "Within 30 days.",
    createdByAgentId: null,
    createdByUserId: "user-1",
    ...overrides,
  };
}

function conflictError(currentRevisionId: string | null) {
  return new ApiError("This page was changed by someone else", 409, {
    error: "This page was changed by someone else",
    details: { currentRevisionId },
  });
}

/** The server's side of one page: saves are refused unless written on its current version. */
function fakeServer(start: SpacePage = page()) {
  const state = { page: start };
  mockSpacesApi.getPage.mockImplementation(async () => ({ ...state.page }));
  mockSpacesApi.updatePage.mockImplementation(async (_spaceId: string, _pageId: string, change: UpdateSpacePage) => {
    if (change.baseRevisionId !== state.page.latestRevisionId) throw conflictError(state.page.latestRevisionId);
    state.page = savedOver(state.page, change);
    return { ...state.page };
  });
  return state;
}

function savedOver(current: SpacePage, change: { title?: string; body?: string }): SpacePage {
  const number = current.latestRevisionNumber + 1;
  return {
    ...current,
    title: change.title ?? current.title,
    body: change.body ?? current.body,
    latestRevisionId: `rev-${number}`,
    latestRevisionNumber: number,
    updatedAt: new Date(Date.UTC(2026, 9, 11, 9, number)),
  };
}

/** Moves the clock on, letting every promise that is ready settle on the way. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

type Tab = { container: HTMLDivElement; root: Root; queryClient: QueryClient };
const openTabs: Tab[] = [];

type TabOptions = { userId?: string | null; canWrite?: boolean; space?: Space; queryClient?: QueryClient };

/** Draws the page in a tab, or draws it again with other props (the Space it is in, say). */
async function drawEditor(tab: Tab, options: TabOptions) {
  await act(async () => {
    tab.root.render(
      <QueryClientProvider client={tab.queryClient}>
        <SpacePageEditor
          space={options.space ?? SPACE}
          pageId="page-1"
          canWrite={options.canWrite ?? true}
          currentUserId={options.userId === undefined ? "user-1" : options.userId}
        />
      </QueryClientProvider>,
    );
  });
  await advance(0);
  await advance(0);
}

/** One browser tab with the page open. A reload is the same tab id opened again. */
async function openTab(tabId: string, options: TabOptions = {}) {
  window.sessionStorage.setItem("paperclip:tab-id", tabId);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const tab: Tab = {
    container,
    root: createRoot(container),
    queryClient:
      options.queryClient
      ?? new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }),
  };
  openTabs.push(tab);
  await drawEditor(tab, options);
  return tab;
}

async function closeTab(tab: Tab) {
  const index = openTabs.indexOf(tab);
  if (index !== -1) openTabs.splice(index, 1);
  await act(async () => tab.root.unmount());
  tab.container.remove();
  tab.queryClient.clear();
}

function editor(tab: Tab) {
  return tab.container.querySelector<HTMLTextAreaElement>('[data-testid="markdown-editor"]');
}

async function type(tab: Tab, body: string) {
  const textarea = editor(tab)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, body);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function saveLine(tab: Tab) {
  return Array.from(tab.container.querySelectorAll('[role="status"]')).map((el) => el.textContent ?? "").join(" ");
}

async function click(tab: Tab, label: string) {
  const button = Array.from(tab.container.querySelectorAll("button")).find((el) => el.textContent?.trim() === label);
  expect(button, label).toBeDefined();
  await act(async () => {
    button!.click();
  });
}

function kept(tabId: string, userId = "user-1"): KeptSpacePageDraft | null {
  const raw = window.localStorage.getItem(keptSpacePageDraftKey(userId, "page-1", tabId));
  return raw ? (JSON.parse(raw) as KeptSpacePageDraft) : null;
}

function keep(tabId: string, draft: Omit<KeptSpacePageDraft, "keptAt"> & { keptAt?: number }, userId = "user-1", pageId = "page-1") {
  window.localStorage.setItem(
    keptSpacePageDraftKey(userId, pageId, tabId),
    JSON.stringify({ keptAt: Date.now(), ...draft }),
  );
}

describe("SpacePageEditor", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-10-11T12:00:00.000Z") });
    mockSpacesApi.getPage.mockReset();
    mockSpacesApi.updatePage.mockReset();
    mockSpacesApi.restoreRevision.mockReset();
    Object.defineProperty(window, "localStorage", { configurable: true, value: new MemoryStorage() });
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: new MemoryStorage() });
  });

  afterEach(async () => {
    for (const tab of [...openTabs]) await closeTab(tab);
    vi.useRealTimers();
  });

  it("saves a moment after typing stops, naming the version the change was written on", async () => {
    fakeServer();
    const tab = await openTab("tab-a");
    expect(editor(tab)!.value).toBe("Within 30 days.");

    await type(tab, "Within 60 days.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS - 100);
    expect(mockSpacesApi.updatePage).not.toHaveBeenCalled();
    expect(kept("tab-a")).toMatchObject({ body: "Within 60 days.", baseRevisionId: "rev-1" });

    await advance(100);
    expect(mockSpacesApi.updatePage).toHaveBeenCalledWith("space-1", "page-1", {
      baseRevisionId: "rev-1",
      body: "Within 60 days.",
    });
    expect(saveLine(tab)).toContain("Saved");
    expect(kept("tab-a")).toBeNull();

    // The next save names the version the last one made.
    await type(tab, "Within 90 days.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS);
    expect(mockSpacesApi.updatePage).toHaveBeenLastCalledWith("space-1", "page-1", {
      baseRevisionId: "rev-2",
      body: "Within 90 days.",
    });
  });

  it("does not say Saved for a save answered after newer typing", async () => {
    const server = fakeServer();
    let answerFirst!: () => void;
    mockSpacesApi.updatePage.mockImplementationOnce(
      (_spaceId: string, _pageId: string, change: UpdateSpacePage) =>
        new Promise<SpacePage>((resolve) => {
          answerFirst = () => {
            server.page = savedOver(server.page, change);
            resolve({ ...server.page });
          };
        }),
    );
    const tab = await openTab("tab-a");

    await type(tab, "Within 45 days.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS + 300);
    expect(saveLine(tab)).toContain("Saving");
    await type(tab, "Within 45 days, or 60 for members.");
    await act(async () => {
      answerFirst();
    });
    await advance(0);
    expect(saveLine(tab)).not.toContain("Saved");

    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS);
    expect(mockSpacesApi.updatePage).toHaveBeenLastCalledWith("space-1", "page-1", {
      baseRevisionId: "rev-2",
      body: "Within 45 days, or 60 for members.",
    });
    expect(saveLine(tab)).toContain("Saved");
  });

  it("when the page moved on, keeps the text and offers to load the newer version or keep it", async () => {
    const server = fakeServer();
    const tab = await openTab("tab-a");
    // Someone else saves first.
    server.page = savedOver(server.page, { body: "Within 14 days." });

    await type(tab, "Within 45 days.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS);
    expect(tab.container.textContent).toContain("This page changed while you were writing");
    expect(saveLine(tab)).toContain("Not saved, your text is kept");
    expect(saveLine(tab)).not.toContain("Saved.");
    expect(editor(tab)!.value).toBe("Within 45 days.");
    expect(kept("tab-a")).toMatchObject({ body: "Within 45 days.", baseRevisionId: "rev-1" });

    // Nothing more is saved while the choice is open.
    await type(tab, "Within 45 days, or 60 for members.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS * 3);
    expect(mockSpacesApi.updatePage).toHaveBeenCalledTimes(1);

    await click(tab, "Keep mine");
    await advance(0);
    // On top of the newer version, which the save asks to keep as a version of its own.
    expect(mockSpacesApi.updatePage).toHaveBeenLastCalledWith("space-1", "page-1", {
      baseRevisionId: "rev-2",
      body: "Within 45 days, or 60 for members.",
      keepPrevious: true,
    });
    expect(tab.container.textContent).not.toContain("This page changed while you were writing");
    expect(saveLine(tab)).toContain("Saved");
    expect(kept("tab-a")).toBeNull();

    // Later saves fold as usual again.
    await type(tab, "Within 45 days, or 60 for members. Ask for a receipt.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS);
    expect(mockSpacesApi.updatePage.mock.lastCall?.[2]).not.toHaveProperty("keepPrevious");
  });

  it("loads the newer version instead, when that is the choice", async () => {
    const server = fakeServer();
    const tab = await openTab("tab-a");
    server.page = savedOver(server.page, { body: "Within 14 days." });

    await type(tab, "Within 45 days.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS);
    await click(tab, "Show the newer version");
    expect(tab.container.textContent).toContain("Within 14 days.");

    await click(tab, "Load the newer version");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS * 2);
    expect(editor(tab)!.value).toBe("Within 14 days.");
    expect(tab.container.textContent).not.toContain("This page changed while you were writing");
    expect(kept("tab-a")).toBeNull();
    expect(mockSpacesApi.updatePage).toHaveBeenCalledTimes(1);

    // The next change is written on the newer version.
    await type(tab, "Within 21 days.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS);
    expect(mockSpacesApi.updatePage).toHaveBeenLastCalledWith("space-1", "page-1", {
      baseRevisionId: "rev-2",
      body: "Within 21 days.",
    });
  });

  it("keeps text that could not be saved, and brings it back when the tab is reloaded", async () => {
    mockSpacesApi.getPage.mockResolvedValue(page());
    mockSpacesApi.updatePage.mockRejectedValue(new ApiError("Paperclip is not answering", 0, null));
    const first = await openTab("tab-a");

    await type(first, "Within 30 days, with a receipt.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS);
    expect(saveLine(first)).toContain("Not saved, your text is kept");
    expect(first.container.textContent).toContain("Try again");
    expect(kept("tab-a")).toMatchObject({ body: "Within 30 days, with a receipt.", baseRevisionId: "rev-1" });
    await closeTab(first);

    // The same tab, reloaded, with the server answering again.
    fakeServer();
    const reloaded = await openTab("tab-a");
    expect(editor(reloaded)!.value).toBe("Within 30 days, with a receipt.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS);
    expect(mockSpacesApi.updatePage).toHaveBeenLastCalledWith("space-1", "page-1", {
      baseRevisionId: "rev-1",
      body: "Within 30 days, with a receipt.",
    });
    expect(kept("tab-a")).toBeNull();
  });

  it("asks before kept text written on an older version overwrites a newer one", async () => {
    keep("tab-a", { title: "Refunds", body: "Written offline.", baseRevisionId: "rev-1" });
    fakeServer(page({ body: "Within 14 days.", latestRevisionId: "rev-2", latestRevisionNumber: 2 }));
    const tab = await openTab("tab-a");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS * 2);

    expect(editor(tab)!.value).toBe("Written offline.");
    expect(tab.container.textContent).toContain("This page changed while you were writing");
    expect(mockSpacesApi.updatePage).not.toHaveBeenCalled();
  });

  it("keeps each tab's text apart, so one tab's save does not throw away another's", async () => {
    const server = fakeServer();
    const tabA = await openTab("tab-a");
    const tabB = await openTab("tab-b");

    await type(tabA, "Written in tab A.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS);
    expect(server.page.latestRevisionId).toBe("rev-2");

    // Tab B is still on the first version: refused, and its text is kept.
    await type(tabB, "Written in tab B.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS);
    expect(tabB.container.textContent).toContain("This page changed while you were writing");
    expect(kept("tab-b")).toMatchObject({ body: "Written in tab B.", baseRevisionId: "rev-1" });

    // Tab A writes and saves again. Tab B's kept text is not touched.
    await type(tabA, "Written in tab A, and more.");
    expect(kept("tab-b")).toMatchObject({ body: "Written in tab B." });
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS);
    expect(server.page.latestRevisionId).toBe("rev-3");
    expect(kept("tab-a")).toBeNull();
    expect(kept("tab-b")).toMatchObject({ body: "Written in tab B.", baseRevisionId: "rev-1" });
    expect(saveLine(tabB)).toContain("Not saved, your text is kept");

    // Tab B reloaded gets its own text back, with the choice.
    await closeTab(tabB);
    const reloadedB = await openTab("tab-b");
    expect(editor(reloadedB)!.value).toBe("Written in tab B.");
    expect(reloadedB.container.textContent).toContain("This page changed while you were writing");
  });

  it("brings a closed tab's text back in a new tab, and lets go of it once it is saved", async () => {
    keep("tab-closed", { title: "Refunds", body: "Written in a tab that closed.", baseRevisionId: "rev-1" });
    fakeServer();
    const tab = await openTab("tab-new");

    expect(editor(tab)!.value).toBe("Written in a tab that closed.");
    expect(tab.container.textContent).not.toContain("This page changed while you were writing");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS);
    expect(mockSpacesApi.updatePage).toHaveBeenLastCalledWith("space-1", "page-1", {
      baseRevisionId: "rev-1",
      body: "Written in a tab that closed.",
    });
    expect(kept("tab-closed")).toBeNull();
    expect(kept("tab-new")).toBeNull();
  });

  it("does not bring one person's kept text back for someone else on the same browser", async () => {
    keep("tab-a", { title: "Refunds", body: "Person one's words.", baseRevisionId: "rev-1" }, "user-1");
    fakeServer();
    const tab = await openTab("tab-a", { userId: "user-2" });
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS * 2);

    expect(editor(tab)!.value).toBe("Within 30 days.");
    expect(mockSpacesApi.updatePage).not.toHaveBeenCalled();
    expect(kept("tab-a", "user-1")).toMatchObject({ body: "Person one's words." });
  });

  it("does not say the text is kept when this browser could not keep it", async () => {
    mockSpacesApi.getPage.mockResolvedValue(page());
    mockSpacesApi.updatePage.mockRejectedValue(new ApiError("Paperclip is not answering", 0, null));
    const tab = await openTab("tab-a");
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });

    await type(tab, "Within 30 days, with a receipt.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS);

    expect(saveLine(tab)).toContain("Not saved");
    expect(saveLine(tab)).not.toContain("your text is kept");
    expect(saveLine(tab)).toContain("this browser could not keep a copy");
  });

  it("drops kept text older than 30 days when a page opens", async () => {
    keep("tab-x", { title: "Old", body: "From long ago.", baseRevisionId: "rev-1", keptAt: Date.now() - KEPT_DRAFT_MAX_AGE_MS - 1 }, "user-1", "page-9");
    keep("tab-y", { title: "Recent", body: "From this week.", baseRevisionId: "rev-1" }, "user-1", "page-9");
    fakeServer();
    await openTab("tab-a");

    expect(window.localStorage.getItem(keptSpacePageDraftKey("user-1", "page-9", "tab-x"))).toBeNull();
    expect(window.localStorage.getItem(keptSpacePageDraftKey("user-1", "page-9", "tab-y"))).not.toBeNull();
  });

  it("shows a viewer the page to read, with nothing to edit or save", async () => {
    fakeServer();
    const tab = await openTab("tab-a", { canWrite: false });

    expect(editor(tab)).toBeNull();
    expect(tab.container.querySelector('[data-testid="markdown-body"]')?.textContent).toBe("Within 30 days.");
    expect(tab.container.querySelector<HTMLInputElement>('input[aria-label="Page title"]')?.readOnly).toBe(true);
    expect(tab.container.textContent).toContain("Read only");

    // History is there to read, without restoring.
    await click(tab, "History");
    expect(tab.container.querySelector('[data-testid="history"]')?.getAttribute("data-can-restore")).toBe("false");
  });

  it("restores a version from History after the save on its way, and shows its text", async () => {
    const server = fakeServer();
    mockSpacesApi.restoreRevision.mockImplementation(
      async (_spaceId: string, _pageId: string, _revisionId: string, data: { baseRevisionId: string }) => {
        if (data.baseRevisionId !== server.page.latestRevisionId) throw conflictError(server.page.latestRevisionId);
        server.page = savedOver(server.page, { body: "Within 30 days." });
        return { ...server.page };
      },
    );
    const tab = await openTab("tab-a");

    // History opens before typing has paused long enough to save.
    await type(tab, "Within 45 days.");
    await click(tab, "History");
    expect(tab.container.querySelector('[data-testid="history"]')?.getAttribute("data-can-restore")).toBe("true");
    await click(tab, "Restore version 1");
    await advance(0);

    // The waiting save went first, and the restore was written on the version it made.
    expect(mockSpacesApi.updatePage).toHaveBeenCalledWith("space-1", "page-1", { baseRevisionId: "rev-1", body: "Within 45 days." });
    expect(mockSpacesApi.restoreRevision).toHaveBeenCalledWith("space-1", "page-1", "rev-1", { baseRevisionId: "rev-2" });
    expect(editor(tab)!.value).toBe("Within 30 days.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS * 2);
    expect(mockSpacesApi.updatePage).toHaveBeenCalledTimes(1);
    expect(kept("tab-a")).toBeNull();

    // The next change is written on the restored version.
    await type(tab, "Within 30 days, with a receipt.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS);
    expect(mockSpacesApi.updatePage).toHaveBeenLastCalledWith("space-1", "page-1", {
      baseRevisionId: "rev-3",
      body: "Within 30 days, with a receipt.",
    });
  });

  it("keeps a restore answered after the page was left, rather than saving the text from before over it", async () => {
    const server = fakeServer();
    const tab = await openTab("tab-a");
    await type(tab, "Within 45 days.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS);
    expect(server.page.latestRevisionId).toBe("rev-2");

    // The restore is held, as a slow answer is, and the person leaves (Back, a phone's back gesture).
    let answer!: () => void;
    mockSpacesApi.restoreRevision.mockImplementation(
      (_spaceId: string, _pageId: string, _revisionId: string, data: { baseRevisionId: string }) =>
        new Promise<SpacePage>((resolve, reject) => {
          answer = () => {
            if (data.baseRevisionId !== server.page.latestRevisionId) {
              reject(conflictError(server.page.latestRevisionId));
              return;
            }
            server.page = savedOver(server.page, { body: "Within 30 days." });
            resolve({ ...server.page });
          };
        }),
    );
    await click(tab, "History");
    await click(tab, "Restore version 1");
    await advance(0);
    await closeTab(tab);
    await act(async () => {
      answer();
    });
    await advance(0);
    await advance(0);

    expect(server.page).toMatchObject({ latestRevisionId: "rev-3", body: "Within 30 days." });
    // The save made while typing, and nothing after the restore.
    expect(mockSpacesApi.updatePage).toHaveBeenCalledTimes(1);
  });

  it("after a restore refused because the page moved on, shows the newer version and writes a second try on it", async () => {
    const server = fakeServer();
    mockSpacesApi.restoreRevision.mockImplementation(
      async (_spaceId: string, _pageId: string, _revisionId: string, data: { baseRevisionId: string }) => {
        if (data.baseRevisionId !== server.page.latestRevisionId) throw conflictError(server.page.latestRevisionId);
        server.page = savedOver(server.page, { body: "Within 30 days." });
        return { ...server.page };
      },
    );
    const tab = await openTab("tab-a");
    // Someone else saves while this tab still shows version 1.
    server.page = savedOver(server.page, { body: "Within 14 days, said someone else." });

    await click(tab, "History");
    await click(tab, "Restore version 1");
    await advance(0);
    expect(mockSpacesApi.restoreRevision).toHaveBeenLastCalledWith("space-1", "page-1", "rev-1", { baseRevisionId: "rev-1" });
    // Refused; the newer version is shown, and is the one this page is now on.
    expect(editor(tab)!.value).toBe("Within 14 days, said someone else.");
    expect(tab.container.textContent).not.toContain("This page changed while you were writing");

    await click(tab, "Restore version 1");
    await advance(0);
    expect(mockSpacesApi.restoreRevision).toHaveBeenLastCalledWith("space-1", "page-1", "rev-1", { baseRevisionId: "rev-2" });
    expect(server.page).toMatchObject({ latestRevisionId: "rev-3", body: "Within 30 days." });
    expect(editor(tab)!.value).toBe("Within 30 days.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS * 2);
    expect(mockSpacesApi.updatePage).not.toHaveBeenCalled();
  });

  it("says at once that a page is not here, without trying again for seconds", async () => {
    mockSpacesApi.getPage.mockRejectedValue(new ApiError("Page not found", 404, { error: "Page not found" }));
    // The app's own query defaults, which try a failed request three more times.
    const tab = await openTab("tab-a", { queryClient: new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } }) });

    expect(tab.container.textContent).toContain("Page not found");
    expect(tab.container.textContent).not.toContain("Loading the page");
    expect(mockSpacesApi.getPage).toHaveBeenCalledTimes(1);
  });

  it("marks the page's history out of date after a save, so History opened again lists the newest version", async () => {
    fakeServer();
    const tab = await openTab("tab-a");
    const versionsKey = queryKeys.spaces.revisions("space-1", "page-1");
    tab.queryClient.setQueryData(versionsKey, []);

    await type(tab, "Within 45 days.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS);
    expect(mockSpacesApi.updatePage).toHaveBeenCalledTimes(1);
    expect(tab.queryClient.getQueryState(versionsKey)?.isInvalidated).toBe(true);
  });

  it("says a save was refused because the Space was archived, keeps the text, and asks for the Space again", async () => {
    mockSpacesApi.getPage.mockResolvedValue(page());
    mockSpacesApi.updatePage.mockRejectedValue(
      new ApiError("This Space is archived. Unarchive it to change it.", 422, {
        error: "This Space is archived. Unarchive it to change it.",
        details: { code: "space_archived" },
      }),
    );
    const tab = await openTab("tab-a");
    const spaceKey = queryKeys.spaces.detail("company-1", "handbook");
    tab.queryClient.setQueryData(spaceKey, SPACE);

    await type(tab, "Within 60 days.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS);

    expect(saveLine(tab)).toContain("Not saved. This Space is archived. Unarchive it to change it. Your text is kept.");
    // Trying again would get the same answer.
    expect(tab.container.textContent).not.toContain("Try again");
    expect(kept("tab-a")).toMatchObject({ body: "Within 60 days." });
    // Asked again, the Space turns the page read only with its archived notice.
    expect(tab.queryClient.getQueryState(spaceKey)?.isInvalidated).toBe(true);
  });

  it("says a save was refused because the page left this Space, keeps the text, and asks for the list of pages again", async () => {
    mockSpacesApi.getPage.mockResolvedValue(page());
    mockSpacesApi.updatePage.mockRejectedValue(new ApiError("Page not found", 404, { error: "Page not found" }));
    const tab = await openTab("tab-a");
    const treeKey = queryKeys.spaces.pageTree("space-1");
    tab.queryClient.setQueryData(treeKey, []);

    await type(tab, "Within 60 days.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS);

    expect(saveLine(tab)).toContain(
      "Not saved. This page is no longer in this Space: it was moved, or sent to the trash. Your text is kept.",
    );
    expect(tab.container.textContent).not.toContain("Try again");
    expect(kept("tab-a")).toMatchObject({ body: "Within 60 days." });
    // Asked again, the list finds where the page went, or says it is in the trash.
    expect(tab.queryClient.getQueryState(treeKey)?.isInvalidated).toBe(true);
  });

  it("saves to a page's new Space what its old Space refused, once the new address opens it here", async () => {
    const server = fakeServer();
    // The page moved to Rules while open here, so its old Space has it no longer.
    mockSpacesApi.updatePage.mockImplementation(async (spaceId: string, _pageId: string, change: UpdateSpacePage) => {
      if (spaceId !== "space-2") throw new ApiError("Page not found", 404, { error: "Page not found" });
      if (change.baseRevisionId !== server.page.latestRevisionId) throw conflictError(server.page.latestRevisionId);
      server.page = savedOver(server.page, change);
      return { ...server.page };
    });
    const tab = await openTab("tab-a");
    await type(tab, "Within 60 days.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS);
    expect(saveLine(tab)).toContain("This page is no longer in this Space");

    await drawEditor(tab, { space: { ...SPACE, id: "space-2", name: "Rules", urlKey: "rules" } });
    await advance(0);
    expect(mockSpacesApi.updatePage).toHaveBeenLastCalledWith("space-2", "page-1", {
      baseRevisionId: "rev-1",
      body: "Within 60 days.",
    });
    expect(saveLine(tab)).toContain("Saved");
    expect(kept("tab-a")).toBeNull();
  });
});
