/**
 * @fileoverview Adapter Manager page — install, view, and manage external adapters.
 *
 * Adapters are simpler than plugins: no workers, no events, no manifests.
 * They just register a ServerAdapterModule that provides model discovery and execution.
 */
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Cpu, Plus, Power, Trash2, FolderOpen, Package, RefreshCw, Download, LogIn } from "lucide-react";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { adaptersApi } from "@/api/adapters";
import type { AdapterInfo, AdapterAuthResult, AdapterAuthStatusEntry } from "@/api/adapters";
import { getAdapterLabel } from "@/adapters/adapter-display-registry";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToastActions } from "@/context/ToastContext";
import { cn } from "@/lib/utils";
import { ChoosePathButton } from "@/components/PathInstructionsModal";
import { invalidateDynamicParser } from "@/adapters/dynamic-loader";
import { invalidateConfigSchemaCache } from "@/adapters/schema-config-fields";

function AdapterRow({
  adapter,
  canRemove,
  onToggle,
  onRemove,
  onReload,
  onReinstall,
  onSignIn,
  isToggling,
  isReloading,
  isReinstalling,
  overriddenBy,
  authStatus,
  /** Custom tooltip for the power button when adapter is enabled. */
  toggleTitleEnabled,
  /** Custom tooltip for the power button when adapter is disabled. */
  toggleTitleDisabled,
  /** Custom label for the disabled badge (defaults to "Hidden from menus"). */
  disabledBadgeLabel,
}: {
  adapter: AdapterInfo;
  canRemove: boolean;
  onToggle: (type: string, disabled: boolean) => void;
  onRemove: (type: string) => void;
  onReload?: (type: string) => void;
  onReinstall?: (type: string) => void;
  onSignIn?: (type: string) => void;
  isToggling: boolean;
  isReloading?: boolean;
  isReinstalling?: boolean;
  /** When set, shows an "Overridden by …" badge (used for builtin entries). */
  overriddenBy?: string;
  /** Auth-status entry for this adapter, when known. Undefined = still loading. */
  authStatus?: AdapterAuthStatusEntry;
  toggleTitleEnabled?: string;
  toggleTitleDisabled?: string;
  disabledBadgeLabel?: string;
}) {
  const showAuthBadge = authStatus?.supported && authStatus.status;
  const loggedIn = showAuthBadge && authStatus.status?.loggedIn;
  const authMethod = authStatus?.status?.method ?? null;
  const authDetail = authStatus?.status?.detail ?? null;
  const showSignInButton = authStatus?.supported && onSignIn;
  return (
    <li>
      <div className="flex items-center gap-4 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("font-medium", adapter.disabled && "text-muted-foreground line-through")}>
              {adapter.label || getAdapterLabel(adapter.type)}
            </span>
            <Badge variant="outline">{adapter.source === "external" ? "External" : "Built-in"}</Badge>
            {adapter.source === "external" && (
              adapter.isLocalPath
                ? <span title="Installed from local path"><FolderOpen className="h-4 w-4 text-amber-500" /></span>
                : <span title="Installed from npm"><Package className="h-4 w-4 text-red-500" /></span>
            )}
            {adapter.version && (
              <Badge variant="secondary" className="font-mono text-[10px]">
                v{adapter.version}
              </Badge>
            )}
            {adapter.overriddenBuiltin && (
              <Badge variant="secondary" className="text-blue-600 border-blue-400">
                Overrides built-in
              </Badge>
            )}
            {overriddenBy && (
              <Badge variant="secondary" className="text-blue-600 border-blue-400">
                Overridden by {overriddenBy}
              </Badge>
            )}
            {adapter.disabled && (
              <Badge variant="secondary" className="text-amber-600 border-amber-400">
                {disabledBadgeLabel ?? "Hidden from menus"}
              </Badge>
            )}
            {showAuthBadge && (
              loggedIn ? (
                <Badge
                  variant="secondary"
                  className="text-emerald-700 border-emerald-400 dark:text-emerald-400"
                  title={authDetail ?? undefined}
                >
                  {authMethod ?? "Signed in"}
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-amber-600 border-amber-400">
                  Sign-in required
                </Badge>
              )
            )}
          </div>
          {adapter.description && (
            <p className="text-xs text-foreground/80 mt-1 leading-snug">
              {adapter.description}
            </p>
          )}
          <p className="text-xs text-muted-foreground mt-0.5">
            {adapter.type}
            {adapter.packageName && adapter.packageName !== adapter.type && (
              <> · {adapter.packageName}</>
            )}
            {" · "}{adapter.modelsCount} models
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {showSignInButton && (
            <Button
              variant="outline"
              size="icon-sm"
              className="h-8 w-8"
              title={loggedIn ? "Re-authenticate" : "Sign in"}
              onClick={() => onSignIn?.(adapter.type)}
            >
              <LogIn className={cn("h-4 w-4", !loggedIn && "text-amber-600")} />
            </Button>
          )}
          {onReinstall && (
            <Button
              variant="outline"
              size="icon-sm"
              className="h-8 w-8"
              title="Reinstall adapter (pull latest from npm)"
              disabled={isReinstalling}
              onClick={() => onReinstall(adapter.type)}
            >
              <Download className={cn("h-4 w-4", isReinstalling && "animate-bounce")} />
            </Button>
          )}
          {onReload && (
            <Button
              variant="outline"
              size="icon-sm"
              className="h-8 w-8"
              title="Reload adapter (hot-swap)"
              disabled={isReloading}
              onClick={() => onReload(adapter.type)}
            >
              <RefreshCw className={cn("h-4 w-4", isReloading && "animate-spin")} />
            </Button>
          )}
          <Button
            variant="outline"
            size="icon-sm"
            className="h-8 w-8"
            title={adapter.disabled
              ? (toggleTitleEnabled ?? "Show in agent menus")
              : (toggleTitleDisabled ?? "Hide from agent menus")}
            disabled={isToggling}
            onClick={() => onToggle(adapter.type, !adapter.disabled)}
          >
            <Power className={cn("h-4 w-4", !adapter.disabled ? "text-green-600" : "text-muted-foreground")} />
          </Button>
          {canRemove && (
            <Button
              variant="outline"
              size="icon-sm"
              className="h-8 w-8 text-destructive hover:text-destructive"
              title="Remove adapter"
              onClick={() => onRemove(adapter.type)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

function fetchNpmLatestVersion(packageName: string): Promise<string | null> {
  return fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
    signal: AbortSignal.timeout(5000),
  })
    .then((res) => res.json())
    .then((data) => (typeof data?.version === "string" ? (data.version as string) : null))
    .catch(() => null);
}

function ReinstallDialog({
  adapter,
  open,
  isReinstalling,
  onConfirm,
  onCancel,
}: {
  adapter: AdapterInfo | null;
  open: boolean;
  isReinstalling: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { data: latestVersion, isLoading: isFetchingVersion } = useQuery({
    queryKey: ["npm-latest-version", adapter?.packageName],
    queryFn: () => {
      if (!adapter?.packageName) return null;
      return fetchNpmLatestVersion(adapter.packageName);
    },
    enabled: open && !!adapter?.packageName,
    staleTime: 60_000,
  });

  const isUpToDate = adapter?.version && latestVersion && adapter.version === latestVersion;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reinstall Adapter</DialogTitle>
          <DialogDescription>
            This will pull the latest version of{" "}
            <strong>{adapter?.packageName}</strong> from npm and hot-swap
            the running adapter module. Existing agents will use the new
            version on their next run.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border bg-muted/50 px-4 py-3 text-sm space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Package</span>
            <span className="font-mono">{adapter?.packageName}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Current</span>
            <span className="font-mono">
              {adapter?.version ? `v${adapter.version}` : "unknown"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Latest on npm</span>
            <span className="font-mono">
              {isFetchingVersion
                ? "checking..."
                : latestVersion
                  ? `v${latestVersion}`
                  : "unavailable"}
            </span>
          </div>
          {isUpToDate && (
            <p className="text-xs text-muted-foreground pt-1">
              Already on the latest version.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={isReinstalling}>
            Cancel
          </Button>
          <Button disabled={isReinstalling} onClick={onConfirm}>
            {isReinstalling ? "Reinstalling..." : "Reinstall"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatElapsed(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function ClaudeTokenDialog({
  open,
  value,
  onChange,
  onSubmit,
  pending,
  ok,
  expiresAt,
  errorMessage,
  onClose,
}: {
  open: boolean;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  pending: boolean;
  ok: boolean;
  expiresAt: string | null;
  errorMessage: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sign in to claude_local</DialogTitle>
          <DialogDescription>
            In a terminal on the host run{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">claude setup-token</code>, approve
            the sign-in in your browser, then paste the token (starts with{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">sk-ant-oat01-</code>) below. It's
            applied host-wide for all claude_local agents.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="sk-ant-oat01-…"
            rows={3}
            spellCheck={false}
            className="w-full rounded-md border bg-background px-2 py-1 text-sm font-mono"
          />
          {ok && (
            <p className="text-sm text-emerald-700 dark:text-emerald-400">
              ✓ Token applied{expiresAt ? ` — valid until ${new Date(expiresAt).toLocaleDateString()}` : ""}.
            </p>
          )}
          {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Done</Button>
          <Button onClick={onSubmit} disabled={pending || value.trim().length === 0}>
            {pending ? "Saving…" : "Save token"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AdapterLoginDialog({
  adapterType,
  open,
  phase,
  result,
  errorMessage,
  elapsedSec,
  onClose,
}: {
  adapterType: string | null;
  open: boolean;
  phase: "starting" | "running" | "ok" | "error";
  result: AdapterAuthResult | null;
  errorMessage: string | null;
  elapsedSec: number;
  onClose: () => void;
}) {
  const busy = phase === "starting" || phase === "running";
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sign in to {adapterType}</DialogTitle>
          <DialogDescription>
            Paperclip runs an interactive sign-in for the{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">{adapterType}</code> adapter. A
            browser window opens — approve the sign-in there. This can take a minute or two; keep this
            dialog open until it confirms.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border bg-muted/40 px-4 py-3 text-sm space-y-2 min-h-20">
          {phase === "starting" && (
            <p className="text-muted-foreground">Starting sign-in…</p>
          )}
          {phase === "running" && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" />
              <span>Waiting for you to approve the sign-in in your browser… ({formatElapsed(elapsedSec)})</span>
            </div>
          )}
          {result?.loginUrl && (
            <div className="space-y-1">
              <p className="text-foreground">If a browser didn't open, use this URL:</p>
              <a
                href={result.loginUrl}
                target="_blank"
                rel="noreferrer"
                className="text-blue-600 underline underline-offset-2 break-all dark:text-blue-400"
              >
                {result.loginUrl}
              </a>
            </div>
          )}
          {phase === "ok" && (
            <p className="text-emerald-700 dark:text-emerald-400">Signed in successfully.</p>
          )}
          {phase === "error" && (
            <p className="text-destructive">{errorMessage ?? "Sign-in failed."}</p>
          )}
          {!busy && (result?.output || result?.error) && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">Details</summary>
              <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px]">{result?.output || result?.error}</pre>
            </details>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {busy ? "Run in background" : "Done"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AdapterManager() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const [installPackage, setInstallPackage] = useState("");
  const [installVersion, setInstallVersion] = useState("");
  const [isLocalPath, setIsLocalPath] = useState(false);
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [removeType, setRemoveType] = useState<string | null>(null);
  const [reinstallTarget, setReinstallTarget] = useState<AdapterInfo | null>(null);
  const [signInTarget, setSignInTarget] = useState<string | null>(null);
  const [signInJobId, setSignInJobId] = useState<string | null>(null);
  const [signInStartedAt, setSignInStartedAt] = useState<number | null>(null);
  const [signInClock, setSignInClock] = useState<number>(() => Date.now());

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings" },
      { label: "Adapters" },
    ]);
  }, [setBreadcrumbs]);

  const { data: adapters, isLoading } = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: () => adaptersApi.list(),
  });

  const { data: authStatusesData } = useQuery({
    queryKey: queryKeys.adapters.authStatuses,
    queryFn: () => adaptersApi.getAuthStatuses(),
    refetchOnWindowFocus: true,
  });
  const authStatuses: Record<string, AdapterAuthStatusEntry> = authStatusesData?.statuses ?? {};

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.adapters.all });
    queryClient.invalidateQueries({ queryKey: queryKeys.adapters.authStatuses });
  };

  const installMutation = useMutation({
    mutationFn: (params: { packageName: string; version?: string; isLocalPath?: boolean }) =>
      adaptersApi.install(params),
    onSuccess: (result) => {
      invalidate();
      setInstallDialogOpen(false);
      setInstallPackage("");
      setInstallVersion("");
      setIsLocalPath(false);
      pushToast({
        title: "Adapter installed",
        body: `Type "${result.type}" registered successfully.${result.version ? ` (v${result.version})` : ""}`,
        tone: "success",
      });
    },
    onError: (err: Error) => {
      pushToast({ title: "Install failed", body: err.message, tone: "error" });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (type: string) => adaptersApi.remove(type),
    onSuccess: () => {
      invalidate();
      pushToast({ title: "Adapter removed", tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: "Removal failed", body: err.message, tone: "error" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ type, disabled }: { type: string; disabled: boolean }) =>
      adaptersApi.setDisabled(type, disabled),
    onSuccess: () => {
      invalidate();
    },
    onError: (err: Error) => {
      pushToast({ title: "Toggle failed", body: err.message, tone: "error" });
    },
  });

  const overrideMutation = useMutation({
    mutationFn: ({ type, paused }: { type: string; paused: boolean }) =>
      adaptersApi.setOverridePaused(type, paused),
    onSuccess: () => {
      invalidate();
    },
    onError: (err: Error) => {
      pushToast({ title: "Override toggle failed", body: err.message, tone: "error" });
    },
  });

  const reloadMutation = useMutation({
    mutationFn: (type: string) => adaptersApi.reload(type),
    onSuccess: (result) => {
      invalidate();
      invalidateDynamicParser(result.type);
      invalidateConfigSchemaCache(result.type);
      pushToast({
        title: "Adapter reloaded",
        body: `Type "${result.type}" reloaded.${result.version ? ` (v${result.version})` : ""}`,
        tone: "success",
      });
    },
    onError: (err: Error) => {
      pushToast({ title: "Reload failed", body: err.message, tone: "error" });
    },
  });

  const reinstallMutation = useMutation({
    mutationFn: (type: string) => adaptersApi.reinstall(type),
    onSuccess: (result) => {
      invalidate();
      invalidateDynamicParser(result.type);
      invalidateConfigSchemaCache(result.type);
      pushToast({
        title: "Adapter reinstalled",
        body: `Type "${result.type}" updated from npm.${result.version ? ` (v${result.version})` : ""}`,
        tone: "success",
      });
    },
    onError: (err: Error) => {
      pushToast({ title: "Reinstall failed", body: err.message, tone: "error" });
    },
  });

  // Sign-in runs as a background job (it opens a browser and can take 1-2 min):
  // kick it off, then poll for completion so the dialog never looks hung.
  const startSignInMutation = useMutation({
    mutationFn: (type: string) => adaptersApi.authenticate(type),
    onSuccess: (data) => {
      setSignInJobId(data.jobId);
      setSignInStartedAt(Date.now());
    },
  });

  const authJob = useQuery({
    queryKey: ["adapterAuthJob", signInJobId],
    queryFn: () => adaptersApi.getAuthJob(signInJobId as string),
    enabled: signInJobId !== null && signInTarget !== null,
    refetchInterval: (query) => {
      const status = (query.state.data as { status?: string } | undefined)?.status;
      return status === "running" || status === undefined ? 2500 : false;
    },
  });

  // Refresh the auth-status badges once a sign-in lands successfully.
  useEffect(() => {
    if (authJob.data?.status === "ok") {
      queryClient.invalidateQueries({ queryKey: queryKeys.adapters.authStatuses });
    }
  }, [authJob.data?.status, queryClient]);

  const signInBusy =
    startSignInMutation.isPending ||
    (signInJobId !== null && (authJob.data === undefined || authJob.data.status === "running"));

  // Tick an elapsed clock while a sign-in is in flight (drives the dialog timer).
  useEffect(() => {
    if (!signInBusy) return;
    const id = setInterval(() => setSignInClock(Date.now()), 1000);
    return () => clearInterval(id);
  }, [signInBusy]);

  // claude_local uses a pasted long-lived token (terminal `claude setup-token`)
  // applied host-wide, instead of the unreliable spawned interactive sign-in.
  const [hostTokenInput, setHostTokenInput] = useState("");
  const submitClaudeHostToken = useMutation({
    mutationFn: () => adaptersApi.submitToken("claude_local", hostTokenInput.trim()),
    onSuccess: () => {
      setHostTokenInput("");
      queryClient.invalidateQueries({ queryKey: queryKeys.adapters.authStatuses });
    },
  });

  const handleSignIn = (type: string) => {
    setSignInTarget(type);
    if (type === "claude_local") {
      // Paste-token flow — no spawned sign-in.
      setHostTokenInput("");
      submitClaudeHostToken.reset();
      return;
    }
    setSignInJobId(null);
    setSignInStartedAt(Date.now());
    setSignInClock(Date.now());
    startSignInMutation.reset();
    startSignInMutation.mutate(type);
  };

  const handleCloseSignIn = () => {
    // Closing a spawned sign-in while running is fine — the job keeps going
    // server-side; the badge refreshes on the next status poll / window focus.
    setSignInTarget(null);
    setSignInJobId(null);
    setSignInStartedAt(null);
    setHostTokenInput("");
    startSignInMutation.reset();
    submitClaudeHostToken.reset();
    queryClient.invalidateQueries({ queryKey: queryKeys.adapters.authStatuses });
  };

  const signInPhase: "starting" | "running" | "ok" | "error" = startSignInMutation.isError
    ? "error"
    : signInJobId === null
      ? "starting"
      : authJob.data?.status === "ok"
        ? "ok"
        : authJob.data?.status === "error"
          ? "error"
          : "running";
  const signInElapsed =
    signInStartedAt !== null ? Math.max(0, Math.floor((signInClock - signInStartedAt) / 1000)) : 0;
  const signInResult = authJob.data?.result ?? null;
  const signInErrorMessage =
    startSignInMutation.error instanceof Error
      ? startSignInMutation.error.message
      : authJob.data?.error ?? (authJob.isError ? "Lost track of the sign-in — try again." : null);

  const builtinAdapters = (adapters ?? []).filter((a) => a.source === "builtin");
  const externalAdapters = (adapters ?? []).filter((a) => a.source === "external");

  // External adapters that override a builtin type.  The server only returns
  // one entry per type (the external), so we synthesize a builtin row for
  // the builtins section so users can see which builtins are affected.
  const overriddenBuiltins = (adapters ?? [])
    .filter((a) => a.source === "external" && a.overriddenBuiltin)
    .filter((a) => !builtinAdapters.some((b) => b.type === a.type))
    .map((a) => ({
      type: a.type,
      label: getAdapterLabel(a.type),
      overriddenBy: [
        a.packageName,
        a.version ? `v${a.version}` : undefined,
      ].filter(Boolean).join(" "),
      overridePaused: !!a.overridePaused,
      menuDisabled: !!a.disabled,
    }));

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground">Loading adapters...</div>;

  const isMutating = installMutation.isPending || removeMutation.isPending || toggleMutation.isPending || overrideMutation.isPending || reloadMutation.isPending || reinstallMutation.isPending;

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cpu className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Adapters</h1>
          <Badge variant="outline" className="text-amber-600 border-amber-400">
            Alpha
          </Badge>
        </div>

        <Dialog open={installDialogOpen} onOpenChange={setInstallDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-2">
              <Plus className="h-4 w-4" />
              Install Adapter
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Install External Adapter</DialogTitle>
              <DialogDescription>
                Add an adapter from npm or a local path. The adapter package must export <code className="text-xs bg-muted px-1 py-0.5 rounded">createServerAdapter()</code>.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              {/* Source toggle */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors",
                    !isLocalPath
                      ? "border-foreground bg-accent text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/50"
                  )}
                  onClick={() => setIsLocalPath(false)}
                >
                  <Package className="h-3.5 w-3.5" />
                  npm package
                </button>
                <button
                  type="button"
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors",
                    isLocalPath
                      ? "border-foreground bg-accent text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/50"
                  )}
                  onClick={() => setIsLocalPath(true)}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  Local path
                </button>
              </div>

              {isLocalPath ? (
                /* Local path input */
                <div className="grid gap-2">
                  <Label htmlFor="adapterLocalPath">Path to adapter package</Label>
                  <div className="flex gap-2">
                    <Input
                      id="adapterLocalPath"
                      className="flex-1 font-mono text-xs"
                      placeholder="/mnt/e/Projects/my-adapter  or  E:\Projects\my-adapter"
                      value={installPackage}
                      onChange={(e) => setInstallPackage(e.target.value)}
                    />
                    <ChoosePathButton />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Accepts Linux, WSL, and Windows paths. Windows paths are auto-converted.
                  </p>
                </div>
              ) : (
                /* npm package input */
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="adapterPackageName">Package Name</Label>
                    <Input
                      id="adapterPackageName"
                      placeholder="my-paperclip-adapter"
                      value={installPackage}
                      onChange={(e) => setInstallPackage(e.target.value)}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="adapterVersion">Version (optional)</Label>
                    <Input
                      id="adapterVersion"
                      placeholder="latest"
                      value={installVersion}
                      onChange={(e) => setInstallVersion(e.target.value)}
                    />
                  </div>
                </>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setInstallDialogOpen(false)}>Cancel</Button>
              <Button
                onClick={() =>
                  installMutation.mutate({
                    packageName: installPackage,
                    version: installVersion || undefined,
                    isLocalPath,
                  })
                }
                disabled={!installPackage || installMutation.isPending}
              >
                {installMutation.isPending ? "Installing..." : "Install"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Alpha notice */}
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
          <div className="space-y-1 text-sm">
            <p className="font-medium text-foreground">External adapters are alpha.</p>
            <p className="text-muted-foreground">
              The adapter plugin system is under active development. APIs and storage format may change.
              Use the power icon to hide adapters from agent menus without removing them.
            </p>
          </div>
        </div>
      </div>

      {/* External adapters */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Cpu className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">External Adapters</h2>
        </div>

        {externalAdapters.length === 0 ? (
          <Card className="bg-muted/30">
            <CardContent className="flex flex-col items-center justify-center py-10">
              <Cpu className="h-10 w-10 text-muted-foreground mb-4" />
              <p className="text-sm font-medium">No external adapters installed</p>
              <p className="text-xs text-muted-foreground mt-1">
                Install an adapter package to extend model support.
              </p>
            </CardContent>
          </Card>
        ) : (
          <ul className="divide-y rounded-md border bg-card">
            {externalAdapters.map((adapter) => {
              const isBuiltinOverride = adapter.overriddenBuiltin;
              const overridePaused = isBuiltinOverride && !!adapter.overridePaused;

              // For overridden builtins, the power button controls the
              // override pause state (not server menu visibility).
              const effectiveAdapter: AdapterInfo = isBuiltinOverride
                ? { ...adapter, disabled: overridePaused ?? false }
                : adapter;

              return (
                <AdapterRow
                  key={adapter.type}
                  adapter={effectiveAdapter}
                  canRemove={true}
                  onToggle={
                    isBuiltinOverride
                      ? (type, disabled) => overrideMutation.mutate({ type, paused: disabled })
                      : (type, disabled) => toggleMutation.mutate({ type, disabled })
                  }
                  onRemove={(type) => setRemoveType(type)}
                  onReload={(type) => reloadMutation.mutate(type)}
                  onReinstall={!adapter.isLocalPath ? (type) => setReinstallTarget(adapter) : undefined}
                  onSignIn={authStatuses[adapter.type]?.supported ? handleSignIn : undefined}
                  authStatus={authStatuses[adapter.type]}
                  isToggling={isBuiltinOverride ? overrideMutation.isPending : toggleMutation.isPending}
                  isReloading={reloadMutation.isPending}
                  isReinstalling={reinstallMutation.isPending}
                  toggleTitleDisabled={isBuiltinOverride ? "Pause external override" : undefined}
                  toggleTitleEnabled={isBuiltinOverride ? "Resume external override" : undefined}
                  disabledBadgeLabel={isBuiltinOverride ? "Override paused" : undefined}
                />
              );
            })}
          </ul>
        )}
      </section>

      {/* Built-in adapters */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Cpu className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">Built-in Adapters</h2>
        </div>

        {builtinAdapters.length === 0 && overriddenBuiltins.length === 0 ? (
          <div className="text-sm text-muted-foreground">No built-in adapters found.</div>
        ) : (
          <ul className="divide-y rounded-md border bg-card">
            {builtinAdapters.map((adapter) => (
              <AdapterRow
                key={adapter.type}
                adapter={adapter}
                canRemove={false}
                onToggle={(type, disabled) => toggleMutation.mutate({ type, disabled })}
                onRemove={() => {}}
                onSignIn={authStatuses[adapter.type]?.supported ? handleSignIn : undefined}
                authStatus={authStatuses[adapter.type]}
                isToggling={isMutating}
              />
            ))}
            {overriddenBuiltins.map((virtual) => (
              <AdapterRow
                key={virtual.type}
                adapter={{
                  type: virtual.type,
                  label: virtual.label,
                  source: "builtin",
                  modelsCount: 0,
                  loaded: true,
                  disabled: virtual.menuDisabled,
                  capabilities: {
                    supportsInstructionsBundle: false,
                    supportsSkills: false,
                    supportsLocalAgentJwt: false,
                    requiresMaterializedRuntimeSkills: false,
                  },
                }}
                canRemove={false}
                onToggle={(type, disabled) => toggleMutation.mutate({ type, disabled })}
                onRemove={() => {}}
                authStatus={authStatuses[virtual.type]}
                isToggling={isMutating}
                overriddenBy={virtual.overridePaused ? undefined : virtual.overriddenBy}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Remove confirmation */}
      <Dialog
        open={removeType !== null}
        onOpenChange={(open) => { if (!open) setRemoveType(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove Adapter</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove the <strong>{removeType}</strong> adapter?
              It will be unregistered and removed from the adapter store.
              {removeType && adapters?.find((a) => a.type === removeType)?.packageName && (
                <> npm packages will be cleaned up from disk.</>
              )}
              {" "}This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveType(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={removeMutation.isPending}
              onClick={() => {
                if (removeType) {
                  removeMutation.mutate(removeType, {
                    onSettled: () => setRemoveType(null),
                  });
                }
              }}
            >
              {removeMutation.isPending ? "Removing..." : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Reinstall confirmation */}
      <ReinstallDialog
        adapter={reinstallTarget}
        open={reinstallTarget !== null}
        isReinstalling={reinstallMutation.isPending}
        onConfirm={() => {
          if (reinstallTarget) {
            reinstallMutation.mutate(reinstallTarget.type, {
              onSettled: () => setReinstallTarget(null),
            });
          }
        }}
        onCancel={() => setReinstallTarget(null)}
      />
      {/* Adapter sign-in flow */}
      {signInTarget === "claude_local" ? (
        <ClaudeTokenDialog
          open
          value={hostTokenInput}
          onChange={setHostTokenInput}
          onSubmit={() => submitClaudeHostToken.mutate()}
          pending={submitClaudeHostToken.isPending}
          ok={submitClaudeHostToken.data?.ok ?? false}
          expiresAt={submitClaudeHostToken.data?.expiresAt ?? null}
          errorMessage={
            submitClaudeHostToken.error instanceof Error ? submitClaudeHostToken.error.message : null
          }
          onClose={handleCloseSignIn}
        />
      ) : (
        <AdapterLoginDialog
          adapterType={signInTarget}
          open={signInTarget !== null}
          phase={signInPhase}
          result={signInResult}
          errorMessage={signInErrorMessage}
          elapsedSec={signInElapsed}
          onClose={handleCloseSignIn}
        />
      )}
    </div>
  );
}
