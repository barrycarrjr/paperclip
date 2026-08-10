import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { AlertCircle, Check, Plug, Settings2, X } from "lucide-react";
import type { PluginConnectorStatus } from "@paperclipai/shared";
import { pluginsApi } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Where a plugin's settings live, so "Connect" lands somewhere useful. */
function pluginSettingsPath(pluginId: string): string {
  return `/instance/settings/plugins/${pluginId}`;
}

interface CalendarConnectorStatusProps {
  /**
   * Company the calendar is showing. Leave unset on the portfolio calendar,
   * where the chip counts every company instead of judging one.
   */
  companyId?: string | null;
  className?: string;
}

/** What the chip should say, given who is being looked at. */
function summarize(
  connectors: PluginConnectorStatus[],
  companyId: string | null | undefined,
): { label: string; tone: "connected" | "partial" | "none" } {
  if (companyId) {
    const connected = connectors.filter((connector) =>
      connector.companies.some((company) => company.companyId === companyId && company.connected),
    );
    if (connected.length === connectors.length && connectors.length > 0) {
      return {
        label: connectors.length === 1 ? `${connectors[0].displayName} connected` : "Calendars connected",
        tone: "connected",
      };
    }
    if (connected.length > 0) {
      return { label: `${connected.length} of ${connectors.length} calendars connected`, tone: "partial" };
    }
    return {
      label: connectors.length === 1 ? `${connectors[0].displayName} not connected` : "Calendars not connected",
      tone: "none",
    };
  }

  // Portfolio view: count companies across every connector.
  const totals = connectors.reduce(
    (acc, connector) => ({
      connected: acc.connected + connector.companies.filter((company) => company.connected).length,
      total: acc.total + connector.companies.length,
    }),
    { connected: 0, total: 0 },
  );

  const prefix = connectors.length === 1 ? connectors[0].displayName : "Calendars";
  if (totals.total === 0) return { label: `${prefix}: no companies yet`, tone: "none" };
  if (totals.connected === 0) return { label: `${prefix}: none connected`, tone: "none" };
  if (totals.connected === totals.total) {
    return { label: `${prefix}: all ${totals.total} connected`, tone: "connected" };
  }
  return { label: `${prefix}: ${totals.connected} of ${totals.total} connected`, tone: "partial" };
}

const TONE_CLASS: Record<"connected" | "partial" | "none", string> = {
  connected: "text-emerald-600 dark:text-emerald-400",
  partial: "text-amber-600 dark:text-amber-400",
  none: "text-muted-foreground",
};

/**
 * Shows whether an outside calendar (Google today, anything else later) is
 * actually hooked up, and gives a one-click way to go fix it.
 *
 * Renders nothing at all when no installed plugin offers a calendar connector,
 * so instances that do not use one never see it.
 */
export function CalendarConnectorStatus({ companyId, className }: CalendarConnectorStatusProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const { data: connectors = [] } = useQuery({
    queryKey: queryKeys.plugins.connectors("calendar"),
    queryFn: () => pluginsApi.listConnectors("calendar"),
    staleTime: 30_000,
  });

  const summary = useMemo(() => summarize(connectors, companyId), [connectors, companyId]);

  if (connectors.length === 0) return null;

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className={cn("gap-2", className)}
        onClick={() => setOpen(true)}
      >
        <Plug className={cn("h-3.5 w-3.5", TONE_CLASS[summary.tone])} />
        <span className="truncate">{summary.label}</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Calendar connections</DialogTitle>
          </DialogHeader>

          <div className="space-y-5">
            {connectors.map((connector) => (
              <ConnectorSection
                key={`${connector.pluginId}:${connector.connectorId}`}
                connector={connector}
                highlightCompanyId={companyId ?? null}
                onOpenSettings={() => {
                  setOpen(false);
                  navigate(pluginSettingsPath(connector.pluginId));
                }}
              />
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface ConnectorSectionProps {
  connector: PluginConnectorStatus;
  highlightCompanyId: string | null;
  onOpenSettings: () => void;
}

function ConnectorSection({ connector, highlightCompanyId, onOpenSettings }: ConnectorSectionProps) {
  const connectedCount = connector.companies.filter((company) => company.connected).length;

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{connector.displayName}</p>
          <p className="text-xs text-muted-foreground">
            {connectedCount} of {connector.companies.length} companies connected
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onOpenSettings}>
          <Settings2 className="h-3.5 w-3.5" />
          {connectedCount === 0 ? "Connect" : "Manage"}
        </Button>
      </div>

      {!connector.pluginEnabled ? (
        <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            The {connector.pluginDisplayName} plugin is installed but switched off, so nothing will sync
            until you turn it back on.
          </span>
        </p>
      ) : null}

      {connector.unfinishedAccounts.length > 0 ? (
        <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            {connector.unfinishedAccounts.length === 1
              ? `Half-finished account: ${connector.unfinishedAccounts[0]}. It is still missing credentials, so it does not count as connected.`
              : `Half-finished accounts: ${connector.unfinishedAccounts.join(", ")}. These are still missing credentials, so they do not count as connected.`}
          </span>
        </p>
      ) : null}

      {connector.companies.length === 0 ? (
        <p className="text-xs text-muted-foreground">No companies in the portfolio yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {connector.companies.map((company) => (
            <li
              key={company.companyId}
              className={cn(
                "flex items-center justify-between gap-3 px-3 py-2",
                company.companyId === highlightCompanyId && "bg-accent/50",
              )}
            >
              <span className="min-w-0 truncate text-sm">{company.companyName}</span>
              {company.connected ? (
                <span className="flex min-w-0 items-center gap-2">
                  {company.accountLabel ? (
                    <span className="truncate text-xs text-muted-foreground">{company.accountLabel}</span>
                  ) : null}
                  {company.viaPortfolioWide ? (
                    <Badge variant="outline" className="shrink-0 text-[11px] font-normal">
                      Portfolio-wide
                    </Badge>
                  ) : null}
                  <Check className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                </span>
              ) : (
                <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  Not connected
                  <X className="h-4 w-4" />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
