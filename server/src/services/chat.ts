import { and, asc, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { chatMessages, chatSessions } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { badRequest, forbidden, notFound, HttpError } from "../errors.js";
import {
  CHAT_TOOLS,
  executeChatTool,
  listChatToolSpecs,
  listPluginToolSpecsForChat,
  resolveDefaultCompanyId,
  type ToolActor,
  type ToolContext,
} from "./chat-tools.js";
import { DRAFT_RESULT_HEADER } from "./tool-draft-gate.js";
import type { PluginToolDispatcher } from "./plugin-tool-dispatcher.js";
import { chatPermissions } from "./chat-permissions.js";
import {
  getProviderForModel,
  listAvailableModels,
  listConfiguredProviders,
  pickBestDefaultModel,
  removeClippyWorkspace,
  type CanonicalContentBlock,
  type CanonicalMessage,
} from "./chat-providers.js";
import {
  attachmentDownloadUrl,
  chatAttachmentService,
  type ChatAttachment,
} from "./chat-attachments.js";

const MAX_TOOL_LOOPS = 12;

export type ChatMode = "chat" | "agent";
export type PermissionMode = "ask" | "bypass";
export type EffortLevel = "auto" | "low" | "medium" | "high";

export interface ChatSession {
  id: string;
  boardUserId: string;
  companyId: string | null;
  title: string;
  model: string;
  mode: ChatMode;
  permissionMode: PermissionMode;
  effort: EffortLevel;
  adapterSessionParams: Record<string, unknown> | null;
  pageContext: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SessionListStatus = "active" | "archived" | "all";
export type SessionListSort = "recency" | "title" | "created";

export interface SessionListFilters {
  status?: SessionListStatus;
  /** Only return sessions with updatedAt newer than now - N days. */
  lastActivityDays?: number;
  /** Filter to sessions scoped to this company id (no match for null). */
  companyId?: string;
  sort?: SessionListSort;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "tool";
  content: unknown;
  createdAt: string;
}

export type StreamEvent =
  | { type: "session_state"; session: ChatSession }
  | { type: "message_started"; messageId: string; role: "assistant" }
  | { type: "text_delta"; delta: string }
  | {
      type: "tool_use_block";
      toolUseId: string;
      name: string;
      input: unknown;
      mutating: boolean;
    }
  | { type: "permission_required"; toolUseId: string; name: string; input: unknown }
  | { type: "tool_result_block"; toolUseId: string; ok: boolean; result: unknown }
  | { type: "message_completed"; messageId: string }
  | { type: "done"; stopReason: string }
  | { type: "error"; error: string; code?: string };

function rowToSession(row: typeof chatSessions.$inferSelect): ChatSession {
  return {
    id: row.id,
    boardUserId: row.boardUserId,
    companyId: row.companyId,
    title: row.title,
    model: row.model,
    // `mode` is a legacy field — the Chat/Agent toggle was removed in favor of
    // permission_mode alone, so every session behaves as Agent. Old rows may
    // still have 'chat' stored; coerce on read so the UI doesn't need to care.
    mode: "agent",
    permissionMode: row.permissionMode as PermissionMode,
    effort: row.effort as EffortLevel,
    adapterSessionParams: row.adapterSessionParams ?? null,
    pageContext: row.pageContext ?? null,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToMessage(row: typeof chatMessages.$inferSelect): ChatMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role as "user" | "assistant" | "tool",
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Standalone helper for resuming a chat session after a drafted outbound tool
 * call (queued by the tool draft gate) has been resolved by the user. The
 * approve route calls this for Clippy-attributed approvals so the LLM can pick
 * up where it left off — the message gets sent to the model on the user's
 * next turn (see `buildCanonicalMessages`, which maps role="tool" → user).
 *
 * No actor authentication: the approve route already verified the user can
 * resolve the approval. This is server-internal plumbing, not a user-facing
 * route — that's why it lives outside `chatService` and skips the actor check.
 *
 * Returns the appended message id, or `{ skipped: "session_not_found" }` if
 * the chat session was deleted between draft and approve. Failures inside the
 * insert bubble up; the caller decides whether to log-and-swallow.
 */
export async function appendApprovedDraftResultToChatSession(
  db: Db,
  args: {
    chatSessionId: string;
    toolName: string;
    summary: string;
    outcome:
      | { ok: true; content: string | null }
      | { ok: false; error: string };
  },
): Promise<{ messageId: string } | { skipped: "session_not_found" }> {
  const sessionRow = await db
    .select({ id: chatSessions.id })
    .from(chatSessions)
    .where(eq(chatSessions.id, args.chatSessionId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!sessionRow) {
    return { skipped: "session_not_found" };
  }

  // Build a single text block describing the resolved outcome. We use a
  // tool-role chat_messages row so the canonical-message builder maps it to
  // the Anthropic "user with tool_result-or-text content" convention. The
  // message is plain text (not a tool_result block) because the original
  // tool_use_id in the transcript already has its matching tool_result block
  // (the synthesized "queued for human approval" one); adding a second
  // tool_result for the same id would violate the API's pairing rule.
  const headline = args.outcome.ok
    ? `[Paperclip] The user approved your earlier \`${args.toolName}\` draft (${args.summary}). The tool ran${args.outcome.content ? ` and returned: ${args.outcome.content}` : " successfully."}`
    : `[Paperclip] The user approved your earlier \`${args.toolName}\` draft (${args.summary}), but the tool failed: ${args.outcome.error}`;

  const block: CanonicalContentBlock = { type: "text", text: headline };
  const created = await db
    .insert(chatMessages)
    .values({ sessionId: args.chatSessionId, role: "tool", content: [block] })
    .returning()
    .then((rows) => rows[0]);

  // Bump the session's updatedAt so the chat list re-sorts and any open
  // client refetch picks up the new message via existing list/messages
  // queries. No real-time push wired up here — see plan v2.
  await db
    .update(chatSessions)
    .set({ updatedAt: new Date() })
    .where(eq(chatSessions.id, args.chatSessionId));

  return { messageId: created.id };
}

export interface ChatActor extends ToolActor {}

function systemPromptFor(session: ChatSession, defaultCompanyId: string | null): string {
  const lines = [
    "You are Clippy, Paperclip's in-app assistant for board users. You can help the user understand the state of their Paperclip companies and take actions on their behalf via tools.",
    "Be concise. Prefer short, direct answers. When you call a tool, briefly say what you are about to do.",
    "You have access to tools that read and (when permitted) modify Paperclip state. Mutating tools may require the user to approve each call. If the user denies a tool, acknowledge it and stop.",
    "Plugin tools (names containing '__', e.g. '3cx-tools__pbx_click_to_call') are bridged from installed Paperclip plugins. They take a runContext implicitly from this chat session — pass only the documented parameters; never include agentId/runId/companyId yourself. Plugin tool errors arrive as `[E<CODE>] message` strings — read the code, surface a helpful explanation to the user, and don't loop on the same failure.",
  ];
  if (defaultCompanyId) {
    lines.push(`Current company id (default for tools that take companyId): ${defaultCompanyId}`);
  } else {
    lines.push(
      "There is no current company selected. Ask the user which company they mean before calling tools that need a companyId.",
    );
  }
  if (session.pageContext) {
    lines.push(`User's current page when this chat was opened: ${session.pageContext}`);
  }
  return lines.join("\n\n");
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; message?: string };
  return e.name === "AbortError" || /aborted|abort/i.test(e.message ?? "");
}

/**
 * True when a chat tool outcome was synthesized by the outbound-tool draft
 * gate (the call was queued for human approval, not actually executed).
 * Used by `runTurn` to force-end the turn after a draft is queued — without
 * this guard, an LLM that ignores the prompt's "do not retry" instruction
 * would loop on the same tool every iteration, creating a fresh pending
 * approval each time the user resolves the previous one.
 *
 * Detects both shapes the gate can produce: the human-readable string
 * (chat-tools surfaces this for plugin tools) and the structured object
 * (`{ drafted: true, ... }`) for any future caller that bypasses the
 * content preference in `executePluginChatTool`.
 */
function isDraftedToolOutcome(result: unknown): boolean {
  if (typeof result === "string") return result.startsWith(DRAFT_RESULT_HEADER);
  if (result && typeof result === "object" && "drafted" in result) {
    return (result as { drafted?: unknown }).drafted === true;
  }
  return false;
}

function buildCanonicalMessages(messages: ChatMessage[]): CanonicalMessage[] {
  // chat_messages.content stores Anthropic-shape blocks already.
  // user messages map directly. tool_result messages (stored under role 'tool')
  // map to Anthropic's "user with tool_result blocks" convention.
  return messages.map((msg): CanonicalMessage => {
    if (msg.role === "tool") {
      return { role: "user", content: msg.content as CanonicalContentBlock[] };
    }
    return {
      role: msg.role,
      content: msg.content as CanonicalContentBlock[] | string,
    };
  });
}

function collectAttachmentIds(messages: CanonicalMessage[]): string[] {
  const ids = new Set<string>();
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "image" || b.type === "file") ids.add(b.attachmentId);
    }
  }
  return [...ids];
}

function attachmentToBlock(att: ChatAttachment): CanonicalContentBlock {
  if (att.kind === "image") {
    return {
      type: "image",
      attachmentId: att.id,
      url: attachmentDownloadUrl(att.id),
      mediaType: att.mediaType,
      name: att.name,
    };
  }
  return {
    type: "file",
    attachmentId: att.id,
    url: attachmentDownloadUrl(att.id),
    mediaType: att.mediaType,
    name: att.name,
    sizeBytes: att.sizeBytes,
  };
}

export interface ChatServiceOptions {
  /**
   * Plugin tool dispatcher. When provided, plugin tools are projected
   * into chat-Agent sessions so the LLM can invoke them. Without it,
   * Agent mode is limited to the hardcoded chat tools.
   */
  pluginToolDispatcher?: PluginToolDispatcher | null;
  /**
   * Plugin MCP bridge. When provided, chat-Agent sessions running on
   * adapter-execute providers (e.g. claude_local) get an ephemeral MCP
   * token minted per turn so the spawned LLM subprocess can call plugin
   * tools via the bridge. Without it, those adapter sessions only see
   * whatever tools the adapter natively exposes.
   */
  pluginMcpBridge?: import("./plugin-mcp-bridge.js").PluginMcpBridge | null;
}

export function chatService(db: Db, options: ChatServiceOptions = {}) {
  const attachments = chatAttachmentService(db);
  const pluginToolDispatcher = options.pluginToolDispatcher ?? null;
  const pluginMcpBridge = options.pluginMcpBridge ?? null;

  // Pre-load attachment bytes referenced anywhere in the conversation so
  // providers can splice base64 inline without async fanout during the stream.
  async function loadAttachmentsForMessages(messages: CanonicalMessage[]) {
    const ids = collectAttachmentIds(messages);
    if (ids.length === 0) return new Map();
    const map = new Map<string, { data: Buffer; mediaType: string; name: string }>();
    for (const id of ids) {
      const att = await attachments.getById(id);
      if (!att) continue;
      try {
        const data = await attachments.readContent(att);
        map.set(id, { data, mediaType: att.mediaType, name: att.name });
      } catch (err) {
        logger.warn({ err, attachmentId: id }, "failed to read chat attachment bytes");
      }
    }
    return map;
  }

  async function listSessions(actor: ChatActor, filters: SessionListFilters = {}) {
    const status: SessionListStatus = filters.status ?? "active";
    const conditions = [eq(chatSessions.boardUserId, actor.userId)];
    if (status === "active") {
      conditions.push(isNull(chatSessions.archivedAt));
    } else if (status === "archived") {
      conditions.push(isNotNull(chatSessions.archivedAt));
    }
    if (typeof filters.lastActivityDays === "number" && filters.lastActivityDays > 0) {
      const cutoff = new Date(Date.now() - filters.lastActivityDays * 24 * 60 * 60 * 1000);
      conditions.push(gte(chatSessions.updatedAt, cutoff));
    }
    if (filters.companyId) {
      conditions.push(eq(chatSessions.companyId, filters.companyId));
    }

    const sort = filters.sort ?? "recency";
    const order =
      sort === "title"
        ? [asc(sql`lower(${chatSessions.title})`)]
        : sort === "created"
          ? [desc(chatSessions.createdAt)]
          : [desc(chatSessions.updatedAt)];

    const rows = await db
      .select()
      .from(chatSessions)
      .where(and(...conditions))
      .orderBy(...order)
      .limit(200);
    return rows.map(rowToSession);
  }

  async function getSession(actor: ChatActor, id: string) {
    const row = await db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, id))
      .then((r) => r[0] ?? null);
    if (!row) throw notFound(`Chat session ${id} not found`);
    if (row.boardUserId !== actor.userId) throw forbidden("Not your chat session");
    return rowToSession(row);
  }

  async function createSession(
    actor: ChatActor,
    input: {
      title?: string;
      companyId?: string | null;
      permissionMode?: PermissionMode;
      model?: string;
      pageContext?: string | null;
    },
  ) {
    // Auto-pick the best available model when the caller didn't specify one,
    // so a fresh chat lands on something that actually works for this user
    // (e.g. claude_local Opus via Claude Pro auth) rather than a hardcoded
    // model that requires an API key they may not have set.
    const initialModel = input.model ?? (await pickBestDefaultModel());
    const created = await db
      .insert(chatSessions)
      .values({
        boardUserId: actor.userId,
        companyId: input.companyId ?? null,
        title: input.title?.slice(0, 200) ?? "New chat",
        mode: "agent",
        permissionMode: input.permissionMode ?? "ask",
        model: initialModel,
        pageContext: input.pageContext ?? null,
      })
      .returning()
      .then((rows) => rows[0]);
    return rowToSession(created);
  }

  async function updateSession(
    actor: ChatActor,
    id: string,
    patch: {
      title?: string;
      permissionMode?: PermissionMode;
      effort?: EffortLevel;
      companyId?: string | null;
      model?: string;
      archived?: boolean;
    },
  ) {
    await getSession(actor, id);
    // Drizzle infers `updatedAt` as `Date | SQL` because of the default; the
    // partial type widens that to include `undefined` which the `set()` call
    // rejects, so we build the update object as a plain record and cast.
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.title !== undefined) updates.title = patch.title.slice(0, 200);
    if (patch.permissionMode !== undefined) updates.permissionMode = patch.permissionMode;
    if (patch.effort !== undefined) updates.effort = patch.effort;
    if (patch.companyId !== undefined) updates.companyId = patch.companyId;
    if (patch.model !== undefined) updates.model = patch.model;
    if (patch.archived !== undefined) {
      updates.archivedAt = patch.archived ? new Date() : null;
    }
    const updated = await db
      .update(chatSessions)
      .set(updates)
      .where(eq(chatSessions.id, id))
      .returning()
      .then((rows) => rows[0]);
    return rowToSession(updated);
  }

  async function deleteSession(actor: ChatActor, id: string) {
    await getSession(actor, id);
    await db.delete(chatSessions).where(eq(chatSessions.id, id));
    // Best-effort cleanup of on-disk artefacts. The DB cascades remove the
    // chat_attachments rows; we still need to drop the files and any adapter
    // workspace this session created so ~/.paperclip/ doesn't grow forever.
    await Promise.all([
      removeClippyWorkspace(id).catch((err) => {
        logger.warn({ err, sessionId: id }, "failed to remove clippy workspace");
      }),
      attachments.removeAllForSession(id),
    ]);
  }

  async function listMessages(actor: ChatActor, sessionId: string) {
    await getSession(actor, sessionId);
    const rows = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(asc(chatMessages.createdAt));
    return rows.map(rowToMessage);
  }

  async function appendUserMessage(
    sessionId: string,
    text: string,
    attachmentBlocks: CanonicalContentBlock[] = [],
  ) {
    const blocks: CanonicalContentBlock[] = [];
    if (text.length > 0) blocks.push({ type: "text", text });
    for (const b of attachmentBlocks) blocks.push(b);
    const created = await db
      .insert(chatMessages)
      .values({
        sessionId,
        role: "user",
        content: blocks,
      })
      .returning()
      .then((rows) => rows[0]);
    await db
      .update(chatSessions)
      .set({ updatedAt: new Date() })
      .where(eq(chatSessions.id, sessionId));
    return rowToMessage(created);
  }

  // Derive a short title from the first user message: first line, trimmed,
  // capped to 60 chars. The dropdown rail is otherwise a wall of "New chat".
  function deriveTitleFromText(text: string): string {
    const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
    if (firstLine.length === 0) return "New chat";
    if (firstLine.length <= 60) return firstLine;
    return `${firstLine.slice(0, 59).trimEnd()}…`;
  }

  function deriveTitleFromAttachments(atts: ChatAttachment[]): string {
    if (atts.length === 0) return "New chat";
    const head = atts[0].name || (atts[0].kind === "image" ? "Image" : "File");
    if (atts.length === 1) return head.slice(0, 60);
    return `${head.slice(0, 50)} + ${atts.length - 1} more`;
  }

  async function appendAssistantMessage(sessionId: string, blocks: CanonicalContentBlock[]) {
    const created = await db
      .insert(chatMessages)
      .values({ sessionId, role: "assistant", content: blocks })
      .returning()
      .then((rows) => rows[0]);
    return rowToMessage(created);
  }

  async function appendToolResults(sessionId: string, blocks: CanonicalContentBlock[]) {
    const created = await db
      .insert(chatMessages)
      .values({ sessionId, role: "tool", content: blocks })
      .returning()
      .then((rows) => rows[0]);
    return rowToMessage(created);
  }

  async function* runTurn(
    actor: ChatActor,
    sessionId: string,
    userText: string,
    onAbort?: (cb: () => void) => void,
    attachmentIds: string[] = [],
  ): AsyncGenerator<StreamEvent, void, void> {
    let session = await getSession(actor, sessionId);
    const provider = getProviderForModel(session.model);
    if (!provider) {
      const available = await listAvailableModels();
      yield {
        type: "error",
        error: `No provider supports model "${session.model}". Available: ${
          available.map((m) => m.model).join(", ")
            || "(none — set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or start a local Ollama)"
        }`,
        code: "unsupported_model",
      };
      return;
    }
    if (!provider.isConfigured()) {
      const help =
        provider.name === "anthropic"
          ? "Set ANTHROPIC_API_KEY in your environment (or, if you use Claude Pro via the claude_local adapter, that integration is on the roadmap and not yet wired into Clippy)."
          : provider.name === "openai"
            ? "Set OPENAI_API_KEY in your environment."
            : provider.name === "gemini"
              ? "Set GEMINI_API_KEY (or GOOGLE_API_KEY) in your environment."
              : "Start a local Ollama (https://ollama.com) — it'll be auto-detected at 127.0.0.1:11434, or set OLLAMA_HOST to point elsewhere.";
      yield {
        type: "error",
        error: `${provider.name} provider is not configured. ${help}`,
        code: "missing_api_key",
      };
      return;
    }
    const defaultCompanyId = await resolveDefaultCompanyId(db, actor, session.companyId);
    yield { type: "session_state", session };

    // Resolve attachments up front so we can fail the whole turn if the user
    // somehow referenced an attachment from another session/user.
    const attachmentRows: ChatAttachment[] = attachmentIds.length > 0
      ? await attachments.findByIdsForSession(attachmentIds, sessionId, actor.userId)
      : [];
    const attachmentBlocks: CanonicalContentBlock[] = attachmentRows.map(attachmentToBlock);
    await appendUserMessage(sessionId, userText, attachmentBlocks);

    // First-turn auto-title: replace the placeholder "New chat" with a
    // short version of what the user actually asked, so the rail dropdown
    // is browsable. Skip if the user manually picked a title.
    if (session.title === "New chat") {
      // Fall back to "Image" / "Image + 2 more" etc. when the user only
      // attached files without typing text.
      const newTitle = userText.trim().length > 0
        ? deriveTitleFromText(userText)
        : deriveTitleFromAttachments(attachmentRows);
      if (newTitle !== session.title) {
        const updated = await db
          .update(chatSessions)
          .set({ title: newTitle, updatedAt: new Date() })
          .where(eq(chatSessions.id, sessionId))
          .returning()
          .then((rows) => rows[0]);
        if (updated) {
          session = rowToSession(updated);
          yield { type: "session_state", session };
        }
      }
    }

    let aborted = false;
    const abortController = new AbortController();
    onAbort?.(() => {
      aborted = true;
      // Aborts the in-flight provider HTTP/SDK call so we stop generating
      // (and stop being billed) the moment the user clicks Stop.
      abortController.abort();
      chatPermissions.cancelSession(sessionId);
    });

    const toolCtx: ToolContext = {
      db,
      actor,
      defaultCompanyId,
      chatSessionId: sessionId,
    };
    // Every Clippy session runs as Agent now — tool access is gated only by
    // permissionMode (`ask` vs `bypass`). See systemPromptFor + rowToSession
    // for the rest of the always-Agent contract.
    const builtIn = listChatToolSpecs();
    const plugin = await listPluginToolSpecsForChat(pluginToolDispatcher, defaultCompanyId);
    const tools: ReturnType<typeof listChatToolSpecs> = [...builtIn, ...plugin];

    // Plugin MCP bridge token is minted ONCE per turn-stream invocation
    // and reused across the tool-loop iterations below; revoked in the
    // post-loop cleanup. Adapter-execute providers (claude_local) read
    // pluginMcpUrl from adapterContext and write it into a temp .mcp.json
    // so the spawned LLM subprocess can call plugin tools as MCP tools.
    let mcpBridgeToken: string | null = null;
    let pluginMcpUrl: string | undefined;
    if (
      provider.name === "adapter" &&
      defaultCompanyId &&
      pluginMcpBridge
    ) {
      try {
        mcpBridgeToken = pluginMcpBridge.mintToken({
          chatSessionId: session.id,
          companyId: defaultCompanyId,
          actor,
        });
        const port = process.env.PAPERCLIP_LISTEN_PORT ?? "3100";
        pluginMcpUrl = `http://127.0.0.1:${port}/api/internal/mcp/${mcpBridgeToken}`;
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "Failed to mint MCP bridge token; adapter session will run without plugin tools",
        );
      }
    }

    let loops = 0;
    while (loops < MAX_TOOL_LOOPS && !aborted) {
      loops += 1;
      const allMessages = await listMessages(actor, sessionId);
      const canonical = buildCanonicalMessages(allMessages);
      const resolved = await loadAttachmentsForMessages(canonical);
      const turnStream = provider.streamTurn({
        model: session.model,
        system: systemPromptFor(session, defaultCompanyId),
        messages: canonical,
        tools,
        effort: session.effort,
        signal: abortController.signal,
        resolvedAttachments: resolved,
        // Adapter-execute providers use this to resume their own session
        // (e.g. Claude Code session id) and persist updated params after each turn.
        adapterContext: {
          sessionId: session.id,
          companyId: session.companyId,
          boardUserId: session.boardUserId,
          prevSessionParams: session.adapterSessionParams,
          saveSessionParams: async (params) => {
            await db
              .update(chatSessions)
              .set({ adapterSessionParams: params, updatedAt: new Date() })
              .where(eq(chatSessions.id, session.id));
            session = { ...session, adapterSessionParams: params };
          },
          pluginMcpUrl,
        },
      });

      const messageStartedAt = new Date();
      yield { type: "message_started", messageId: `pending-${messageStartedAt.getTime()}`, role: "assistant" };

      let result;
      try {
        while (true) {
          const next = await turnStream.next();
          if (next.done) {
            result = next.value;
            break;
          }
          if (aborted) break;
          const event = next.value;
          if (event.type === "text_delta") {
            yield event;
          }
        }
      } catch (err) {
        // Aborts are user-initiated (Stop button or socket close) and not
        // actually errors — don't log noise or emit an error event.
        if (aborted || isAbortError(err)) return;
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, sessionId, provider: provider.name }, "Chat provider stream errored");
        yield { type: "error", error: message };
        return;
      }
      if (aborted || !result) return;

      const persisted = await appendAssistantMessage(sessionId, result.content);
      yield { type: "message_completed", messageId: persisted.id };

      const toolUseBlocks = result.content.filter(
        (b): b is Extract<CanonicalContentBlock, { type: "tool_use" }> => b.type === "tool_use",
      );

      if (toolUseBlocks.length === 0 || result.stopReason !== "tool_use") {
        yield { type: "done", stopReason: result.stopReason };
        return;
      }

      const toolResults: CanonicalContentBlock[] = [];
      let draftedThisIteration = false;
      for (const block of toolUseBlocks) {
        if (aborted) return;
        const def = CHAT_TOOLS.find((t) => t.name === block.name);
        const mutating = def?.mutating ?? false;
        yield {
          type: "tool_use_block",
          toolUseId: block.id,
          name: block.name,
          input: block.input,
          mutating,
        };

        let approved: boolean = !mutating || session.permissionMode === "bypass";
        if (mutating && session.permissionMode === "ask") {
          yield {
            type: "permission_required",
            toolUseId: block.id,
            name: block.name,
            input: block.input,
          };
          const decision = await chatPermissions.await(block.id, sessionId);
          approved = decision === "approve";
        }

        if (aborted) return;

        if (!approved) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            is_error: true,
            content: "User denied this action.",
          });
          yield {
            type: "tool_result_block",
            toolUseId: block.id,
            ok: false,
            result: { error: "User denied this action." },
          };
          continue;
        }

        const outcome = await executeChatTool(
          block.name,
          block.input,
          toolCtx,
          pluginToolDispatcher,
        );
        if (outcome.ok) {
          if (isDraftedToolOutcome(outcome.result)) draftedThisIteration = true;
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(outcome.result),
          });
          yield {
            type: "tool_result_block",
            toolUseId: block.id,
            ok: true,
            result: outcome.result,
          };
        } else {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            is_error: true,
            content: outcome.error,
          });
          yield {
            type: "tool_result_block",
            toolUseId: block.id,
            ok: false,
            result: { error: outcome.error },
          };
        }
      }

      await appendToolResults(sessionId, toolResults);

      // Trust-loop safety net: a tool was intercepted by the outbound draft
      // gate (queued as an approval). End the turn now so the LLM cannot
      // re-fire the same gated tool on the next iteration. The user resolves
      // the draft in the inbox; `appendApprovedDraftResultToChatSession`
      // wakes the conversation by appending a tool-role message they will
      // see on their next turn.
      if (draftedThisIteration) {
        yield { type: "done", stopReason: "tool_drafted" };
        if (mcpBridgeToken && pluginMcpBridge) {
          pluginMcpBridge.revokeToken(mcpBridgeToken);
        }
        return;
      }

      session = await getSession(actor, sessionId);
    }

    // Revoke the per-turn MCP bridge token now that the turn is over.
    // Token has a TTL fallback in the bridge, so a missed revoke just
    // means it lingers for a day, not a leak. Best effort either way.
    if (mcpBridgeToken && pluginMcpBridge) {
      pluginMcpBridge.revokeToken(mcpBridgeToken);
    }

    if (loops >= MAX_TOOL_LOOPS) {
      yield {
        type: "error",
        error: `Tool loop exceeded max iterations (${MAX_TOOL_LOOPS}). Stopping to avoid runaway.`,
      };
    }
  }

  async function resolvePermission(
    actor: ChatActor,
    sessionId: string,
    toolUseId: string,
    decision: "approve" | "deny",
  ) {
    await getSession(actor, sessionId);
    const ok = chatPermissions.resolve(sessionId, toolUseId, decision);
    if (!ok) throw notFound("No pending permission for this tool use");
  }

  function getMissingApiKeyError(): HttpError | null {
    if (listConfiguredProviders().length === 0) {
      return badRequest(
        "No LLM provider is configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or start a local Ollama (OLLAMA_HOST).",
      );
    }
    return null;
  }

  async function listModels() {
    return listAvailableModels();
  }

  return {
    listSessions,
    getSession,
    createSession,
    updateSession,
    deleteSession,
    listMessages,
    runTurn,
    resolvePermission,
    getMissingApiKeyError,
    listModels,
  };
}

export type ChatService = ReturnType<typeof chatService>;
