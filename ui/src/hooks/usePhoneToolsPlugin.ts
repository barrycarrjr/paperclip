import { useQuery } from "@tanstack/react-query";
import { pluginsApi } from "../api/plugins";
import { queryKeys } from "../lib/queryKeys";

/** The add-on that provides the Phone pages. */
export const PHONE_TOOLS_PLUGIN_KEY = "3cx-tools";

export interface PhoneToolsPluginInfo {
  pluginId: string | null;
  /** True when at least one phone account covers this company. */
  hasAccountForCompany: boolean;
  isLoading: boolean;
}

/**
 * Whether the Phone add-on can actually do anything for one company.
 *
 * Written to match useEmailToolsPlugin line for line, because the two add-ons
 * answer the same question the same way: an instance level config holding a
 * list of accounts, each naming the companies it covers, with "*" meaning all
 * of them. The Phone menu group hides itself under exactly this rule, so a
 * shortcut that used a different one would offer a page the menu will not.
 *
 * False while the config is still being fetched, on purpose. Briefly offering
 * a shortcut that turns out to lead nowhere is worse than briefly not offering
 * one: the first sends someone to a page that cannot help them, the second
 * corrects itself a moment later.
 */
export function usePhoneToolsPlugin(companyId: string | null | undefined): PhoneToolsPluginInfo {
  const { data: plugins, isLoading: pluginsLoading } = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list("ready"),
    staleTime: 60_000,
  });

  const phonePlugin = plugins?.find((p) => p.pluginKey === PHONE_TOOLS_PLUGIN_KEY) ?? null;
  const pluginId = phonePlugin?.id ?? null;

  const { data: config, isLoading: configLoading } = useQuery({
    queryKey: queryKeys.plugins.config(pluginId ?? ""),
    queryFn: () => pluginsApi.getConfig(pluginId!),
    enabled: !!pluginId,
    staleTime: 60_000,
  });

  let hasAccountForCompany = false;
  if (pluginId && config && companyId) {
    const accounts = (config.configJson?.accounts ?? []) as Array<{
      allowedCompanies?: string[];
    }>;
    hasAccountForCompany = accounts.some((account) => {
      const allowed = account.allowedCompanies;
      if (!allowed || allowed.length === 0) return false;
      return allowed.includes("*") || allowed.includes(companyId);
    });
  }

  return {
    pluginId,
    hasAccountForCompany,
    isLoading: pluginsLoading || (!!pluginId && configLoading),
  };
}
