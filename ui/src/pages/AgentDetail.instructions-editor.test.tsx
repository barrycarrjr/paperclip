// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { $getRoot, $isTextNode, type LexicalEditor } from "lexical";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../context/ToastContext";
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
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
  files: [{ path: "AGENTS.md", size: 120, isEntryFile: true, deprecated: false }],
  warnings: [],
  legacyPromptTemplateActive: false,
  legacyBootstrapPromptTemplateActive: false,
};

// Written the way people write it, which is not how the editor writes
// markdown by default ("*" bullets, "1." numbers, "*" emphasis, "***" rules).
const INSTRUCTIONS = [
  "# Agent rules",
  "",
  "You are a _careful_ agent.",
  "",
  "- Always run the tests.",
  "- Never push to master.",
  "",
  "1) Read the issue.",
  "2) Fix it.",
  "",
  "---",
  "",
  "Ask when unsure.",
].join("\n");

// An instructions file that starts with YAML front matter, as AGENTS.md and
// references/COMPANY.md often do.
const COMPANY = [
  "---",
  "name: Acme Printing",
  "description: Printing and graphic design",
  "tags: [printing, design, mailing]",
  "---",
  "",
  "## Identity",
  "",
  "- Prints things.",
  "- Designs things.",
].join("\n");

/**
 * The Instructions tab with the real rich editor (the other PromptsTab tests
 * stand in for it), because the editor rewriting the file as it opened it is
 * what made the tab offer Save and Cancel before anything was edited.
 */
describe("PromptsTab, opening instructions in the rich editor", () => {
  let container: HTMLDivElement;
  let root: Root;
  let saveAction: (() => void) | null;
  let cancelAction: (() => void) | null;
  let dirtyChanges: boolean[];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    saveAction = null;
    cancelAction = null;
    dirtyChanges = [];
    mockAgentsApi.instructionsBundle.mockResolvedValue(BUNDLE);
    mockAgentsApi.instructionsFile.mockResolvedValue({ path: "AGENTS.md", content: INSTRUCTIONS, language: "markdown" });
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

  /** Draws the tab and waits for the file to show, by a line of it. */
  async function render(shownText = "Always run the tests.") {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      // StrictMode as in main.tsx: the rewrite reached the tab there.
      root.render(
        <StrictMode>
          <QueryClientProvider client={queryClient}>
            <ToastProvider>
              <TooltipProvider>
                <PromptsTab
                  agent={AGENT}
                  companyId="company-1"
                  onDirtyChange={(dirty) => dirtyChanges.push(dirty)}
                  onSaveActionChange={(save) => {
                    saveAction = save;
                  }}
                  onCancelActionChange={(cancel) => {
                    cancelAction = cancel;
                  }}
                  onSavingChange={() => {}}
                />
              </TooltipProvider>
            </ToastProvider>
          </QueryClientProvider>
        </StrictMode>,
      );
    });
    await flushReact();
    await vi.waitFor(() => expect(container.textContent).toContain(shownText));
    await flushReact();
  }

  function lexicalEditor() {
    const editable = container.querySelector('[contenteditable="true"]') as
      | (HTMLElement & { __lexicalEditor?: LexicalEditor })
      | null;
    expect(editable?.__lexicalEditor, "the rich editor is on the page").toBeDefined();
    return editable!.__lexicalEditor!;
  }

  it("does not offer Save or Cancel for instructions that were only opened", async () => {
    await render();

    expect(container.querySelector("textarea"), "the rich editor loaded").toBeNull();
    expect(dirtyChanges).not.toContain(true);
    expect(saveAction).toBeNull();
    expect(cancelAction).toBeNull();
  });

  it("offers Save after a real edit, and saves the file with its own markers", async () => {
    await render();

    // Typing " now" after the title.
    await act(async () => {
      lexicalEditor().update(() => {
        const title = $getRoot().getAllTextNodes()[0];
        if (!$isTextNode(title)) throw new Error("no title to type into");
        title.setTextContent(`${title.getTextContent()} now`);
      });
    });
    await flushReact();

    expect(dirtyChanges.at(-1)).toBe(true);
    expect(saveAction).not.toBeNull();
    await act(async () => {
      saveAction!();
    });
    await flushReact();

    expect(mockAgentsApi.saveInstructionsFile).toHaveBeenCalledTimes(1);
    expect(mockAgentsApi.saveInstructionsFile.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        path: "AGENTS.md",
        content: INSTRUCTIONS.replace("# Agent rules", "# Agent rules now"),
      }),
    );
  });

  describe("a file with front matter", () => {
    beforeEach(() => {
      mockAgentsApi.instructionsFile.mockResolvedValue({ path: "AGENTS.md", content: COMPANY, language: "markdown" });
    });

    function frontMatterBox() {
      return container.querySelector<HTMLElement>('[data-testid="front-matter"]');
    }

    async function save() {
      expect(saveAction, "Save is offered").not.toBeNull();
      await act(async () => {
        saveAction!();
      });
      await flushReact();
    }

    it("shows the front matter, and saves an edit with the front matter byte for byte", async () => {
      await render("Prints things.");
      expect(dirtyChanges).not.toContain(true);
      expect(saveAction).toBeNull();

      // Typing " now" after the first heading.
      await act(async () => {
        lexicalEditor().update(() => {
          const heading = $getRoot().getAllTextNodes()[0];
          if (!$isTextNode(heading)) throw new Error("no heading to type into");
          heading.setTextContent(`${heading.getTextContent()} now`);
        });
      });
      await flushReact();
      await save();

      // It used to save "***", then "tags: \[printing, design, mailing]" under
      // a line of dashes that made the YAML a heading.
      expect(mockAgentsApi.saveInstructionsFile.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({ path: "AGENTS.md", content: COMPANY.replace("## Identity", "## Identity now") }),
      );
      expect(frontMatterBox()?.textContent).toContain("tags: [printing, design, mailing]");
    });

    it("saves the front matter edited as text, with the rest of the file as it was", async () => {
      await render("Prints things.");

      const edit = Array.from(frontMatterBox()?.querySelectorAll("button") ?? []).find((button) => button.textContent === "Edit");
      expect(edit, "an Edit button for the front matter").toBeDefined();
      await act(async () => {
        edit!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      const yaml = frontMatterBox()!.querySelector("textarea")!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
        setter.call(yaml, "name: Acme Printing\ndescription: Printing, design and mailing\ntags: [printing, design, mailing]");
        yaml.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await flushReact();
      await save();

      expect(mockAgentsApi.saveInstructionsFile.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({
          path: "AGENTS.md",
          content: COMPANY.replace("description: Printing and graphic design", "description: Printing, design and mailing"),
        }),
      );
    });
  });
});
