/**
 * Runtime registry of plugin-contributed page `routePath` slugs (e.g.
 * "notepad", "campaigns", "recordings"), so client-side route helpers can
 * recognize them as valid company-scoped route roots.
 *
 * Unlike core host routes (see `PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS` in
 * `@paperclipai/shared`, which `company-routes.ts` reads directly), plugin
 * routes cannot be known at compile time: a plugin can be installed —
 * contributing a brand-new `routePath` — without any change to this repo at
 * all. A hand-maintained static list would therefore be wrong by
 * construction, not just easy to forget; this registry is populated at
 * runtime from the same plugin UI contribution data the app already fetches
 * to render plugin pages and nav entries (see `useCompanyPageMemory.ts`,
 * which calls `registerPluginRouteRoots` whenever that data resolves).
 *
 * Known limitation: until the plugin contribution list has loaded at least
 * once this session, a plugin route won't be recognized here yet, so the
 * same double-prefix bug this exists to fix (B01,
 * docs/plans/2026-09-02-ux-control-center-preservation.md) can still show up
 * in the narrow window before that first load resolves. In practice that
 * window is short (a fraction of a second after a hard page load) and this
 * is a strict improvement over the previous state, where plugin routes were
 * never recognized at all.
 */
const knownPluginRouteRoots = new Set<string>();

export function registerPluginRouteRoots(routePaths: Iterable<string>): void {
  for (const routePath of routePaths) {
    knownPluginRouteRoots.add(routePath.toLowerCase());
  }
}

export function isKnownPluginRouteRoot(segment: string): boolean {
  return knownPluginRouteRoots.has(segment.toLowerCase());
}

/**
 * Reset registry state. Only use in tests.
 * @internal
 */
export function _resetPluginRouteRegistryForTests(): void {
  knownPluginRouteRoots.clear();
}
