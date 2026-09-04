import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceUnavailable } from "./WorkspaceUnavailable";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

describe("WorkspaceUnavailable", () => {
  it("names the workspace and says why it is not available", () => {
    const html = renderToStaticMarkup(
      <WorkspaceUnavailable
        title="Workspaces"
        reason="Isolated workspaces are switched off for this instance."
      />,
    );

    expect(html).toContain("Workspaces is not available here");
    expect(html).toContain("switched off for this instance");
  });

  it("offers the setting to someone who can change it", () => {
    const html = renderToStaticMarkup(
      <WorkspaceUnavailable
        title="Workspaces"
        reason="Switched off."
        whatToDo="Turn on isolated workspaces in the instance's experimental settings."
        actionHref="/instance/settings/experimental"
        actionLabel="Open experimental settings"
      />,
    );

    expect(html).toContain("/instance/settings/experimental");
    expect(html).toContain("Open experimental settings");
  });

  it("offers no link to someone who cannot act on it", () => {
    // A settings link shown to someone without the rights reads as "you did
    // this wrong", which is worse than saying who to ask.
    const html = renderToStaticMarkup(
      <WorkspaceUnavailable
        title="Workspaces"
        reason="Switched off."
        whatToDo="An instance administrator can turn this on in the experimental settings."
      />,
    );

    expect(html).not.toContain("<a");
    expect(html).toContain("An instance administrator can turn this on");
  });

  it("works with nothing to suggest", () => {
    const html = renderToStaticMarkup(
      <WorkspaceUnavailable title="Phone" reason="No PBX account covers this company." />,
    );

    expect(html).toContain("Phone is not available here");
    expect(html).not.toContain("<a");
  });
});
