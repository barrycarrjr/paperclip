// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Space, SpacePageTreeNode } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { SpacePageMenu } from "./SpacePageMenu";

const mockSpacesApi = vi.hoisted(() => ({
  list: vi.fn(),
  pageTree: vi.fn(),
  movePage: vi.fn(),
  deletePage: vi.fn(),
}));

const toasts = vi.hoisted(() => ({ pushToast: vi.fn(), dismissToast: vi.fn() }));

vi.mock("../api/spaces", () => ({ spacesApi: mockSpacesApi }));

vi.mock("../context/ToastContext", () => ({
  useOptionalToastActions: () => toasts,
}));

/** The titles of the messages said, in order. */
function said() {
  return toasts.pushToast.mock.calls.map(([toast]) => (toast as { title: string }).title);
}

// The menu is a portal with its own focus handling; flattened, its items are simply there.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({ children, onSelect, disabled }: { children: ReactNode; onSelect: () => void; disabled?: boolean }) => (
    <button type="button" disabled={disabled} onClick={onSelect}>{children}</button>
  ),
}));

// A plain box stands in for each dialog, so what it holds is drawn in the test's container.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div data-testid="dialog">{children}</div> : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, type = "button", ...props }: ComponentProps<"button">) => (
    <button type={type} onClick={onClick} {...props}>{children}</button>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function space(id: string, name: string, urlKey: string): Space {
  return {
    id,
    companyId: "company-1",
    name,
    urlKey,
    description: null,
    sortOrder: 0,
    archivedAt: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: new Date("2026-10-11T09:00:00.000Z"),
    updatedAt: new Date("2026-10-11T09:00:00.000Z"),
  };
}

const HANDBOOK = space("space-1", "Handbook", "handbook");
const RULES = space("space-2", "Rules", "rules");

function node(id: string, title: string, children: SpacePageTreeNode[] = [], parentPageId: string | null = null, spaceId = "space-1"): SpacePageTreeNode {
  return {
    id,
    companyId: "company-1",
    spaceId,
    parentPageId,
    documentId: `document-${id}`,
    sortOrder: 0,
    title,
    latestRevisionId: `rev-${id}`,
    latestRevisionNumber: 1,
    updatedByAgentId: null,
    updatedByUserId: "user-1",
    createdAt: new Date("2026-10-11T09:00:00.000Z"),
    updatedAt: new Date("2026-10-11T09:00:00.000Z"),
    children,
  };
}

const TREE: SpacePageTreeNode[] = [
  node("page-1", "Introduction"),
  node("page-2", "People", [node("page-3", "Hiring", [node("page-4", "Interviews", [], "page-3")], "page-2")]),
  node("page-5", "Pricing"),
];
const RULES_TREE: SpacePageTreeNode[] = [node("rule-1", "Standing rules", [], null, "space-2")];

function buttonNamed(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);
}

function place(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find(
    (button) => button.textContent?.trim() === label,
  );
}

describe("SpacePageMenu", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  const onMoved = vi.fn();
  const onDeleted = vi.fn();

  beforeEach(() => {
    mockSpacesApi.list.mockReset().mockResolvedValue([{ ...HANDBOOK, pageCount: 5 }, { ...RULES, pageCount: 1 }]);
    mockSpacesApi.pageTree.mockReset().mockImplementation(async (spaceId: string) => (spaceId === "space-2" ? RULES_TREE : TREE));
    mockSpacesApi.movePage.mockReset().mockImplementation(async (_spaceId: string, pageId: string) => node(pageId, "Moved"));
    mockSpacesApi.deletePage.mockReset().mockResolvedValue({ pageId: "page-2", parentPageId: null, subpageCount: 2 });
    onMoved.mockReset();
    onDeleted.mockReset();
    toasts.pushToast.mockReset();
    toasts.dismissToast.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    queryClient.clear();
  });

  async function render(page: SpacePageTreeNode) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SpacePageMenu space={HANDBOOK} tree={TREE} page={page} onMoved={onMoved} onDeleted={onDeleted} />
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  it("puts a page in order among its neighbours, without dragging, and says it did", async () => {
    await render(TREE[1]!);

    await act(async () => {
      buttonNamed(container, "Move up")!.click();
    });
    await flush();
    // With the parent this list shows, so a page moved since is not put back here.
    expect(mockSpacesApi.movePage).toHaveBeenLastCalledWith("space-1", "page-2", {
      parentPageId: null,
      index: 0,
      fromParentPageId: null,
    });
    await act(async () => {
      buttonNamed(container, "Move down")!.click();
    });
    await flush();
    expect(mockSpacesApi.movePage).toHaveBeenLastCalledWith("space-1", "page-2", {
      parentPageId: null,
      index: 2,
      fromParentPageId: null,
    });
    // Said, since beside an open page on a phone the list is not on screen.
    expect(said()).toEqual(["Moved People up", "Moved People down"]);
  });

  it("draws the list again and says why when the page moved since the list was drawn", async () => {
    mockSpacesApi.movePage.mockRejectedValue(
      new ApiError("This page has moved since you last saw it.", 409, {
        error: "This page has moved since you last saw it.",
        details: { parentPageId: "page-5" },
      }),
    );
    const treeKey = queryKeys.spaces.pageTree("space-1");
    queryClient.setQueryData(treeKey, TREE);
    await render(TREE[1]!);

    await act(async () => {
      buttonNamed(container, "Move down")!.click();
    });
    await flush();

    expect(toasts.pushToast).toHaveBeenLastCalledWith(
      expect.objectContaining({ tone: "error", title: "Could not move the page", body: "This page has moved since you last saw it." }),
    );
    expect(queryClient.getQueryState(treeKey)?.isInvalidated).toBe(true);
  });

  it("cannot move the first page up or the last one down", async () => {
    await render(TREE[0]!);
    expect(buttonNamed(container, "Move up")!.disabled).toBe(true);
    expect(buttonNamed(container, "Move down")!.disabled).toBe(false);

    await render(TREE[2]!);
    expect(buttonNamed(container, "Move up")!.disabled).toBe(false);
    expect(buttonNamed(container, "Move down")!.disabled).toBe(true);

    // The only subpage of its parent.
    await render(TREE[1]!.children[0]!);
    expect(buttonNamed(container, "Move up")!.disabled).toBe(true);
    expect(buttonNamed(container, "Move down")!.disabled).toBe(true);
  });

  it("moves a page with its subpages under a page of another Space, and never under its own subpages", async () => {
    await render(TREE[1]!);
    await act(async () => {
      buttonNamed(container, "Move to…")!.click();
    });
    await flush();

    expect(container.querySelector("h2")?.textContent).toBe("Move People");
    // Where it is now: nothing to move yet.
    expect(place(container, "The top level of Handbook")!.getAttribute("aria-checked")).toBe("true");
    expect(buttonNamed(container, "Move here")!.disabled).toBe(true);
    // Itself and its own subpages cannot be where it goes.
    expect(place(container, "People")!.disabled).toBe(true);
    expect(place(container, "Hiring")!.disabled).toBe(true);
    expect(place(container, "Interviews")!.disabled).toBe(true);
    expect(place(container, "Pricing")!.disabled).toBe(false);

    const select = container.querySelector<HTMLSelectElement>("#move-page-space")!;
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(["Handbook", "Rules"]);
    await act(async () => {
      select.value = "space-2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(place(container, "The top level of Rules")).toBeDefined();
    await act(async () => {
      place(container, "Standing rules")!.click();
    });
    await act(async () => {
      buttonNamed(container, "Move here")!.click();
    });
    await flush();

    expect(mockSpacesApi.movePage).toHaveBeenCalledWith("space-1", "page-2", { spaceId: "space-2", parentPageId: "rule-1" });
    // Reported with the page as it was, subpages and all, so an open subpage can be followed.
    expect(onMoved).toHaveBeenCalledWith(TREE[1], expect.objectContaining({ id: "space-2", urlKey: "rules" }));
    expect(container.querySelector('[data-testid="dialog"]')).toBeNull();
    expect(said()).toEqual(["Moved People to Rules, under Standing rules"]);
  });

  it("moves a page to the top level of its own Space", async () => {
    await render(TREE[1]!.children[0]!);
    await act(async () => {
      buttonNamed(container, "Move to…")!.click();
    });
    await flush();
    await act(async () => {
      place(container, "The top level of Handbook")!.click();
    });
    await act(async () => {
      buttonNamed(container, "Move here")!.click();
    });
    await flush();

    expect(mockSpacesApi.movePage).toHaveBeenCalledWith("space-1", "page-3", { parentPageId: null });
    expect(said()).toEqual(["Moved Hiring to the top level"]);

    // And under another page of its own Space.
    await act(async () => {
      buttonNamed(container, "Move to…")!.click();
    });
    await flush();
    await act(async () => {
      place(container, "Pricing")!.click();
    });
    await act(async () => {
      buttonNamed(container, "Move here")!.click();
    });
    await flush();
    expect(said()).toEqual(["Moved Hiring to the top level", "Moved Hiring under Pricing"]);
  });

  it("says why a move was refused, in the dialog", async () => {
    mockSpacesApi.movePage.mockRejectedValue(new Error("A page cannot move under itself or one of its own subpages."));
    await render(TREE[0]!);
    await act(async () => {
      buttonNamed(container, "Move to…")!.click();
    });
    await flush();
    await act(async () => {
      place(container, "Pricing")!.click();
    });
    await act(async () => {
      buttonNamed(container, "Move here")!.click();
    });
    await flush();

    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Could not move the page. A page cannot move under itself or one of its own subpages.",
    );
    expect(container.querySelector('[data-testid="dialog"]')).not.toBeNull();
    expect(onMoved).not.toHaveBeenCalled();
  });

  it("asks before deleting, saying how many subpages go with it, then sends them to the trash", async () => {
    // Copies of the pages this tab holds: they go with the pages, so going
    // back to one finds it in the trash rather than drawing it from a copy.
    for (const id of ["page-1", "page-2", "page-3", "page-4"]) {
      queryClient.setQueryData(queryKeys.spaces.page("space-1", id), { id });
    }
    await render(TREE[1]!);
    await act(async () => {
      buttonNamed(container, "Delete…")!.click();
    });

    expect(container.querySelector("h2")?.textContent).toBe("Delete People?");
    expect(container.textContent).toContain("It goes to the trash of Handbook with its 2 subpages. You can restore them from there.");
    expect(mockSpacesApi.deletePage).not.toHaveBeenCalled();
    await act(async () => {
      buttonNamed(container, "Delete")!.click();
    });
    await flush();

    expect(mockSpacesApi.deletePage).toHaveBeenCalledWith("space-1", "page-2");
    expect(onDeleted).toHaveBeenCalledWith(TREE[1]);
    expect(container.querySelector('[data-testid="dialog"]')).toBeNull();
    const held = (id: string) => queryClient.getQueryData(queryKeys.spaces.page("space-1", id));
    expect(["page-2", "page-3", "page-4"].map(held)).toEqual([undefined, undefined, undefined]);
    expect(held("page-1")).toEqual({ id: "page-1" });
  });
});
