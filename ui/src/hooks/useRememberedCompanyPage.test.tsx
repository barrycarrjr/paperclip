import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { useRememberedCompanyPage } from "./useRememberedCompanyPage";
import { writeRememberedCompanyPath } from "../lib/company-page-memory";

const acme = { id: "acme", issuePrefix: "ACME" };

function Probe({ currentPath }: { currentPath?: string }) {
  const page = useRememberedCompanyPage(acme, currentPath);
  return <span>{page ? `${page.to} as ${page.pageLabel ?? "unnamed"}` : "nothing to offer"}</span>;
}

function render(currentPath?: string) {
  return renderToStaticMarkup(<Probe currentPath={currentPath} />);
}

describe("useRememberedCompanyPage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("offers nothing when the company has never been open", () => {
    expect(render()).toContain("nothing to offer");
  });

  it("offers the page by the name the app gives it", () => {
    writeRememberedCompanyPath("acme", "/issues");
    expect(render()).toContain("/issues as Tasks");
  });

  it("keeps the search string, which is where the selection was", () => {
    writeRememberedCompanyPath("acme", "/email?uid=17");
    expect(render()).toContain("/email?uid=17 as Email");
  });

  it("drops a record that belonged to another company", () => {
    writeRememberedCompanyPath("acme", "/issues/HQ-4");
    expect(render()).toContain("/brief as Overview");
  });

  it("offers nothing when it would take you where you already are", () => {
    writeRememberedCompanyPath("acme", "/issues");
    expect(render("/ACME/issues")).toContain("nothing to offer");
  });
});
