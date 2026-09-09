// @vitest-environment jsdom

/**
 * Covers the React stand-in module the host builds for plugin bundles.
 *
 * A plugin bundle imports React by name ("react"), which a browser cannot
 * resolve on its own, so the host swaps that import for a small module it
 * builds on the fly. If that module does not export a name the bundle asks
 * for, the browser refuses to link the bundle at all and the plugin registers
 * nothing. These tests import real generated modules through data URLs, so a
 * missing name fails here the same way it fails in a browser.
 */

import { act } from "react";
import * as React from "react";
import * as ReactDom from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/auth", () => ({
  authApi: { getSession: async () => null },
}));

const {
  PluginSlotMount,
  ensurePluginContributionLoaded,
  getPluginLoadFailure,
  resolveRegisteredPluginComponent,
  _resetPluginModuleLoader,
  _buildReactShimSourceForTests,
  _buildReactDomShimSourceForTests,
  _collectReactExportNamesForTests,
} = await import("./slots");

type Contribution = Parameters<typeof ensurePluginContributionLoaded>[0];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The loader turns generated source into a Blob and asks for an object URL.
 * jsdom hands back a blob: URL that Node's module loader cannot import, so
 * swap in a data: URL carrying the same source. Everything else about the
 * loader stays real, including the linking step under test.
 */
class SourceCarryingBlob {
  readonly source: string;
  constructor(parts: string[]) {
    this.source = parts.join("");
  }
}

function toDataUrl(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

function makeContribution(overrides: Partial<Contribution> = {}): Contribution {
  return {
    pluginId: "gbp-reviews",
    pluginKey: "gbp-reviews",
    displayName: "Google reviews",
    version: "0.1.10",
    updatedAt: `stamp-${Math.random().toString(36).slice(2)}`,
    uiEntryFile: "index.js",
    slots: [
      {
        type: "page",
        id: "reviews-page",
        displayName: "Reviews",
        exportName: "ReviewsPage",
      },
    ],
    launchers: [],
    ...overrides,
  } as Contribution;
}

function resolvedSlot(contribution: Contribution) {
  return {
    ...contribution.slots[0]!,
    pluginId: contribution.pluginId,
    pluginKey: contribution.pluginKey,
    pluginDisplayName: contribution.displayName,
    pluginVersion: contribution.version,
  };
}

describe("plugin React stand-in module", () => {
  let container: HTMLDivElement;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    globalThis.__paperclipPluginBridge__ = {
      react: React,
      reactDom: ReactDom,
      sdkUi: {},
    };

    vi.stubGlobal("Blob", SourceCarryingBlob);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: (blob: SourceCarryingBlob) => toDataUrl(blob.source),
      revokeObjectURL: () => {},
    });

    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    _resetPluginModuleLoader();
  });

  afterEach(() => {
    container.remove();
    consoleError.mockRestore();
    vi.unstubAllGlobals();
    delete globalThis.__paperclipPluginBridge__;
    _resetPluginModuleLoader();
    vi.restoreAllMocks();
  });

  /** Serves the given bundle source at whatever URL the loader asks for. */
  function serveBundle(source: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(source, { status: 200 })),
    );
  }

  async function renderSlot(contribution: Contribution) {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PluginSlotMount
            slot={resolvedSlot(contribution)}
            context={{ companyId: "company-1" }}
            missingBehavior="placeholder"
          />
        </QueryClientProvider>,
      );
    });
    return root;
  }

  // -------------------------------------------------------------------------
  // What the stand-in decides to export
  // -------------------------------------------------------------------------

  it("forwards every ordinary React name, not a hand written list", () => {
    const names = _collectReactExportNamesForTests(React);

    for (const name of [
      "useReducer",
      "useLayoutEffect",
      "useId",
      "useTransition",
      "useSyncExternalStore",
      "useImperativeHandle",
      "useState",
      "createElement",
      "Fragment",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("leaves out names that cannot legally be re-exported", () => {
    const names = _collectReactExportNamesForTests({
      useState: () => {},
      default: {},
      __esModule: true,
      "not-an-identifier": 1,
      "": 2,
    });

    expect(names).toContain("useState");
    expect(names).not.toContain("default");
    expect(names).not.toContain("__esModule");
    expect(names).not.toContain("not-an-identifier");
    expect(names).not.toContain("");
  });

  it("falls back to the names it always forwarded when React is missing", () => {
    const names = _collectReactExportNamesForTests(undefined);

    expect(names).toContain("useState");
    expect(names).toContain("createElement");
    expect(names).not.toContain("useReducer");
  });

  it("keeps a default export and stays valid when a React name is a keyword", async () => {
    const source = _buildReactShimSourceForTests({
      useState: () => "state",
      delete: () => "keyword named",
      class: 1,
    });

    expect(source).toContain("export default __pxModule");

    globalThis.__paperclipPluginBridge__ = {
      react: { useState: () => "state", delete: () => "keyword named", class: 1 },
      reactDom: ReactDom,
      sdkUi: {},
    };
    const mod = await import(/* @vite-ignore */ toDataUrl(source));
    expect(typeof mod.useState).toBe("function");
    expect(mod.delete()).toBe("keyword named");
    expect(mod.default).toBeTruthy();
  });

  it("keeps forwarding the react-dom names it always did, and adds the rest", async () => {
    const source = _buildReactDomShimSourceForTests(ReactDom);

    globalThis.__paperclipPluginBridge__ = { react: React, reactDom: ReactDom, sdkUi: {} };
    const mod = await import(/* @vite-ignore */ toDataUrl(source));

    // createRoot lives on react-dom/client, not on the object the bridge holds.
    // It has always come back undefined, and it must stay a name rather than
    // becoming a reason the whole bundle refuses to load.
    expect("createRoot" in mod).toBe(true);
    expect("hydrateRoot" in mod).toBe(true);
    expect(typeof mod.createPortal).toBe("function");
    expect(typeof mod.flushSync).toBe("function");
    expect(mod.default).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // The case that is broken today
  // -------------------------------------------------------------------------

  it("loads a bundle that imports useReducer, and renders it", async () => {
    serveBundle(`
      import { useReducer, createElement } from "react";
      export function ReviewsPage() {
        const [count] = useReducer((state) => state, 4);
        return createElement("div", { "data-testid": "reviews" }, "reviews: " + count);
      }
    `);

    const contribution = makeContribution();
    await ensurePluginContributionLoaded(contribution);

    expect(getPluginLoadFailure(contribution.pluginId)).toBeNull();
    expect(resolveRegisteredPluginComponent("gbp-reviews", "ReviewsPage")).toMatchObject({
      kind: "react",
    });

    await renderSlot(contribution);
    expect(container.textContent).toContain("reviews: 4");
    expect(container.querySelector("[data-testid='plugin-load-failure']")).toBeNull();
  });

  it("loads a bundle that uses the other React names the old list left out", async () => {
    serveBundle(`
      import { useId, useLayoutEffect, useTransition, useSyncExternalStore,
        useImperativeHandle, createElement } from "react";
      export function ReviewsPage() {
        const id = useId();
        useLayoutEffect(() => {}, []);
        useTransition();
        useSyncExternalStore(() => () => {}, () => "live", () => "live");
        useImperativeHandle(null, () => ({}), []);
        return createElement("div", null, "ready " + (typeof id === "string"));
      }
    `);

    const contribution = makeContribution();
    await ensurePluginContributionLoaded(contribution);

    await renderSlot(contribution);
    expect(container.textContent).toContain("ready true");
  });

  it("still loads bundles that only use the names the host always forwarded", async () => {
    serveBundle(`
      import { useState, useEffect, useMemo, useCallback, useRef, createElement,
        Fragment, memo, forwardRef } from "react";
      const Inner = memo(forwardRef(function Inner(props, ref) {
        return createElement("span", { ref }, props.label);
      }));
      export function ReviewsPage() {
        const [label] = useState("backup tools");
        const memoised = useMemo(() => label, [label]);
        const noop = useCallback(() => {}, []);
        const held = useRef(null);
        useEffect(() => { noop(); held.current = memoised; }, [noop, memoised]);
        return createElement(Fragment, null, createElement(Inner, { label: memoised }));
      }
    `);

    const contribution = makeContribution({
      pluginId: "backup-tools",
      pluginKey: "backup-tools",
      displayName: "Backup tools",
    });
    await ensurePluginContributionLoaded(contribution);

    await renderSlot(contribution);
    expect(container.textContent).toContain("backup tools");
    expect(getPluginLoadFailure("backup-tools")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // What a person sees when a bundle will not load
  // -------------------------------------------------------------------------

  it("says on screen that the plugin could not be loaded, and names it", async () => {
    serveBundle(`
      import { thisNameDoesNotExist, createElement } from "react";
      export function ReviewsPage() {
        return createElement("div", null, thisNameDoesNotExist());
      }
    `);

    const contribution = makeContribution();
    await ensurePluginContributionLoaded(contribution);

    expect(getPluginLoadFailure(contribution.pluginId)).toBeTruthy();
    expect(consoleError).toHaveBeenCalled();

    await renderSlot(contribution);

    const notice = container.querySelector("[data-testid='plugin-load-failure']");
    expect(notice).not.toBeNull();
    expect(notice?.getAttribute("role")).toBe("alert");
    expect(container.textContent).toContain("Google reviews could not be loaded");
    expect(container.textContent).toContain("Its page did not load");
    // The detail belongs in the console, not on screen.
    expect(container.textContent).not.toContain("does not provide an export");
  });

  it("says so for a failed bundle even where a missing slot would be hidden", async () => {
    serveBundle(`
      import { thisNameDoesNotExist } from "react";
      export const ReviewsPage = thisNameDoesNotExist;
    `);

    const contribution = makeContribution();
    await ensurePluginContributionLoaded(contribution);

    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PluginSlotMount
            slot={resolvedSlot(contribution)}
            context={{ companyId: "company-1" }}
            missingBehavior="hidden"
          />
        </QueryClientProvider>,
      );
    });

    expect(container.querySelector("[data-testid='plugin-load-failure']")).not.toBeNull();
  });

  it("shows the plain placeholder when nothing failed and the export is simply absent", async () => {
    serveBundle(`
      import { createElement } from "react";
      export function SomethingElse() { return createElement("div", null, "hi"); }
    `);

    const contribution = makeContribution();
    await ensurePluginContributionLoaded(contribution);

    expect(getPluginLoadFailure(contribution.pluginId)).toBeNull();

    await renderSlot(contribution);
    expect(container.querySelector("[data-testid='plugin-load-failure']")).toBeNull();
    expect(container.textContent).toContain("Google reviews: Reviews");
  });
});
