// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarAccountMenu } from "./SidebarAccountMenu";
import { TooltipProvider } from "@/components/ui/tooltip";

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
  signInEmail: vi.fn(),
  signUpEmail: vi.fn(),
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
  signOut: vi.fn(),
}));
const mockSystemApi = vi.hoisted(() => ({
  shutdown: vi.fn(),
  restart: vi.fn(),
  update: vi.fn(),
  rebuild: vi.fn(),
  checkUpdate: vi.fn(),
}));
const mockToggleTheme = vi.hoisted(() => vi.fn());
const mockSetSidebarOpen = vi.hoisted(() => vi.fn());

vi.mock("@/api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("@/api/system", () => ({
  systemApi: mockSystemApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
    setSidebarOpen: mockSetSidebarOpen,
  }),
}));

vi.mock("../context/ThemeContext", () => ({
  useTheme: () => ({
    theme: "dark",
    toggleTheme: mockToggleTheme,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("SidebarAccountMenu", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        name: "Jane Example",
        email: "jane@example.com",
        image: "https://example.com/jane.png",
      },
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders the signed-in user and opens the account card menu", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
          <SidebarAccountMenu
            deploymentMode="authenticated"
            instanceSettingsTarget="/instance/settings/general"
            version="1.2.3"
          />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Jane Example");
    expect(container.textContent).not.toContain("jane@example.com");

    const trigger = container.querySelector('button[aria-label="Open account menu"]');
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    // View / Edit profile have been folded into the hero row: the whole
    // identity row links to View profile and a small pencil icon links to
    // Edit profile. Both have aria-labels; the visible "Edit profile" text
    // lives in a portalled TooltipContent that only mounts on hover.
    expect(document.body.querySelector('[aria-label="View profile"]')).not.toBeNull();
    expect(document.body.querySelector('[aria-label="Edit profile"]')).not.toBeNull();
    // Tooltip-only labels (Documentation, Update Paperclip, etc.) live in
    // portalled TooltipContent that only mounts on hover, so we look at the
    // trigger button's aria-label instead.
    expect(document.body.querySelector('[aria-label="Documentation"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Paperclip v1.2.3");
    expect(document.body.textContent).toContain("jane@example.com");

    // Don't call root.unmount() — Radix's popover/tooltip portals throw
    // NotFoundError under React 19 + jsdom. afterEach wipes document.body.
    void root;
  });

  // Skipped: this test opens the Popover, which under React 19 + jsdom + radix
  // throws AggregateError(NotFoundError) during portal cleanup that vitest
  // surfaces as a test failure even when assertions pass. The trigger-row hash
  // assertion is covered indirectly by the "renders an Update pill…" tests
  // (which assert hash hidden when updateAvailable, present otherwise).
  it.skip("renders the first 8 chars of the commit hash next to the user name", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
          <SidebarAccountMenu
            deploymentMode="authenticated"
            instanceSettingsTarget="/instance/settings/general"
            version="1.2.3"
            commit="9be597811d288770ab6722fad3e69aa40ebf4a64"
          />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const trigger = container.querySelector('button[aria-label="Open account menu"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain("9be59781");
    expect(trigger?.textContent).not.toContain("9be597811d288770");

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("Paperclip v1.2.3");
    expect(document.body.textContent).toContain("9be59781");

    // See note on the previous test.
    void root;
  });

  it("does not render an Update pill on the trigger row when no update is available", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
          <SidebarAccountMenu
            deploymentMode="authenticated"
            instanceSettingsTarget="/instance/settings/general"
            version="1.2.3"
            commit="9be597811d288770ab6722fad3e69aa40ebf4a64"
            updateAvailable={false}
          />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const updatePill = container.querySelector(
      'button[aria-label^="Update available"]',
    );
    expect(updatePill).toBeNull();
    // Hash still rendered when no update is available.
    const trigger = container.querySelector('button[aria-label="Open account menu"]');
    expect(trigger?.textContent).toContain("9be59781");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders an Update pill on the trigger row when an update is available", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
          <SidebarAccountMenu
            deploymentMode="authenticated"
            instanceSettingsTarget="/instance/settings/general"
            version="1.2.3"
            commit="9be597811d288770ab6722fad3e69aa40ebf4a64"
            updateAvailable={true}
          />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const updatePill = container.querySelector(
      'button[aria-label^="Update available"]',
    );
    expect(updatePill).not.toBeNull();
    expect(updatePill?.textContent).toContain("Update");
    // Hash is hidden on the trigger row to make room for the pill.
    const trigger = container.querySelector('button[aria-label="Open account menu"]');
    expect(trigger?.textContent).not.toContain("9be59781");

    await act(async () => {
      root.unmount();
    });
  });

  // The gap a real instance was found in: the checkout was level with GitHub but 28
  // commits ahead of the build that was actually running. Pulling would have
  // done nothing, so the pill has to offer the rebuild that does.
  it("offers Rebuild instead of Update when the build is the thing that is behind", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    mockSystemApi.rebuild.mockResolvedValue({ ok: true, action: "rebuild" });
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
          <SidebarAccountMenu
            deploymentMode="authenticated"
            instanceSettingsTarget="/instance/settings/general"
            version="1.2.3"
            commit="9be597811d288770ab6722fad3e69aa40ebf4a64"
            updateAvailable={true}
            updateReason="build_behind"
          />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const pill = container.querySelector('button[aria-label^="Downloaded but not built"]');
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toContain("Rebuild");
    expect(container.querySelector('button[aria-label^="Update available"]')).toBeNull();

    await act(async () => {
      pill?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(mockSystemApi.rebuild).toHaveBeenCalledOnce();
    expect(mockSystemApi.update).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
    await act(async () => {
      root.unmount();
    });
  });

  it("clicking the Update pill confirms then triggers systemApi.update without opening the popover", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    mockSystemApi.update.mockResolvedValue({ ok: true, action: "update" });

    const onOpenChange = vi.fn();
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
          <SidebarAccountMenu
            deploymentMode="authenticated"
            instanceSettingsTarget="/instance/settings/general"
            version="1.2.3"
            commit="9be597811d288770ab6722fad3e69aa40ebf4a64"
            updateAvailable={true}
            open={false}
            onOpenChange={onOpenChange}
          />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const updatePill = container.querySelector(
      'button[aria-label^="Update available"]',
    ) as HTMLButtonElement | null;
    expect(updatePill).not.toBeNull();

    await act(async () => {
      updatePill?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(mockSystemApi.update).toHaveBeenCalledTimes(1);
    // The popover trigger should not have been asked to open via the pill click.
    expect(onOpenChange).not.toHaveBeenCalledWith(true);

    confirmSpy.mockRestore();

    await act(async () => {
      root.unmount();
    });
  });

  it("does not call systemApi.update when the user cancels the confirm prompt", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    mockSystemApi.update.mockResolvedValue({ ok: true, action: "update" });

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
          <SidebarAccountMenu
            deploymentMode="authenticated"
            instanceSettingsTarget="/instance/settings/general"
            updateAvailable={true}
          />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const updatePill = container.querySelector(
      'button[aria-label^="Update available"]',
    ) as HTMLButtonElement | null;

    await act(async () => {
      updatePill?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(mockSystemApi.update).not.toHaveBeenCalled();

    confirmSpy.mockRestore();

    await act(async () => {
      root.unmount();
    });
  });

  // How this copy stands against GitHub. Only "behind" is a job; the rest are
  // things to say. The trigger row must never turn any of them into a button.
  describe("when this copy is not behind GitHub", () => {
    async function renderMenu(props: Record<string, unknown>) {
      const root = createRoot(container);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <TooltipProvider>
              <SidebarAccountMenu
                deploymentMode="authenticated"
                instanceSettingsTarget="/instance/settings/general"
                version="1.2.3"
                commit="9be597811d288770ab6722fad3e69aa40ebf4a64"
                {...props}
              />
            </TooltipProvider>
          </QueryClientProvider>,
        );
      });
      await flushReact();
      await flushReact();
      return root;
    }

    // The defect: a checkout ahead of GitHub used to be offered an update that
    // would have moved it backwards.
    it("shows a quiet Newer badge and no Update pill when this copy is ahead", async () => {
      const root = await renderMenu({ updateAvailable: false, remoteRelation: "ahead" });

      expect(container.querySelector('button[aria-label^="Update available"]')).toBeNull();
      expect(container.querySelector('button[aria-label^="Downloaded but not built"]')).toBeNull();

      const trigger = container.querySelector('button[aria-label="Open account menu"]');
      expect(trigger?.textContent).toContain("Newer");
      // The commit hash gives up its slot, so the row never carries both.
      expect(trigger?.textContent).not.toContain("9be59781");

      // A badge, not a button: there is nothing here to press.
      const badge = Array.from(container.querySelectorAll("span")).find(
        (el) => el.textContent === "Newer",
      );
      expect(badge).toBeDefined();
      expect(badge?.closest("button")?.getAttribute("aria-label")).toBe("Open account menu");
      expect(badge?.getAttribute("title")).toBe(
        "This copy is newer than GitHub. There is nothing to update.",
      );

      await act(async () => {
        root.unmount();
      });
    });

    it("shows a quiet Differs badge and no pill when the two have diverged", async () => {
      const root = await renderMenu({ updateAvailable: false, remoteRelation: "diverged" });

      expect(container.querySelector('button[aria-label^="Update available"]')).toBeNull();
      const trigger = container.querySelector('button[aria-label="Open account menu"]');
      expect(trigger?.textContent).toContain("Differs");

      const badge = Array.from(container.querySelectorAll("span")).find(
        (el) => el.textContent === "Differs",
      );
      expect(badge?.getAttribute("title")).toContain("would not be a simple move forward");

      await act(async () => {
        root.unmount();
      });
    });

    it("keeps the commit hash and says nothing when the two are level", async () => {
      const root = await renderMenu({ updateAvailable: false, remoteRelation: "level" });

      const trigger = container.querySelector('button[aria-label="Open account menu"]');
      expect(trigger?.textContent).toContain("9be59781");
      expect(trigger?.textContent).not.toContain("Newer");
      expect(trigger?.textContent).not.toContain("Differs");

      await act(async () => {
        root.unmount();
      });
    });

    // A direction we could not work out is not a state to announce. The row
    // looks exactly as it does when everything is fine, because claiming
    // anything else would be inventing it.
    it("says nothing when the direction could not be worked out", async () => {
      const root = await renderMenu({ updateAvailable: false, remoteRelation: "unknown" });

      const trigger = container.querySelector('button[aria-label="Open account menu"]');
      expect(trigger?.textContent).toContain("9be59781");
      expect(trigger?.textContent).not.toContain("Newer");
      expect(trigger?.textContent).not.toContain("Differs");
      expect(container.querySelector('button[aria-label^="Update available"]')).toBeNull();

      await act(async () => {
        root.unmount();
      });
    });

    it("says nothing on the row when GitHub has never seen this branch, and offers nothing", async () => {
      const root = await renderMenu({
        updateAvailable: false,
        remoteRelation: "no_remote_branch",
        trackedBranch: "ux-mockup-shell",
      });

      const trigger = container.querySelector('button[aria-label="Open account menu"]');
      expect(trigger?.textContent).not.toContain("Newer");
      expect(container.querySelector('button[aria-label^="Update available"]')).toBeNull();

      await act(async () => {
        root.unmount();
      });
    });

    // A copy running the working tree has no build to move forward, so the
    // Rebuild pill has nothing to offer and must not appear.
    it("shows no Rebuild pill on a copy that runs from the working tree", async () => {
      const root = await renderMenu({
        updateAvailable: false,
        runningFromSource: true,
        remoteRelation: "ahead",
      });

      expect(container.querySelector('button[aria-label^="Downloaded but not built"]')).toBeNull();
      expect(container.querySelector('button[aria-label^="Update available"]')).toBeNull();
      // The one slot on the trigger row still belongs to the GitHub answer.
      const trigger = container.querySelector('button[aria-label="Open account menu"]');
      expect(trigger?.textContent).toContain("Newer");

      await act(async () => {
        root.unmount();
      });
    });

    // Both can be true at once: newer than GitHub, and never built. The
    // rebuild is a real job so it keeps the pill; the badge stands down.
    it("keeps the Rebuild pill when this copy is ahead but was never built", async () => {
      const root = await renderMenu({
        updateAvailable: true,
        updateReason: "build_behind",
        remoteRelation: "ahead",
      });

      const pill = container.querySelector('button[aria-label^="Downloaded but not built"]');
      expect(pill).not.toBeNull();
      expect(pill?.textContent).toContain("Rebuild");
      expect(container.querySelector('button[aria-label^="Update available"]')).toBeNull();
      const trigger = container.querySelector('button[aria-label="Open account menu"]');
      expect(trigger?.textContent).not.toContain("Newer");

      await act(async () => {
        root.unmount();
      });
    });
  });

  // These read the popover, which is portalled into document.body, so they
  // leave the tree mounted for afterEach to wipe (see the note above about
  // Radix portal cleanup under React 19 and jsdom).
  describe("what the account card says about GitHub", () => {
    async function renderOpenMenu(props: Record<string, unknown>) {
      const root = createRoot(container);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <TooltipProvider>
              <SidebarAccountMenu
                deploymentMode="authenticated"
                instanceSettingsTarget="/instance/settings/general"
                version="1.2.3"
                open={true}
                {...props}
              />
            </TooltipProvider>
          </QueryClientProvider>,
        );
      });
      await flushReact();
      await flushReact();
      return root;
    }

    it("says this copy is newer, and does not offer an update", async () => {
      const root = await renderOpenMenu({ updateAvailable: false, remoteRelation: "ahead" });

      expect(document.body.textContent).toContain(
        "This copy is newer than GitHub, so there is nothing to update.",
      );
      expect(document.body.textContent).not.toContain("Update available.");
      void root;
    });

    it("says both sides have changed, and leaves the decision to a person", async () => {
      const root = await renderOpenMenu({ updateAvailable: false, remoteRelation: "diverged" });

      expect(document.body.textContent).toContain("This copy and GitHub have both changed");
      expect(document.body.textContent).toContain("no update is offered here");
      void root;
    });

    it("names the branch GitHub has never seen", async () => {
      const root = await renderOpenMenu({
        updateAvailable: false,
        remoteRelation: "no_remote_branch",
        trackedBranch: "ux-mockup-shell",
      });

      expect(document.body.textContent).toContain("GitHub has no branch called ux-mockup-shell");
      void root;
    });

    it("still says this copy is newer while offering the rebuild", async () => {
      const root = await renderOpenMenu({
        updateAvailable: true,
        updateReason: "build_behind",
        remoteRelation: "ahead",
      });

      expect(document.body.textContent).toContain("Downloaded but not built. Rebuild to run it.");
      expect(document.body.textContent).toContain(
        "This copy is newer than GitHub, so there is nothing to update.",
      );
      void root;
    });

    it("says nothing extra when the direction could not be worked out", async () => {
      const root = await renderOpenMenu({ updateAvailable: false, remoteRelation: "unknown" });

      expect(document.body.textContent).not.toContain("newer than GitHub");
      expect(document.body.textContent).not.toContain("have both changed");
      expect(document.body.textContent).not.toContain("has no branch called");
      void root;
    });

    it("says this copy runs from the working tree, and offers no rebuild", async () => {
      const root = await renderOpenMenu({ updateAvailable: false, runningFromSource: true });

      expect(document.body.textContent).toContain(
        "This copy runs straight from the working tree, so there is nothing to build.",
      );
      expect(document.body.textContent).not.toContain("Downloaded but not built");
      void root;
    });

    it("says nothing about the working tree on a copy that runs a build", async () => {
      const root = await renderOpenMenu({ updateAvailable: false });

      expect(document.body.textContent).not.toContain("runs straight from the working tree");
      void root;
    });

    // The real rebuild case is untouched: a built copy that was never rebuilt
    // still says so, and says nothing about a working tree it is not running.
    it("still says the build is behind on a copy that runs a build", async () => {
      const root = await renderOpenMenu({
        updateAvailable: true,
        updateReason: "build_behind",
        runningFromSource: false,
      });

      expect(document.body.textContent).toContain("Downloaded but not built. Rebuild to run it.");
      expect(document.body.textContent).not.toContain("runs straight from the working tree");
      void root;
    });
  });

});
