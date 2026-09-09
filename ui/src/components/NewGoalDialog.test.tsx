// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({
    children,
    showCloseButton: _showCloseButton,
    ...props
  }: ComponentProps<"div"> & { showCloseButton?: boolean }) => <div {...props}>{children}</div>,
}));

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
  // exact same element object, and these tests re-render on purpose.
  const draw = () =>
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <NewGoalDialog />
        </QueryClientProvider>,
      ),
    );
  draw();
  return { root, rerender: draw };
}

function typeIn(input: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickButtonWithText(container: HTMLDivElement, text: string) {
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
});
