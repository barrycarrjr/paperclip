import { useQuery } from "@tanstack/react-query";
import { pluginsApi } from "../api/plugins";
import { PRINT_TOOLS_PLUGIN_KEY } from "../api/printTools";
import { queryKeys } from "../lib/queryKeys";

/**
 * Where the operator stands with the print-tools plugin:
 * - "ready": installed and turned on; printing will work.
 * - "inactive": installed but not running (disabled, errored, or mid-upgrade).
 * - "missing": never installed, or uninstalled.
 */
export type PrintToolsAvailability = "ready" | "inactive" | "missing";

export interface PrintToolsPluginInfo {
  pluginId: string | null;
  availability: PrintToolsAvailability;
  isLoading: boolean;
}

/**
 * Availability of the print-tools plugin, for surfaces that show a Print
 * control. Unlike `useEmailToolsPlugin` this fetches the UNFILTERED plugin
 * list: a Print button stays visible when the plugin is off, greyed out with
 * a hint, and "installed but turned off" needs different hint wording than
 * "not installed" — a ready-only list cannot tell the two apart.
 */
export function usePrintToolsPlugin(): PrintToolsPluginInfo {
  const { data: plugins, isLoading } = useQuery({
    queryKey: queryKeys.plugins.listAll,
    queryFn: () => pluginsApi.list(),
    staleTime: 60_000,
  });

  const record = plugins?.find((p) => p.pluginKey === PRINT_TOOLS_PLUGIN_KEY) ?? null;

  let availability: PrintToolsAvailability;
  if (!record || record.status === "uninstalled") {
    availability = "missing";
  } else if (record.status === "ready") {
    availability = "ready";
  } else {
    availability = "inactive";
  }

  return {
    pluginId: record?.id ?? null,
    availability,
    isLoading,
  };
}
