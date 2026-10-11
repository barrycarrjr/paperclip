// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Space, SpacePage, SpacePageTreeNode } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findSpacePage, SpaceDetail, spacePageIndentPx } from "./SpaceDetail";

const mockSpacesApi = vi.hoisted(() => ({
  get: vi.fn(),
  pageTree: vi.fn(),
  createPage: vi.fn(),
}));

const routeState = vi.hoisted(() => ({
  params: { spaceKey: "handbook" } as { spaceKey: string; pageId?: string },
}));

const accessState = vi.hoisted(() => ({ role: "owner" as string }));
const navigate = vi.hoisted(() => vi.fn());
const setBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("@/api/spaces", () => ({ spacesApi: mockSpacesApi }));

vi.mock("@/api/access", () => ({
  accessApi: {
    getCurrentBoardAccess: async () => ({
      source: "session",
      isInstanceAdmin: false,
      userId: "user-1",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: accessState.role }],
    }),
  },
}));

vi.mock("@/hooks/useRouteCompany", () => ({
  useActiveCompanyId: () => "company-1",
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    to,
    children,
    className,
    style,
    disableIssueQuicklook,
    ...rest
  }: { to: string; children: ReactNode; disableIssueQuicklook?: boolean } & ComponentProps<"a">) => (
    <a href={to} className={className} style={style} data-issue-quicklook={disableIssueQuicklook ? "off" : "on"} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => navigate,
  useParams: () => routeState.params,
}));

vi.mock("@/components/SpacePageEditor", () => ({
  NEW_SPACE_PAGE_TITLE: "Untitled",
  SpacePageEditor: ({ pageId, onAddSubpage }: { pageId: string; onAddSubpage?: () => void }) => (
    <div data-testid="page-editor" data-page-id={pageId}>
      {onAddSubpage && <button type="button" onClick={onAddSubpage}>Add a subpage</button>}
    </div>
  ),
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

const SPACE: Space = {
  id: "space-1",
  companyId: "company-1",
  name: "Handbook",
  urlKey: "handbook",
  description: "How we work",
  sortOrder: 0,
  archivedAt: null,
  createdByAgentId: null,
  createdByUserId: "user-1",
  createdAt: new Date("2026-10-11T09:00:00.000Z"),
  updatedAt: new Date("2026-10-11T09:00:00.000Z"),
};

function node(id: string, title: string, children: SpacePageTreeNode[] = [], parentPageId: string | null = null): SpacePageTreeNode {
  return {
    id,
    companyId: "company-1",
    spaceId: "space-1",
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
  node("page-2", "People", [
    node("page-3", "Hiring", [node("page-4", "Interviews", [], "page-3")], "page-2"),
  ]),
];

function createdPage(overrides: Partial<SpacePage> = {}): SpacePage {
  const { children: _children, ...summary } = node("page-9", "Untitled");
  return { ...summary, format: "markdown", body: "", createdByAgentId: null, createdByUserId: "user-1", ...overrides };
}

function linkTo(container: HTMLElement, href: string) {
  return container.querySelector<HTMLAnchorElement>(`a[href="${href}"]`);
}

function buttonLabelled(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.getAttribute("aria-label") === label || button.textContent?.trim() === label,
  );
}

describe("SpaceDetail", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    mockSpacesApi.get.mockReset().mockResolvedValue(SPACE);
    mockSpacesApi.pageTree.mockReset().mockResolvedValue(TREE);
    mockSpacesApi.createPage.mockReset();
    navigate.mockReset();
    setBreadcrumbs.mockReset();
    accessState.role = "owner";
    routeState.params = { spaceKey: "handbook" };
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

  async function render() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SpaceDetail />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();
    await flush();
  }

  it("lists the Space's pages nested under their parents, each at its own address", async () => {
    await render();

    expect(mockSpacesApi.get).toHaveBeenCalledWith("company-1", "handbook");
    expect(container.querySelector("h1")?.textContent).toBe("Handbook");
    expect(container.textContent).toContain("How we work");
    for (const [id, depth] of [["page-1", 0], ["page-2", 0], ["page-3", 1], ["page-4", 2]] as const) {
      const link = linkTo(container, `/spaces/handbook/${id}`);
      expect(link, id).not.toBeNull();
      expect(link!.parentElement!.style.paddingInlineStart, id).toBe(`${depth * 14}px`);
    }
    expect(setBreadcrumbs).toHaveBeenLastCalledWith([
      { label: "Spaces", href: "/spaces" },
      { label: "Handbook" },
    ]);
  });

  it("hides and shows a page's subpages", async () => {
    await render();

    await act(async () => {
      buttonLabelled(container, "Hide the subpages of People")!.click();
    });
    expect(linkTo(container, "/spaces/handbook/page-3")).toBeNull();
    expect(linkTo(container, "/spaces/handbook/page-2")).not.toBeNull();

    await act(async () => {
      buttonLabelled(container, "Show the subpages of People")!.click();
    });
    expect(linkTo(container, "/spaces/handbook/page-4")).not.toBeNull();
  });

  it("adds a page, or a subpage of a page, and opens it", async () => {
    mockSpacesApi.createPage.mockResolvedValue(createdPage());
    await render();

    await act(async () => {
      buttonLabelled(container, "New page")!.click();
    });
    await flush();
    expect(mockSpacesApi.createPage).toHaveBeenCalledWith("space-1", { title: "Untitled", parentPageId: null });
    expect(navigate).toHaveBeenCalledWith("/spaces/handbook/page-9");

    await act(async () => {
      buttonLabelled(container, "Add a subpage to Hiring")!.click();
    });
    await flush();
    expect(mockSpacesApi.createPage).toHaveBeenLastCalledWith("space-1", { title: "Untitled", parentPageId: "page-3" });
  });

  it("opens one page, marked in the list beside it, with the Space and the page in the breadcrumbs", async () => {
    routeState.params = { spaceKey: "handbook", pageId: "page-4" };
    mockSpacesApi.createPage.mockResolvedValue(createdPage({ parentPageId: "page-4" }));
    await render();

    expect(container.querySelector('[data-testid="page-editor"]')?.getAttribute("data-page-id")).toBe("page-4");
    expect(linkTo(container, "/spaces/handbook/page-4")?.getAttribute("aria-current")).toBe("page");
    // Not every page above it: a longer trail leaves no room for the page's name on a phone.
    expect(setBreadcrumbs).toHaveBeenLastCalledWith([
      { label: "Spaces", href: "/spaces" },
      { label: "Handbook", href: "/spaces/handbook" },
      { label: "Interviews" },
    ]);

    await act(async () => {
      buttonLabelled(container, "Add a subpage")!.click();
    });
    await flush();
    expect(mockSpacesApi.createPage).toHaveBeenCalledWith("space-1", { title: "Untitled", parentPageId: "page-4" });
  });

  it("offers a viewer nothing to add", async () => {
    accessState.role = "viewer";
    await render();

    expect(linkTo(container, "/spaces/handbook/page-4")).not.toBeNull();
    expect(buttonLabelled(container, "New page")).toBeUndefined();
    expect(buttonLabelled(container, "Add a subpage to Hiring")).toBeUndefined();
  });

  it("never shows a page as a task, even in a Space whose address is issues", async () => {
    // Its pages live at /spaces/issues/<page>, which the app's links read as a task.
    mockSpacesApi.get.mockResolvedValue({ ...SPACE, name: "Issues", urlKey: "issues" });
    await render();

    const pageLinks = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href^="/spaces/issues/"]'));
    expect(pageLinks).toHaveLength(4);
    for (const link of pageLinks) {
      expect(link.getAttribute("data-issue-quicklook"), link.getAttribute("href") ?? "").toBe("off");
    }
  });

  it("keeps setting deeper pages further in past six levels, so none sits level with its parent", () => {
    const indents = Array.from({ length: 12 }, (_, depth) => spacePageIndentPx(depth));
    expect(indents.slice(0, 7)).toEqual([0, 14, 28, 42, 56, 70, 84]);
    for (let depth = 1; depth < indents.length; depth += 1) {
      expect(indents[depth], `depth ${depth}`).toBeGreaterThan(indents[depth - 1]!);
    }
  });

  it("finds a page at any depth of the tree", () => {
    expect(findSpacePage(TREE, "page-4")?.title).toBe("Interviews");
    expect(findSpacePage(TREE, "missing")).toBeNull();
  });
});
