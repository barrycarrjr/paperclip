import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PatchInstanceGeneralSettings, BackupRetentionPolicy, SelfNotifySettings } from "@paperclipai/shared";
import {
  DAILY_RETENTION_PRESETS,
  WEEKLY_RETENTION_PRESETS,
  MONTHLY_RETENTION_PRESETS,
  DEFAULT_BACKUP_RETENTION,
  DEFAULT_SELF_NOTIFY_SETTINGS,
} from "@paperclipai/shared";
import { LogOut, Power, RefreshCw, SlidersHorizontal } from "lucide-react";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { systemApi } from "@/api/system";
import { ModeBadge } from "@/components/access/ModeBadge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { cn } from "../lib/utils";

/** Parse a comma/semicolon/newline-separated address list into clean entries. */
function parseAddressList(value: string): string[] {
  return value
    .split(/[,;\n]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

interface SelfAddressDraft {
  slackUserIds: string;
  emails: string;
  phoneNumbers: string;
}

export function InstanceGeneralSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const signOutMutation = useMutation({
    mutationFn: () => authApi.signOut(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to sign out.");
    },
  });

  const [systemActionMessage, setSystemActionMessage] = useState<string | null>(null);

  const restartMutation = useMutation({
    mutationFn: () => systemApi.restart(),
    onSuccess: (resp) => {
      setActionError(null);
      setSystemActionMessage(
        resp.message ??
          "Paperclip is restarting. Wait a few seconds and refresh the page.",
      );
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to restart Paperclip.");
    },
  });

  const shutdownMutation = useMutation({
    mutationFn: () => systemApi.shutdown(),
    onSuccess: (resp) => {
      setActionError(null);
      setSystemActionMessage(
        resp.message ??
          "Paperclip is shutting down. Re-launch it from your launcher script when ready.",
      );
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to shut down Paperclip.");
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings" },
      { label: "General" },
    ]);
  }, [setBreadcrumbs]);

  const generalQuery = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  });
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });

  const updateGeneralMutation = useMutation({
    mutationFn: instanceSettingsApi.updateGeneral,
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to update general settings.");
    },
  });

  // Editable copies of the self-address lists, seeded once from the loaded
  // settings so typing isn't clobbered by query refreshes.
  const [selfAddressDraft, setSelfAddressDraft] = useState<SelfAddressDraft | null>(null);
  useEffect(() => {
    const selfNotify = generalQuery.data?.selfNotify;
    if (selfNotify && selfAddressDraft === null) {
      setSelfAddressDraft({
        slackUserIds: selfNotify.slackUserIds.join(", "),
        emails: selfNotify.emails.join(", "),
        phoneNumbers: selfNotify.phoneNumbers.join(", "),
      });
    }
  }, [generalQuery.data, selfAddressDraft]);

  if (generalQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading general settings...</div>;
  }

  if (generalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {generalQuery.error instanceof Error
          ? generalQuery.error.message
          : "Failed to load general settings."}
      </div>
    );
  }

  const censorUsernameInLogs = generalQuery.data?.censorUsernameInLogs === true;
  const keyboardShortcuts = generalQuery.data?.keyboardShortcuts === true;
  const backupRetention: BackupRetentionPolicy = generalQuery.data?.backupRetention ?? DEFAULT_BACKUP_RETENTION;
  const outboundToolDraftMode = generalQuery.data?.outboundToolDraftMode !== false;
  const selfNotify: SelfNotifySettings = generalQuery.data?.selfNotify ?? DEFAULT_SELF_NOTIFY_SETTINGS;

  const saveSelfNotify = (patch: Partial<SelfNotifySettings>) => {
    updateGeneralMutation.mutate({
      selfNotify: {
        skipApproval: selfNotify.skipApproval,
        slackUserIds: selfNotify.slackUserIds,
        emails: selfNotify.emails,
        phoneNumbers: selfNotify.phoneNumbers,
        ...patch,
      },
    });
  };

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">General</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Configure instance-wide preferences including log display, keyboard shortcuts, backup
          retention, and data sharing.
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Deployment and auth</h2>
            <ModeBadge
              deploymentMode={healthQuery.data?.deploymentMode}
              deploymentExposure={healthQuery.data?.deploymentExposure}
            />
          </div>
          <div className="text-sm text-muted-foreground">
            {healthQuery.data?.deploymentMode === "local_trusted"
              ? "Local trusted mode is optimized for a local operator. Browser requests run as local board context and no sign-in is required."
              : healthQuery.data?.deploymentExposure === "public"
                ? "Authenticated public mode requires sign-in for board access and is intended for public URLs."
                : "Authenticated private mode requires sign-in and is intended for LAN, VPN, or other private-network deployments."}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <StatusBox
              label="Auth readiness"
              value={healthQuery.data?.authReady ? "Ready" : "Not ready"}
            />
            <StatusBox
              label="Bootstrap status"
              value={healthQuery.data?.bootstrapStatus === "bootstrap_pending" ? "Setup required" : "Ready"}
            />
            <StatusBox
              label="Bootstrap invite"
              value={healthQuery.data?.bootstrapInviteActive ? "Active" : "None"}
            />
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Censor username in logs</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Hide the username segment in home-directory paths and similar operator-visible log output. Standalone
              username mentions outside of paths are not yet masked in the live transcript view. This is off by
              default.
            </p>
          </div>
          <ToggleSwitch
            checked={censorUsernameInLogs}
            onCheckedChange={() => updateGeneralMutation.mutate({ censorUsernameInLogs: !censorUsernameInLogs })}
            disabled={updateGeneralMutation.isPending}
            aria-label="Toggle username log censoring"
          />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Keyboard shortcuts</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Enable app keyboard shortcuts, including inbox navigation and global shortcuts like creating issues or
              toggling panels. This is off by default.
            </p>
          </div>
          <ToggleSwitch
            checked={keyboardShortcuts}
            onCheckedChange={() => updateGeneralMutation.mutate({ keyboardShortcuts: !keyboardShortcuts })}
            disabled={updateGeneralMutation.isPending}
            aria-label="Toggle keyboard shortcuts"
          />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1.5">
              <h2 className="text-sm font-semibold">Hold outbound messages for approval</h2>
              <p className="max-w-2xl text-sm text-muted-foreground">
                When on, agent emails, Slack messages, and phone calls wait in Approvals until you
                OK them. Turning this off lets every outbound message send immediately, including
                ones to other people.
              </p>
            </div>
            <ToggleSwitch
              checked={outboundToolDraftMode}
              onCheckedChange={() =>
                updateGeneralMutation.mutate({ outboundToolDraftMode: !outboundToolDraftMode })
              }
              disabled={updateGeneralMutation.isPending}
              aria-label="Toggle outbound message approvals"
            />
          </div>

          <div className="flex items-start justify-between gap-4 border-t border-border pt-4">
            <div className="space-y-1.5">
              <h2 className="text-sm font-semibold">Send messages addressed to me right away</h2>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Skips the approval step when every recipient of a message is you, so agent status
                notes reach you without a review detour. A Slack DM with no explicit recipient goes
                to the workspace&apos;s default DM target (you), so those send right away too.
                Messages to anyone else still wait for approval.
              </p>
            </div>
            <ToggleSwitch
              checked={selfNotify.skipApproval}
              onCheckedChange={() => saveSelfNotify({ skipApproval: !selfNotify.skipApproval })}
              disabled={updateGeneralMutation.isPending || !outboundToolDraftMode}
              aria-label="Toggle sending self-addressed messages without approval"
            />
          </div>

          <div className="space-y-3">
            <p className="max-w-2xl text-sm text-muted-foreground">
              Tell Paperclip which addresses are yours. A message counts as &quot;to me&quot; only
              when every recipient matches one of these (emails ignore capitalization, phone
              numbers ignore formatting). Separate multiple entries with commas.
            </p>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="self-slack-ids" className="text-xs text-muted-foreground">
                  Your Slack user IDs
                </Label>
                <Input
                  id="self-slack-ids"
                  placeholder="U01ABCDEFGH"
                  value={selfAddressDraft?.slackUserIds ?? ""}
                  onChange={(e) =>
                    setSelfAddressDraft((prev) => ({
                      ...(prev ?? { slackUserIds: "", emails: "", phoneNumbers: "" }),
                      slackUserIds: e.target.value,
                    }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="self-emails" className="text-xs text-muted-foreground">
                  Your email addresses
                </Label>
                <Input
                  id="self-emails"
                  placeholder="you@example.com"
                  value={selfAddressDraft?.emails ?? ""}
                  onChange={(e) =>
                    setSelfAddressDraft((prev) => ({
                      ...(prev ?? { slackUserIds: "", emails: "", phoneNumbers: "" }),
                      emails: e.target.value,
                    }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="self-phones" className="text-xs text-muted-foreground">
                  Your phone numbers
                </Label>
                <Input
                  id="self-phones"
                  placeholder="+15551234567"
                  value={selfAddressDraft?.phoneNumbers ?? ""}
                  onChange={(e) =>
                    setSelfAddressDraft((prev) => ({
                      ...(prev ?? { slackUserIds: "", emails: "", phoneNumbers: "" }),
                      phoneNumbers: e.target.value,
                    }))
                  }
                />
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={updateGeneralMutation.isPending || selfAddressDraft === null}
              onClick={() => {
                if (!selfAddressDraft) return;
                saveSelfNotify({
                  slackUserIds: parseAddressList(selfAddressDraft.slackUserIds),
                  emails: parseAddressList(selfAddressDraft.emails),
                  phoneNumbers: parseAddressList(selfAddressDraft.phoneNumbers),
                });
              }}
            >
              {updateGeneralMutation.isPending ? "Saving…" : "Save my addresses"}
            </Button>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-5">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Backup retention</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Configure how long automatic database backups are retained. Backups run roughly
              every hour and are compressed with gzip. Within the daily window all backups are
              kept; beyond that, one backup per week and one per month are preserved.
            </p>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Daily</h3>
            <div className="flex flex-wrap gap-2">
              {DAILY_RETENTION_PRESETS.map((days) => {
                const active = backupRetention.dailyDays === days;
                return (
                  <button
                    key={days}
                    type="button"
                    disabled={updateGeneralMutation.isPending}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      active
                        ? "border-foreground bg-accent text-foreground"
                        : "border-border bg-background hover:bg-accent/50",
                    )}
                    onClick={() =>
                      updateGeneralMutation.mutate({
                        backupRetention: { ...backupRetention, dailyDays: days },
                      })
                    }
                  >
                    <div className="text-sm font-medium">{days} days</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Weekly</h3>
            <div className="flex flex-wrap gap-2">
              {WEEKLY_RETENTION_PRESETS.map((weeks) => {
                const active = backupRetention.weeklyWeeks === weeks;
                const label = weeks === 1 ? "1 week" : `${weeks} weeks`;
                return (
                  <button
                    key={weeks}
                    type="button"
                    disabled={updateGeneralMutation.isPending}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      active
                        ? "border-foreground bg-accent text-foreground"
                        : "border-border bg-background hover:bg-accent/50",
                    )}
                    onClick={() =>
                      updateGeneralMutation.mutate({
                        backupRetention: { ...backupRetention, weeklyWeeks: weeks },
                      })
                    }
                  >
                    <div className="text-sm font-medium">{label}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Monthly</h3>
            <div className="flex flex-wrap gap-2">
              {MONTHLY_RETENTION_PRESETS.map((months) => {
                const active = backupRetention.monthlyMonths === months;
                const label = months === 1 ? "1 month" : `${months} months`;
                return (
                  <button
                    key={months}
                    type="button"
                    disabled={updateGeneralMutation.isPending}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      active
                        ? "border-foreground bg-accent text-foreground"
                        : "border-border bg-background hover:bg-accent/50",
                    )}
                    onClick={() =>
                      updateGeneralMutation.mutate({
                        backupRetention: { ...backupRetention, monthlyMonths: months },
                      })
                    }
                  >
                    <div className="text-sm font-medium">{label}</div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Server lifecycle</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Stop or restart the running Paperclip server. Affects every user
              connected to this instance, not just you. Restart spawns a fresh
              server in a few seconds; shutdown leaves it stopped until you
              re-launch it.
            </p>
          </div>
          {systemActionMessage && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              {systemActionMessage}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={restartMutation.isPending || shutdownMutation.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    "Restart the Paperclip server? Everyone connected will be disconnected briefly while a new instance boots.",
                  )
                ) {
                  restartMutation.mutate();
                }
              }}
            >
              <RefreshCw
                className={cn("size-4", restartMutation.isPending && "animate-spin")}
              />
              {restartMutation.isPending ? "Restarting…" : "Restart"}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={restartMutation.isPending || shutdownMutation.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    "Shut down the Paperclip server? Everyone connected will be disconnected and the server will stay stopped until you re-launch it manually.",
                  )
                ) {
                  shutdownMutation.mutate();
                }
              }}
            >
              <Power className="size-4" />
              {shutdownMutation.isPending ? "Shutting down…" : "Shut down"}
            </Button>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Sign out</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Sign out of this Paperclip instance. You will be redirected to the login page.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={signOutMutation.isPending}
            onClick={() => signOutMutation.mutate()}
          >
            <LogOut className="size-4" />
            {signOutMutation.isPending ? "Signing out..." : "Sign out"}
          </Button>
        </div>
      </section>
    </div>
  );
}

function StatusBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-background px-3 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-2 text-sm font-medium">{value}</div>
    </div>
  );
}
