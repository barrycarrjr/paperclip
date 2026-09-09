/**
 * PluginToolDispatcher — orchestrates plugin tool discovery, lifecycle
 * integration, and execution routing for the agent service.
 *
 * This service sits between the agent service and the lower-level
 * `PluginToolRegistry` + `PluginWorkerManager`, providing a clean API that:
 *
 * - Discovers tools from loaded plugin manifests and registers them
 *   in the tool registry.
 * - Hooks into `PluginLifecycleManager` events to automatically register
 *   and unregister tools when plugins are enabled or disabled.
 * - Exposes the tool list in an agent-friendly format (with namespaced
 *   names, descriptions, parameter schemas).
 * - Routes `executeTool` calls to the correct plugin worker and returns
 *   structured results.
 * - Validates tool parameters against declared schemas before dispatch.
 *
 * The dispatcher is created once at server startup and shared across
 * the application.
 *
 * @see PLUGIN_SPEC.md §11 — Agent Tools
 * @see PLUGIN_SPEC.md §13.10 — `executeTool`
 */

import type { Db } from "@paperclipai/db";
import type {
  PaperclipPluginManifestV1,
  PluginOperationPolicy,
  PluginRecord,
} from "@paperclipai/shared";
import type { ToolRunContext, ToolResult } from "@paperclipai/plugin-sdk";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import type { PluginLifecycleManager } from "./plugin-lifecycle.js";
import {
  createPluginToolRegistry,
  type PluginToolRegistry,
  type RegisteredTool,
  type ToolListFilter,
  type ToolExecutionResult,
} from "./plugin-tool-registry.js";
import { pluginRegistryService } from "./plugin-registry.js";
import type { ExternalMcpToolSource } from "./external-mcp-tool-source.js";
import type { ExternalMcpServerManager } from "./external-mcp-server-manager.js";
import type { DraftGate } from "./tool-draft-gate.js";
import {
  deriveIdempotencyKey,
  type OperationCallKey,
  type PluginOperationIdempotencyStore,
} from "./plugin-operation-idempotency.js";
import { EXTERNAL_MCP_TOOL_NAMESPACE, isCompanyAllowed } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * An agent-facing tool descriptor — the shape returned when agents
 * query for available tools.
 *
 * This is intentionally simpler than `RegisteredTool`, exposing only
 * what agents need to decide whether and how to call a tool.
 */
export interface AgentToolDescriptor {
  /** Fully namespaced tool name (e.g. `"acme.linear:search-issues"`). */
  name: string;
  /** Human-readable display name. */
  displayName: string;
  /** Description for the agent — explains when and how to use this tool. */
  description: string;
  /** JSON Schema describing the tool's input parameters. */
  parametersSchema: Record<string, unknown>;
  /** The plugin that provides this tool. */
  pluginId: string;
}

/**
 * Options for creating the plugin tool dispatcher.
 */
export interface PluginToolDispatcherOptions {
  /** The worker manager used to dispatch RPC calls to plugin workers. */
  workerManager?: PluginWorkerManager;
  /** The lifecycle manager to listen for plugin state changes. */
  lifecycleManager?: PluginLifecycleManager;
  /** Database connection for looking up plugin records. */
  db?: Db;
  /**
   * External MCP tool source — supplies tools from operator-registered
   * external MCP servers. Optional; when omitted, only plugin tools surface.
   */
  externalMcpToolSource?: ExternalMcpToolSource;
  /**
   * External MCP server manager — handles `tools/call` for `mcp:*`
   * namespaced tool names. Required if `externalMcpToolSource` is provided.
   */
  externalMcpServerManager?: ExternalMcpServerManager;
  /**
   * Optional draft gate — when provided, mutating outbound tools (email
   * send, Slack DM, outbound call, etc.) are intercepted and queued as
   * pending approvals instead of executed immediately. The dispatcher
   * returns a synthesized "drafted" result to the agent. See
   * `tool-draft-gate.ts` for policy.
   */
  draftGate?: DraftGate;
  /**
   * Optional repeat-protection store. When provided, a tool or operation
   * declared `writes: true` is claimed before it runs, so an agent retrying a
   * call whose response was lost replays the first result instead of doing the
   * work a second time.
   *
   * Omitted in tests that do not care, and in any host without a database. The
   * dispatcher runs writing operations unprotected in that case, which is the
   * behaviour it had before this existed.
   */
  idempotencyStore?: PluginOperationIdempotencyStore;
}

/**
 * Per-call flags for `executeTool`.
 */
export interface ExecuteToolOptions {
  /**
   * When true, the dispatcher skips the outbound tool draft gate even if the
   * tool is in the gated set. Set by `executeDraftedApproval` when re-running
   * a tool whose draft has already been approved — without this, the gate
   * would intercept the re-dispatch and queue a fresh pending approval,
   * looping on every approve click.
   */
  bypassDraftGate?: boolean;
  /**
   * When true, the tool is drafted for approval even if the instance-wide
   * outbound hold is off (and even if every recipient looks like the
   * operator). The mirror image of `bypassDraftGate`, for a caller whose own
   * policy is stricter than the instance default — today that is a reply
   * closing an email handoff, where the operator can ask for these
   * specifically to always wait. See `emailHandoffReplyNeedsApproval`.
   *
   * Ignored when `bypassDraftGate` is also set: an already-approved draft
   * being replayed must never be re-queued, or approving it would loop.
   */
  forceDraftGate?: boolean;
}

/**
 * Filter shape extended to support per-company external MCP tool listing.
 */
export interface AgentToolListFilter extends ToolListFilter {
  /**
   * If provided, also include tools from external MCP servers whose
   * `allowedCompanies` includes this company. Plugin tools are unaffected
   * (plugin company-scoping is enforced elsewhere).
   */
  companyId?: string;
}

// ---------------------------------------------------------------------------
// PluginToolDispatcher interface
// ---------------------------------------------------------------------------

/**
 * The plugin tool dispatcher — the primary integration point between the
 * agent service and the plugin tool system.
 *
 * Agents use this service to:
 * 1. List all available tools (for prompt construction / tool choice)
 * 2. Execute a specific tool by its namespaced name
 *
 * The dispatcher handles lifecycle management internally — when a plugin
 * is loaded or unloaded, its tools are automatically registered or removed.
 */
export interface PluginToolDispatcher {
  /**
   * Initialize the dispatcher — load tools from all currently-ready plugins
   * and start listening for lifecycle events.
   *
   * Must be called once at server startup after the lifecycle manager
   * and worker manager are ready.
   */
  initialize(): Promise<void>;

  /**
   * Tear down the dispatcher — unregister lifecycle event listeners
   * and clear all tool registrations.
   *
   * Called during server shutdown.
   */
  teardown(): void;

  /**
   * List all available tools for agents, optionally filtered.
   *
   * Returns tool descriptors in an agent-friendly format. Plugin tools are
   * always included; external MCP tools are included when `filter.companyId`
   * is provided and the server's `allowedCompanies` matches.
   *
   * @param filter - Optional filter criteria
   * @returns Array of agent tool descriptors
   */
  listToolsForAgent(filter?: AgentToolListFilter): Promise<AgentToolDescriptor[]>;

  /**
   * Look up a tool by its namespaced name.
   *
   * @param namespacedName - e.g. `"acme.linear:search-issues"`
   * @returns The registered tool, or `null` if not found
   */
  getTool(namespacedName: string): RegisteredTool | null;

  /**
   * Execute a tool by its namespaced name, routing to the correct
   * plugin worker.
   *
   * @param namespacedName - Fully qualified tool name
   * @param parameters - Input parameters matching the tool's schema
   * @param runContext - Agent run context
   * @param options - Optional execution flags
   * @returns The execution result with routing metadata
   * @throws {Error} if the tool is not found, the worker is not running,
   *   or the tool execution fails
   */
  executeTool(
    namespacedName: string,
    parameters: unknown,
    runContext: ToolRunContext,
    options?: ExecuteToolOptions,
  ): Promise<ToolExecutionResult>;

  /**
   * Register all tools from a plugin manifest.
   *
   * This is called automatically when a plugin transitions to `ready`.
   * Can also be called manually for testing or recovery scenarios.
   *
   * @param pluginId - The plugin's unique identifier
   * @param manifest - The plugin manifest containing tool declarations
   */
  registerPluginTools(
    pluginId: string,
    manifest: PaperclipPluginManifestV1,
    pluginDbId?: string,
    operationPolicy?: PluginOperationPolicy,
  ): void;

  /**
   * Unregister all tools for a plugin.
   *
   * Called automatically when a plugin is disabled or unloaded.
   *
   * @param pluginId - The plugin to unregister
   */
  unregisterPluginTools(pluginId: string): void;

  /**
   * Get the total number of registered tools, optionally scoped to a plugin.
   *
   * @param pluginId - If provided, count only this plugin's tools
   */
  toolCount(pluginId?: string): number;

  /**
   * Access the underlying tool registry for advanced operations.
   *
   * This escape hatch exists for internal use (e.g. diagnostics).
   * Prefer the dispatcher's own methods for normal operations.
   */
  getRegistry(): PluginToolRegistry;
}

// ---------------------------------------------------------------------------
// Factory: createPluginToolDispatcher
// ---------------------------------------------------------------------------

/**
 * Create a new `PluginToolDispatcher`.
 *
 * The dispatcher:
 * 1. Creates and owns a `PluginToolRegistry` backed by the given worker manager.
 * 2. Listens for lifecycle events (plugin.enabled, plugin.disabled, plugin.unloaded)
 *    to automatically register and unregister tools.
 * 3. On `initialize()`, loads tools from all currently-ready plugins via the DB.
 *
 * @param options - Configuration options
 *
 * @example
 * ```ts
 * // At server startup
 * const dispatcher = createPluginToolDispatcher({
 *   workerManager,
 *   lifecycleManager,
 *   db,
 * });
 * await dispatcher.initialize();
 *
 * // In agent service — list tools for prompt construction
 * const tools = await dispatcher.listToolsForAgent({ companyId });
 *
 * // In agent service — execute a tool
 * const result = await dispatcher.executeTool(
 *   "acme.linear:search-issues",
 *   { query: "auth bug" },
 *   { agentId: "a-1", runId: "r-1", companyId: "c-1", projectId: "p-1" },
 * );
 * ```
 */
export function createPluginToolDispatcher(
  options: PluginToolDispatcherOptions = {},
): PluginToolDispatcher {
  const {
    workerManager,
    lifecycleManager,
    draftGate,
    idempotencyStore,
    db,
    externalMcpToolSource,
    externalMcpServerManager,
  } = options;
  const log = logger.child({ service: "plugin-tool-dispatcher" });

  if (externalMcpToolSource && !externalMcpServerManager) {
    throw new Error(
      "createPluginToolDispatcher: externalMcpServerManager is required when externalMcpToolSource is provided",
    );
  }

  // Create the underlying tool registry, backed by the worker manager
  const registry = createPluginToolRegistry(workerManager);

  const externalMcpPrefix = `${EXTERNAL_MCP_TOOL_NAMESPACE}:`;

  /**
   * Run a plugin tool, giving anything declared `writes: true` protection
   * against happening twice.
   *
   * Everything else goes straight through. A read costs nothing to repeat, and
   * claiming one would mean a database write per lookup for no benefit.
   *
   * The key comes from the caller when it supplies one, and otherwise from the
   * run plus the arguments — which makes "the same call repeated inside one
   * run" the thing that gets caught. That is the failure this exists for: an
   * agent that never saw a response trying again.
   *
   * @see PLUGIN_SPEC.md §11.7 — Repeat-safe operations
   */
  async function executeWithRepeatProtection(
    namespacedName: string,
    parameters: unknown,
    runContext: ToolRunContext,
  ): Promise<ToolExecutionResult> {
    const tool = registry.getTool(namespacedName);

    if (!idempotencyStore || !tool?.writes) {
      return registry.executeTool(namespacedName, parameters, runContext);
    }

    const idempotencyKey = runContext.idempotencyKey
      ?? deriveIdempotencyKey({
        runId: runContext.runId,
        namespacedName,
        parameters,
      });

    const key: OperationCallKey = {
      pluginId: tool.pluginId,
      operationKey: tool.name,
      idempotencyKey,
      companyId: runContext.companyId || null,
    };

    const claim = await idempotencyStore.claim(key, {
      invokedBy: "agent",
      runId: runContext.runId,
    });

    if (claim.kind === "replay") {
      log.info(
        { tool: namespacedName, idempotencyKey, runId: runContext.runId },
        "replaying a previous result instead of running a writing operation again",
      );
      return { pluginId: tool.pluginId, toolName: tool.name, result: claim.result };
    }

    if (claim.kind === "in_flight") {
      // Refused rather than queued: there is no result to replay yet, and
      // holding the request open for however long the operation takes would
      // turn one slow call into two.
      const message =
        `The same call to "${namespacedName}" is already running (started `
        + `${claim.startedAt.toISOString()}). It was not run again.`;
      return {
        pluginId: tool.pluginId,
        toolName: tool.name,
        result: {
          error: message,
          failure: { code: "unavailable", message, retryAfterMs: 5_000 },
        },
      };
    }

    // We own the key. Every path out of here must settle or release it, or the
    // operation stays unrunnable for this key until the stale window passes.
    let outcome: ToolExecutionResult;
    try {
      outcome = await registry.executeTool(
        namespacedName,
        parameters,
        { ...runContext, idempotencyKey },
      );
    } catch (err) {
      // The call did not produce a result at all — the worker was not running,
      // the RPC blew up. Release rather than settle: recording this as a
      // failure would replay it to a caller who could legitimately have
      // succeeded on a later attempt.
      await idempotencyStore.release(key).catch((releaseErr) => {
        log.error(
          { tool: namespacedName, err: String(releaseErr) },
          "failed to release an operation claim after an execution error",
        );
      });
      throw err;
    }

    await idempotencyStore.settle(key, outcome.result, !outcome.result.error)
      .catch((err) => {
        // The work has already happened. Failing the call now would tell the
        // agent it did not, which is the more dangerous lie.
        log.error(
          { tool: namespacedName, idempotencyKey, err: String(err) },
          "operation ran but its result could not be recorded for replay",
        );
      });

    return outcome;
  }
  function isExternalMcpName(name: string): boolean {
    return name.startsWith(externalMcpPrefix);
  }

  // Track lifecycle event listeners so we can remove them on teardown
  let enabledListener: ((payload: { pluginId: string; pluginKey: string }) => void) | null = null;
  let disabledListener: ((payload: { pluginId: string; pluginKey: string; reason?: string }) => void) | null = null;
  let unloadedListener: ((payload: { pluginId: string; pluginKey: string; removeData: boolean }) => void) | null = null;

  let initialized = false;

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Attempt to register tools for a plugin by looking up its manifest
   * from the DB. No-ops gracefully if the plugin or manifest is missing.
   */
  async function registerFromDb(pluginId: string): Promise<void> {
    if (!db) {
      log.warn(
        { pluginId },
        "cannot register tools from DB — no database connection configured",
      );
      return;
    }

    const pluginRegistry = pluginRegistryService(db);
    const plugin = await pluginRegistry.getById(pluginId) as PluginRecord | null;

    if (!plugin) {
      log.warn({ pluginId }, "plugin not found in registry, cannot register tools");
      return;
    }

    const manifest = plugin.manifestJson;
    if (!manifest) {
      log.warn({ pluginId }, "plugin has no manifest, cannot register tools");
      return;
    }

    registry.registerPlugin(plugin.pluginKey, manifest, plugin.id, plugin.operationPolicyJson);
  }

  /**
   * Convert a `RegisteredTool` to an `AgentToolDescriptor`.
   */
  function toAgentDescriptor(tool: RegisteredTool): AgentToolDescriptor {
    return {
      name: tool.namespacedName,
      displayName: tool.displayName,
      description: tool.description,
      parametersSchema: tool.parametersSchema,
      pluginId: tool.pluginDbId,
    };
  }

  // -----------------------------------------------------------------------
  // Lifecycle event handlers
  // -----------------------------------------------------------------------

  function handlePluginEnabled(payload: { pluginId: string; pluginKey: string }): void {
    log.debug({ pluginId: payload.pluginId, pluginKey: payload.pluginKey }, "plugin enabled — registering tools");
    // Async registration from DB — we fire-and-forget since the lifecycle
    // event handler must be synchronous. Any errors are logged.
    void registerFromDb(payload.pluginId).catch((err) => {
      log.error(
        { pluginId: payload.pluginId, err: err instanceof Error ? err.message : String(err) },
        "failed to register tools after plugin enabled",
      );
    });
  }

  function handlePluginDisabled(payload: { pluginId: string; pluginKey: string; reason?: string }): void {
    log.debug({ pluginId: payload.pluginId, pluginKey: payload.pluginKey }, "plugin disabled — unregistering tools");
    registry.unregisterPlugin(payload.pluginKey);
  }

  function handlePluginUnloaded(payload: { pluginId: string; pluginKey: string; removeData: boolean }): void {
    log.debug({ pluginId: payload.pluginId, pluginKey: payload.pluginKey }, "plugin unloaded — unregistering tools");
    registry.unregisterPlugin(payload.pluginKey);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    async initialize(): Promise<void> {
      if (initialized) {
        log.warn("dispatcher already initialized, skipping");
        return;
      }

      log.info("initializing plugin tool dispatcher");

      // Step 1: Load tools from all currently-ready plugins
      if (db) {
        const pluginRegistry = pluginRegistryService(db);
        const readyPlugins = await pluginRegistry.listByStatus("ready") as PluginRecord[];

        let totalTools = 0;
        for (const plugin of readyPlugins) {
          const manifest = plugin.manifestJson;
          // Operations count as much as tools here. Checking only `tools`
          // meant a plugin that declared its work as operations came back from
          // a restart with nothing registered, so agents silently lost it.
          const declaredCount = (manifest?.tools?.length ?? 0) + (manifest?.operations?.length ?? 0);
          if (manifest && declaredCount > 0) {
            registry.registerPlugin(
              plugin.pluginKey,
              manifest,
              plugin.id,
              plugin.operationPolicyJson,
            );
            totalTools += registry.toolCount(plugin.pluginKey);
          }
        }

        log.info(
          { readyPlugins: readyPlugins.length, registeredTools: totalTools },
          "loaded tools from ready plugins",
        );
      }

      // Step 2: Subscribe to lifecycle events for dynamic updates
      if (lifecycleManager) {
        enabledListener = handlePluginEnabled;
        disabledListener = handlePluginDisabled;
        unloadedListener = handlePluginUnloaded;

        lifecycleManager.on("plugin.enabled", enabledListener);
        lifecycleManager.on("plugin.disabled", disabledListener);
        lifecycleManager.on("plugin.unloaded", unloadedListener);

        log.debug("subscribed to lifecycle events");
      } else {
        log.warn("no lifecycle manager provided — tools will not auto-update on plugin state changes");
      }

      initialized = true;
      log.info(
        { totalTools: registry.toolCount() },
        "plugin tool dispatcher initialized",
      );
    },

    teardown(): void {
      if (!initialized) return;

      // Unsubscribe from lifecycle events
      if (lifecycleManager) {
        if (enabledListener) lifecycleManager.off("plugin.enabled", enabledListener);
        if (disabledListener) lifecycleManager.off("plugin.disabled", disabledListener);
        if (unloadedListener) lifecycleManager.off("plugin.unloaded", unloadedListener);

        enabledListener = null;
        disabledListener = null;
        unloadedListener = null;
      }

      // Note: we do NOT clear the registry here because teardown may be
      // called during graceful shutdown where in-flight tool calls should
      // still be able to resolve their tool entries.

      initialized = false;
      log.info("plugin tool dispatcher torn down");
    },

    async listToolsForAgent(filter?: AgentToolListFilter): Promise<AgentToolDescriptor[]> {
      const pluginDescriptors = registry.listTools(filter).map(toAgentDescriptor);

      if (!externalMcpToolSource || !filter?.companyId) {
        return pluginDescriptors;
      }

      try {
        const mcpTools = await externalMcpToolSource.listToolsForCompany(filter.companyId);
        const mcpDescriptors: AgentToolDescriptor[] = mcpTools.map((tool) => ({
          name: tool.namespacedName,
          displayName: tool.name,
          description: tool.description,
          parametersSchema: tool.parametersSchema,
          pluginId: `${EXTERNAL_MCP_TOOL_NAMESPACE}:${tool.serverKey}`,
        }));
        return [...pluginDescriptors, ...mcpDescriptors];
      } catch (err) {
        log.warn(
          {
            companyId: filter.companyId,
            err: err instanceof Error ? err.message : String(err),
          },
          "external mcp tool source failed; returning plugin tools only",
        );
        return pluginDescriptors;
      }
    },

    getTool(namespacedName: string): RegisteredTool | null {
      return registry.getTool(namespacedName);
    },

    async executeTool(
      namespacedName: string,
      parameters: unknown,
      runContext: ToolRunContext,
      options?: ExecuteToolOptions,
    ): Promise<ToolExecutionResult> {
      log.debug(
        {
          tool: namespacedName,
          agentId: runContext.agentId,
          runId: runContext.runId,
        },
        "dispatching tool execution",
      );

      // Trust loop: certain mutating outbound tools (email_send, slack_send_dm,
      // phone_call_make, ...) are intercepted by the draft gate, queued as
      // approvals, and a synthesized "drafted" result is returned to the agent.
      // The actual side effect runs only when the user approves the draft, via
      // the approve route's hook into `executeDraftedApproval()`, which sets
      // `bypassDraftGate` so the gate does not re-intercept the re-dispatch.
      if (draftGate && !options?.bypassDraftGate) {
        const gateResult = await draftGate.intercept(namespacedName, parameters, runContext, {
          force: options?.forceDraftGate === true,
        });
        if (gateResult.intercepted && gateResult.result) {
          // Resolve the pluginId so the synthesized result still attributes
          // correctly in audit logs. Read from the registry rather than
          // hardcoding so this stays accurate as plugins evolve.
          const tool = registry.getTool(namespacedName);
          return {
            pluginId: tool?.pluginId ?? namespacedName.split(":")[0] ?? "draft-gate",
            toolName: namespacedName,
            result: gateResult.result,
          };
        }
      }

      // Route external MCP tools through the connector manager.
      if (isExternalMcpName(namespacedName)) {
        if (!externalMcpToolSource || !externalMcpServerManager) {
          throw new Error(
            `Cannot execute MCP tool "${namespacedName}" — external MCP support is not configured on this dispatcher.`,
          );
        }
        const parsed = externalMcpToolSource.parseNamespacedName(namespacedName);
        if (!parsed) {
          throw new Error(
            `Invalid MCP tool name "${namespacedName}". Expected format: "${EXTERNAL_MCP_TOOL_NAMESPACE}:<serverKey>:<toolName>"`,
          );
        }
        const server = await externalMcpServerManager.getServerByKey(parsed.serverKey);
        if (!server) {
          throw new Error(`MCP server "${parsed.serverKey}" not found`);
        }
        if (!runContext.companyId) {
          throw new Error(`Cannot execute MCP tool "${namespacedName}" — runContext.companyId is required`);
        }
        if (!isCompanyAllowed(server.allowedCompanies, runContext.companyId)) {
          throw new Error(
            `[ECOMPANY_NOT_ALLOWED] Company ${runContext.companyId} cannot call MCP server "${server.key}"`,
          );
        }
        const callResult = await externalMcpServerManager.callTool(
          server.id,
          runContext.companyId,
          parsed.toolName,
          parameters,
        );
        // MCP tool results carry an array of content blocks; the plugin
        // ToolResult shape carries a single string. Flatten text blocks into
        // `content` and preserve the original blocks under `data` for any
        // caller that wants structured access (e.g. images, resource links).
        const flatContent = Array.isArray(callResult.content)
          ? callResult.content
              .map((block: unknown) => {
                if (block && typeof block === "object" && "type" in block) {
                  const b = block as { type: string; text?: string };
                  if (b.type === "text" && typeof b.text === "string") return b.text;
                }
                return "";
              })
              .filter(Boolean)
              .join("\n")
          : "";
        const result: ToolResult = {
          content: flatContent,
          data: callResult.content,
          ...(callResult.isError ? { error: "tool reported isError=true" } : {}),
        };
        log.debug(
          {
            tool: namespacedName,
            serverKey: server.key,
            toolName: parsed.toolName,
            hasError: callResult.isError,
          },
          "external mcp tool execution completed",
        );
        return {
          pluginId: `${EXTERNAL_MCP_TOOL_NAMESPACE}:${server.key}`,
          toolName: parsed.toolName,
          result,
        };
      }

      const result = await executeWithRepeatProtection(namespacedName, parameters, runContext);

      log.debug(
        {
          tool: namespacedName,
          pluginId: result.pluginId,
          hasContent: !!result.result.content,
          hasError: !!result.result.error,
        },
        "tool execution completed",
      );

      return result;
    },

    registerPluginTools(
      pluginId: string,
      manifest: PaperclipPluginManifestV1,
      pluginDbId?: string,
      operationPolicy?: PluginOperationPolicy,
    ): void {
      registry.registerPlugin(pluginId, manifest, pluginDbId, operationPolicy);
    },

    unregisterPluginTools(pluginId: string): void {
      registry.unregisterPlugin(pluginId);
    },

    toolCount(pluginId?: string): number {
      return registry.toolCount(pluginId);
    },

    getRegistry(): PluginToolRegistry {
      return registry;
    },
  };
}
