import { PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS } from "@paperclipai/shared";
import { isKnownPluginRouteRoot } from "./plugin-route-registry";

// The set of valid company-scoped route roots (what may legally follow
// /:companyPrefix/) comes from the same shared constant the server uses to
// stop a plugin manifest from claiming one of these names — see its comment
// in packages/shared/src/constants.ts for why these two concerns share one
// list, and docs/plans/2026-09-02-ux-control-center-preservation.md (B01)
// for the drift/double-prefix bugs that motivated unifying them. Keep it in
// sync with every top-level path segment registered inside boardRoutes() in
// App.tsx. Plugin-contributed routePath values (notepad, campaigns, ...)
// can never be listed here at compile time; those are recognized separately
// via plugin-route-registry.ts's runtime registry.
const BOARD_ROUTE_ROOTS = new Set<string>(PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS);

const GLOBAL_ROUTE_ROOTS = new Set([
  "auth",
  "invite",
  "board-claim",
  "cli-auth",
  "docs",
  "instance",
  // /clippy-popup is the pop-out drawer route registered at the top level
  // (outside the :companyPrefix parent). Without listing it here,
  // extractCompanyPrefixFromPath would mis-read "clippy-popup" as a company
  // slug and our Link wrapper would prefix every relative link inside the
  // popup with /CLIPPY-POPUP/ — e.g. /CLIPPY-POPUP/issues/IND-44.
  "clippy-popup",
]);

export function normalizeCompanyPrefix(prefix: string): string {
  return prefix.trim().toUpperCase();
}

function splitPath(path: string): { pathname: string; search: string; hash: string } {
  const match = path.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  return {
    pathname: match?.[1] ?? path,
    search: match?.[2] ?? "",
    hash: match?.[3] ?? "",
  };
}

function getRootSegment(pathname: string): string | null {
  const segment = pathname.split("/").filter(Boolean)[0];
  return segment ?? null;
}

export function isGlobalPath(pathname: string): boolean {
  if (pathname === "/") return true;
  const root = getRootSegment(pathname);
  if (!root) return true;
  return GLOBAL_ROUTE_ROOTS.has(root.toLowerCase());
}

export function isBoardPathWithoutPrefix(pathname: string): boolean {
  const root = getRootSegment(pathname);
  if (!root) return false;
  return BOARD_ROUTE_ROOTS.has(root.toLowerCase());
}

export function extractCompanyPrefixFromPath(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const first = segments[0]!.toLowerCase();
  // A bare (unprefixed) plugin route, e.g. "/notepad", must be recognized
  // here too — code-reviewed 2026-09-02: without this, applyCompanyPrefix
  // (which calls this function to check whether a path already has a
  // prefix) mistakes the plugin's own route slug for an unrecognized
  // company code and refuses to prepend the real one, so every link this
  // app generates to a plugin page (e.g. the Command Palette's "Plugins"
  // group) lands on a 404 instead of the page. toCompanyRelativePath below
  // got this same fix already; this function needed it just as much.
  if (GLOBAL_ROUTE_ROOTS.has(first) || BOARD_ROUTE_ROOTS.has(first) || isKnownPluginRouteRoot(first)) {
    return null;
  }
  return normalizeCompanyPrefix(segments[0]!);
}

export function applyCompanyPrefix(path: string, companyPrefix: string | null | undefined): string {
  const { pathname, search, hash } = splitPath(path);
  if (!pathname.startsWith("/")) return path;
  if (isGlobalPath(pathname)) return path;
  if (!companyPrefix) return path;

  const prefix = normalizeCompanyPrefix(companyPrefix);
  const activePrefix = extractCompanyPrefixFromPath(pathname);
  if (activePrefix) return path;

  return `/${prefix}${pathname}${search}${hash}`;
}

export function toCompanyRelativePath(path: string): string {
  const { pathname, search, hash } = splitPath(path);
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length >= 2) {
    const second = segments[1]!.toLowerCase();
    const looksLikeKnownRoute = BOARD_ROUTE_ROOTS.has(second) || isKnownPluginRouteRoot(second);
    if (!GLOBAL_ROUTE_ROOTS.has(segments[0]!.toLowerCase()) && looksLikeKnownRoute) {
      return `/${segments.slice(1).join("/")}${search}${hash}`;
    }
  }

  return `${pathname}${search}${hash}`;
}
