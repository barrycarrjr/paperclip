export interface CompanyRoutingMeta {
  id: string;
  name: string;
  issuePrefix: string;
  kind?: string | null;
  isPortfolioRoot?: boolean | null;
}

/**
 * Normalizes a company name into candidate match tokens.
 * e.g. "B2 Industries LLC" -> ["b2 industries llc", "b2 industries", "b2"]
 *      "Industry Bureau LLC" -> ["industry bureau llc", "industry bureau"]
 *      "440-44 Brown St LLC" -> ["440-44 brown st llc", "440-44 brown st", "brown st", "brown"]
 */
export function getCompanyMatchTokens(company: CompanyRoutingMeta): string[] {
  const tokens = new Set<string>();

  if (company.issuePrefix) {
    tokens.add(company.issuePrefix.trim().toLowerCase());
  }

  const rawName = company.name.trim().toLowerCase();
  tokens.add(rawName);

  // Strip common corporate suffixes
  const stripped = rawName
    .replace(/\b(llc|inc|corp|corporation|holdings|services|construction|mergers & acquisitions)\b/gi, "")
    .replace(/[,\.]/g, "")
    .trim()
    .replace(/\s+/g, " ");

  if (stripped && stripped !== rawName) {
    tokens.add(stripped);
  }

  // Handle specific common short names
  // If stripped is "b2 industries", also include "b2"
  const words = stripped.split(" ").filter(Boolean);
  if (words.length > 1 && words[0].length >= 2) {
    // e.g. "b2", "brown", "carr", "m3", "c3"
    tokens.add(words[0]);
  }

  return Array.from(tokens);
}

/**
 * Checks if a string contains any tag for this company.
 */
export function hasCompanyTag(text: string, company: CompanyRoutingMeta): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  const tokens = getCompanyMatchTokens(company);

  for (const token of tokens) {
    // Check [token]
    if (lower.includes(`[${token}]`)) return true;
    // Check #token
    const hashRegex = new RegExp(`(?:^|\\s)#${escapeRegExp(token)}(?:$|\\s|[^a-z0-9])`, "i");
    if (hashRegex.test(lower)) return true;
    // Check prefix: at start
    const colonRegex = new RegExp(`^${escapeRegExp(token)}\\s*:`, "i");
    if (colonRegex.test(lower)) return true;
  }

  return false;
}

/**
 * Resolves which company a calendar event belongs to based on title and body.
 * If tags are found, maps to the corresponding company.
 * If no company tag is found, returns fallbackCompanyId (typically Personal).
 */
export function resolveCompanyForCalendarEvent(
  title: string,
  body: string | null | undefined,
  companies: CompanyRoutingMeta[],
  fallbackCompanyId: string,
): string {
  const combined = `${title || ""} ${body || ""}`.trim();
  if (!combined) {
    return fallbackCompanyId;
  }

  // 1. Check bracketed tags first: e.g. [BIN], [B2], [Personal], [IND]
  const bracketMatches = Array.from(combined.matchAll(/\[([^\]]+)\]/g)).map((m) =>
    m[1].trim().toLowerCase(),
  );

  for (const bracketContent of bracketMatches) {
    // Match exact prefix first
    for (const comp of companies) {
      if (comp.issuePrefix.toLowerCase() === bracketContent) {
        return comp.id;
      }
    }
    // Match name or short token
    for (const comp of companies) {
      const tokens = getCompanyMatchTokens(comp);
      if (tokens.includes(bracketContent)) {
        return comp.id;
      }
    }
  }

  // 2. Check hashtags: e.g. #bin, #b2, #personal, #ind
  const hashtagMatches = Array.from(combined.matchAll(/#([a-zA-Z0-9_-]+)/g)).map((m) =>
    m[1].trim().toLowerCase(),
  );

  for (const tag of hashtagMatches) {
    for (const comp of companies) {
      if (comp.issuePrefix.toLowerCase() === tag) {
        return comp.id;
      }
    }
    for (const comp of companies) {
      const tokens = getCompanyMatchTokens(comp);
      if (tokens.includes(tag)) {
        return comp.id;
      }
    }
  }

  // 3. Check leading prefix with colon: e.g. "BIN: ...", "B2: ...", "Personal: ..."
  const colonMatch = title?.match(/^([A-Za-z0-9\s_-]+):/);
  if (colonMatch) {
    const candidate = colonMatch[1].trim().toLowerCase();
    for (const comp of companies) {
      if (comp.issuePrefix.toLowerCase() === candidate) {
        return comp.id;
      }
      const tokens = getCompanyMatchTokens(comp);
      if (tokens.includes(candidate)) {
        return comp.id;
      }
    }
  }

  // Untagged event defaults to fallbackCompanyId
  return fallbackCompanyId;
}

/**
 * Prepares the Google event summary when creating from Paperclip.
 * If the target company is not Personal, tags the summary with [PREFIX] if not already tagged.
 */
export function formatGoogleEventSummary(
  summary: string,
  targetCompany: CompanyRoutingMeta,
): string {
  const trimmed = summary.trim();
  const isPersonal =
    targetCompany.kind === "personal" || targetCompany.name.toLowerCase() === "personal";

  if (isPersonal) {
    return trimmed;
  }

  if (hasCompanyTag(trimmed, targetCompany)) {
    return trimmed;
  }

  const prefix = targetCompany.issuePrefix ? targetCompany.issuePrefix.toUpperCase() : targetCompany.name;
  return `[${prefix}] ${trimmed}`;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
