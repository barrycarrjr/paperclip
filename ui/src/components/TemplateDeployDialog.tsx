import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, MinusCircle, AlertCircle, Rocket } from "lucide-react";
import type {
  Company,
  TemplateDeployment,
  TemplateDeploymentResult,
  TemplateType,
} from "@paperclipai/shared";
import { companiesApi } from "@/api/companies";
import { templatesApi } from "@/api/templates";
import { queryKeys } from "@/lib/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Props {
  type: TemplateType;
  templateId: string;
  templateName: string;
  existingDeployments: TemplateDeployment[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TemplateDeployDialog({
  type,
  templateId,
  templateName,
  existingDeployments,
  open,
  onOpenChange,
}: Props) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [skipExisting, setSkipExisting] = useState(true);
  const [result, setResult] = useState<TemplateDeploymentResult | null>(null);

  const companiesQuery = useQuery({
    queryKey: queryKeys.companies.all,
    queryFn: () => companiesApi.list(),
    enabled: open,
  });

  const deployedCompanyIds = useMemo(
    () => new Set(existingDeployments.map((d) => d.companyId)),
    [existingDeployments],
  );

  const sortedCompanies = useMemo(() => {
    const all = companiesQuery.data ?? [];
    return [...all].sort((a, b) => {
      if (a.isPortfolioRoot && !b.isPortfolioRoot) return -1;
      if (!a.isPortfolioRoot && b.isPortfolioRoot) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [companiesQuery.data]);

  const deployMutation = useMutation({
    mutationFn: () =>
      templatesApi.deploy(type, templateId, {
        companyIds: Array.from(selected),
        skipExisting,
      }),
    onSuccess: (data) => {
      setResult(data);
      void queryClient.invalidateQueries({ queryKey: queryKeys.templates.detail(type, templateId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.templates.deployments(type, templateId) });
    },
  });

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const reset = () => {
    setSelected(new Set());
    setResult(null);
    setSkipExisting(true);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="h-4 w-4" />
            Deploy {templateName}
          </DialogTitle>
          <DialogDescription>
            Pick the companies to instantiate this template into. Skipping a company that
            already has a deployment is the default &mdash; uncheck to redeploy.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <ResultView result={result} onClose={() => handleOpenChange(false)} />
        ) : (
          <>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                id="skip-existing"
                checked={skipExisting}
                onCheckedChange={(v) => setSkipExisting(Boolean(v))}
              />
              <label htmlFor="skip-existing" className="cursor-pointer">
                Skip companies that already have this template deployed
              </label>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto border rounded-md">
              {companiesQuery.isLoading ? (
                <div className="p-4 text-sm text-muted-foreground">Loading companies...</div>
              ) : (
                <ul className="divide-y">
                  {sortedCompanies.map((c) => (
                    <CompanyRow
                      key={c.id}
                      company={c}
                      checked={selected.has(c.id)}
                      onToggle={() => toggle(c.id)}
                      alreadyDeployed={deployedCompanyIds.has(c.id)}
                    />
                  ))}
                </ul>
              )}
            </div>

            {deployMutation.error && (
              <div className="text-sm text-destructive">
                {(deployMutation.error as Error).message}
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => deployMutation.mutate()}
                disabled={selected.size === 0 || deployMutation.isPending}
              >
                {deployMutation.isPending
                  ? "Deploying..."
                  : `Deploy to ${selected.size} compan${selected.size === 1 ? "y" : "ies"}`}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CompanyRow({
  company,
  checked,
  onToggle,
  alreadyDeployed,
}: {
  company: Company;
  checked: boolean;
  onToggle: () => void;
  alreadyDeployed: boolean;
}) {
  return (
    <li
      className="px-3 py-2 flex items-center gap-3 hover:bg-muted/40 cursor-pointer"
      onClick={onToggle}
    >
      <Checkbox checked={checked} onCheckedChange={onToggle} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">
          {company.name}
          {company.isPortfolioRoot && (
            <Badge variant="outline" className="ml-2 text-[10px]">portfolio root</Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground truncate">
          {company.issuePrefix} &middot; {company.status}
        </div>
      </div>
      {alreadyDeployed && (
        <Badge variant="outline" className="text-[10px]">deployed</Badge>
      )}
    </li>
  );
}

function ResultView({
  result,
  onClose,
}: {
  result: TemplateDeploymentResult;
  onClose: () => void;
}) {
  const counts = useMemo(() => {
    let created = 0;
    let skipped = 0;
    let error = 0;
    for (const r of result.results) {
      if (r.status === "created") created++;
      else if (r.status === "skipped") skipped++;
      else error++;
    }
    return { created, skipped, error };
  }, [result.results]);

  return (
    <>
      <div className="flex gap-2 text-xs">
        <Badge variant="outline" className="border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-300">
          {counts.created} created
        </Badge>
        <Badge variant="outline">{counts.skipped} skipped</Badge>
        {counts.error > 0 && (
          <Badge variant="outline" className="border-destructive/40 bg-destructive/10 text-destructive">
            {counts.error} error
          </Badge>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto border rounded-md">
        <ul className="divide-y">
          {result.results.map((r) => (
            <li key={r.companyId} className="px-3 py-2 flex items-start gap-2">
              {r.status === "created" && <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0 mt-0.5" />}
              {r.status === "skipped" && <MinusCircle className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />}
              {r.status === "error" && <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{r.companyName}</div>
                {r.message && (
                  <div className="text-xs text-muted-foreground">{r.message}</div>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
      <DialogFooter>
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </>
  );
}
