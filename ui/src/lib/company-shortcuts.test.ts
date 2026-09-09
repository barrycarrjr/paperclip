import { describe, expect, it } from "vitest";
import {
  PHONE_LANDING_ROUTE_PATHS,
  resolveCompanyShortcuts,
  resolvePhoneShortcutPath,
} from "./company-shortcuts";

const NO_PHONE = { installedRoutePaths: [], coversCompany: false };
const PHONE_INSTALLED = {
  installedRoutePaths: ["notepad", "phone-active-calls", "phone-queues"],
  coversCompany: true,
};

function labels(shortcuts: { label: string }[]): string[] {
  return shortcuts.map((shortcut) => shortcut.label);
}

describe("resolveCompanyShortcuts", () => {
  it("offers the five the mockup shows, in that order", () => {
    const shortcuts = resolveCompanyShortcuts({
      isPortfolioRoot: false,
      hasMailbox: true,
      phone: PHONE_INSTALLED,
    });
    expect(labels(shortcuts)).toEqual(["Email", "Calendar", "Team", "Work", "Phone"]);
  });

  it("uses the names the rest of the app uses for the same pages", () => {
    // Not a restatement of the test above. These four are the names the menu,
    // the search box and each page's own heading settled on, and a shortcut
    // calling a destination something else would be its own small bug.
    const shortcuts = resolveCompanyShortcuts({
      isPortfolioRoot: false,
      hasMailbox: true,
      phone: PHONE_INSTALLED,
    });
    const byId = new Map(shortcuts.map((shortcut) => [shortcut.id, shortcut]));
    expect(byId.get("email")?.to).toBe("/email");
    expect(byId.get("calendar")?.to).toBe("/calendar");
    expect(byId.get("team")?.label).toBe("Team");
    expect(byId.get("team")?.to).toBe("/team");
    // Work and Team are each one page now, not five and three menu lines.
    expect(byId.get("work")?.label).toBe("Work");
    expect(byId.get("work")?.to).toBe("/work");
  });

  it("leaves Email out of a company with no mailbox", () => {
    const shortcuts = resolveCompanyShortcuts({
      isPortfolioRoot: false,
      hasMailbox: false,
      phone: NO_PHONE,
    });
    expect(labels(shortcuts)).toEqual(["Calendar", "Team", "Work"]);
  });

  it("leaves Email and Calendar out of HQ, the same way the menu does", () => {
    const shortcuts = resolveCompanyShortcuts({
      isPortfolioRoot: true,
      hasMailbox: true,
      phone: PHONE_INSTALLED,
    });
    expect(labels(shortcuts)).toEqual(["Team", "Work", "Phone"]);
  });

  it("leaves Phone out where the add-on is not installed", () => {
    const shortcuts = resolveCompanyShortcuts({
      isPortfolioRoot: false,
      hasMailbox: true,
      phone: NO_PHONE,
    });
    expect(labels(shortcuts)).not.toContain("Phone");
  });

  it("leaves Phone out where the add-on is installed but covers no phone account for this company", () => {
    const shortcuts = resolveCompanyShortcuts({
      isPortfolioRoot: false,
      hasMailbox: true,
      phone: { installedRoutePaths: ["phone-active-calls"], coversCompany: false },
    });
    expect(labels(shortcuts)).not.toContain("Phone");
  });
});

describe("resolvePhoneShortcutPath", () => {
  it("opens the first page the add-on's own menu opens", () => {
    expect(resolvePhoneShortcutPath(PHONE_INSTALLED)).toBe("/phone-active-calls");
  });

  it("falls back down the add-on's own order when the first page is missing", () => {
    expect(
      resolvePhoneShortcutPath({
        installedRoutePaths: ["recordings", "phone-call-history"],
        coversCompany: true,
      }),
    ).toBe("/phone-call-history");
  });

  it("gives nothing rather than a dead link when none of its pages are installed", () => {
    expect(
      resolvePhoneShortcutPath({ installedRoutePaths: ["notepad"], coversCompany: true }),
    ).toBeNull();
  });

  it("gives nothing when no phone account covers the company", () => {
    expect(
      resolvePhoneShortcutPath({ installedRoutePaths: PHONE_LANDING_ROUTE_PATHS, coversCompany: false }),
    ).toBeNull();
  });
});
