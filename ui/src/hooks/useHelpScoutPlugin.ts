import { useQuery } from "@tanstack/react-query";
import { pluginsApi } from "../api/plugins";
import { HELP_SCOUT_PLUGIN_KEY } from "../api/helpScoutBridge";
import { queryKeys } from "../lib/queryKeys";

export interface HelpScoutAccount {
  key: string;
  displayName?: string;
  defaultMailbox?: string;
  allowedMailboxes?: string[];
  allowedCompanies?: string[];
}

export interface HelpScoutPluginInfo {
  pluginId: string | null;
  /** Accounts whose `allowedCompanies` covers the active company. */
  accountsForCompany: HelpScoutAccount[];
  /** True if at least one account is usable by this company. */
  hasAccountForCompany: boolean;
  isLoading: boolean;
}

export function useHelpScoutPlugin(
  companyId: string | null | undefined,
): HelpScoutPluginInfo {
  const { data: plugins, isLoading: pluginsLoading } = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list("ready"),
    staleTime: 60_000,
  });

  const helpScoutPlugin =
    plugins?.find((p) => p.pluginKey === HELP_SCOUT_PLUGIN_KEY) ?? null;
  const pluginId = helpScoutPlugin?.id ?? null;

  const { data: config, isLoading: configLoading } = useQuery({
    queryKey: queryKeys.plugins.config(pluginId ?? ""),
    queryFn: () => pluginsApi.getConfig(pluginId!),
    enabled: !!pluginId,
    staleTime: 60_000,
  });

  let accountsForCompany: HelpScoutAccount[] = [];
  if (pluginId && config && companyId) {
    const accounts = (config.configJson?.accounts ?? []) as HelpScoutAccount[];
    accountsForCompany = accounts.filter((a) => {
      const allowed = a.allowedCompanies;
      if (!allowed || allowed.length === 0) return false;
      return allowed.includes("*") || allowed.includes(companyId);
    });
  }

  return {
    pluginId,
    accountsForCompany,
    hasAccountForCompany: accountsForCompany.length > 0,
    isLoading: pluginsLoading || (!!pluginId && configLoading),
  };
}
