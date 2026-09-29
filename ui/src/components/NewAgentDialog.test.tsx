// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewAgentDialog } from "./NewAgentDialog";

const dialogState = vi.hoisted(() => ({
  newAgentOpen: true,
  closeNewAgent: vi.fn(),
  openNewIssue: vi.fn(),
}));

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "hq" as string | null,
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/adapters", () => ({
  adaptersApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../adapters", () => ({
  listUIAdapters: () => [],
}));

vi.mock("../adapters/adapter-display-registry", () => ({
  getAdapterDisplay: () => ({ label: "", description: "", icon: () => null }),
}));

vi.mock("../adapters/use-disabled-adapters", () => ({
  useDisabledAdaptersSync: () => new Set<string>(),
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("NewAgentDialog", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    companyState.selectedCompanyId = "hq";
    dialogState.closeNewAgent.mockReset();
    dialogState.openNewIssue.mockReset();
    mockAgentsApi.list.mockResolvedValue([{ id: "ceo-1", role: "ceo" }]);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  // On a portfolio page no company is implied, so the new issue form asks
  // which one unless the opener names it. The CEO was looked up in the
  // selected company, so that is the company the request is for.
  it("asks the CEO in the company the CEO was found in", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <NewAgentDialog />
        </QueryClientProvider>,
      );
    });
    // The agents query resolves and re-renders over more than one tick; the
    // CEO is only known after that, and the click must come after it.
    await flush();
    await flush();
    await flush();

    const askButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Ask the CEO"));
    expect(askButton).not.toBeUndefined();
    await act(async () => {
      askButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockAgentsApi.list).toHaveBeenCalledWith("hq");
    expect(dialogState.openNewIssue).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: "hq", assigneeAgentId: "ceo-1" }),
    );

    act(() => root.unmount());
  });
});
