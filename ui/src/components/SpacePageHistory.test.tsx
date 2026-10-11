// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Space, SpacePage, SpacePageRevision } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { SpacePageHistory } from "./SpacePageHistory";

const mockSpacesApi = vi.hoisted(() => ({
  revisions: vi.fn(),
  revision: vi.fn(),
}));

vi.mock("../api/spaces", () => ({ spacesApi: mockSpacesApi }));

vi.mock("../api/access", () => ({
  accessApi: {
    listUserDirectory: async () => ({
      users: [
        { principalId: "user-a", status: "active", user: { id: "user-a", name: "Ann Lee", email: null, image: null } },
        { principalId: "user-b", status: "active", user: { id: "user-b", name: "Bea Cruz", email: null, image: null } },
      ],
    }),
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: { list: async () => [{ id: "agent-1", name: "Coder" }] },
}));

vi.mock("../lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div data-testid="markdown-body">{children}</div>,
}));

// A plain box stands in for the sheet, so what it holds is drawn in the test's container.
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div data-testid="sheet">{children}</div> : null),
  SheetContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
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
  createdByUserId: "user-a",
  createdAt: new Date("2026-10-11T09:00:00.000Z"),
  updatedAt: new Date("2026-10-11T09:00:00.000Z"),
};

function version(revisionNumber: number, overrides: Partial<SpacePageRevision> = {}): SpacePageRevision {
  return {
    id: `rev-${revisionNumber}`,
    revisionNumber,
    title: "Refunds",
    changeSummary: null,
    createdByAgentId: null,
    createdByUserId: "user-a",
    createdByRunId: null,
    createdAt: new Date("2026-10-11T09:00:00.000Z"),
    ...overrides,
  };
}

const VERSIONS = [
  version(4, { createdByUserId: null, createdByAgentId: "agent-1", createdByRunId: "run-12345678abcd" }),
  version(3, { createdByUserId: "user-b", changeSummary: "Restored version 1" }),
  version(2, { createdByUserId: "user-b" }),
  version(1),
];

function buttonNamed(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);
}

/** The list's row for a version, by its number. */
function row(container: HTMLElement, revisionNumber: number) {
  return Array.from(container.querySelectorAll("li button")).find((button) =>
    button.textContent?.startsWith(`Version ${revisionNumber}`),
  ) as HTMLButtonElement | undefined;
}

describe("SpacePageHistory", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  const onRestore = vi.fn();

  beforeEach(() => {
    mockSpacesApi.revisions.mockReset().mockResolvedValue(VERSIONS);
    mockSpacesApi.revision.mockReset().mockImplementation(async (_spaceId: string, _pageId: string, revisionId: string) => {
      const found = VERSIONS.find((candidate) => candidate.id === revisionId)!;
      return { ...found, format: "markdown", body: `The text of version ${found.revisionNumber}.` };
    });
    onRestore.mockReset();
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

  async function render(options: { canRestore?: boolean } = {}) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SpacePageHistory
            space={SPACE}
            pageId="page-1"
            open
            onOpenChange={() => undefined}
            currentRevisionId="rev-4"
            canRestore={options.canRestore ?? true}
            onRestore={onRestore}
          />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();
  }

  async function open(revisionNumber: number) {
    await act(async () => {
      row(container, revisionNumber)!.click();
    });
    await flush();
  }

  it("lists every version newest first, with who made it: a person, or an agent and its run", async () => {
    await render();

    expect(mockSpacesApi.revisions).toHaveBeenCalledWith("space-1", "page-1");
    const rows = Array.from(container.querySelectorAll("li")).map((item) => item.textContent);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain("Version 4");
    expect(rows[0]).toContain("Current");
    expect(rows[0]).toContain("Coder, in a run");
    expect(rows[1]).toContain("Bea Cruz");
    expect(rows[1]).toContain("Restored version 1");
    expect(rows[3]).toContain("Version 1");
    expect(rows[3]).toContain("Ann Lee");
    expect(rows[3]).not.toContain("Current");
  });

  it("opens a version to read, with its agent's run linked", async () => {
    await render();
    await open(4);

    expect(container.querySelector('[data-testid="markdown-body"]')?.textContent).toBe("The text of version 4.");
    expect(container.querySelector('a[href="/agents/agent-1/runs/run-12345678abcd"]')?.textContent).toBe("run run-1234");
    // The current version is the page already.
    expect(buttonNamed(container, "Restore this version")).toBeUndefined();

    await act(async () => {
      buttonNamed(container, "All versions")!.click();
    });
    expect(container.querySelectorAll("li")).toHaveLength(4);
  });

  it("restores an older version, then says which version it became", async () => {
    onRestore.mockResolvedValue({ latestRevisionNumber: 5 } as SpacePage);
    await render();
    await open(1);

    expect(container.querySelector('[data-testid="markdown-body"]')?.textContent).toBe("The text of version 1.");
    await act(async () => {
      buttonNamed(container, "Restore this version")!.click();
    });
    await flush();

    expect(onRestore).toHaveBeenCalledWith(VERSIONS[3]);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Version 1 is back, as version 5.");
    // Back to the list, which is asked for again.
    expect(container.querySelectorAll("li")).toHaveLength(4);
    expect(mockSpacesApi.revisions).toHaveBeenCalledTimes(2);
  });

  it("says when the page changed before the restore reached it", async () => {
    onRestore.mockRejectedValue(new ApiError("This page was changed by someone else", 409, null));
    await render();
    await open(2);
    await act(async () => {
      buttonNamed(container, "Restore this version")!.click();
    });
    await flush();

    // The editor has taken the newer version by then, so another try can work.
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "The page changed after you opened its history. It now shows the newest version. Restore again if you still want version 2.",
    );
    expect(buttonNamed(container, "Restore this version")!.disabled).toBe(false);
  });

  it("lets a viewer read every version but restore none", async () => {
    await render({ canRestore: false });
    await open(1);

    expect(container.querySelector('[data-testid="markdown-body"]')?.textContent).toBe("The text of version 1.");
    expect(buttonNamed(container, "Restore this version")).toBeUndefined();
  });
});
