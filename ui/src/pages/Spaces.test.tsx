// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SpaceListItem } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Spaces } from "./Spaces";

const mockSpacesApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
}));

const accessState = vi.hoisted(() => ({
  role: "owner" as string,
}));

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

vi.mock("@/context/ToastContext", () => ({
  useOptionalToastActions: () => null,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
  useNavigate: () => navigate,
}));

vi.mock("@/components/InfoPopoverButton", () => ({
  InfoPopoverButton: () => null,
}));

// A plain box stands in for the dialog, so what it holds is drawn in the test's container.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
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

function space(overrides: Partial<SpaceListItem> = {}): SpaceListItem {
  return {
    id: "space-1",
    companyId: "company-1",
    name: "Sales handbook",
    urlKey: "sales-handbook",
    description: "How we sell",
    sortOrder: 0,
    archivedAt: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: new Date("2026-10-11T10:00:00.000Z"),
    updatedAt: new Date("2026-10-11T10:00:00.000Z"),
    pageCount: 3,
    ...overrides,
  };
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonNamed(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);
}

describe("Spaces", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    mockSpacesApi.list.mockReset();
    mockSpacesApi.create.mockReset();
    navigate.mockReset();
    accessState.role = "owner";
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
          <Spaces />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();
  }

  it("lists the company's Spaces, each linking to its own address with its page count", async () => {
    mockSpacesApi.list.mockResolvedValue([
      space(),
      space({ id: "space-2", name: "Standing rules", urlKey: "standing-rules", description: null, pageCount: 1 }),
    ]);

    await render();

    expect(mockSpacesApi.list).toHaveBeenCalledWith("company-1");
    const links = Array.from(container.querySelectorAll("a"));
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/spaces/sales-handbook", "/spaces/standing-rules"]);
    expect(links[0]!.textContent).toContain("Sales handbook");
    expect(links[0]!.textContent).toContain("How we sell");
    expect(links[0]!.textContent).toContain("3 pages");
    expect(links[1]!.textContent).toContain("1 page");
    expect(setBreadcrumbs).toHaveBeenCalledWith([{ label: "Spaces" }]);
  });

  it("offers to make the first Space, and makes it and opens it", async () => {
    mockSpacesApi.list.mockResolvedValue([]);
    mockSpacesApi.create.mockResolvedValue(space({ id: "space-9", name: "Rules", urlKey: "rules", pageCount: 0 }));

    await render();
    expect(container.textContent).toContain("No Spaces yet");

    await act(async () => {
      buttonNamed(container, "New Space")!.click();
    });
    const name = container.querySelector<HTMLInputElement>("#new-space-name")!;
    await act(async () => {
      setInputValue(name, "  Rules  ");
    });
    await act(async () => {
      buttonNamed(container, "Create Space")!.click();
    });
    await flush();

    expect(mockSpacesApi.create).toHaveBeenCalledWith("company-1", { name: "Rules", description: null });
    expect(navigate).toHaveBeenCalledWith("/spaces/rules");
  });

  it("says why a Space could not be made, in the dialog, and keeps it open", async () => {
    mockSpacesApi.list.mockResolvedValue([]);
    mockSpacesApi.create.mockRejectedValue(new Error("The name is too long"));

    await render();
    await act(async () => {
      buttonNamed(container, "New Space")!.click();
    });
    await act(async () => {
      setInputValue(container.querySelector<HTMLInputElement>("#new-space-name")!, "Rules");
    });
    await act(async () => {
      buttonNamed(container, "Create Space")!.click();
    });
    await flush();

    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Could not create the Space. The name is too long",
    );
    expect(container.querySelector("#new-space-name")).not.toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("says why the list did not load, and does not offer to make the first Space", async () => {
    mockSpacesApi.list.mockRejectedValue(new Error("Paperclip is not answering"));

    await render();

    expect(container.textContent).toContain("Paperclip is not answering");
    expect(container.textContent).not.toContain("No Spaces yet");
    // Only the header's button: a second one under the error read as an empty shelf.
    expect(Array.from(container.querySelectorAll("button")).filter((button) => button.textContent?.trim() === "New Space"))
      .toHaveLength(1);
  });

  it("shows archived Spaces when asked, apart from the others", async () => {
    mockSpacesApi.list.mockImplementation(async (_companyId: string, options?: { archived?: boolean }) =>
      options?.archived
        ? [space({ id: "space-3", name: "Old rules", urlKey: "old-rules", archivedAt: new Date("2026-10-11T11:00:00.000Z") })]
        : [space()],
    );
    await render();

    // Asked for only when shown.
    expect(mockSpacesApi.list).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("Old rules");
    await act(async () => {
      buttonNamed(container, "Show archived Spaces")!.click();
    });
    await flush();

    expect(mockSpacesApi.list).toHaveBeenLastCalledWith("company-1", { archived: true });
    const archived = container.querySelector('section[aria-label="Archived Spaces"]')!;
    expect(archived.querySelector("a")?.getAttribute("href")).toBe("/spaces/old-rules");
    expect(archived.textContent).toContain("Archived");
    expect(Array.from(container.querySelectorAll("a")).map((link) => link.getAttribute("href"))).toEqual([
      "/spaces/sales-handbook",
      "/spaces/old-rules",
    ]);

    await act(async () => {
      buttonNamed(container, "Hide archived Spaces")!.click();
    });
    expect(container.querySelector('section[aria-label="Archived Spaces"]')).toBeNull();
  });

  it("says every Space is archived, and shows them, rather than offering to make the first one", async () => {
    mockSpacesApi.list.mockImplementation(async (_companyId: string, options?: { archived?: boolean }) =>
      options?.archived
        ? [space({ id: "space-3", name: "Old rules", urlKey: "old-rules", archivedAt: new Date("2026-10-11T11:00:00.000Z") })]
        : [],
    );
    await render();
    await flush();

    expect(mockSpacesApi.list).toHaveBeenCalledWith("company-1", { archived: true });
    expect(container.textContent).toContain("Every Space is archived.");
    expect(container.textContent).not.toContain("No Spaces yet");
    const archived = container.querySelector('section[aria-label="Archived Spaces"]')!;
    expect(archived.querySelector("a")?.getAttribute("href")).toBe("/spaces/old-rules");
    // Shown already, so there is nothing to show or hide.
    expect(buttonNamed(container, "Show archived Spaces")).toBeUndefined();
    // Only the header's button: a second under the list read as an empty shelf.
    expect(Array.from(container.querySelectorAll("button")).filter((button) => button.textContent?.trim() === "New Space"))
      .toHaveLength(1);
  });

  it("lets a viewer read the list but offers nothing to make", async () => {
    accessState.role = "viewer";
    mockSpacesApi.list.mockResolvedValue([space()]);

    await render();

    expect(container.textContent).toContain("Sales handbook");
    expect(buttonNamed(container, "New Space")).toBeUndefined();
  });
});
