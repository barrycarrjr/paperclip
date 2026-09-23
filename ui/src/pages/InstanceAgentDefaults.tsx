import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, RotateCw } from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { adaptersApi, type AdapterInfo } from "@/api/adapters";
import { agentsApi, type AdapterModel } from "@/api/agents";
import { getAdapterLabel } from "@/adapters/adapter-display-registry";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { ModelPicker } from "@/components/ModelPicker";
import { SavedModelNotice } from "@/components/SavedModelNotice";
import { useAdapterModelRefresh } from "@/hooks/useAdapterModelRefresh";

// opencode_local agents must specify a model — the "Default" affordance never
// applies, so a configured default for it would be dead config. Hide it from
// this page entirely.
const HIDDEN_ADAPTER_TYPES = new Set(["opencode_local"]);

export function InstanceAgentDefaults() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings" },
      { label: "Agent defaults" },
    ]);
  }, [setBreadcrumbs]);

  const adaptersQuery = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: () => adaptersApi.list(),
  });

  const defaultsQuery = useQuery({
    queryKey: queryKeys.instance.agentDefaults,
    queryFn: () => instanceSettingsApi.getAgentDefaults(),
  });

  const updateMutation = useMutation({
    mutationFn: instanceSettingsApi.updateAgentDefaults,
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.agentDefaults });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to update agent defaults.");
    },
  });

  const visibleAdapters = useMemo<AdapterInfo[]>(() => {
    const adapters = adaptersQuery.data ?? [];
    return adapters
      .filter((adapter) => adapter.loaded && !adapter.disabled)
      .filter((adapter) => !HIDDEN_ADAPTER_TYPES.has(adapter.type));
  }, [adaptersQuery.data]);

  const modelQueries = useQueries({
    queries: visibleAdapters.map((adapter) => ({
      queryKey: selectedCompanyId
        ? queryKeys.agents.adapterModels(selectedCompanyId, adapter.type)
        : ["agents", "none", "adapter-models", adapter.type],
      queryFn: () => agentsApi.adapterModels(selectedCompanyId!, adapter.type),
      enabled: Boolean(selectedCompanyId),
    })),
  });
  const modelRefresh = useAdapterModelRefresh(selectedCompanyId);

  const isLoading = adaptersQuery.isLoading || defaultsQuery.isLoading;

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading agent defaults…</div>;
  }

  if (adaptersQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {adaptersQuery.error instanceof Error
          ? adaptersQuery.error.message
          : "Failed to load adapters."}
      </div>
    );
  }

  if (defaultsQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {defaultsQuery.error instanceof Error
          ? defaultsQuery.error.message
          : "Failed to load agent defaults."}
      </div>
    );
  }

  const defaults = defaultsQuery.data?.defaultModelByAdapterType ?? {};

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Cpu className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Agent defaults</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          When an agent's model is left as <span className="font-medium">Default</span>, Paperclip
          uses the value chosen here for that adapter type. If unset, the adapter CLI picks its own
          default. Changes take effect on each agent's next step.
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      {!selectedCompanyId && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          Select a company in the sidebar to load adapter model lists. The default itself is
          instance-wide; the picker just needs a company context to discover models.
        </div>
      )}

      {visibleAdapters.length === 0 ? (
        <div className="rounded-md border border-border bg-card px-3 py-4 text-sm text-muted-foreground">
          No adapters are currently installed and enabled.
        </div>
      ) : (
        <div className="space-y-3">
          {visibleAdapters.map((adapter, index) => {
            const modelsQuery = modelQueries[index];
            const models = (modelsQuery?.data as AdapterModel[] | undefined) ?? [];
            const currentValue = defaults[adapter.type] ?? "";
            const modelLoadError = modelsQuery?.error;
            const refreshing = modelRefresh.isRefreshing(adapter.type);
            const isFetching = (modelsQuery?.isFetching ?? false) || refreshing;
            const refreshError = modelRefresh.errorFor(adapter.type);
            const adapterLabel = adapter.label || getAdapterLabel(adapter.type);
            const saveDefault = (next: string) =>
              updateMutation.mutate({
                defaultModelByAdapterType: {
                  ...defaults,
                  [adapter.type]: next,
                },
              });
            return (
              <section
                key={adapter.type}
                className="rounded-xl border border-border bg-card p-4 space-y-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="space-y-0.5">
                    <h2 className="text-sm font-semibold">{adapterLabel}</h2>
                    <p className="text-xs text-muted-foreground">
                      Adapter type: <code className="font-mono">{adapter.type}</code>
                    </p>
                  </div>
                </div>
                {modelLoadError && (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                    {modelLoadError instanceof Error
                      ? modelLoadError.message
                      : "Could not load models. Adapter may not be configured yet."}
                    {" "}You can still type a model ID below; Paperclip will pass it through to the adapter at run time.
                  </div>
                )}
                {refreshError && (
                  <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                    {refreshError}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <ModelPicker
                      models={models}
                      value={currentValue}
                      onChange={saveDefault}
                      loading={modelsQuery?.isLoading ?? false}
                      emptyOption={{
                        label: "No default",
                        hint: "adapter CLI picks",
                        triggerLabel: "No default (adapter CLI picks)",
                      }}
                      creatable
                      disabled={updateMutation.isPending || !selectedCompanyId}
                      aria-label={`Default model for ${adapterLabel}`}
                    />
                  </div>
                  {selectedCompanyId && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isFetching}
                      onClick={() => void modelRefresh.refresh(adapter.type)}
                    >
                      <RotateCw className={isFetching ? "size-3 animate-spin" : "size-3"} />
                      Refresh
                    </Button>
                  )}
                </div>
                <SavedModelNotice
                  models={models}
                  value={currentValue}
                  onSwitch={saveDefault}
                  disabled={updateMutation.isPending}
                />
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
