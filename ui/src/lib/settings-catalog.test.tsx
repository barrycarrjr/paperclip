import type { ReactElement, ReactNode } from "react";
import { createRoutesFromElements, matchRoutes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import {
  SETTINGS_CATALOG,
  SETTINGS_SCOPE_COPY,
  settingsCatalogForScope,
  settingsSearchValue,
} from "./settings-catalog";
import { applyCompanyPrefix, isGlobalPath } from "./company-routes";
import { boardRoutes } from "../App";
import { InstanceSidebar } from "../components/InstanceSidebar";
import { CompanySettings } from "../pages/CompanySettings";
import { CompanyAccess } from "../pages/CompanyAccess";
import { CompanyInvites } from "../pages/CompanyInvites";
import { CompanySecrets } from "../pages/CompanySecrets";
import { CompanyExport } from "../pages/CompanyExport";
import { CompanyImport } from "../pages/CompanyImport";

const routes = createRoutesFromElements(boardRoutes());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pageAt(pathname: string): any {
  const matches = matchRoutes(routes, pathname);
  expect(matches, `no route matched ${pathname}`).not.toBeNull();
  const leaf = matches![matches!.length - 1]!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (leaf.route as any).element?.type;
}

/**
 * Walk a rendered-in-memory element tree collecting one prop from every node
 * that has it. No DOM: InstanceSidebar is a plain function returning
 * elements, so calling it is enough to read what it links to.
 */
function collectProps(node: ReactNode, out: { to: string; label: string }[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) collectProps(child as ReactNode, out);
    return;
  }
  const element = node as ReactElement<{ to?: string; label?: string; children?: ReactNode }>;
  const props = element.props ?? {};
  if (typeof props.to === "string" && typeof props.label === "string") {
    out.push({ to: props.to, label: props.label });
  }
  if (props.children) collectProps(props.children, out);
}

function instanceMenuEntries(): { to: string; label: string }[] {
  const out: { to: string; label: string }[] = [];
  collectProps(InstanceSidebar(), out);
  return out;
}

describe("SETTINGS_CATALOG", () => {
  it("has a unique id and a unique path per entry", () => {
    const ids = SETTINGS_CATALOG.map((entry) => entry.id);
    const paths = SETTINGS_CATALOG.map((entry) => entry.path);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("opens the real company settings screens, not a plugin route or a not-found", () => {
    // The catch-all and the plugin route in boardRoutes() mean a typo still
    // "matches" something, so each path is checked against the page it is
    // supposed to open rather than merely against there being a match.
    const expected: [string, unknown][] = [
      ["/company/settings", CompanySettings],
      ["/company/settings/access", CompanyAccess],
      ["/company/settings/invites", CompanyInvites],
      ["/company/settings/secrets", CompanySecrets],
      ["/company/export", CompanyExport],
      ["/company/import", CompanyImport],
    ];
    for (const [path, page] of expected) {
      expect(pageAt(path), path).toBe(page);
    }
    // And the list really is those six, so a new one cannot be added without
    // being checked here too.
    expect(settingsCatalogForScope("company").map((entry) => entry.path)).toEqual(
      expected.map(([path]) => path),
    );
  });

  it("keeps a company setting company-scoped and an instance setting global", () => {
    // This is the whole reason the two scopes are separate values rather than
    // a label: the Link wrapper adds the company prefix to one and must never
    // add it to the other. An instance page opened at /IND/instance/... would
    // be a 404, and a company page opened without the prefix would act on
    // whichever company happened to be selected.
    for (const entry of settingsCatalogForScope("company")) {
      expect(isGlobalPath(entry.path), entry.path).toBe(false);
      expect(applyCompanyPrefix(entry.path, "IND"), entry.path).toBe(`/IND${entry.path}`);
    }
    for (const entry of settingsCatalogForScope("instance")) {
      expect(isGlobalPath(entry.path), entry.path).toBe(true);
      expect(applyCompanyPrefix(entry.path, "IND"), entry.path).toBe(entry.path);
    }
  });

  it("lists only pages the Instance Settings menu itself offers, under the same names", () => {
    // Stops this list drifting from the real one. A wrong address here would
    // send someone to a settings page that does not exist, and a wrong name
    // would mean the same page is called two different things in two places.
    const menu = instanceMenuEntries();
    expect(menu.length).toBeGreaterThan(0);
    for (const entry of settingsCatalogForScope("instance")) {
      const match = menu.find((item) => item.to === entry.path);
      expect(match, entry.path).toBeDefined();
      expect(match!.label, entry.path).toBe(entry.label);
    }
  });

  it("leaves your own profile out, because it is not an instance-wide setting", () => {
    // Profile lives in the same menu but only ever changes your own account,
    // so listing it under "every company on this instance" would be a lie.
    // The account menu already offers it.
    expect(SETTINGS_CATALOG.some((entry) => entry.path.endsWith("/profile"))).toBe(false);
  });
});

describe("what each group says about itself", () => {
  it("says out loud that instance settings are not just this company", () => {
    expect(SETTINGS_SCOPE_COPY.instance.description.toLowerCase()).toContain("every company");
    expect(SETTINGS_SCOPE_COPY.company.description.toLowerCase()).toContain("company you are in");
    expect(SETTINGS_SCOPE_COPY.company.description).not.toBe(
      SETTINGS_SCOPE_COPY.instance.description,
    );
    expect(SETTINGS_SCOPE_COPY.company.rowNote).not.toBe(SETTINGS_SCOPE_COPY.instance.rowNote);
  });

  it("uses plain punctuation in everything a person reads", () => {
    const onScreen = [
      ...SETTINGS_CATALOG.map((entry) => entry.label),
      ...Object.values(SETTINGS_SCOPE_COPY).flatMap((copy) => [
        copy.title,
        copy.description,
        copy.rowNote,
      ]),
    ];
    for (const text of onScreen) {
      expect(text, text).not.toMatch(/[–—]/);
    }
  });
});

describe("settingsSearchValue", () => {
  it("tells the two pages called Access apart", () => {
    const company = settingsCatalogForScope("company").find((entry) => entry.label === "Access")!;
    const instance = settingsCatalogForScope("instance").find((entry) => entry.label === "Access")!;
    expect(company).toBeDefined();
    expect(instance).toBeDefined();
    expect(settingsSearchValue(company)).toContain("company settings");
    expect(settingsSearchValue(instance)).toContain("instance settings");
    expect(settingsSearchValue(company)).not.toBe(settingsSearchValue(instance));
  });

  it("matches the words someone would actually type", () => {
    const byId = (id: string) => SETTINGS_CATALOG.find((entry) => entry.id === id)!;
    expect(settingsSearchValue(byId("instance-external-mcp"))).toContain("mcp");
    expect(settingsSearchValue(byId("instance-plugins"))).toContain("add-ons");
    expect(settingsSearchValue(byId("company-secrets"))).toContain("credentials");
  });
});
