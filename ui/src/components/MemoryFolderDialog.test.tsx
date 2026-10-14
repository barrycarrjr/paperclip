// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeRun, describeValidation, MemoryFolderDialog } from "./MemoryFolderDialog";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  export: vi.fn(),
  import: vi.fn(),
  sync: vi.fn(),
  findings: vi.fn(),
  rebuildIndex: vi.fn(),
}));
const pushToast = vi.hoisted(() => vi.fn());

vi.mock("@/api/memoryFolders", () => ({ memoryFoldersApi: mockApi }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast }) }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  for (let index = 0; index < 3; index += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find((item) => item.textContent?.trim() === label);
  expect(found, `button ${label}`).toBeTruthy();
  return found!;
}

describe("MemoryFolderDialog knowledge-base controls", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    mockApi.get.mockResolvedValue({
      companyId: "company-1",
      path: "~/knowledge",
      scheduleMinutes: null,
      lastSyncAt: null,
      lastResult: null,
    });
    mockApi.findings.mockResolvedValue({
      trigger: "manual",
      scannedAt: "2026-10-14T00:00:00.000Z",
      filesScanned: 2,
      findings: [{ kind: "open_gap", fingerprint: "gap", severity: "medium", path: "plan.md", line: 4, summary: "Open gap: owner", details: {} }],
      error: null,
    });
    mockApi.rebuildIndex.mockResolvedValue({ indexedAt: "2026-10-14T00:00:00.000Z", filesIndexed: 2, changed: true });
    pushToast.mockReset();
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("formats validation results in folder-run summaries", () => {
    expect(describeValidation({
      trigger: "manual",
      scannedAt: "2026-10-14T00:00:00.000Z",
      filesScanned: 2,
      findings: [],
      error: null,
    })).toBe("2 notes checked, no findings");
    expect(describeRun({
      mode: "export",
      trigger: "manual",
      startedAt: "2026-10-14T00:00:00.000Z",
      finishedAt: "2026-10-14T00:00:01.000Z",
      exported: 1,
      removed: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      warnings: [],
      validation: { trigger: "manual", scannedAt: "2026-10-14T00:00:01.000Z", filesScanned: 1, findings: [], error: "folder changed" },
      error: null,
    })).toContain("check failed: folder changed");
  });

  it("runs the read-only check and explicit index rebuild controls", async () => {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryFolderDialog companyId="company-1" open onOpenChange={() => undefined} />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    await act(async () => button("Check notes").click());
    await flushReact();
    expect(mockApi.findings).toHaveBeenCalledWith("company-1");
    expect(pushToast).toHaveBeenLastCalledWith(expect.objectContaining({ tone: "warn", title: "Knowledge-base check finished" }));

    await act(async () => button("Rebuild index").click());
    await flushReact();
    expect(mockApi.rebuildIndex).toHaveBeenCalledWith("company-1");
    expect(pushToast).toHaveBeenLastCalledWith(expect.objectContaining({ tone: "success", title: "Memory index rebuilt" }));
  });
});
