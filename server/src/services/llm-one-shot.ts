import { randomUUID } from "node:crypto";
import {
  getProviderForModel,
  decodeAdapterModel,
  removeClippyWorkspace,
  type CanonicalContentBlock,
  type ProviderTurnResult,
  type ResolvedAttachments,
} from "./chat-providers.js";
import { logger } from "../middleware/logger.js";

/**
 * One-shot model calls from the server itself (plugin `ai.complete`, the
 * start-work planner). Every caller used to carry its own copy of the same
 * streamTurn drain; this is the single copy. Callers own model choice,
 * prompt shape, audit logging and error wording, so this module only turns
 * "model + system + content" into "text", and cleans up after itself.
 */

export type OneShotErrorCode = "unknown_model" | "not_configured";

/**
 * Thrown before any provider call is made. Callers map `code` onto their own
 * error vocabulary (plugin `[E...]` strings, HTTP statuses) rather than
 * matching on message text.
 */
export class OneShotError extends Error {
  code: OneShotErrorCode;
  model: string;
  constructor(code: OneShotErrorCode, model: string) {
    super(
      code === "unknown_model"
        ? `no provider handles model "${model}"`
        : `provider for "${model}" is missing credentials`,
    );
    this.name = "OneShotError";
    this.code = code;
    this.model = model;
  }
}

export interface CompleteOnceInput {
  model: string;
  system: string;
  content: CanonicalContentBlock[] | string;
  resolvedAttachments?: ResolvedAttachments;
  /**
   * Names the caller in the ephemeral session id and in the cleanup warning
   * (for example `plugin-ai-<pluginId>` or `start-work-planner`), so a
   * leftover workspace or a log line can be traced back to who asked.
   */
  callerLabel: string;
  /** Adapter-side audit identity; falls back to `callerLabel`. */
  boardUserId?: string | null;
}

export interface CompleteOnceResult {
  text: string;
  modelUsed: string;
  stopReason: ProviderTurnResult["stopReason"];
}

export async function completeOnce(input: CompleteOnceInput): Promise<CompleteOnceResult> {
  const modelToUse = input.model;
  const provider = getProviderForModel(modelToUse);
  if (!provider) {
    throw new OneShotError("unknown_model", modelToUse);
  }
  if (!provider.isConfigured()) {
    throw new OneShotError("not_configured", modelToUse);
  }

  const content: CanonicalContentBlock[] =
    typeof input.content === "string" ? [{ type: "text", text: input.content }] : input.content;

  // Adapter-routed providers (claude_local etc.) require an adapterContext
  // (session identity, callbacks for persisting per-turn state, etc.) that
  // comes from the chat orchestrator in the Clippy flow. For a one-shot we
  // synthesize a minimal context: a per-call sessionId so the provider can
  // materialize a private workspace (and we clean it up afterwards), a no-op
  // saveSessionParams (we never resume), and the caller's identity as the
  // boardUserId so adapter-side audit trails name the actual caller. Native
  // providers (Anthropic, OpenAI, Gemini SDKs) ignore this entirely.
  const ephemeralSessionId = `${input.callerLabel}-${randomUUID()}`;
  const isAdapterRoute = decodeAdapterModel(modelToUse) !== null;
  const adapterContext = isAdapterRoute
    ? {
        sessionId: ephemeralSessionId,
        companyId: null,
        boardUserId: input.boardUserId ?? input.callerLabel,
        prevSessionParams: null,
        saveSessionParams: async () => {
          /* one-shot, nothing to persist */
        },
      }
    : undefined;

  let final: ProviderTurnResult | null = null;
  try {
    // Drain the provider stream into a final result. We discard text_delta
    // events (no caller-side streaming on this surface) and use the returned
    // ProviderTurnResult.content to assemble plain text.
    const generator = provider.streamTurn({
      model: modelToUse,
      system: input.system,
      messages: [{ role: "user", content }],
      resolvedAttachments: input.resolvedAttachments,
      adapterContext,
    });
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const step = await generator.next();
      if (step.done) {
        final = step.value;
        break;
      }
      // streaming events ignored for one-shot
    }
  } finally {
    // Adapter routes materialized a per-call workspace; drop it now so we
    // don't litter ~/.paperclip/clippy-workspaces with one-shot dirs.
    if (isAdapterRoute) {
      removeClippyWorkspace(ephemeralSessionId).catch((err) => {
        logger.warn(
          { caller: input.callerLabel, sessionId: ephemeralSessionId, err: (err as Error).message },
          "one-shot completion: failed to clean up ephemeral workspace",
        );
      });
    }
  }

  const text = (final?.content ?? [])
    .filter((b): b is Extract<CanonicalContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  return { text, modelUsed: modelToUse, stopReason: final?.stopReason ?? "other" };
}

export type OneShotJsonErrorCode = "not_json" | "not_object";

/** Thrown by parseJsonObject; `code` says whether the text failed to parse or parsed to a non-object. */
export class OneShotJsonError extends Error {
  code: OneShotJsonErrorCode;
  constructor(code: OneShotJsonErrorCode, detail?: string) {
    super(
      code === "not_json"
        ? `model output is not valid JSON${detail ? `: ${detail}` : ""}`
        : "model output is JSON but not an object",
    );
    this.name = "OneShotJsonError";
    this.code = code;
  }
}

/**
 * Models asked for "JSON only" still wrap the answer in a ```json fence often
 * enough that every JSON caller would end up stripping it. One fence is
 * removed; anything else must already be a JSON object.
 */
export function parseJsonObject(text: string): Record<string, unknown> {
  let body = text.trim();
  const fence = body.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/i);
  if (fence) body = fence[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new OneShotJsonError("not_json", (err as Error).message);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OneShotJsonError("not_object");
  }
  return parsed as Record<string, unknown>;
}
