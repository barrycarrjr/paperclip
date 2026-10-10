// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../context/ToastContext";
import { ToastViewport } from "./ToastViewport";
import { NewProjectDialog } from "./NewProjectDialog";

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
  newProjectOpen: true,
  closeNewProject: vi.fn(),
}));

const companyState = vi.hoisted(() => ({
  companies: [] as Array<Record<string, unknown>>,
  selectedCompanyId: "company-1" as string | null,
  selectedCompany: null as Record<string, unknown> | null,
}));

const routeState = vi.hoisted(() => ({
  companyPrefix: "PAP" as string | undefined,
}));

const mockProjectsApi = vi.hoisted(() => ({
  create: vi.fn(),
  createWorkspace: vi.fn(),
}));

const mockGoalsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockAccessApi = vi.hoisted(() => ({ listUserDirectory: vi.fn() }));
const mockAssetsApi = vi.hoisted(() => ({ uploadImage: vi.fn() }));

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

vi.mock("../api/projects", () => ({ projectsApi: mockProjectsApi }));
vi.mock("../api/goals", () => ({ goalsApi: mockGoalsApi }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/access", () => ({ accessApi: mockAccessApi }));
vi.mock("../api/assets", () => ({ assetsApi: mockAssetsApi }));

vi.mock("./MarkdownEditor", async () => {
  const React = await import("react");
  return {
    MarkdownEditor: React.forwardRef<
      { focus: () => void },
      { value: string; onChange?: (value: string) => void; placeholder?: string; readOnly?: boolean }
    >(function MarkdownEditorMock({ value, onChange, placeholder, readOnly }, ref) {
      React.useImperativeHandle(ref, () => ({ focus: () => undefined }));
      return (
        <textarea
          aria-label={placeholder ?? "Description"}
          value={value}
          readOnly={readOnly}
          onChange={(event) => onChange?.(event.target.value)}
        />
      );
    }),
  };
});

vi.mock("./StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("./PathInstructionsModal", () => ({
  ChoosePathButton: () => null,
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

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
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
            {withDialog ? <NewProjectDialog /> : null}
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

/** Everything the footer's button can say, depending on how far the create has got. */
const FOOTER_BUTTON_LABELS = ["Create project", "Creating…", "Add workspace", "Adding workspace…", "Done"];

/** The footer's button, whatever it says at the moment. */
function createButton(container: ParentNode) {
  const button = Array.from(container.querySelectorAll("button"))
    .find((candidate) => FOOTER_BUTTON_LABELS.includes(candidate.textContent?.trim() ?? ""));
  expect(button, "no footer button").not.toBeUndefined();
  return button as HTMLButtonElement;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("NewProjectDialog", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    dialogStandIn.real = false;
    dialogState.newProjectOpen = true;
    dialogState.closeNewProject.mockReset();
    companyState.companies = [PAPERCLIP, ACME];
    companyState.selectedCompanyId = "company-1";
    companyState.selectedCompany = PAPERCLIP;
    routeState.companyPrefix = "PAP";
    mockProjectsApi.create.mockReset();
    mockProjectsApi.createWorkspace.mockReset();
    mockProjectsApi.create.mockResolvedValue({ id: "project-1" });
    mockGoalsApi.list.mockReset();
    mockGoalsApi.list.mockResolvedValue([
      { id: "goal-1", title: "Grow revenue", status: "planned", level: "company" },
    ]);
    mockAgentsApi.list.mockResolvedValue([]);
    mockAccessApi.listUserDirectory.mockResolvedValue({ users: [] });
    mockAssetsApi.uploadImage.mockResolvedValue({ contentPath: "/uploads/asset.png" });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("creates the project in the company it was started in, not the one you switched to", async () => {
    const { root, rerender } = renderDialog(container);
    await flush();

    const nameInput = container.querySelector<HTMLInputElement>('input[placeholder="Project name"]');
    expect(nameInput).not.toBeNull();
    typeIn(nameInput!, "Website refresh");

    // Link a goal that only exists in Paperclip.
    await clickButtonWithText(container, "Grow revenue");
    await flush();

    // The person changes company while the half filled form is still open.
    companyState.selectedCompanyId = "company-2";
    companyState.selectedCompany = ACME;
    routeState.companyPrefix = "ACM";
    rerender();
    await flush();

    expect(container.textContent).toContain("This project will be saved in Paperclip, where you started it.");

    await clickButtonWithText(container, "Create project");
    await flush();

    expect(mockProjectsApi.create).toHaveBeenCalledTimes(1);
    expect(mockProjectsApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ name: "Website refresh", goalIds: ["goal-1"] }),
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

    const nameInput = container.querySelector<HTMLInputElement>('input[placeholder="Project name"]');
    typeIn(nameInput!, "Shop fit out");

    await clickButtonWithText(container, "Create project");
    await flush();

    expect(mockProjectsApi.create).toHaveBeenCalledWith("company-2", expect.objectContaining({
      name: "Shop fit out",
    }));

    act(() => root.unmount());
  });

  /** Types a name and a local folder, so a create has both of its steps. */
  async function fillNameAndFolder(container: HTMLDivElement, name: string) {
    await flush();
    typeIn(container.querySelector<HTMLInputElement>('input[placeholder="Project name"]')!, name);
    typeIn(container.querySelector<HTMLInputElement>('input[placeholder="/absolute/path/to/workspace"]')!, "/srv/site");
  }

  function statusLine(container: HTMLDivElement) {
    const status = container.querySelector('[role="status"]');
    expect(status, "the dialog has a status line for failures").not.toBeNull();
    return status as HTMLElement;
  }

  it("makes one project however often Create is pressed while the first is being made", async () => {
    const projectMade = deferred<{ id: string }>();
    const workspaceAdded = deferred<{ id: string }>();
    mockProjectsApi.create.mockReturnValueOnce(projectMade.promise);
    mockProjectsApi.createWorkspace.mockReturnValueOnce(workspaceAdded.promise);
    const { root } = renderDialog(container);
    await fillNameAndFolder(container, "Website refresh");

    await act(async () => {
      createButton(container).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    // Ctrl+Enter while the project is still being made.
    await act(async () => {
      container.querySelector('input[placeholder="Project name"]')!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
      );
    });
    await flush();
    expect(mockProjectsApi.create).toHaveBeenCalledTimes(1);

    // The project is made, its workspace is still being added.
    await act(async () => {
      projectMade.resolve({ id: "project-1" });
    });
    await flush();
    await act(async () => {
      createButton(container).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(mockProjectsApi.create).toHaveBeenCalledTimes(1);

    await act(async () => {
      workspaceAdded.resolve({ id: "workspace-1" });
    });
    await flush();
    expect(mockProjectsApi.create).toHaveBeenCalledTimes(1);
    expect(dialogState.closeNewProject).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });

  it("adds the workspace to the same project on the next try when adding it failed, and says so in the dialog", async () => {
    mockProjectsApi.createWorkspace.mockRejectedValueOnce(new Error("That folder is not readable."));
    const { root } = renderDialog(container);
    await fillNameAndFolder(container, "Website refresh");

    await clickButtonWithText(container, "Create project");
    await flush();

    expect(dialogState.closeNewProject).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Project name"]')!.value).toBe("Website refresh");
    const shownAfterFailure = container.textContent;

    mockProjectsApi.createWorkspace.mockResolvedValueOnce({ id: "workspace-1" });
    await clickButtonWithText(container, "Add workspace");
    await flush();

    // One project, with its workspace added on the second try.
    expect(mockProjectsApi.create).toHaveBeenCalledTimes(1);
    expect(mockProjectsApi.createWorkspace).toHaveBeenCalledTimes(2);
    expect(mockProjectsApi.createWorkspace).toHaveBeenLastCalledWith(
      "project-1",
      expect.objectContaining({ cwd: "/srv/site" }),
    );
    expect(dialogState.closeNewProject).toHaveBeenCalledTimes(1);
    expect(shownAfterFailure).toContain(
      "The project was created, but its workspace was not added. That folder is not readable.",
    );

    act(() => root.unmount());
  });

  it("says in the dialog why the project could not be made, and keeps what was typed", async () => {
    mockProjectsApi.create.mockRejectedValueOnce(new Error("A project with that name already exists."));
    const { root } = renderDialog(container);
    await fillNameAndFolder(container, "Website refresh");
    const statusBefore = container.querySelector('[role="status"]');

    await clickButtonWithText(container, "Create project");
    await flush();

    expect(container.textContent).toContain("A project with that name already exists.");
    // Said in a line that was there before the failure, so a screen reader
    // hears it arrive.
    expect(statusBefore, "the status line is in the dialog before any failure").not.toBeNull();
    expect(statusBefore).toBe(statusLine(container));
    expect(statusBefore!.textContent).toBe(
      "Could not create the project. A project with that name already exists.",
    );
    expect(dialogState.closeNewProject).not.toHaveBeenCalled();
    expect(mockProjectsApi.createWorkspace).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Project name"]')!.value).toBe("Website refresh");

    act(() => root.unmount());
  });

  it("locks the project's own fields once it is made, and the button says it adds the workspace", async () => {
    mockProjectsApi.createWorkspace.mockRejectedValueOnce(new Error("That folder is not readable."));
    const { root } = renderDialog(container);
    await fillNameAndFolder(container, "Website refresh");

    await clickButtonWithText(container, "Create project");
    await flush();

    // Trying again only adds the workspace, so an edit to the project itself
    // would go nowhere. It used to be allowed, and dropped without a word.
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Project name"]')!.readOnly).toBe(true);
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add description..."]')!.readOnly).toBe(true);
    const buttonReading = (text: string) =>
      Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === text);
    expect(buttonReading("planned")?.disabled, "the status").toBe(true);
    expect(buttonReading("Goal")?.disabled, "the goal").toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[type="date"]')!.disabled).toBe(true);
    // The workspace is what is left to do, so it can still be changed.
    const folder = container.querySelector<HTMLInputElement>('input[placeholder="/absolute/path/to/workspace"]')!;
    expect(folder.readOnly || folder.disabled).toBe(false);
    expect(createButton(container).textContent).toBe("Add workspace");

    // With the workspace emptied, the button only finishes.
    typeIn(folder, "");
    expect(createButton(container).textContent).toBe("Done");
    typeIn(folder, "/srv/site");
    expect(createButton(container).textContent).toBe("Add workspace");

    mockProjectsApi.createWorkspace.mockResolvedValueOnce({ id: "workspace-1" });
    await clickButtonWithText(container, "Add workspace");
    await flush();

    expect(mockProjectsApi.create).toHaveBeenCalledTimes(1);
    expect(mockProjectsApi.createWorkspace).toHaveBeenLastCalledWith(
      "project-1",
      expect.objectContaining({ cwd: "/srv/site" }),
    );
    expect(dialogState.closeNewProject).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });

  /*
   * The dialog stays open until its create is done, but the layout holding it
   * can go first (browser Back to a page outside it). The create carries on,
   * and its answer has no dialog left to be said in.
   */

  it("says in a message that the project was made but not its workspace, once the page holding the dialog has gone", async () => {
    const workspaceAdded = deferred<{ id: string }>();
    mockProjectsApi.createWorkspace.mockReturnValueOnce(workspaceAdded.promise);
    const { root, leavePage } = renderDialog(container);
    await fillNameAndFolder(container, "Website refresh");
    await clickButtonWithText(container, "Create project");
    await flush();
    expect(statusLine(container).textContent).toBe("Adding the workspace…");

    leavePage();
    await act(async () => {
      workspaceAdded.reject(new Error("That folder is not readable."));
    });
    await flush();

    // Not "Could not create the project": it was, and it is in the list.
    const region = messageRegion(container);
    expect(region.textContent).toContain("The project was created, but its workspace was not added");
    expect(region.textContent).toContain("That folder is not readable.");
    expect(mockProjectsApi.create).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });

  it("leaves the dialog shown on the next page alone when the project before it is made", async () => {
    const projectMade = deferred<{ id: string }>();
    mockProjectsApi.create.mockReturnValueOnce(projectMade.promise);
    const { root, rerender, leavePage } = renderDialog(container);
    await flush();
    typeIn(container.querySelector<HTMLInputElement>('input[placeholder="Project name"]')!, "Website refresh");
    await clickButtonWithText(container, "Create project");
    await flush();

    // Left with the dialog open, so the next page shows it again, empty, and
    // it is half typed for the next project when the first one is made.
    leavePage();
    rerender();
    await flush();
    const nameInput = container.querySelector<HTMLInputElement>('input[placeholder="Project name"]')!;
    typeIn(nameInput, "Shop fit out");
    await act(async () => {
      projectMade.resolve({ id: "project-1" });
    });
    await flush();

    expect(mockProjectsApi.create).toHaveBeenCalledTimes(1);
    // The project before it would close this one, as if it had made it.
    expect(dialogState.closeNewProject).not.toHaveBeenCalled();
    expect(nameInput.value).toBe("Shop fit out");
    expect(nameInput.readOnly).toBe(false);
    expect(createButton(container).textContent).toBe("Create project");

    act(() => root.unmount());
  });

  describe("with the real dialog", () => {
    beforeEach(() => {
      dialogStandIn.real = true;
    });

    function dialog() {
      return document.querySelector<HTMLElement>('[role="dialog"]');
    }

    it("cannot be closed while the project is being made", async () => {
      const projectMade = deferred<{ id: string }>();
      mockProjectsApi.create.mockReturnValueOnce(projectMade.promise);
      const { root } = renderDialog(container);
      await flush();
      const nameInput = document.querySelector<HTMLInputElement>('input[placeholder="Project name"]')!;
      typeIn(nameInput, "Website refresh");

      await clickButtonWithText(document.body, "Create project");
      await flush();
      // Escape and the × do nothing now, so the dialog says what it is doing.
      expect(dialog()!.querySelector('[role="status"]')!.textContent).toBe("Creating the project…");
      // Escape is the dialog's own way out.
      await act(async () => {
        dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      await flush();
      expect(dialogState.closeNewProject).not.toHaveBeenCalled();
      // The × in its corner is the other, and it is off.
      const close = document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
      expect(close.disabled).toBe(true);
      await act(async () => {
        close.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flush();

      expect(dialogState.closeNewProject).not.toHaveBeenCalled();
      expect(nameInput.value).toBe("Website refresh");

      // So when the create fails, the dialog is still there to say why.
      await act(async () => {
        projectMade.reject(new Error("A project with that name already exists."));
      });
      await flush();
      expect(dialog()!.querySelector('[role="status"]')!.textContent).toBe(
        "Could not create the project. A project with that name already exists.",
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
        expect(document.getElementById(titleId!)?.textContent).toBe("New project");
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
