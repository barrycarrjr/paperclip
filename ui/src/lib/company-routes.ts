const BOARD_ROUTE_ROOTS = new Set([
  "brief",
  "receipts",
  "dashboard",
  "companies",
  "company",
  "skills",
  "org",
  "agents",
  "projects",
  "workspaces",
  "execution-workspaces",
  "issues",
  "portfolio-brief",
  "portfolio-receipts",
  "portfolio-issues",
  "portfolio-directives",
  "portfolio-agents",
  "portfolio-approvals",
  "portfolio-activity",
  "portfolio-routines",
  "portfolio-calendar",
  "portfolio-costs",
  "portfolio-dashboard",
  "portfolio-email",
  "routines",
  "calendar",
  "goals",
  "memories",
  "work-queues",
  "approvals",
  "costs",
  "usage",
  "activity",
  "inbox",
  "email",
  "u",
  "design-guide",
]);

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
  if (GLOBAL_ROUTE_ROOTS.has(first) || BOARD_ROUTE_ROOTS.has(first)) {
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
    if (!GLOBAL_ROUTE_ROOTS.has(segments[0]!.toLowerCase()) && BOARD_ROUTE_ROOTS.has(second)) {
      return `/${segments.slice(1).join("/")}${search}${hash}`;
    }
  }

  return `${pathname}${search}${hash}`;
}
