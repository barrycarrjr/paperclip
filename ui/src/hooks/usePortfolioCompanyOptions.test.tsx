// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Company } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  usePortfolioCompanyOptions,
  type CompanyFilterOption,
} from "./usePortfolioCompanyOptions";

const companyState = vi.hoisted(() => ({ companies: [] as Company[] }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ companies: companyState.companies }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function company(overrides: Partial<Company> & { id: string; name: string }): Company {
  return {
    status: "active",
    isPortfolioRoot: false,
    ...overrides,
  } as Company;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function readOptions(): CompanyFilterOption[] {
  let captured: CompanyFilterOption[] = [];
  function Probe() {
    captured = usePortfolioCompanyOptions();
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Probe />);
  });
  return captured;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  companyState.companies = [];
});

describe("usePortfolioCompanyOptions", () => {
  it("offers every non-archived company", () => {
    companyState.companies = [
      company({ id: "a", name: "Carr Rock Holdings" }),
      company({ id: "b", name: "Industry Bureau LLC" }),
      company({ id: "c", name: "C3 Media LLC" }),
    ];

    expect(readOptions().map((o) => o.label)).toEqual([
      "Carr Rock Holdings",
      "Industry Bureau LLC",
      "C3 Media LLC",
    ]);
  });

  it("puts the portfolio root first", () => {
    companyState.companies = [
      company({ id: "a", name: "Carr Rock Holdings" }),
      company({ id: "hq", name: "HQ", isPortfolioRoot: true }),
      company({ id: "b", name: "C3 Media LLC" }),
    ];

    expect(readOptions()[0].label).toBe("HQ");
  });

  it("leaves archived companies out", () => {
    companyState.companies = [
      company({ id: "a", name: "Carr Rock Holdings" }),
      company({ id: "z", name: "Old Co", status: "archived" }),
    ];

    expect(readOptions().map((o) => o.label)).toEqual(["Carr Rock Holdings"]);
  });

  it("does not shrink when the caller has filtered down to one company", () => {
    // The regression this exists for: the option list used to be built from
    // the page's own filtered response, so choosing one company left it as the
    // only choice and no second company could ever be added. This hook reads
    // the full company list, which no filter can narrow, so the menu is the
    // same size whatever is selected.
    companyState.companies = [
      company({ id: "a", name: "Carr Rock Holdings" }),
      company({ id: "b", name: "Industry Bureau LLC" }),
      company({ id: "c", name: "C3 Media LLC" }),
    ];

    const optionsWhileUnfiltered = readOptions();

    act(() => {
      root?.unmount();
    });
    container?.remove();

    // Same context, caller now filtering to one company: options are unchanged.
    const optionsWhileFiltered = readOptions();

    expect(optionsWhileFiltered).toHaveLength(3);
    expect(optionsWhileFiltered).toEqual(optionsWhileUnfiltered);
  });

  it("maps each option to the company id the filter sends to the server", () => {
    companyState.companies = [company({ id: "company-1", name: "Carr Rock Holdings" })];

    expect(readOptions()[0]).toEqual({ value: "company-1", label: "Carr Rock Holdings" });
  });
});
