import { Router } from "express";
import { z } from "zod";
import { badRequest, forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";
import {
  getProviderForModel,
  listConfiguredProviders,
  type AdapterTurnContext,
  type CanonicalContentBlock,
  type CanonicalMessage,
  type ChatProvider,
} from "../services/chat-providers.js";
import { buildDraftUserText, stripDraftPreamble } from "../services/email-draft-text.js";

const draftReplySchema = z.object({
  subject: z.string().max(500).optional(),
  from: z.string().max(500).optional(),
  /** Recipient — only meaningful when composing a new message. */
  to: z.string().max(500).optional(),
  bodyText: z.string().max(50_000).default(""),
  instructions: z.string().max(2000).optional(),
  /** Reply text already in the composer — when set, the model revises it
   *  instead of starting over, so the operator can nudge a draft repeatedly. */
  currentDraft: z.string().max(20_000).optional(),
  /** "reply" answers an email the operator received; "new" writes a first
   *  message to someone, where there is no incoming email to work from. */
  mode: z.enum(["reply", "new"]).default("reply"),
  model: z.string().max(200).optional(),
});

/** Shared tail — the composer pastes the response in verbatim, so it has to
 *  be the message and nothing else. */
const OUTPUT_RULES = [
  "Your entire response is pasted straight into the operator's compose box and sent to",
  "the recipient as-is, so it must contain nothing but the message itself:",
  "- Begin with the first word of the message. Never announce what you are about to do.",
  '- Never write lead-ins like "Here is the draft:", "Sure, here you go:", or "Let me write that".',
  "- Never restate or comment on the task, the instructions, or your reasoning.",
  "- Add no commentary afterwards either — no \"let me know if you'd like changes\".",
].join("\n");

const REPLY_SYSTEM_PROMPT = [
  "You are drafting a reply to an email on behalf of the operator who received it.",
  "Read the email and produce a polite, concise reply.",
  "",
  "Guidelines:",
  "- Write only the body of the reply. Do not include a salutation line, signature, or quoted history.",
  "- Match the tone of the email being replied to (formal/casual).",
  "- Address the points raised; do not invent facts.",
  "- If the email asks specific questions you cannot answer, acknowledge the question and ask for the missing detail rather than guessing.",
  "- Keep it under 200 words unless the email is unusually detailed.",
  "- Output plain text only — no markdown, no headers.",
  "",
  OUTPUT_RULES,
].join("\n");

const NEW_MESSAGE_SYSTEM_PROMPT = [
  "You are writing a new outbound email on behalf of the operator. There is no",
  "incoming email — the operator's instructions describe what they want to say.",
  "",
  "Guidelines:",
  "- Write only the body. Do not include a salutation line, a subject line, or a signature.",
  "- Professional and warm, and as brief as the message allows.",
  "- Invent nothing. Order numbers, dates, prices, names, commitments and delivery",
  "  times must come from the operator's instructions. If a detail is missing, either",
  "  leave it out or ask the recipient for it — never make one up and never write a",
  "  placeholder like [date] or [order number].",
  "- If the instructions are too thin to write from, write the shortest honest message",
  "  that opens the conversation rather than padding it with invented specifics.",
  "- Keep it under 200 words unless the instructions call for more.",
  "- Output plain text only — no markdown, no headers.",
  "",
  OUTPUT_RULES,
].join("\n");

// When the caller explicitly chose a model, honor it — including adapter-routed
// (claude_local etc.). When no model is requested, auto-pick a *native* provider
// so we don't silently spin up an adapter CLI subprocess for someone who hasn't
// opted into it. The auto-pick keeps Ollama last because its `isConfigured()`
// returns true even when the daemon isn't actually running.
function pickProviderAndModel(
  requestedModel: string | undefined,
): { provider: ChatProvider; model: string } | null {
  if (requestedModel) {
    const p = getProviderForModel(requestedModel);
    if (p && p.isConfigured()) return { provider: p, model: requestedModel };
    return null;
  }
  const preferred: Array<ChatProvider["name"]> = ["anthropic", "openai", "gemini", "ollama"];
  for (const name of preferred) {
    const p = listConfiguredProviders().find((x) => x.name === name);
    if (p) return { provider: p, model: p.defaultModel() };
  }
  return null;
}

export function emailDraftRoutes() {
  const router = Router();

  router.post("/email-drafts/reply", async (req, res) => {
    if (req.actor.type !== "board") {
      throw forbidden("Email drafting is available to board users only");
    }
    const boardUserId = req.actor.userId;
    if (!boardUserId) throw forbidden("Board user context required");
    const companyId = req.actor.companyIds?.[0] ?? null;

    const parsed = draftReplySchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    const {
      subject,
      from,
      to,
      bodyText,
      instructions,
      currentDraft,
      mode,
      model: requestedModel,
    } = parsed.data;
    const revising = !!currentDraft?.trim();

    // A new message has no incoming email, so the instructions (or at minimum a
    // subject) are the only thing to write from. Without either, the model can
    // only invent — better to say so than to hand back a fabricated email.
    if (mode === "new" && !instructions?.trim() && !subject?.trim() && !revising) {
      throw badRequest("Tell the AI what the message should say, or fill in a subject first.");
    }

    const pick = pickProviderAndModel(requestedModel);
    if (!pick) {
      throw badRequest(
        requestedModel
          ? `Model "${requestedModel}" is not available or its provider is not configured.`
          : "No LLM provider is configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, run Ollama locally, or pick an adapter-routed model.",
      );
    }
    const { provider, model } = pick;

    const userText = buildDraftUserText({
      mode,
      subject,
      from,
      to,
      bodyText,
      instructions,
      currentDraft,
    });

    const messages: CanonicalMessage[] = [{ role: "user", content: userText }];

    // Adapter-routed providers (claude_local etc.) require an adapter context.
    // For one-shot drafts we synthesize a minimal one — stable per user so we
    // don't accumulate a workspace directory per draft, and noop saveSessionParams
    // so adapter session state isn't persisted across drafts.
    const adapterContext: AdapterTurnContext = {
      sessionId: `email-draft-${boardUserId}`,
      companyId,
      boardUserId,
      prevSessionParams: null,
      saveSessionParams: async () => {
        /* discard — one-shot, no resume */
      },
    };

    let accumulated = "";
    try {
      const stream = provider.streamTurn({
        model,
        system: mode === "new" ? NEW_MESSAGE_SYSTEM_PROMPT : REPLY_SYSTEM_PROMPT,
        messages,
        adapterContext,
      });
      while (true) {
        const next = await stream.next();
        if (next.done) {
          const blockText = (next.value.content as CanonicalContentBlock[])
            .filter((b): b is Extract<CanonicalContentBlock, { type: "text" }> => b.type === "text")
            .map((b) => b.text)
            .join("");
          if (blockText && blockText.length > accumulated.length) {
            accumulated = blockText;
          }
          break;
        }
        const ev = next.value;
        if (ev.type === "text_delta") accumulated += ev.delta;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, provider: provider.name, model }, "Email draft completion failed");
      res.status(502).json({ error: message });
      return;
    }

    res.json({ draft: stripDraftPreamble(accumulated), model });
  });

  return router;
}
