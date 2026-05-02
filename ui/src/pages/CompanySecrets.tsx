import { useEffect } from "react";
import { KeyRound } from "lucide-react";
import { InfoPopoverButton } from "@/components/InfoPopoverButton";
import { SecretsManager } from "@/components/SecretsManager";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";

const SECRETS_GUIDE_URL = "https://docs.paperclip.ing/#/reference/guides/board-operator/managing-secrets";

export function CompanySecrets() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Secrets" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  if (!selectedCompany || !selectedCompanyId) {
    return (
      <div className="text-sm text-muted-foreground">
        No company selected. Select a company from the switcher above.
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center gap-2">
        <KeyRound className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Company Secrets</h1>
        <InfoPopoverButton
          title="How secrets work"
          side="bottom"
          info={
            <>
              <p>
                This vault stores encrypted values. Adding a secret here doesn't expose it to anything on
                its own — each consumer (agent, plugin, environment, scheduled task) needs its own
                <em> binding</em> that maps an env var name to a vault secret.
              </p>
              <p>
                For an agent: open its settings and add a row in the Environment variables editor pointing
                at the vault secret. The runtime resolves and injects the value at process start.
              </p>
              <p>
                <a
                  href={SECRETS_GUIDE_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  Learn more →
                </a>
              </p>
            </>
          }
        />
      </div>
      <SecretsManager companyId={selectedCompanyId} />
    </div>
  );
}
