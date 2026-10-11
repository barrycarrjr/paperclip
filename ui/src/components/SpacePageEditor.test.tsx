// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Space, SpacePage } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import {
  readKeptSpacePageDraft,
  SPACE_PAGE_AUTOSAVE_DELAY_MS,
  SpacePageEditor,
} from "./SpacePageEditor";

const mockSpacesApi = vi.hoisted(() => ({
  getPage: vi.fn(),
  updatePage: vi.fn(),
}));

const editorState = vi.hoisted(() => ({
  // The change handler of the editor drawn last, so a test can type into it.
  onChange: null as ((value: string) => void) | null,
  value: null as string | null,
}));

vi.mock("../api/spaces", () => ({ spacesApi: mockSpacesApi }));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => {
    editorState.onChange = onChange;
    editorState.value = value;
    return <div data-testid="markdown-editor">{value}</div>;
  },
}));

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div data-testid="markdown-body">{children}</div>,
}));

vi.mock("./InfoPopoverButton", () => ({
  InfoPopoverButton: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

function conflictError() {
  return new ApiError("This page was changed by someone else", 409, {
    error: "This page was changed by someone else",
    details: { currentRevisionId: "rev-2", currentRevisionNumber: 2 },
  });
}

/** Moves the clock on, letting every promise that is ready settle on the way. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function buttonNamed(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);
}

function saveLine(container: HTMLElement) {
  return Array.from(container.querySelectorAll('[role="status"]')).map((el) => el.textContent ?? "").join(" ");
}

describe("SpacePageEditor", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSpacesApi.getPage.mockReset();
    mockSpacesApi.updatePage.mockReset();
    editorState.onChange = null;
    editorState.value = null;
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    queryClient.clear();
    vi.useRealTimers();
  });

  async function render(options: { canWrite?: boolean; target?: Root } = {}) {
    await act(async () => {
      (options.target ?? root).render(
        <QueryClientProvider client={queryClient}>
          <SpacePageEditor space={SPACE} pageId="page-1" canWrite={options.canWrite ?? true} />
        </QueryClientProvider>,
      );
    });
    await advance(0);
    await advance(0);
  }

  async function type(body: string) {
    await act(async () => {
      editorState.onChange!(body);
    });
  }

  it("saves a moment after typing stops, naming the version the change was written on", async () => {
    mockSpacesApi.getPage.mockResolvedValue(page());
    mockSpacesApi.updatePage.mockResolvedValue(
      page({ body: "Within 60 days.", latestRevisionId: "rev-1b", updatedAt: new Date("2026-10-11T09:05:00.000Z") }),
    );
    await render();
    expect(editorState.value).toBe("Within 30 days.");

    await type("Within 60 days.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS - 100);
    expect(mockSpacesApi.updatePage).not.toHaveBeenCalled();

    await advance(100);
    expect(mockSpacesApi.updatePage).toHaveBeenCalledWith("space-1", "page-1", {
      baseRevisionId: "rev-1",
      body: "Within 60 days.",
    });
    expect(saveLine(container)).toContain("Saved");
    // Saved, so nothing is left kept in the browser.
    expect(readKeptSpacePageDraft("page-1")).toBeNull();

    // The next save names the version the last one made.
    mockSpacesApi.updatePage.mockResolvedValue(
      page({ body: "Within 90 days.", latestRevisionId: "rev-1c", updatedAt: new Date("2026-10-11T09:06:00.000Z") }),
    );
    await type("Within 90 days.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS);
    expect(mockSpacesApi.updatePage).toHaveBeenLastCalledWith("space-1", "page-1", {
      baseRevisionId: "rev-1b",
      body: "Within 90 days.",
    });
  });

  it("when someone else saved first, keeps the text and offers to load theirs or keep it", async () => {
    mockSpacesApi.getPage
      .mockResolvedValueOnce(page())
      .mockResolvedValue(
        page({ body: "Within 14 days.", latestRevisionId: "rev-2", latestRevisionNumber: 2, updatedByUserId: "user-2" }),
      );
    mockSpacesApi.updatePage.mockRejectedValueOnce(conflictError());
    await render();

    await type("Within 45 days.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS);

    expect(container.textContent).toContain("This page changed while you were writing");
    expect(saveLine(container)).toContain("Not saved, your text is kept");
    expect(saveLine(container)).not.toContain("Saved.");
    expect(editorState.value).toBe("Within 45 days.");
    expect(readKeptSpacePageDraft("page-1")).toEqual({
      title: "Refunds",
      body: "Within 45 days.",
      baseRevisionId: "rev-1",
    });

    // Nothing more is saved while the choice is open.
    await type("Within 45 days, or 60 for members.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS * 3);
    expect(mockSpacesApi.updatePage).toHaveBeenCalledTimes(1);

    mockSpacesApi.updatePage.mockResolvedValueOnce(
      page({ body: "Within 45 days, or 60 for members.", latestRevisionId: "rev-3", latestRevisionNumber: 3 }),
    );
    await act(async () => {
      buttonNamed(container, "Keep mine")!.click();
    });
    await advance(0);

    expect(mockSpacesApi.updatePage).toHaveBeenLastCalledWith("space-1", "page-1", {
      baseRevisionId: "rev-2",
      body: "Within 45 days, or 60 for members.",
    });
    expect(container.textContent).not.toContain("This page changed while you were writing");
    expect(readKeptSpacePageDraft("page-1")).toBeNull();
  });

  it("loads the newer version instead, when that is the choice", async () => {
    mockSpacesApi.getPage
      .mockResolvedValueOnce(page())
      .mockResolvedValue(page({ body: "Within 14 days.", latestRevisionId: "rev-2", latestRevisionNumber: 2 }));
    mockSpacesApi.updatePage.mockRejectedValueOnce(conflictError());
    await render();

    await type("Within 45 days.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS);
    await act(async () => {
      buttonNamed(container, "Show the newer version")!.click();
    });
    expect(container.textContent).toContain("Within 14 days.");

    await act(async () => {
      buttonNamed(container, "Load the newer version")!.click();
    });
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS * 2);

    expect(editorState.value).toBe("Within 14 days.");
    expect(container.textContent).not.toContain("This page changed while you were writing");
    expect(readKeptSpacePageDraft("page-1")).toBeNull();
    expect(mockSpacesApi.updatePage).toHaveBeenCalledTimes(1);

    // The next change is written on the newer version.
    mockSpacesApi.updatePage.mockResolvedValueOnce(page({ body: "Within 21 days.", latestRevisionId: "rev-3" }));
    await type("Within 21 days.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS);
    expect(mockSpacesApi.updatePage).toHaveBeenLastCalledWith("space-1", "page-1", {
      baseRevisionId: "rev-2",
      body: "Within 21 days.",
    });
  });

  it("keeps text that could not be saved in the browser, and brings it back next time", async () => {
    mockSpacesApi.getPage.mockResolvedValue(page());
    mockSpacesApi.updatePage.mockRejectedValue(new ApiError("Paperclip is not answering", 0, null));
    await render();

    await type("Within 30 days, with a receipt.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS);
    expect(saveLine(container)).toContain("Not saved, your text is kept");
    expect(buttonNamed(container, "Try again")).toBeDefined();
    expect(readKeptSpacePageDraft("page-1")).toEqual({
      title: "Refunds",
      body: "Within 30 days, with a receipt.",
      baseRevisionId: "rev-1",
    });

    // Opened again later, on the same version: the text comes back and is saved.
    await act(async () => root.unmount());
    queryClient.clear();
    mockSpacesApi.updatePage.mockReset();
    mockSpacesApi.updatePage.mockResolvedValue(page({ body: "Within 30 days, with a receipt.", latestRevisionId: "rev-1b" }));
    root = createRoot(container);
    await render();

    expect(editorState.value).toBe("Within 30 days, with a receipt.");
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS);
    expect(mockSpacesApi.updatePage).toHaveBeenCalledWith("space-1", "page-1", {
      baseRevisionId: "rev-1",
      body: "Within 30 days, with a receipt.",
    });
    expect(readKeptSpacePageDraft("page-1")).toBeNull();
  });

  it("asks before kept text written on an older version overwrites a newer one", async () => {
    window.localStorage.setItem(
      "paperclip:space-page-draft:page-1",
      JSON.stringify({ title: "Refunds", body: "Written offline.", baseRevisionId: "rev-1" }),
    );
    mockSpacesApi.getPage.mockResolvedValue(
      page({ body: "Within 14 days.", latestRevisionId: "rev-2", latestRevisionNumber: 2 }),
    );
    await render();
    await advance(SPACE_PAGE_AUTOSAVE_DELAY_MS * 2);

    expect(editorState.value).toBe("Written offline.");
    expect(container.textContent).toContain("This page changed while you were writing");
    expect(mockSpacesApi.updatePage).not.toHaveBeenCalled();
  });

  it("shows a viewer the page to read, with nothing to edit or save", async () => {
    mockSpacesApi.getPage.mockResolvedValue(page());
    await render({ canWrite: false });

    expect(container.querySelector('[data-testid="markdown-editor"]')).toBeNull();
    expect(container.querySelector('[data-testid="markdown-body"]')?.textContent).toBe("Within 30 days.");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Page title"]')?.readOnly).toBe(true);
    expect(container.textContent).toContain("Read only");
  });
});
