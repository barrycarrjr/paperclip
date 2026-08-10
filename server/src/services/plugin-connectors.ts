/**
 * @fileoverview Works out, per company, whether a plugin's outside account is
 * actually hooked up.
 *
 * A plugin says where its account list lives with a `connectors` entry in its
 * manifest (see `PluginConnectorDeclaration`). This service reads that array
 * out of the plugin's saved instance config and answers the only question a
 * board page cares about: for this company, is there a finished account that
 * covers it?
 *
 * Nothing here is calendar-specific. The calendar page asks for
 * `surface: "calendar"`; a future surface asks for its own.
 */

import { asc, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, pluginConfig, plugins } from "@paperclipai/db";
import type {
  PluginConnectorCompanyStatus,
  PluginConnectorDeclaration,
  PluginConnectorStatus,
  PluginConnectorSurface,
  PaperclipPluginManifestV1,
} from "@paperclipai/shared";

/** A company entry every account is allowed to serve. */
const PORTFOLIO_WIDE = "*";

/** Statuses where the plugin is present and its config is worth reading. */
const READABLE_STATUSES = new Set(["ready", "installed", "disabled", "upgrade_pending"]);

/** Only a `ready` plugin is actually running, so only that counts as on. */
const ENABLED_STATUS = "ready";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A field counts as filled in when it holds a non-empty string, or a non-empty
 * array. Anything else (null, "", [], 0) reads as "the operator has not got to
 * this yet", which is what `requiredFields` is for.
 */
function isFilledIn(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined && value !== false;
}

/** Company ids an account entry serves, normalized to strings. */
function readCompanyIds(account: Record<string, unknown>, field: string): string[] {
  const raw = account[field];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

/** Best label available for an account, falling back to its identifier. */
function readAccountLabel(
  account: Record<string, unknown>,
  connector: PluginConnectorDeclaration,
): string | null {
  for (const field of [connector.labelField, "displayName", "key"]) {
    if (!field) continue;
    const value = account[field];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

interface ResolvedAccount {
  label: string | null;
  companyIds: string[];
  portfolioWide: boolean;
  finished: boolean;
}

/** Pull the account list named by the connector out of saved config. */
export function readConnectorAccounts(
  connector: PluginConnectorDeclaration,
  configJson: Record<string, unknown> | null,
): ResolvedAccount[] {
  const raw = configJson?.[connector.connectionsKey];
  if (!Array.isArray(raw)) return [];

  const accounts: ResolvedAccount[] = [];
  for (const entry of raw) {
    const account = asRecord(entry);
    if (!account) continue;

    const companyIds = readCompanyIds(account, connector.companiesField);
    accounts.push({
      label: readAccountLabel(account, connector),
      companyIds: companyIds.filter((id) => id !== PORTFOLIO_WIDE),
      portfolioWide: companyIds.includes(PORTFOLIO_WIDE),
      finished: (connector.requiredFields ?? []).every((field) => isFilledIn(account[field])),
    });
  }
  return accounts;
}

/**
 * Resolve one connector against the companies in the portfolio.
 *
 * An account only counts when it is finished AND covers the company, so a
 * half-filled account reads as not connected rather than quietly passing.
 */
export function resolveConnectorCompanies(
  connector: PluginConnectorDeclaration,
  accounts: ResolvedAccount[],
  companyRows: { id: string; name: string }[],
): { companies: PluginConnectorCompanyStatus[]; unfinishedAccounts: string[] } {
  const usable = accounts.filter((account) => account.finished);

  const companyStatuses = companyRows.map((company) => {
    const direct = usable.find((account) => account.companyIds.includes(company.id));
    const wide = direct ? null : usable.find((account) => account.portfolioWide);
    const serving = direct ?? wide ?? null;

    return {
      companyId: company.id,
      companyName: company.name,
      connected: serving !== null,
      accountLabel: serving?.label ?? null,
      viaPortfolioWide: serving !== null && direct === undefined,
    } satisfies PluginConnectorCompanyStatus;
  });

  const unfinishedAccounts = accounts
    .filter((account) => !account.finished)
    .map((account, index) => account.label ?? `Account ${index + 1}`);

  return { companies: companyStatuses, unfinishedAccounts };
}

export function pluginConnectorService(db: Db) {
  return {
    /**
     * Every connector declared for `surface`, resolved against saved config.
     *
     * Returns an empty array when no installed plugin declares one, which is
     * how a board page decides not to render its status control at all.
     */
    async listForSurface(surface: PluginConnectorSurface): Promise<PluginConnectorStatus[]> {
      const [pluginRows, configRows, companyRows] = await Promise.all([
        db.select().from(plugins).where(ne(plugins.status, "uninstalled")).orderBy(asc(plugins.installOrder)),
        db.select().from(pluginConfig),
        db
          .select({ id: companies.id, name: companies.name, isPortfolioRoot: companies.isPortfolioRoot })
          .from(companies)
          .where(ne(companies.status, "archived"))
          .orderBy(asc(companies.name)),
      ]);

      // The portfolio root is a container, not a company an account serves.
      const realCompanies = companyRows.filter((company) => !company.isPortfolioRoot);
      const configByPluginId = new Map(configRows.map((row) => [row.pluginId, row.configJson]));

      const statuses: PluginConnectorStatus[] = [];
      for (const plugin of pluginRows) {
        if (!READABLE_STATUSES.has(plugin.status)) continue;

        const manifest = plugin.manifestJson as PaperclipPluginManifestV1 | null;
        const declared = manifest?.connectors ?? [];
        if (declared.length === 0) continue;

        const configJson = asRecord(configByPluginId.get(plugin.id) ?? null);

        for (const connector of declared) {
          if (connector.surface !== surface) continue;

          const accounts = readConnectorAccounts(connector, configJson);
          const resolved = resolveConnectorCompanies(connector, accounts, realCompanies);

          statuses.push({
            pluginId: plugin.id,
            pluginKey: plugin.pluginKey,
            pluginDisplayName: manifest?.displayName ?? plugin.pluginKey,
            connectorId: connector.id,
            displayName: connector.displayName,
            surface: connector.surface,
            pluginEnabled: plugin.status === ENABLED_STATUS,
            unfinishedAccounts: resolved.unfinishedAccounts,
            companies: resolved.companies,
          });
        }
      }

      return statuses;
    },
  };
}

export type PluginConnectorService = ReturnType<typeof pluginConnectorService>;

/** Re-exported for tests that build a connector without touching the db. */
export { PORTFOLIO_WIDE };
export type { ResolvedAccount };
