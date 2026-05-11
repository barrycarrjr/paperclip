import { useQuery } from "@tanstack/react-query";
import { pluginsApi } from "../api/plugins";
import { EMAIL_TOOLS_PLUGIN_KEY } from "../api/emailTools";
import { queryKeys } from "../lib/queryKeys";

export interface EmailToolsPluginInfo {
  pluginId: string | null;
  hasMailboxForCompany: boolean;
  isLoading: boolean;
}

export function useEmailToolsPlugin(companyId: string | null | undefined): EmailToolsPluginInfo {
  const { data: plugins, isLoading: pluginsLoading } = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list("ready"),
    staleTime: 60_000,
  });

  const emailPlugin = plugins?.find((p) => p.pluginKey === EMAIL_TOOLS_PLUGIN_KEY) ?? null;
  const pluginId = emailPlugin?.id ?? null;

  const { data: config, isLoading: configLoading } = useQuery({
    queryKey: queryKeys.plugins.config(pluginId ?? ""),
    queryFn: () => pluginsApi.getConfig(pluginId!),
    enabled: !!pluginId,
    staleTime: 60_000,
  });

  let hasMailboxForCompany = false;
  if (pluginId && config && companyId) {
    const mailboxes = (config.configJson?.mailboxes ?? []) as Array<{
      allowedCompanies?: string[];
    }>;
    hasMailboxForCompany = mailboxes.some((m) => {
      const allowed = m.allowedCompanies;
      if (!allowed || allowed.length === 0) return false;
      return allowed.includes("*") || allowed.includes(companyId);
    });
  }

  return {
    pluginId,
    hasMailboxForCompany,
    isLoading: pluginsLoading || (!!pluginId && configLoading),
  };
}
