// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../context/ToastContext";
import { ToastViewport } from "../components/ToastViewport";
import { Pipelines } from "./Pipelines";

const mockNavigate = vi.hoisted(() => vi.fn());

const mockPipelinesApi = vi.hoisted(() => ({
  get: vi.fn(),
  getIntakeForm: vi.fn(),
  ingestCasesBatch: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname: "/pipelines/pipeline-1/add", search: "", hash: "" }),
  useNavigate: () => mockNavigate,
  useParams: () => ({ pipelineId: "pipeline-1" }),
}));

vi.mock("../api/pipelines", () => ({
  pipelinesApi: mockPipelinesApi,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

// The add page has no rich text, but the module brings in the editor through
// the board's other components, and the real one does not load in jsdom.
vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

const PIPELINE = {
  id: "pipeline-1",
  name: "Leads",
  stages: [{ id: "stage-1", name: "Inbox" }],
};

const INTAKE_FORM = {
  pipelineId: "pipeline-1",
  stageId: "stage-1",
  stageName: "Inbox",
  fields: [{ key: "title", label: "Title", type: "text", required: true }],
};

function created(title: string) {
  return { ok: true, created: true, case: { id: `case-${title}`, pipelineId: "pipeline-1", stageId: "stage-1", title } };
}

/**
 * The list is sent in one request, but the server adds each row on its own,
 * so some rows can go in while others fail. Only the rows that failed may be
 * sent again.
 */
describe("Pipelines, adding items in a batch", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockPipelinesApi.get.mockResolvedValue(PIPELINE);
    mockPipelinesApi.getIntakeForm.mockResolvedValue(INTAKE_FORM);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <Pipelines />
            <ToastViewport />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    await vi.waitFor(() => expect(container.textContent).toContain("Build your list"));
  }

  /** The message viewport's live region, taken before anything is submitted. */
  function liveRegion() {
    const region = container.querySelector('aside[aria-live="polite"]');
    expect(region, "the live region is on the page before the submit").not.toBeNull();
    return region as HTMLElement;
  }

  function titleInputs() {
    return Array.from(container.querySelectorAll<HTMLInputElement>("input#pipeline-intake-title"));
  }

  async function typeInto(input: HTMLInputElement, value: string) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function buttonStartingWith(text: string) {
    const button = Array.from(container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent?.trim().startsWith(text));
    expect(button, `no button reading "${text}..."`).not.toBeUndefined();
    return button as HTMLButtonElement;
  }

  async function click(button: HTMLElement) {
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
  }

  /** Fills the open first row, then adds, opens and fills one row per title after it. */
  async function fillRows(titles: string[]) {
    await typeInto(titleInputs()[0]!, titles[0]!);
    for (const title of titles.slice(1)) {
      await click(buttonStartingWith("Add another item"));
      await click(container.querySelector<HTMLButtonElement>('button[aria-label="Expand item"]')!);
      const inputs = titleInputs();
      await typeInto(inputs[inputs.length - 1]!, title);
    }
  }

  it("takes the rows that went in off the list, so Submit again sends only the one that failed", async () => {
    await render();
    const region = liveRegion();
    await fillRows(["Alpha", "Beta", "Gamma"]);

    mockPipelinesApi.ingestCasesBatch.mockResolvedValueOnce([
      created("Alpha"),
      { ok: false, caseKey: null, error: { status: 422, message: "Pipeline title is already taken" } },
      created("Gamma"),
    ]);
    await click(buttonStartingWith("Submit 3 items"));

    await vi.waitFor(() => expect(container.textContent).toContain("title is already taken"));
    // Alpha and Gamma are in the pipeline now, so they leave the list.
    expect(container.textContent).not.toContain("Alpha");
    expect(container.textContent).not.toContain("Gamma");
    expect(container.textContent).toContain("Beta");
    expect(mockNavigate).not.toHaveBeenCalled();
    // Said how many of the rows went in. Checked now, not at the end: a
    // "submitted" message fades after a few seconds, so a check at the end
    // only held when the test finished quickly.
    await vi.waitFor(() => expect(region.textContent).toContain("2 of 3 items submitted"));

    mockPipelinesApi.ingestCasesBatch.mockResolvedValueOnce([created("Beta")]);
    await click(buttonStartingWith("Submit 1 item"));

    await vi.waitFor(() => expect(mockPipelinesApi.ingestCasesBatch).toHaveBeenCalledTimes(2));
    expect(mockPipelinesApi.ingestCasesBatch.mock.calls[1]).toEqual([
      "pipeline-1",
      { items: [{ title: "Beta", fields: {} }] },
    ]);
    await vi.waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/pipelines/pipeline-1"));
    // The second submit said the rest went in.
    await vi.waitFor(() => expect(region.textContent).toContain("1 item submitted"));
  });

  it("says why when the whole batch is turned away, where it used to say nothing", async () => {
    await render();
    const region = liveRegion();
    await fillRows(["Alpha", "Beta"]);

    mockPipelinesApi.ingestCasesBatch.mockRejectedValueOnce(new Error("You cannot add items to this pipeline."));
    await click(buttonStartingWith("Submit 2 items"));

    await vi.waitFor(() => expect(region.textContent).toContain("Could not submit the items"));
    expect(region.textContent).toContain("You cannot add items to this pipeline.");
    // Nothing went in, so both rows are still there to try again.
    expect(container.textContent).toContain("Alpha");
    expect(container.textContent).toContain("Beta");
    expect(buttonStartingWith("Submit 2 items").disabled).toBe(false);
  });
});
