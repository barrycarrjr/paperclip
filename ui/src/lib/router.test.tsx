// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyRoutePrefixProvider, Link } from "./router";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { issuePrefix: "HQ" },
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("CompanyRoutePrefixProvider", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("routes links inside an embedded company view to that company instead of HQ", () => {
    act(() => {
      root.render(
        <MemoryRouter initialEntries={["/HQ/portfolio-agents"]}>
          <CompanyRoutePrefixProvider companyPrefix="acm">
            <Link to="/agents/operator">Operator</Link>
          </CompanyRoutePrefixProvider>
        </MemoryRouter>,
      );
    });

    expect(container.querySelector("a")?.getAttribute("href")).toBe("/ACM/agents/operator");
  });
});
