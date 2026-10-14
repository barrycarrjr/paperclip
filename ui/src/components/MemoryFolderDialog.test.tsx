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
  previewLinks: vi.fn(),
  applyLinks: vi.fn(),
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
      driveLinkMode: false,
      linkMigration: null,
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
    mockApi.update.mockResolvedValue({
      companyId: "company-1",
      path: "~/knowledge",
      driveLinkMode: true,
      linkMigration: null,
      scheduleMinutes: null,
      lastSyncAt: null,
      lastResult: null,
    });
    mockApi.previewLinks.mockResolvedValue({
      planHash: "a".repeat(64),
      memoriesChanged: 1,
      changes: [{
        path: "plan.md",
        line: 7,
        target: "policy.md",
        replacement: "[Policy](policy.md) (Drive-ID: 1AbCdefGhijk_123)",
        driveFileId: "1AbCdefGhijk_123",
        evidence: "target_frontmatter",
      }],
      skipped: [{ path: "legacy.md", line: 3, reason: "The target has no declared Drive identity" }],
      before: { trigger: "manual", scannedAt: "2026-10-14T00:00:00.000Z", filesScanned: 2, findings: [], error: null },
      after: { trigger: "manual", scannedAt: "2026-10-14T00:00:00.000Z", filesScanned: 2, findings: [], error: null },
    });
    mockApi.applyLinks.mockResolvedValue({
      planHash: "a".repeat(64),
      status: "completed",
      filesChanged: 1,
      memoriesChanged: 1,
      before: { trigger: "manual", scannedAt: "2026-10-14T00:00:00.000Z", filesScanned: 2, findings: [], error: null },
      after: { trigger: "manual", scannedAt: "2026-10-14T00:00:01.000Z", filesScanned: 2, findings: [], error: null },
    });
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

  it("saves Drive-link mode, previews changes, and applies the reviewed plan", async () => {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryFolderDialog companyId="company-1" open onOpenChange={() => undefined} />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const toggle = document.querySelector<HTMLInputElement>("#memory-folder-drive-links");
    expect(toggle).toBeTruthy();
    await act(async () => toggle!.click());
    mockApi.get.mockResolvedValue({
      companyId: "company-1",
      path: "~/knowledge",
      driveLinkMode: true,
      linkMigration: { planHash: "b".repeat(64), status: "completed" },
      scheduleMinutes: null,
      lastSyncAt: null,
      lastResult: null,
    });
    await act(async () => button("Save").click());
    await flushReact();
    expect(mockApi.update).toHaveBeenCalledWith("company-1", {
      path: "~/knowledge",
      scheduleMinutes: null,
      driveLinkMode: true,
    });

    await act(async () => button("Preview Drive links").click());
    await flushReact();
    expect(mockApi.previewLinks).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("plan.md:7 changes policy.md to [Policy](policy.md) (Drive-ID: 1AbCdefGhijk_123)");
    expect(container.textContent).toContain("legacy.md:3: The target has no declared Drive identity");

    await act(async () => button("Apply Drive links").click());
    await flushReact();
    expect(mockApi.applyLinks).toHaveBeenCalledWith("company-1", "a".repeat(64));
    expect(pushToast).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Drive links applied" }));
  });

  it("offers only the saved recovery plan while a Drive-link apply is pending", async () => {
    const pendingHash = "c".repeat(64);
    mockApi.get.mockResolvedValue({
      companyId: "company-1",
      path: "~/knowledge",
      driveLinkMode: true,
      linkMigration: { planHash: pendingHash, status: "pending" },
      scheduleMinutes: null,
      lastSyncAt: null,
      lastResult: null,
    });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryFolderDialog companyId="company-1" open onOpenChange={() => undefined} />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(button("Import then export").disabled).toBe(true);
    expect(button("Preview Drive links").disabled).toBe(true);
    await act(async () => button("Retry Drive-link apply").click());
    await flushReact();
    expect(mockApi.applyLinks).toHaveBeenCalledWith("company-1", pendingHash);
  });

  it("blocks apply when the preview introduces a validator finding", async () => {
    mockApi.get.mockResolvedValue({
      companyId: "company-1",
      path: "~/knowledge",
      driveLinkMode: true,
      linkMigration: null,
      scheduleMinutes: null,
      lastSyncAt: null,
      lastResult: null,
    });
    mockApi.previewLinks.mockResolvedValue({
      planHash: "d".repeat(64),
      memoriesChanged: 1,
      changes: [{
        path: "plan.md",
        line: 7,
        target: "policy.md",
        replacement: "[Policy](policy.md) (Drive-ID: 1AbCdefGhijk_123)",
        driveFileId: "1AbCdefGhijk_123",
        evidence: "target_frontmatter",
      }],
      skipped: [],
      before: { trigger: "manual", scannedAt: "2026-10-14T00:00:00.000Z", filesScanned: 2, findings: [], error: null },
      after: {
        trigger: "manual",
        scannedAt: "2026-10-14T00:00:00.000Z",
        filesScanned: 2,
        findings: [{ kind: "broken_relative_link", fingerprint: "new", severity: "high", path: "plan.md", line: 7, summary: "Broken", details: {} }],
        error: null,
      },
    });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryFolderDialog companyId="company-1" open onOpenChange={() => undefined} />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    await act(async () => button("Preview Drive links").click());
    await flushReact();
    expect(container.textContent).toContain("Apply is blocked");
    expect(button("Apply Drive links").disabled).toBe(true);
  });

  it("allows apply when only a memory identity needs updating", async () => {
    mockApi.get.mockResolvedValue({
      companyId: "company-1",
      path: "~/knowledge",
      driveLinkMode: true,
      linkMigration: null,
      scheduleMinutes: null,
      lastSyncAt: null,
      lastResult: null,
    });
    mockApi.previewLinks.mockResolvedValue({
      planHash: "e".repeat(64),
      memoriesChanged: 1,
      changes: [],
      skipped: [],
      before: { trigger: "manual", scannedAt: "2026-10-14T00:00:00.000Z", filesScanned: 1, findings: [], error: null },
      after: { trigger: "manual", scannedAt: "2026-10-14T00:00:00.000Z", filesScanned: 1, findings: [], error: null },
    });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryFolderDialog companyId="company-1" open onOpenChange={() => undefined} />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    await act(async () => button("Preview Drive links").click());
    await flushReact();
    expect(button("Apply Drive links").disabled).toBe(false);
  });
});
