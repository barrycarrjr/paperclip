// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCompanyPageMemory } from "./useCompanyPageMemory";
import { writeRememberedCompanyPath } from "../lib/company-page-memory";

const hq = {
  id: "hq",
  name: "HQ",
  issuePrefix: "HQ",
  isPortfolioRoot: true,
  status: "active",
};
const acme = {
  id: "acme",
  name: "Acme",
  issuePrefix: "ACME",
  isPortfolioRoot: false,
  status: "active",
};

const state = vi.hoisted(() => ({
  pathname: "/HQ/issues",
  search: "",
  selectedCompanyId: "hq",
  selectionSource: "manual" as string,
}));

const mockNavigate = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: state.pathname, search: state.search, hash: "", state: null }),
  useNavigate: () => mockNavigate,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [hq, acme],
    selectedCompanyId: state.selectedCompanyId,
    selectedCompany: state.selectedCompanyId === "hq" ? hq : acme,
    selectionSource: state.selectionSource,
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: mockPushToast }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined }),
}));

vi.mock("../api/plugins", () => ({
  pluginsApi: { listUiContributions: vi.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  useCompanyPageMemory();
  return <div>probe</div>;
}

let container: HTMLDivElement;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let root: any;

async function mount() {
  root = createRoot(container);
  await act(async () => {
    root.render(<Probe />);
  });
}

async function pickCompany(companyId: string, source = "manual") {
  state.selectedCompanyId = companyId;
  state.selectionSource = source;
  await act(async () => {
    root.render(<Probe />);
  });
}

function lastToast() {
  return mockPushToast.mock.calls[mockPushToast.mock.calls.length - 1]?.[0];
}

describe("changing company", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
    mockNavigate.mockClear();
    mockPushToast.mockClear();
    state.pathname = "/HQ/issues";
    state.search = "";
    state.selectedCompanyId = "hq";
    state.selectionSource = "manual";
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container.remove();
  });

  it("keeps you on the same page", async () => {
    await mount();
    await pickCompany("acme");

    expect(mockNavigate).toHaveBeenCalledWith("/ACME/issues", { replace: true });
    expect(lastToast()).toMatchObject({
      id: "company-switch",
      title: "Now in Acme",
      body: "Kept you on Tasks.",
      ttlMs: 5000,
    });
  });

  it("leaves the previous company's record behind and says so", async () => {
    state.pathname = "/HQ/issues/HQ-12";
    await mount();
    await pickCompany("acme");

    expect(mockNavigate).toHaveBeenCalledWith("/ACME/issues", { replace: true });
    expect(lastToast().body).toBe("Opened Tasks. The task you had open belongs to HQ.");
  });

  it("swaps an all company page it cannot open for that company's own one", async () => {
    state.pathname = "/HQ/portfolio-costs";
    await mount();
    await pickCompany("acme");

    expect(mockNavigate).toHaveBeenCalledWith("/ACME/costs", { replace: true });
    expect(lastToast().body).toContain("this is Acme's own Costs");
  });

  it("offers the remembered page instead of going there on its own", async () => {
    writeRememberedCompanyPath("acme", "/calendar");
    await mount();
    await pickCompany("acme");

    expect(mockNavigate).toHaveBeenCalledWith("/ACME/issues", { replace: true });
    expect(lastToast().action).toEqual({
      label: "Go to where you left off",
      href: "/ACME/calendar",
    });
  });

  it("does not offer a remembered page that is where you already landed", async () => {
    writeRememberedCompanyPath("acme", "/issues");
    await mount();
    await pickCompany("acme");

    expect(lastToast().action).toBeUndefined();
  });

  it("leaves a clicked shortcut alone, because it already knows where it is going", async () => {
    await mount();
    await pickCompany("acme", "shortcut");

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockPushToast).not.toHaveBeenCalled();
  });

  it("still records the page each company had open", async () => {
    await mount();
    expect(localStorage.getItem("paperclip.companyPaths")).toContain("/issues");
  });
});
