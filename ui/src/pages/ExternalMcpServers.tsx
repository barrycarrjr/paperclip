/**
 * External MCP Servers manager.
 *
 * Board-only page for registering external Model Context Protocol servers
 * (stdio / http / sse). Tools from these servers become callable by agents
 * in the listed `allowedCompanies`. Mirrors the role of PluginManager but
 * for non-bundled, externally-distributed MCP servers.
 *
 * Reuses existing form components:
 *   - `EnvVarEditor` — same shape projects + agents use; secret refs are
 *     resolved against the **calling company's** vault by name at spawn time.
 *   - `CompanyMultiSelectField` — same "Portfolio-wide / per-company"
 *     checkbox pattern plugin instanceConfig uses for `format: company-id`
 *     arrays.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Network,
  Plus,
  RefreshCw,
  Trash,
} from "lucide-react";
import type {
  CompanySecret,
  CreateExternalMcpServer,
  EnvBinding,
  ExternalMcpBindings,
  ExternalMcpServerRecord,
  ExternalMcpTestConnectResult,
  ExternalMcpTransport,
} from "@paperclipai/shared";
import { isPortfolioWide } from "@paperclipai/shared";
import { externalMcpServersApi } from "@/api/external-mcp-servers";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToastActions } from "@/context/ToastContext";
import { useCompany } from "@/context/CompanyContext";
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
} from "@/components/ui/dialog";
import { EnvVarEditor } from "@/components/EnvVarEditor";
import { CompanyMultiSelectField } from "@/components/JsonSchemaForm";
import { api } from "@/api/client";
import { cn } from "@/lib/utils";

const QUERY_KEY = ["external-mcp-servers"] as const;

interface FormState {
  key: string;
  displayName: string;
  description: string;
  transport: ExternalMcpTransport;
  command: string;
  argsRaw: string;
  url: string;
  envBindings: ExternalMcpBindings;
  headerBindings: ExternalMcpBindings;
  allowedCompanies: string[];
  allowMutations: boolean;
  writeAllowListRaw: string;
  toolAllowListRaw: string;
  toolDenyListRaw: string;
}

const emptyForm: FormState = {
  key: "",
  displayName: "",
  description: "",
  transport: "stdio",
  command: "npx",
  argsRaw: "",
  url: "",
  envBindings: {},
  headerBindings: {},
  allowedCompanies: [],
  allowMutations: false,
  writeAllowListRaw: "",
  toolAllowListRaw: "",
  toolDenyListRaw: "",
};

function splitLines(raw: string): string[] {
  return raw
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function formToCreatePayload(form: FormState): CreateExternalMcpServer {
  return {
    key: form.key.trim(),
    displayName: form.displayName.trim(),
    description: form.description.trim() || null,
    transport: form.transport,
    command: form.transport === "stdio" ? form.command.trim() || null : null,
    args: form.transport === "stdio" ? splitLines(form.argsRaw) : null,
    url: form.transport !== "stdio" ? form.url.trim() || null : null,
    envBindings: form.envBindings,
    headerBindings: form.headerBindings,
    allowedCompanies: form.allowedCompanies,
    allowMutations: form.allowMutations,
    writeAllowList: splitLines(form.writeAllowListRaw),
    toolAllowList: splitLines(form.toolAllowListRaw),
    toolDenyList: splitLines(form.toolDenyListRaw),
  };
}

export function ExternalMcpServers() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const { selectedCompanyId } = useCompany();

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance", href: "/instance/settings/general" },
      { label: "External MCP servers" },
    ]);
  }, [setBreadcrumbs]);

  const { data, isLoading, isFetching, dataUpdatedAt, error, refetch } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => externalMcpServersApi.list(),
  });

  // See InternalPluginBridgeCard for rationale: localhost fetches return so
  // fast that a CSS spin animation is imperceptible, so we hold the spin state
  // for at least 500ms after a manual click for visible feedback.
  const [minListSpinning, setMinListSpinning] = useState(false);
  const listSpinning = isFetching || minListSpinning;
  const handleListRefresh = () => {
    setMinListSpinning(true);
    void refetch();
    window.setTimeout(() => setMinListSpinning(false), 500);
  };

  // Fetch the selected company's secrets so EnvVarEditor can offer them in
  // the "Secret" picker. Bindings store the secret by NAME, so each company
  // ends up resolving the same MCP server config against its own vault.
  const { data: secrets } = useQuery({
    queryKey: ["company-secrets", selectedCompanyId],
    queryFn: () =>
      selectedCompanyId
        ? api.get<CompanySecret[]>(`/companies/${selectedCompanyId}/secrets`)
        : Promise.resolve([] as CompanySecret[]),
    enabled: Boolean(selectedCompanyId),
  });

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [deleteTarget, setDeleteTarget] = useState<ExternalMcpServerRecord | null>(null);
  const [testTarget, setTestTarget] = useState<ExternalMcpServerRecord | null>(null);
  const [testCompanyId, setTestCompanyId] = useState("");
  const [testResult, setTestResult] = useState<ExternalMcpTestConnectResult | null>(null);

  const createMutation = useMutation({
    mutationFn: (payload: CreateExternalMcpServer) => externalMcpServersApi.create(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      setCreateDialogOpen(false);
      setForm(emptyForm);
      pushToast({ tone: "success", title: "MCP server registered" });
    },
    onError: (err: Error) => {
      pushToast({ tone: "error", title: "Failed to register", body: err.message });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => externalMcpServersApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      setDeleteTarget(null);
      pushToast({ tone: "success", title: "MCP server removed" });
    },
    onError: (err: Error) => {
      pushToast({ tone: "error", title: "Failed to remove", body: err.message });
    },
  });

  const testMutation = useMutation({
    mutationFn: (input: { id: string; companyId: string }) =>
      externalMcpServersApi.testConnect(input.id, input.companyId),
    onSuccess: (result) => {
      setTestResult(result);
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (err: Error) => {
      setTestResult({
        ok: false,
        toolCount: 0,
        tools: [],
        error: err.message,
      });
    },
  });

  const sortedRows = useMemo(
    () => (data ? [...data].sort((a, b) => a.key.localeCompare(b.key)) : []),
    [data],
  );

  function handleEnvChange(env: Record<string, EnvBinding> | undefined) {
    setForm((f) => ({ ...f, envBindings: env ?? {} }));
  }
  function handleHeadersChange(env: Record<string, EnvBinding> | undefined) {
    setForm((f) => ({ ...f, headerBindings: env ?? {} }));
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Network className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">External MCP servers</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleListRefresh}
            disabled={listSpinning}
            title={
              dataUpdatedAt
                ? `Refresh server list (last: ${new Date(dataUpdatedAt).toLocaleTimeString()})`
                : "Refresh server list"
            }
          >
            <RefreshCw className={cn("h-4 w-4", listSpinning && "animate-spin")} />
          </Button>
          <Button size="sm" onClick={() => setCreateDialogOpen(true)}>
            <Plus className="mr-1 h-4 w-4" /> Register server
          </Button>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        Register external Model Context Protocol servers so their tools become callable by agents in
        the listed companies. Tools are exposed under the namespace{" "}
        <code className="rounded bg-muted px-1 text-xs">mcp:&lt;server-key&gt;:&lt;tool&gt;</code>.
        Use this for community MCP servers (Notion, Linear, etc.); for first-party integrations
        (Help Scout, Stripe) prefer the polished <strong>Plugin</strong> path instead.
      </p>

      <InternalPluginBridgeCard />

      {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
      {error && (
        <Card>
          <CardContent className="py-4 text-sm text-destructive">
            Failed to load: {(error as Error).message}
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {sortedRows.map((row) => (
          <Card key={row.id}>
            <CardContent className="space-y-2 py-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-semibold">{row.key}</span>
                    <Badge variant="secondary">{row.transport}</Badge>
                    {row.allowMutations ? (
                      <Badge variant="destructive">writes on</Badge>
                    ) : (
                      <Badge variant="outline">read-only</Badge>
                    )}
                  </div>
                  <div className="text-sm text-muted-foreground">{row.displayName}</div>
                  {row.description && (
                    <div className="mt-1 text-xs text-muted-foreground">{row.description}</div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setTestTarget(row);
                      setTestCompanyId(
                        isPortfolioWide(row.allowedCompanies)
                          ? selectedCompanyId ?? ""
                          : row.allowedCompanies[0] ?? "",
                      );
                      setTestResult(null);
                    }}
                  >
                    Test connect
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(row)}>
                    <Trash className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {row.transport === "stdio" ? (
                  <div>
                    <span className="font-medium">command:</span>{" "}
                    <code>
                      {row.command} {(row.args ?? []).join(" ")}
                    </code>
                  </div>
                ) : (
                  <div>
                    <span className="font-medium">url:</span> <code>{row.url}</code>
                  </div>
                )}
                <div>
                  <span className="font-medium">env bindings:</span>{" "}
                  {Object.keys(row.envBindings).length}
                </div>
                <div>
                  <span className="font-medium">header bindings:</span>{" "}
                  {Object.keys(row.headerBindings).length}
                </div>
                <div>
                  <span className="font-medium">allowed companies:</span>{" "}
                  {row.allowedCompanies.length === 0 ? (
                    <span className="text-destructive">none (unusable)</span>
                  ) : isPortfolioWide(row.allowedCompanies) ? (
                    "Portfolio-wide"
                  ) : (
                    row.allowedCompanies.length
                  )}
                </div>
              </div>
              {row.lastError && (
                <div className="flex items-start gap-2 rounded border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{row.lastError}</span>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
        {sortedRows.length === 0 && !isLoading && (
          <Card>
            <CardContent className="py-6 text-center text-sm text-muted-foreground">
              No external MCP servers registered yet. Click <strong>Register server</strong> to add
              one.
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-auto">
          <DialogHeader>
            <DialogTitle>Register external MCP server</DialogTitle>
            <DialogDescription>
              Use stdio for npm-distributed servers (run via npx) or http/sse for remote endpoints.
              Bind credentials by referencing existing company secrets — each company resolves the
              binding against its own vault.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="key">Key</Label>
                <Input
                  id="key"
                  placeholder="notion"
                  value={form.key}
                  onChange={(e) => setForm({ ...form, key: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="displayName">Display name</Label>
                <Input
                  id="displayName"
                  placeholder="Notion"
                  value={form.displayName}
                  onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                />
              </div>
            </div>

            <div>
              <Label htmlFor="description">Description (optional)</Label>
              <Input
                id="description"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>

            <div>
              <Label htmlFor="transport">Transport</Label>
              <select
                id="transport"
                className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={form.transport}
                onChange={(e) => setForm({ ...form, transport: e.target.value as ExternalMcpTransport })}
              >
                <option value="stdio">stdio (npx / node)</option>
                <option value="http">http (Streamable HTTP)</option>
                <option value="sse">sse</option>
              </select>
            </div>

            {form.transport === "stdio" ? (
              <>
                <div>
                  <Label htmlFor="command">Command</Label>
                  <Input
                    id="command"
                    placeholder="npx"
                    value={form.command}
                    onChange={(e) => setForm({ ...form, command: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="args">Args (one per line or comma-separated)</Label>
                  <textarea
                    id="args"
                    className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
                    rows={3}
                    placeholder={`-y\n@modelcontextprotocol/server-filesystem\n/tmp`}
                    value={form.argsRaw}
                    onChange={(e) => setForm({ ...form, argsRaw: e.target.value })}
                  />
                </div>
              </>
            ) : (
              <div>
                <Label htmlFor="url">URL</Label>
                <Input
                  id="url"
                  placeholder="https://example.com/mcp"
                  value={form.url}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                />
              </div>
            )}

            {form.transport === "stdio" && (
              <div>
                <Label>Env bindings</Label>
                <div className="mt-1.5">
                  <EnvVarEditor
                    value={form.envBindings}
                    secrets={secrets ?? []}
                    onChange={handleEnvChange}
                  />
                </div>
              </div>
            )}

            {form.transport !== "stdio" && (
              <div>
                <Label>Header bindings</Label>
                <div className="mt-1.5">
                  <EnvVarEditor
                    value={form.headerBindings}
                    secrets={secrets ?? []}
                    onChange={handleHeadersChange}
                  />
                </div>
              </div>
            )}

            <CompanyMultiSelectField
              value={form.allowedCompanies}
              onChange={(val) =>
                setForm((f) => ({
                  ...f,
                  allowedCompanies: Array.isArray(val) ? (val as string[]) : [],
                }))
              }
              disabled={false}
              label="Allowed companies"
              description="Companies whose agents may call this MCP server's tools. Empty = unusable (fail-safe deny)."
            />

            <div className="flex items-center gap-2">
              <input
                id="allowMutations"
                type="checkbox"
                checked={form.allowMutations}
                onChange={(e) => setForm({ ...form, allowMutations: e.target.checked })}
              />
              <Label htmlFor="allowMutations">Allow mutations (create/update/delete tools)</Label>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label htmlFor="writeAllowList">Write allow-list</Label>
                <textarea
                  id="writeAllowList"
                  rows={2}
                  className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-xs"
                  value={form.writeAllowListRaw}
                  onChange={(e) => setForm({ ...form, writeAllowListRaw: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="toolAllowList">Tool allow-list</Label>
                <textarea
                  id="toolAllowList"
                  rows={2}
                  className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-xs"
                  value={form.toolAllowListRaw}
                  onChange={(e) => setForm({ ...form, toolAllowListRaw: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="toolDenyList">Tool deny-list</Label>
                <textarea
                  id="toolDenyList"
                  rows={2}
                  className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-xs"
                  value={form.toolDenyListRaw}
                  onChange={(e) => setForm({ ...form, toolDenyListRaw: e.target.value })}
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createMutation.mutate(formToCreatePayload(form))}
              disabled={createMutation.isPending || !form.key.trim() || !form.displayName.trim()}
            >
              {createMutation.isPending ? "Saving…" : "Register"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove MCP server?</DialogTitle>
            <DialogDescription>
              This stops all running clients for <code>{deleteTarget?.key}</code> and removes its
              config. Agents will no longer see its tools. Bound secrets are not deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Removing…" : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={testTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setTestTarget(null);
            setTestResult(null);
          }
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Test connect — {testTarget?.key}</DialogTitle>
            <DialogDescription>
              Spawn the server with the bindings resolved for the chosen company, run{" "}
              <code>tools/list</code>, and report the discovered tools.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="testCompanyId">Company UUID</Label>
              <Input
                id="testCompanyId"
                value={testCompanyId}
                onChange={(e) => setTestCompanyId(e.target.value)}
              />
              {testTarget &&
                !isPortfolioWide(testTarget.allowedCompanies) &&
                testTarget.allowedCompanies.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {testTarget.allowedCompanies.map((cid) => (
                      <button
                        key={cid}
                        className="rounded border px-2 py-0.5 font-mono text-xs hover:bg-muted"
                        onClick={() => setTestCompanyId(cid)}
                      >
                        {cid.slice(0, 8)}…
                      </button>
                    ))}
                  </div>
                )}
            </div>
            {testResult && (
              <div className="rounded border p-3 text-sm">
                {testResult.ok ? (
                  <div className="flex items-center gap-2 text-green-600">
                    <CheckCircle2 className="h-4 w-4" />
                    Connected. {testResult.toolCount} tool(s) discovered.
                  </div>
                ) : (
                  <div className="flex items-start gap-2 text-destructive">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{testResult.error}</span>
                  </div>
                )}
                {testResult.tools.length > 0 && (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                    {testResult.tools.map((t) => (
                      <li key={t.name}>
                        <span className="font-mono">{t.name}</span> — {t.description}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setTestTarget(null);
                setTestResult(null);
              }}
            >
              Close
            </Button>
            <Button
              onClick={() =>
                testTarget &&
                testCompanyId.trim() &&
                testMutation.mutate({ id: testTarget.id, companyId: testCompanyId.trim() })
              }
              disabled={testMutation.isPending || !testCompanyId.trim()}
            >
              {testMutation.isPending ? "Connecting…" : "Run probe"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Internal Plugin Bridge status card ─────────────────────────────────
//
// Read-only sibling to the External MCP servers list. Surfaces the
// in-process MCP server that exposes plugin tools to spawned LLM
// subprocesses (e.g. Claude Code via the claude_local adapter). Operators
// can't configure it — it's auto-managed by chat sessions — but visibility
// here removes the "where do plugin tools live for adapter chats?" mystery.

interface BridgeStatus {
  enabled: boolean;
  activeTokenCount: number;
  totalMinted: number;
  totalRevoked: number;
  defaultTtlMs: number;
}

function InternalPluginBridgeCard() {
  const { data, error, isLoading, isFetching, dataUpdatedAt, refetch } = useQuery<BridgeStatus>({
    queryKey: ["plugin-mcp-bridge-status"] as const,
    queryFn: async () => api.get("/internal/mcp-bridge/status") as Promise<BridgeStatus>,
    refetchInterval: 15_000,
    staleTime: 5_000,
  });

  // Local-server fetches return in single-digit ms — too fast for a CSS spin
  // animation to register visually. Hold the spin state for at least 500ms
  // after a manual click so the user gets perceptible feedback that the button
  // did something.
  const [minSpinning, setMinSpinning] = useState(false);
  const spinning = isFetching || minSpinning;
  const handleRefresh = () => {
    setMinSpinning(true);
    void refetch();
    window.setTimeout(() => setMinSpinning(false), 500);
  };

  return (
    <Card className="border-dashed">
      <CardContent className="space-y-2 py-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-semibold">paperclip (internal)</span>
              <Badge
                variant="secondary"
                className={
                  data?.enabled
                    ? "text-emerald-700 border-emerald-400 dark:text-emerald-400"
                    : undefined
                }
              >
                {isLoading ? "checking…" : data?.enabled ? "running" : "off"}
              </Badge>
              <Badge variant="outline">auto-managed</Badge>
            </div>
            <div className="text-sm text-muted-foreground">Internal Plugin Bridge</div>
            <div className="mt-1 text-xs text-muted-foreground">
              In-process MCP server that exposes installed plugin tools to spawned LLM
              subprocesses (Claude Code via the claude_local adapter, etc.). Auto-managed by
              chat sessions — no operator action needed. Sits next to the External MCP
              servers below, role-inverted: Paperclip is the server here, not the client.
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            disabled={spinning}
            title={
              dataUpdatedAt
                ? `Refresh bridge status (last: ${new Date(dataUpdatedAt).toLocaleTimeString()})`
                : "Refresh bridge status"
            }
          >
            <RefreshCw className={cn("h-4 w-4", spinning && "animate-spin")} />
          </Button>
        </div>
        {error && (
          <div className="text-xs text-destructive">
            Failed to load bridge status: {(error as Error).message}
          </div>
        )}
        {data && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
            <div>
              <span className="text-foreground">Active tokens: </span>
              <span className="font-mono">{data.activeTokenCount}</span>
            </div>
            <div>
              <span className="text-foreground">Minted (since boot): </span>
              <span className="font-mono">{data.totalMinted}</span>
            </div>
            <div>
              <span className="text-foreground">Revoked (since boot): </span>
              <span className="font-mono">{data.totalRevoked}</span>
            </div>
            <div>
              <span className="text-foreground">Token TTL: </span>
              <span className="font-mono">{Math.round(data.defaultTtlMs / 60_000)}m</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
