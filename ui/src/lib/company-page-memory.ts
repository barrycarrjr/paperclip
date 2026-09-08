import {
  extractCompanyPrefixFromPath,
  normalizeCompanyPrefix,
  toCompanyRelativePath,
} from "./company-routes";

const GLOBAL_SEGMENTS = new Set(["auth", "invite", "board-claim", "cli-auth", "docs"]);

const STORAGE_KEY = "paperclip.companyPaths";

/**
 * The last page each company had open, by company id.
 *
 * Kept here rather than inside useCompanyPageMemory.ts because two different
 * things read it now. The hook still writes it on every navigation, but since
 * switching company keeps you on the page you were reading
 * (lib/company-switch.ts), nothing replays it automatically any more. It is
 * read by hooks/useRememberedCompanyPage.ts, which is what turns it into the
 * explicit "where you left off" choice the scope document allows.
 */
export function readRememberedCompanyPaths(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Record<string, string>;
  } catch {
    /* ignore */
  }
  return {};
}

export function readRememberedCompanyPath(companyId: string | null | undefined): string | null {
  if (!companyId) return null;
  return readRememberedCompanyPaths()[companyId] ?? null;
}

export function writeRememberedCompanyPath(companyId: string, path: string): void {
  const paths = readRememberedCompanyPaths();
  paths[companyId] = path;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(paths));
  } catch {
    /* ignore */
  }
}

export function isRememberableCompanyPath(path: string): boolean {
  const pathname = path.split("?")[0] ?? "";
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return true;
  const [root] = segments;
  if (GLOBAL_SEGMENTS.has(root!)) return false;
  return true;
}

function findCompanyByPrefix<T extends { id: string; issuePrefix: string }>(params: {
  companies: T[];
  companyPrefix: string;
}): T | null {
  const normalizedPrefix = normalizeCompanyPrefix(params.companyPrefix);
  return params.companies.find((company) => normalizeCompanyPrefix(company.issuePrefix) === normalizedPrefix) ?? null;
}

export function getRememberedPathOwnerCompanyId<T extends { id: string; issuePrefix: string }>(params: {
  companies: T[];
  pathname: string;
  fallbackCompanyId: string | null;
}): string | null {
  const routeCompanyPrefix = extractCompanyPrefixFromPath(params.pathname);
  if (!routeCompanyPrefix) {
    return params.fallbackCompanyId;
  }

  return findCompanyByPrefix({
    companies: params.companies,
    companyPrefix: routeCompanyPrefix,
  })?.id ?? null;
}

export function sanitizeRememberedPathForCompany(params: {
  path: string | null | undefined;
  companyPrefix: string;
}): string {
  const relativePath = params.path ? toCompanyRelativePath(params.path) : "/brief";
  if (!isRememberableCompanyPath(relativePath)) {
    return "/brief";
  }

  const pathname = relativePath.split("?")[0] ?? "";
  const segments = pathname.split("/").filter(Boolean);
  const [root, entityId] = segments;
  if (root === "issues" && entityId) {
    const identifierMatch = /^([A-Za-z]+)-\d+$/.exec(entityId);
    if (
      identifierMatch &&
      normalizeCompanyPrefix(identifierMatch[1] ?? "") !== normalizeCompanyPrefix(params.companyPrefix)
    ) {
      return "/brief";
    }
  }

  return relativePath;
}
