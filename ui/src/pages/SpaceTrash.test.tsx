// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Space, SpaceTrashItem } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpaceTrash } from "./SpaceTrash";

const mockSpacesApi = vi.hoisted(() => ({
  get: vi.fn(),
  trash: vi.fn(),
  restoreFromTrash: vi.fn(),
}));

const accessState = vi.hoisted(() => ({ role: "owner" as string }));
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

vi.mock("@/context/ToastContext", () => ({
  useOptionalToastActions: () => null,
}));

vi.mock("@/lib/router", () => ({
  useParams: () => ({ spaceKey: "handbook" }),
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
  description: null,
  sortOrder: 0,
  archivedAt: null,
  createdByAgentId: null,
  createdByUserId: "user-1",
  createdAt: new Date("2026-10-11T09:00:00.000Z"),
  updatedAt: new Date("2026-10-11T09:00:00.000Z"),
};

function item(id: string, title: string, subpageCount: number): SpaceTrashItem {
  return {
    id,
    companyId: "company-1",
    spaceId: "space-1",
    parentPageId: null,
    documentId: `document-${id}`,
    sortOrder: 0,
    title,
    latestRevisionId: `rev-${id}`,
    latestRevisionNumber: 1,
    updatedByAgentId: null,
    updatedByUserId: "user-1",
    createdAt: new Date("2026-10-11T09:00:00.000Z"),
    updatedAt: new Date("2026-10-11T09:00:00.000Z"),
    deletedAt: new Date(),
    subpageCount,
  };
}

function buttonsNamed(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll("button")).filter((button) => button.textContent?.trim() === label);
}

describe("SpaceTrash", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    accessState.role = "owner";
    mockSpacesApi.get.mockReset().mockResolvedValue(SPACE);
    mockSpacesApi.trash.mockReset().mockResolvedValue([item("page-2", "People", 2), item("page-7", "Old draft", 0)]);
    mockSpacesApi.restoreFromTrash.mockReset().mockResolvedValue({ pageId: "page-2", parentPageId: null, subpageCount: 2 });
    setBreadcrumbs.mockReset();
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
          <SpaceTrash />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();
    await flush();
  }

  it("lists each deleted page with how many subpages went with it, and brings one back", async () => {
    await render();

    expect(mockSpacesApi.trash).toHaveBeenCalledWith("space-1");
    const rows = Array.from(container.querySelectorAll("li")).map((row) => row.textContent);
    expect(rows[0]).toContain("People");
    expect(rows[0]).toContain("With 2 subpages");
    expect(rows[0]).toContain("Deleted");
    expect(rows[1]).toContain("Old draft");
    expect(rows[1]).not.toContain("subpage");
    expect(setBreadcrumbs).toHaveBeenLastCalledWith([
      { label: "Spaces", href: "/spaces" },
      { label: "Handbook", href: "/spaces/handbook" },
      { label: "Trash" },
    ]);

    await act(async () => {
      buttonsNamed(container, "Restore")[0]!.click();
    });
    await flush();
    expect(mockSpacesApi.restoreFromTrash).toHaveBeenCalledWith("space-1", "page-2");
    // The trash is asked for again, without what came back.
    expect(mockSpacesApi.trash).toHaveBeenCalledTimes(2);
  });

  it("lets a viewer look but not restore", async () => {
    accessState.role = "viewer";
    await render();

    expect(container.textContent).toContain("People");
    expect(buttonsNamed(container, "Restore")).toHaveLength(0);
  });

  it("restores nothing into an archived Space until it is unarchived", async () => {
    mockSpacesApi.get.mockResolvedValue({ ...SPACE, archivedAt: new Date("2026-10-11T10:00:00.000Z") });
    await render();

    expect(container.textContent).toContain("nothing can come back until it is unarchived");
    expect(buttonsNamed(container, "Restore")).toHaveLength(0);
  });

  it("says when the trash is empty", async () => {
    mockSpacesApi.trash.mockResolvedValue([]);
    await render();

    expect(container.textContent).toContain("The trash is empty.");
  });
});
