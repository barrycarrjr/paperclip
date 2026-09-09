import { afterEach, describe, expect, it } from "vitest";
import {
  _resetPluginRouteRegistryForTests,
  isKnownPluginRouteRoot,
  registerPluginRouteRoots,
} from "./plugin-route-registry";

describe("plugin route registry", () => {
  afterEach(() => {
    _resetPluginRouteRegistryForTests();
  });

  it("does not know about a route that was never registered", () => {
    expect(isKnownPluginRouteRoot("notepad")).toBe(false);
  });

  it("recognizes a registered route root case-insensitively", () => {
    registerPluginRouteRoots(["notepad", "Campaigns"]);
    expect(isKnownPluginRouteRoot("notepad")).toBe(true);
    expect(isKnownPluginRouteRoot("NOTEPAD")).toBe(true);
    expect(isKnownPluginRouteRoot("campaigns")).toBe(true);
  });

  it("accumulates across multiple registration calls instead of replacing", () => {
    registerPluginRouteRoots(["notepad"]);
    registerPluginRouteRoots(["campaigns"]);
    expect(isKnownPluginRouteRoot("notepad")).toBe(true);
    expect(isKnownPluginRouteRoot("campaigns")).toBe(true);
  });
});
