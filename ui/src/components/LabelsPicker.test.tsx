// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IssueLabel } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LabelsPicker } from "./LabelsPicker";

const mockIssuesApi = vi.hoisted(() => ({
  listLabels: vi.fn(),
  createLabel: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div data-testid="popover">{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div data-testid="popover-content">{children}</div>,
}));

vi.mock("@/lib/color-contrast", () => ({
  pickTextColorForPillBg: () => "#fff",
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function createLabel(overrides: Partial<IssueLabel> = {}): IssueLabel {
  return {
    id: "label-1",
    companyId: "company-1",
    name: "Bug",
    color: "#ef4444",
    createdAt: new Date("2026-04-06T12:00:00.000Z"),
    updatedAt: new Date("2026-04-06T12:00:00.000Z"),
    ...overrides,
  };
}

describe("LabelsPicker", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockIssuesApi.listLabels.mockResolvedValue([createLabel(), createLabel({ id: "label-2", name: "Feature", color: "#10b981" })]);
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  function render(props: Partial<Parameters<typeof LabelsPicker>[0]>) {
    const root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <LabelsPicker
            companyId="company-1"
            labelIds={[]}
            onChange={vi.fn()}
            {...props}
          />
        </QueryClientProvider>,
      );
    });
    return root;
  }

  it("renders 'No labels' when none are selected", async () => {
    render({});
    await flush();
    expect(container.textContent).toContain("No labels");
  });

  it("renders selected label chips when labelIds are provided", async () => {
    const label = createLabel({ id: "label-1", name: "Bug" });
    render({ labelIds: ["label-1"], availableLabels: [label] });
    await flush();
    expect(container.textContent).toContain("Bug");
  });

  it("calls onChange with the toggled label id when a label is clicked", async () => {
    const labelA = createLabel({ id: "label-1", name: "Bug" });
    const labelB = createLabel({ id: "label-2", name: "Feature" });
    const onChange = vi.fn();
    render({ labelIds: ["label-1"], availableLabels: [labelA, labelB], onChange });
    await flush();
    const button = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("Feature"),
    );
    expect(button).toBeTruthy();
    act(() => {
      button!.click();
    });
    expect(onChange).toHaveBeenCalledWith(["label-1", "label-2"]);
  });
});
