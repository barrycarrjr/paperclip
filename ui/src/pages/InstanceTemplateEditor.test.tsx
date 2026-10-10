// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ToastProvider } from "../context/ToastContext";
import { ToastViewport } from "../components/ToastViewport";
import { InstanceTemplateEditor } from "./InstanceTemplateEditor";

const routeState = vi.hoisted(() => ({ type: "routine" }));
const mockNavigate = vi.hoisted(() => vi.fn());

const mockTemplatesApi = vi.hoisted(() => ({
  getRoutine: vi.fn(),
  getSkill: vi.fn(),
  getAgent: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => mockNavigate,
  useParams: () => ({ type: routeState.type, id: "template-1" }),
}));

vi.mock("@/api/templates", () => ({
  templatesApi: mockTemplatesApi,
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/components/TemplateDeployDialog", () => ({
  TemplateDeployDialog: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

const DETAILS = {
  routine: {
    id: "template-1",
    name: "Daily digest",
    description: null,
    routineTitle: "Digest",
    routineDescription: null,
    priority: "medium",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    defaultAssigneeRole: null,
    triggers: [],
    deployments: [],
  },
  skill: {
    id: "template-1",
    name: "Daily digest",
    description: null,
    skillKey: "daily-digest",
    skillName: "Daily digest",
    skillDescription: null,
    markdown: "# Daily digest\n",
    deployments: [],
  },
  agent: {
    id: "template-1",
    name: "Daily digest",
    description: null,
    agentName: "Digest writer",
    role: "general",
    title: null,
    capabilities: null,
    adapterType: "process",
    budgetMonthlyCents: 0,
    deployments: [],
  },
};

/**
 * A template delete that works leaves the page. One that failed used to stay
 * on it with nothing said, as if the click had not happened.
 */
describe("InstanceTemplateEditor, deleting a template", () => {
  let container: HTMLDivElement;
  let root: Root;
  let confirmSpy: MockInstance<typeof window.confirm>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockTemplatesApi.getRoutine.mockResolvedValue(DETAILS.routine);
    mockTemplatesApi.getSkill.mockResolvedValue(DETAILS.skill);
    mockTemplatesApi.getAgent.mockResolvedValue(DETAILS.agent);
    confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    confirmSpy.mockRestore();
    vi.clearAllMocks();
  });

  it.each(["routine", "skill", "agent"] as const)("says why the %s template could not be deleted", async (type) => {
    routeState.type = type;
    mockTemplatesApi.remove.mockRejectedValueOnce(new Error("Two companies still use this template."));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <InstanceTemplateEditor />
            <ToastViewport />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await vi.waitFor(() => expect(container.textContent).toContain("Daily digest"));
    const region = container.querySelector('aside[aria-live="polite"]') as HTMLElement;
    expect(region, "the live region is on the page before the delete").not.toBeNull();

    const deleteButton = Array.from(container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent?.trim() === "Delete");
    expect(deleteButton, "no Delete button").not.toBeUndefined();
    await act(async () => {
      deleteButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockTemplatesApi.remove).toHaveBeenCalledWith(type, "template-1");
    await vi.waitFor(() => expect(region.textContent).toContain("Could not delete the template"));
    expect(region.textContent).toContain("Two companies still use this template.");
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
