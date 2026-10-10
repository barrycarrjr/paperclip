// @vitest-environment jsdom

import { act, type ReactNode } from "react";
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

const LEE = {
  id: "agent-2",
  urlKey: "lee",
  name: "Lee",
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
    queryClient = null;
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

  let queryClient: QueryClient | null = null;

  /**
   * Draws the tab for an agent. Called again with another agent, it moves the
   * same tab to that agent, as the agent page does when you go from one agent
   * to the next.
   */
  async function render(agent: Agent = AGENT) {
    await draw(
      <PromptsTab
        agent={agent}
        companyId="company-1"
        onDirtyChange={() => {}}
        onSaveActionChange={(save) => {
          saveAction = save;
        }}
        onCancelActionChange={() => {}}
        onSavingChange={(next) => {
          saving = next;
        }}
      />,
    );
    await flushReact();
    await flushReact();
  }

  /** Draws the page around tab: with null, everything but the tab, as leaving the agent page does. */
  async function draw(tab: ReactNode) {
    const client = (queryClient ??= new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ToastProvider>
            <TooltipProvider>{tab}</TooltipProvider>
            <ToastViewport />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
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

  it("takes back the failure message when the next save works", async () => {
    mockAgentsApi.saveInstructionsFile.mockRejectedValueOnce(new Error("The instructions folder is read only."));
    await render();
    const region = liveRegion();

    await editAndSave("# New rules\n");
    await vi.waitFor(() => expect(region.textContent).toContain("Could not save instructions"));

    // The same edit, saved again, goes through this time.
    expect(saveAction).not.toBeNull();
    await act(async () => {
      saveAction!();
    });
    await flushReact();

    await vi.waitFor(() => expect(region.textContent).toContain("Instructions saved"));
    // A failure stays until it is closed, so it used to sit next to
    // "Instructions saved".
    expect(region.textContent).not.toContain("Could not save instructions");
  });

  it("keeps one agent's failure, naming them, when the next agent's instructions then save", async () => {
    mockAgentsApi.saveInstructionsFile.mockRejectedValueOnce(new Error("The instructions folder is read only."));
    await render();
    const region = liveRegion();

    await editAndSave("# New rules\n");
    await vi.waitFor(() => expect(region.textContent).toContain("Could not save instructions for Pat"));

    // On to the next agent, on the same tab, whose save works.
    await render(LEE);
    await flushReact();
    await editAndSave("# Lee's rules\n");
    await vi.waitFor(() => expect(region.textContent).toContain("Instructions saved"));

    expect(mockAgentsApi.saveInstructionsFile).toHaveBeenLastCalledWith(
      "agent-2",
      expect.objectContaining({ content: "# Lee's rules\n" }),
      "company-1",
    );
    // Lee's save used to take back Pat's failure, so Pat's unsaved edit
    // looked saved.
    expect(region.textContent).toContain("Could not save instructions for Pat");
    expect(region.textContent).toContain("The instructions folder is read only.");
  });

  it("takes back a failure said before the agent page was left once the same agent's instructions save", async () => {
    mockAgentsApi.saveInstructionsFile.mockRejectedValueOnce(new Error("The instructions folder is read only."));
    await render();
    const region = liveRegion();

    await editAndSave("# New rules\n");
    await vi.waitFor(() => expect(region.textContent).toContain("Could not save instructions for Pat"));

    // Off to another page and back to Pat, and the edit is saved again.
    await draw(null);
    await render();
    await editAndSave("# New rules\n");
    await vi.waitFor(() => expect(region.textContent).toContain("Instructions saved"));

    // It used to stay up beside "Instructions saved", as if Pat's
    // instructions had not saved.
    expect(region.textContent).not.toContain("Could not save instructions for Pat");
  });

  it("keeps the edit when the save fails, so the same edit can be saved again", async () => {
    mockAgentsApi.saveInstructionsFile.mockRejectedValueOnce(new Error("The instructions folder is read only."));
    await render();
    const region = liveRegion();

    await editAndSave("# New rules\n");

    await vi.waitFor(() => expect(region.textContent).toContain("Could not save instructions"));
    expect(editor()!.value).toBe("# New rules\n");
    expect(saving).toBe(false);
    // Still unsaved, so Save is still offered, and it sends the same edit.
    expect(saveAction).not.toBeNull();
    await act(async () => {
      saveAction!();
    });
    await flushReact();
    expect(mockAgentsApi.saveInstructionsFile).toHaveBeenCalledTimes(2);
    expect(mockAgentsApi.saveInstructionsFile.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ path: "AGENTS.md", content: "# New rules\n" }),
    );
  });

  it("keeps what was typed while the save was running", async () => {
    let finishSave: (file: typeof FILE) => void = () => {};
    mockAgentsApi.saveInstructionsFile.mockImplementationOnce(
      () => new Promise<typeof FILE>((resolve) => {
        finishSave = resolve;
      }),
    );
    await render();

    await editAndSave("# New rules\n");
    await act(async () => {
      setTextareaValue(editor()!, "# New rules\nOne more rule\n");
    });

    // The server takes the save, and the tab reloads what was saved.
    mockAgentsApi.instructionsFile.mockResolvedValue({ ...FILE, content: "# New rules\n" });
    await act(async () => {
      finishSave({ ...FILE, content: "# New rules\n" });
    });
    await flushReact();
    await flushReact();

    await vi.waitFor(() => expect(saving).toBe(false));
    expect(editor()!.value).toBe("# New rules\nOne more rule\n");
    // The line typed during the save is not saved yet, so Save is offered.
    expect(saveAction).not.toBeNull();
  });

  it("still starts another file from what is saved after a save, rather than from the draft of the file left", async () => {
    const contents: Record<string, string> = { "AGENTS.md": "# Old rules\n", "TOOLS.md": "# Tools\n" };
    mockAgentsApi.instructionsBundle.mockResolvedValue({
      ...BUNDLE,
      files: [
        ...BUNDLE.files,
        { path: "TOOLS.md", size: 8, isEntryFile: false, deprecated: false },
      ],
    });
    mockAgentsApi.instructionsFile.mockImplementation(async (_agentId: string, path: string) => ({
      path,
      content: contents[path],
      language: "markdown",
    }));
    mockAgentsApi.saveInstructionsFile.mockImplementation(
      async (_agentId: string, data: { path: string; content: string }) => {
        contents[data.path] = data.content;
        return { path: data.path, content: data.content };
      },
    );
    await render();
    const region = liveRegion();

    async function openFile(name: string) {
      const button = Array.from(container.querySelectorAll("button"))
        .find((candidate) => candidate.textContent?.trim() === name);
      expect(button, `no file row for ${name}`).not.toBeUndefined();
      await act(async () => {
        button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
    }

    await editAndSave("# New rules\n");
    await vi.waitFor(() => expect(region.textContent).toContain("Instructions saved"));

    await openFile("TOOLS.md");
    await vi.waitFor(() => expect(editor()?.value).toBe("# Tools\n"));
    await act(async () => {
      setTextareaValue(editor()!, "# Tools, not saved\n");
    });

    await openFile("AGENTS.md");
    await vi.waitFor(() => expect(editor()?.value).toBe("# New rules\n"));
  });

  it("says why an instructions file could not be deleted, where it used to say nothing", async () => {
    mockAgentsApi.instructionsBundle.mockResolvedValue({
      ...BUNDLE,
      files: [
        ...BUNDLE.files,
        { path: "TOOLS.md", size: 8, isEntryFile: false, deprecated: false },
      ],
    });
    mockAgentsApi.instructionsFile.mockImplementation(async (_agentId: string, path: string) => ({
      path,
      content: path === "TOOLS.md" ? "# Tools\n" : FILE.content,
      language: "markdown",
    }));
    mockAgentsApi.deleteInstructionsFile.mockRejectedValueOnce(new Error("TOOLS.md is in use."));
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      await render();
      const region = liveRegion();

      const toolsRow = Array.from(container.querySelectorAll("button"))
        .find((candidate) => candidate.textContent?.trim() === "TOOLS.md");
      await act(async () => {
        toolsRow!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      await flushReact();
      await vi.waitFor(() => expect(editor()?.value).toBe("# Tools\n"));
      const deleteButton = Array.from(container.querySelectorAll("button"))
        .find((candidate) => candidate.textContent?.trim() === "Delete");
      expect(deleteButton, "no Delete button for TOOLS.md").not.toBeUndefined();
      await act(async () => {
        deleteButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();

      expect(mockAgentsApi.deleteInstructionsFile).toHaveBeenCalledWith("agent-1", "TOOLS.md", "company-1");
      await vi.waitFor(() => expect(region.textContent).toContain("Could not delete TOOLS.md"));
      expect(region.textContent).toContain("TOOLS.md is in use.");
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("keeps a new instructions folder when saving it fails", async () => {
    mockAgentsApi.updateInstructionsBundle.mockRejectedValueOnce(new Error("That folder does not exist."));
    await render();
    const region = liveRegion();

    function buttonReading(text: string) {
      const button = Array.from(container.querySelectorAll("button"))
        .find((candidate) => candidate.textContent?.trim() === text);
      expect(button, `no button reading "${text}"`).not.toBeUndefined();
      return button as HTMLButtonElement;
    }
    function rootPathInput() {
      return container.querySelector<HTMLInputElement>('input[placeholder="/absolute/path/to/agent/prompts"]');
    }

    await act(async () => {
      buttonReading("Advanced").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      buttonReading("External").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => expect(rootPathInput()).not.toBeNull());
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(rootPathInput()!, "/srv/prompts");
      rootPathInput()!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(saveAction).not.toBeNull();
    await act(async () => {
      saveAction!();
    });
    await flushReact();

    await vi.waitFor(() => expect(region.textContent).toContain("Could not save instructions"));
    expect(mockAgentsApi.updateInstructionsBundle.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ mode: "external", rootPath: "/srv/prompts" }),
    );
    // Still external, with the folder that was typed.
    expect(rootPathInput()?.value).toBe("/srv/prompts");
    expect(saveAction).not.toBeNull();
  });
});
