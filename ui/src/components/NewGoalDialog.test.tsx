// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../context/ToastContext";
import { ToastViewport } from "./ToastViewport";
import { NewGoalDialog } from "./NewGoalDialog";

const PAPERCLIP = {
  id: "company-1",
  name: "Paperclip",
  status: "active",
  brandColor: "#123456",
  issuePrefix: "PAP",
};

const ACME = {
  id: "company-2",
  name: "Acme",
  status: "active",
  brandColor: "#654321",
  issuePrefix: "ACM",
};

const dialogState = vi.hoisted(() => ({
  newGoalOpen: true,
  newGoalDefaults: {} as Record<string, unknown>,
  closeNewGoal: vi.fn(),
}));

const companyState = vi.hoisted(() => ({
  companies: [] as Array<Record<string, unknown>>,
  selectedCompanyId: "company-1" as string | null,
  selectedCompany: null as Record<string, unknown> | null,
}));

const routeState = vi.hoisted(() => ({
  companyPrefix: "PAP" as string | undefined,
}));

const mockGoalsApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
}));

const mockAssetsApi = vi.hoisted(() => ({
  uploadImage: vi.fn(),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

// The dialog reads its company through useActiveCompanyId, which reads the
// company out of the web address. Standing in for the address here keeps the
// test honest about where the answer comes from.
vi.mock("@/lib/router", () => ({
  useParams: () => ({ companyPrefix: routeState.companyPrefix }),
}));

vi.mock("../api/goals", () => ({
  goalsApi: mockGoalsApi,
}));

vi.mock("../api/assets", () => ({
  assetsApi: mockAssetsApi,
}));

vi.mock("./MarkdownEditor", async () => {
  const React = await import("react");
  return {
    MarkdownEditor: React.forwardRef<
      { focus: () => void },
      { value: string; onChange?: (value: string) => void; placeholder?: string }
    >(function MarkdownEditorMock({ value, onChange, placeholder }, ref) {
      React.useImperativeHandle(ref, () => ({ focus: () => undefined }));
      return (
        <textarea
          aria-label={placeholder ?? "Description"}
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
        />
      );
    }),
  };
});

vi.mock("./StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

// Most tests here stand a plain box in for the dialog, so what it holds is
// drawn inside the test's container. The tests of closing it and of its title
// use the real one, since Escape and the title are the dialog library's own
// behaviour and a plain box has neither.
const dialogStandIn = vi.hoisted(() => ({ real: false }));

vi.mock("@/components/ui/dialog", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui/dialog")>("@/components/ui/dialog");
  return {
    Dialog: (props: ComponentProps<typeof actual.Dialog>) =>
      dialogStandIn.real ? <actual.Dialog {...props} /> : props.open ? <div>{props.children}</div> : null,
    DialogContent: (props: ComponentProps<typeof actual.DialogContent>) => {
      if (dialogStandIn.real) return <actual.DialogContent {...props} />;
      const { children, showCloseButton: _showCloseButton, ...rest } = props;
      return <div {...(rest as ComponentProps<"div">)}>{children}</div>;
    },
    DialogTitle: (props: ComponentProps<typeof actual.DialogTitle>) =>
      dialogStandIn.real ? <actual.DialogTitle {...props} /> : <h2 className={props.className}>{props.children}</h2>,
  };
});

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, type = "button", ...props }: ComponentProps<"button">) => (
    <button type={type} onClick={onClick} {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderDialog(container: HTMLDivElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const root = createRoot(container);
  // A fresh element every time: React skips the work when handed back the
  // exact same element object, and these tests re-render on purpose. The
  // message viewport stands in for the one the app has around every page.
  const draw = (withDialog = true) =>
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            {withDialog ? <NewGoalDialog /> : null}
            <ToastViewport />
          </ToastProvider>
        </QueryClientProvider>,
      ),
    );
  draw();
  return {
    root,
    rerender: () => draw(),
    // Takes the dialog off the page with the layout holding it, as browser
    // Back to a page outside that layout does, and leaves the rest.
    leavePage: () => draw(false),
  };
}

function messageRegion(container: HTMLDivElement) {
  const region = container.querySelector('aside[aria-live="polite"]');
  expect(region, "the message viewport is on the page").not.toBeNull();
  return region as HTMLElement;
}

function typeIn(input: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickButtonWithText(container: ParentNode, text: string) {
  const button = Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.textContent?.trim() === text);
  expect(button, `no button reading "${text}"`).not.toBeUndefined();
  return act(async () => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("NewGoalDialog", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    dialogStandIn.real = false;
    dialogState.newGoalOpen = true;
    dialogState.newGoalDefaults = {};
    dialogState.closeNewGoal.mockReset();
    companyState.companies = [PAPERCLIP, ACME];
    companyState.selectedCompanyId = "company-1";
    companyState.selectedCompany = PAPERCLIP;
    routeState.companyPrefix = "PAP";
    mockGoalsApi.list.mockReset();
    mockGoalsApi.create.mockReset();
    mockGoalsApi.list.mockResolvedValue([
      { id: "goal-1", title: "Grow revenue", status: "planned", level: "company" },
    ]);
    mockGoalsApi.create.mockResolvedValue({ id: "goal-2" });
    mockAssetsApi.uploadImage.mockResolvedValue({ contentPath: "/uploads/asset.png" });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    onlineManager.setOnline(true);
    vi.useRealTimers();
  });

  it("creates the goal in the company it was started in, not the one you switched to", async () => {
    const { root, rerender } = renderDialog(container);
    await flush();

    const titleInput = container.querySelector<HTMLInputElement>('input[placeholder="Goal title"]');
    expect(titleInput).not.toBeNull();
    typeIn(titleInput!, "Hire two writers");

    // Pick a parent goal that only exists in Paperclip.
    await clickButtonWithText(container, "Grow revenue");
    await flush();

    // The person changes company while the half filled form is still open.
    companyState.selectedCompanyId = "company-2";
    companyState.selectedCompany = ACME;
    routeState.companyPrefix = "ACM";
    rerender();
    await flush();

    expect(container.textContent).toContain("This goal will be saved in Paperclip, where you started it.");

    await clickButtonWithText(container, "Create goal");
    await flush();

    expect(mockGoalsApi.create).toHaveBeenCalledTimes(1);
    expect(mockGoalsApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ title: "Hire two writers", parentId: "goal-1" }),
    );

    act(() => root.unmount());
  });

  it("uses the company in the address when the selection has not caught up yet", async () => {
    // The first render after moving between companies: the address already
    // says Acme, the context selection is still Paperclip.
    routeState.companyPrefix = "ACM";
    companyState.selectedCompanyId = "company-1";
    companyState.selectedCompany = PAPERCLIP;

    const { root } = renderDialog(container);
    await flush();

    const titleInput = container.querySelector<HTMLInputElement>('input[placeholder="Goal title"]');
    typeIn(titleInput!, "Open a second shop");

    await clickButtonWithText(container, "Create goal");
    await flush();

    expect(mockGoalsApi.create).toHaveBeenCalledWith("company-2", expect.objectContaining({
      title: "Open a second shop",
    }));

    act(() => root.unmount());
  });

  it("starts again in the new company once the dialog has been closed and reopened", async () => {
    const { root, rerender } = renderDialog(container);
    await flush();

    dialogState.newGoalOpen = false;
    rerender();
    await flush();

    companyState.selectedCompanyId = "company-2";
    companyState.selectedCompany = ACME;
    routeState.companyPrefix = "ACM";
    dialogState.newGoalOpen = true;
    rerender();
    await flush();

    const titleInput = container.querySelector<HTMLInputElement>('input[placeholder="Goal title"]');
    typeIn(titleInput!, "Run a summer sale");

    await clickButtonWithText(container, "Create goal");
    await flush();

    expect(mockGoalsApi.create).toHaveBeenCalledWith("company-2", expect.objectContaining({
      title: "Run a summer sale",
    }));
    expect(container.textContent).not.toContain("where you started it");

    act(() => root.unmount());
  });

  it("says in the dialog why the goal could not be made, and keeps what was typed", async () => {
    mockGoalsApi.create.mockRejectedValueOnce(new Error("You do not have access to this company."));
    const { root } = renderDialog(container);
    await flush();
    const titleInput = container.querySelector<HTMLInputElement>('input[placeholder="Goal title"]')!;
    typeIn(titleInput, "Hire two writers");
    const statusBefore = container.querySelector('[role="status"]');

    await clickButtonWithText(container, "Create goal");
    await flush();

    expect(container.textContent).toContain("You do not have access to this company.");
    // Said in a line that was there before the failure, so a screen reader
    // hears it arrive.
    expect(statusBefore, "the status line is in the dialog before any failure").not.toBeNull();
    expect(statusBefore!.textContent).toBe("Could not create the goal. You do not have access to this company.");
    expect(dialogState.closeNewGoal).not.toHaveBeenCalled();
    expect(titleInput.value).toBe("Hire two writers");

    act(() => root.unmount());
  });

  it("makes one goal when Ctrl+Enter is pressed while the first is still being made", async () => {
    let finishCreate: (goal: { id: string }) => void = () => {};
    mockGoalsApi.create.mockReturnValueOnce(new Promise((resolve) => {
      finishCreate = resolve;
    }));
    const { root } = renderDialog(container);
    await flush();
    const titleInput = container.querySelector<HTMLInputElement>('input[placeholder="Goal title"]')!;
    typeIn(titleInput, "Hire two writers");

    await clickButtonWithText(container, "Create goal");
    await flush();
    await act(async () => {
      titleInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    });
    await flush();

    expect(mockGoalsApi.create).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishCreate({ id: "goal-2" });
    });
    await flush();
    expect(mockGoalsApi.create).toHaveBeenCalledTimes(1);
    expect(dialogState.closeNewGoal).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });

  /*
   * The dialog stays open until its create is done, but the layout holding it
   * can go first (browser Back to a page outside it). The create carries on,
   * and its answer has no dialog left to be said in.
   */

  it("says in a message why the goal could not be made once the page holding the dialog has gone", async () => {
    let failCreate: (error: Error) => void = () => {};
    mockGoalsApi.create.mockReturnValueOnce(new Promise((_resolve, reject) => {
      failCreate = reject;
    }));
    const { root, leavePage } = renderDialog(container);
    await flush();
    typeIn(container.querySelector<HTMLInputElement>('input[placeholder="Goal title"]')!, "Hire two writers");
    await clickButtonWithText(container, "Create goal");
    await flush();

    leavePage();
    await act(async () => {
      failCreate(new Error("You do not have access to this company."));
    });
    await flush();

    const region = messageRegion(container);
    expect(region.textContent).toContain("Could not create the goal");
    expect(region.textContent).toContain("You do not have access to this company.");

    act(() => root.unmount());
  });

  it("leaves the dialog shown on the next page alone when the goal before it is made", async () => {
    let finishCreate: (goal: { id: string }) => void = () => {};
    mockGoalsApi.create.mockReturnValueOnce(new Promise((resolve) => {
      finishCreate = resolve;
    }));
    const { root, rerender, leavePage } = renderDialog(container);
    await flush();
    typeIn(container.querySelector<HTMLInputElement>('input[placeholder="Goal title"]')!, "Hire two writers");
    await clickButtonWithText(container, "Create goal");
    await flush();

    // Left with the dialog open, so the next page shows it again, empty, and
    // it is half typed for the next goal when the first one is made.
    leavePage();
    rerender();
    await flush();
    const titleInput = container.querySelector<HTMLInputElement>('input[placeholder="Goal title"]')!;
    typeIn(titleInput, "Open a second shop");
    await act(async () => {
      finishCreate({ id: "goal-2" });
    });
    await flush();

    expect(mockGoalsApi.create).toHaveBeenCalledTimes(1);
    // The goal before it would close this one, as if it had made it.
    expect(dialogState.closeNewGoal).not.toHaveBeenCalled();
    expect(titleInput.value).toBe("Open a second shop");

    act(() => root.unmount());
  });

  describe("with the real dialog", () => {
    beforeEach(() => {
      dialogStandIn.real = true;
    });

    function dialog() {
      return document.querySelector<HTMLElement>('[role="dialog"]');
    }

    it("cannot be closed while the goal is being made", async () => {
      let failCreate: (error: Error) => void = () => {};
      mockGoalsApi.create.mockReturnValueOnce(new Promise((_resolve, reject) => {
        failCreate = reject;
      }));
      const { root } = renderDialog(container);
      await flush();
      const titleInput = document.querySelector<HTMLInputElement>('input[placeholder="Goal title"]')!;
      typeIn(titleInput, "Hire two writers");

      await clickButtonWithText(document.body, "Create goal");
      await flush();
      // Escape and the × do nothing now, so the dialog says what it is doing.
      expect(dialog()!.querySelector('[role="status"]')!.textContent).toBe("Creating the goal…");
      // Escape is the dialog's own way out. It used to clear the create, so a
      // failure after it was shown nowhere.
      await act(async () => {
        dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      await flush();
      expect(dialogState.closeNewGoal).not.toHaveBeenCalled();
      // The × in its corner is the other, and it is off.
      const close = document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
      expect(close.disabled).toBe(true);
      await act(async () => {
        close.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flush();

      expect(dialogState.closeNewGoal).not.toHaveBeenCalled();
      expect(titleInput.value).toBe("Hire two writers");

      // So when the create fails, the dialog is still there to say why.
      await act(async () => {
        failCreate(new Error("You do not have access to this company."));
      });
      await flush();
      expect(dialog()!.querySelector('[role="status"]')!.textContent).toBe(
        "Could not create the goal. You do not have access to this company.",
      );

      act(() => root.unmount());
    });

    it("stays open until the goal is made, while there is no connection and however long that takes", async () => {
      // It used to let go of a create sent while the browser said it was
      // offline, and of one that ran for twenty seconds. Closed and opened
      // again, the next try made the goal a second time.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
      let failCreate: (error: Error) => void = () => {};
      mockGoalsApi.create.mockReturnValueOnce(new Promise((_resolve, reject) => {
        failCreate = reject;
      }));
      const { root } = renderDialog(container);
      await flush();
      typeIn(document.querySelector<HTMLInputElement>('input[placeholder="Goal title"]')!, "Hire two writers");
      onlineManager.setOnline(false);

      await clickButtonWithText(document.body, "Create goal");
      await flush();

      async function expectHeldOpen() {
        expect(document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.disabled).toBe(true);
        expect(dialog()!.querySelector('[role="status"]')!.textContent).toBe("Creating the goal…");
        await act(async () => {
          dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        await flush();
        expect(dialogState.closeNewGoal).not.toHaveBeenCalled();
      }

      // Waiting for a connection.
      await expectHeldOpen();
      expect(mockGoalsApi.create).not.toHaveBeenCalled();
      // And a minute on.
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      await flush();
      await expectHeldOpen();

      // Back online, the goal is sent, and the server turns it down.
      await act(async () => {
        onlineManager.setOnline(true);
      });
      await flush();
      expect(mockGoalsApi.create).toHaveBeenCalledTimes(1);
      await act(async () => {
        failCreate(new Error("You do not have access to this company."));
      });
      await flush();
      expect(dialog()!.querySelector('[role="status"]')!.textContent).toBe(
        "Could not create the goal. You do not have access to this company.",
      );

      act(() => root.unmount());
    });

    it("is named by its title, so the dialog library has nothing to warn about", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { root } = renderDialog(container);
        await flush();

        const titleId = dialog()!.getAttribute("aria-labelledby");
        expect(titleId, "the dialog is labelled").toBeTruthy();
        expect(document.getElementById(titleId!)?.textContent).toBe("New goal");
        const libraryWarnings = [...errors.mock.calls, ...warnings.mock.calls]
          .map((call) => String(call[0]))
          .filter((message) => message.includes("DialogTitle") || message.includes("Description"));
        expect(libraryWarnings).toEqual([]);

        act(() => root.unmount());
      } finally {
        errors.mockRestore();
        warnings.mockRestore();
      }
    });
  });
});
