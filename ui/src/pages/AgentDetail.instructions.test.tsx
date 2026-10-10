// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../context/ToastContext";
import { ToastViewport } from "../components/ToastViewport";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PromptsTab } from "./AgentDetail";

const mockAgentsApi = vi.hoisted(() => ({
  instructionsBundle: vi.fn(),
  instructionsFile: vi.fn(),
  saveInstructionsFile: vi.fn(),
  updateInstructionsBundle: vi.fn(),
  deleteInstructionsFile: vi.fn(),
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("@/adapters/use-adapter-capabilities", () => ({
  useAdapterCapabilities: () => () => ({
    supportsInstructionsBundle: true,
    supportsSkills: true,
    supportsLocalAgentJwt: true,
    requiresMaterializedRuntimeSkills: false,
  }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea data-testid="markdown-editor" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

const AGENT = {
  id: "agent-1",
  urlKey: "pat",
  name: "Pat",
  companyId: "company-1",
  adapterType: "claude_local",
} as unknown as Agent;

const BUNDLE = {
  mode: "managed",
  rootPath: "/data/agents/agent-1",
  managedRootPath: "/data/agents/agent-1",
  entryFile: "AGENTS.md",
  files: [{ path: "AGENTS.md", size: 12, isEntryFile: true, deprecated: false }],
  warnings: [],
  legacyPromptTemplateActive: false,
  legacyBootstrapPromptTemplateActive: false,
};

const FILE = { path: "AGENTS.md", content: "# Old rules\n", language: "markdown" };

/**
 * The instructions editor saves from the page's floating Save bar, which says
 * "Saving..." until the tab has reloaded what was saved. The confirmation
 * comes after that reload, and a failure says why instead of nothing.
 */
describe("PromptsTab, saving instructions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let saveAction: (() => void) | null;
  let saving: boolean;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    saveAction = null;
    saving = false;
    mockAgentsApi.instructionsBundle.mockResolvedValue(BUNDLE);
    mockAgentsApi.instructionsFile.mockResolvedValue(FILE);
    mockAgentsApi.saveInstructionsFile.mockImplementation(
      async (_agentId: string, data: { path: string; content: string }) => ({ path: data.path, content: data.content }),
    );
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <TooltipProvider>
              <PromptsTab
                agent={AGENT}
                companyId="company-1"
                onDirtyChange={() => {}}
                onSaveActionChange={(save) => {
                  saveAction = save;
                }}
                onCancelActionChange={() => {}}
                onSavingChange={(next) => {
                  saving = next;
                }}
              />
            </TooltipProvider>
            <ToastViewport />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
  }

  /**
   * The message viewport's live region, taken before the save. It has to be
   * on the page already: a screen reader often misses a region that appears
   * together with its first message. (The copy button has a live region of
   * its own, hence the aside.)
   */
  function liveRegion() {
    const region = container.querySelector('aside[aria-live="polite"]');
    expect(region, "the live region is on the page before the save").not.toBeNull();
    return region as HTMLElement;
  }

  function editor() {
    return container.querySelector('[data-testid="markdown-editor"]') as HTMLTextAreaElement | null;
  }

  /** Edits the open file and presses Save on the page's floating bar. */
  async function editAndSave(text: string) {
    await vi.waitFor(() => expect(editor()).not.toBeNull());
    await act(async () => {
      setTextareaValue(editor()!, text);
    });
    expect(saveAction).not.toBeNull();
    await act(async () => {
      saveAction!();
    });
    await flushReact();
  }

  it("says the instructions were saved once the tab has reloaded them, not while it still says Saving", async () => {
    // Every reload after the first load waits until the test lets it finish.
    // (A save reloads the file more than once: the bundle key is a prefix of
    // the file key, so each reload replaces the one before.)
    let finishReload: (file: typeof FILE) => void = () => {};
    const reload = new Promise<typeof FILE>((resolve) => {
      finishReload = resolve;
    });
    mockAgentsApi.instructionsFile.mockResolvedValueOnce(FILE).mockImplementation(() => reload);
    await render();
    const region = liveRegion();

    await editAndSave("# New rules\n");

    expect(mockAgentsApi.saveInstructionsFile.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ path: "AGENTS.md", content: "# New rules\n" }),
    );
    // Saved on the server, but the tab has not reloaded it yet.
    expect(saving).toBe(true);
    expect(region.textContent).not.toContain("Instructions saved");

    await act(async () => {
      finishReload({ ...FILE, content: "# New rules\n" });
    });
    await flushReact();
    await flushReact();

    expect(region.textContent).toContain("Instructions saved");
    expect(saving).toBe(false);
  });

  it("says why the instructions could not be saved, where it used to say nothing", async () => {
    mockAgentsApi.saveInstructionsFile.mockRejectedValueOnce(new Error("The instructions folder is read only."));
    await render();
    const region = liveRegion();

    await editAndSave("# New rules\n");

    await vi.waitFor(() => expect(region.textContent).toContain("Could not save instructions"));
    expect(region.textContent).toContain("The instructions folder is read only.");
    expect(region.textContent).not.toContain("Instructions saved");
  });

  it("takes back the saved message when the next save fails", async () => {
    await render();
    const region = liveRegion();

    await editAndSave("# New rules\n");
    await vi.waitFor(() => expect(region.textContent).toContain("Instructions saved"));

    mockAgentsApi.saveInstructionsFile.mockRejectedValueOnce(new Error("The instructions folder is read only."));
    await editAndSave("# Newer rules\n");

    await vi.waitFor(() => expect(region.textContent).toContain("Could not save instructions"));
    expect(region.textContent).not.toContain("Instructions saved");
  });
});
