/**
 * Plain-language presentation for Clippy tool calls.
 *
 * Raw tool names ("3cx-tools__pbx_click_to_call") and raw input JSON are for
 * debugging, not for deciding whether to approve an action. This module turns
 * a tool call into a short human label plus one sentence saying what will
 * actually happen, so cards and permission prompts can lead with English and
 * demote the technical bits.
 */

export interface ToolPresentation {
  /** Short human label, e.g. "Create an issue". */
  label: string;
  /** Plugin the tool comes from, when it is a plugin tool. */
  via?: string;
  /** One plain sentence for the permission prompt: what will really happen. */
  sentence: string;
}

const READ_SENTENCE = "This looks up information. Nothing is changed.";

type SentenceBuilder = (input: Record<string, unknown>) => string;

const BUILT_IN: Record<string, { label: string; sentence?: SentenceBuilder }> = {
  list_companies: { label: "Look up your companies" },
  get_company: { label: "Look up a company" },
  list_agents: { label: "Look up agents" },
  get_agent: { label: "Look up an agent" },
  list_issues: { label: "Look up issues" },
  get_issue: { label: "Look up an issue" },
  create_issue: {
    label: "Create an issue",
    sentence: (input) => {
      const title = asString(input.title);
      return title
        ? `This creates a new issue called "${truncate(title, 80)}".`
        : "This creates a new issue.";
    },
  },
  add_comment: {
    label: "Comment on an issue",
    sentence: () =>
      "This posts a comment on an issue. Agents watching the issue will see it and may act on it.",
  },
  broadcast_directive: {
    label: "Send a directive to companies",
    sentence: (input) => {
      const intent = asString(input.intent);
      const companyIds = Array.isArray(input.companyIds) ? input.companyIds : null;
      const scope =
        companyIds && companyIds.length > 0
          ? `${companyIds.length} selected ${companyIds.length === 1 ? "company" : "companies"}`
          : "every company";
      return intent
        ? `This creates a task for the CEO agent of ${scope}, wakes them, and tells them: "${truncate(intent, 100)}"`
        : `This creates a task for the CEO agent of ${scope} and wakes them to act on it.`;
    },
  },
  create_reminder: {
    label: "Set a reminder",
    sentence: () => "This schedules a reminder that will fire on its own later.",
  },
  cancel_reminder: {
    label: "Cancel a reminder",
    sentence: () => "This cancels a reminder so it stops firing.",
  },
};

export function describeChatTool(name: string, input: unknown): ToolPresentation {
  const inputObj =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};

  const builtIn = BUILT_IN[name];
  if (builtIn) {
    return {
      label: builtIn.label,
      sentence: builtIn.sentence ? builtIn.sentence(inputObj) : READ_SENTENCE,
    };
  }

  // Plugin tools are namespaced "<plugin>__<tool>".
  const sepIdx = name.indexOf("__");
  if (sepIdx > 0) {
    const plugin = name.slice(0, sepIdx);
    const label = humanize(name.slice(sepIdx + 2));
    return {
      label,
      via: plugin,
      sentence: `This runs "${label}" from the ${plugin} plugin. It may act on systems outside Paperclip.`,
    };
  }

  // Unknown built-in: guess read vs write from the verb prefix.
  const looksReadOnly = /^(list|get|search|find|read|show)_/.test(name);
  return {
    label: humanize(name),
    sentence: looksReadOnly
      ? READ_SENTENCE
      : "This runs the tool shown below. It may make real changes.",
  };
}

/** Compact one-line preview of a completed tool result for the card face. */
export function toolResultPreview(data: unknown, maxLength = 140): string | null {
  if (data == null) return null;
  let text: string;
  if (typeof data === "string") {
    text = data;
  } else {
    try {
      text = JSON.stringify(data);
    } catch {
      return null;
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  if (text.length === 0 || text === "{}" || text === "[]") return null;
  return truncate(text, maxLength);
}

/** Mirrors DRAFT_RESULT_HEADER in server/src/services/tool-draft-gate.ts. */
const DRAFT_RESULT_HEADER = "[paperclip:tool-draft] queued for human approval";

/**
 * Detect a draft-gate outcome and extract its approval id. The gate produces
 * two shapes: the human-readable marker text ("[paperclip:tool-draft] …\n
 * Approval ID: <id>…", what chat-tools streams and persists for plugin
 * tools) and the structured `{ drafted: true, approvalId }` object.
 */
export function draftedApprovalId(data: unknown): string | null {
  if (typeof data === "string") {
    if (!data.startsWith(DRAFT_RESULT_HEADER)) return null;
    const match = /^Approval ID:\s*(\S+)\s*$/m.exec(data);
    return match ? match[1] : null;
  }
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  if (obj.drafted !== true) return null;
  return typeof obj.approvalId === "string" ? obj.approvalId : null;
}

/**
 * One-line `key=value` summary of a tool call's input for the card header,
 * so historical cards keep their context without expanding. (Restores the
 * pre-redesign header summary.)
 */
export function toolInputSummary(input: unknown): string {
  if (input == null) return "";
  if (typeof input !== "object") return String(input);
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return "";
  const summary = entries
    .slice(0, 3)
    .map(
      ([k, v]) =>
        `${k}=${typeof v === "string" ? `"${truncate(v, 30)}"` : truncate(JSON.stringify(v) ?? String(v), 30)}`,
    )
    .join(", ");
  return entries.length > 3 ? `${summary}, …` : summary;
}

/** "12s", "1m 48s", "1h 04m" — for elapsed/duration readouts on cards. */
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${String(sec).padStart(2, "0")}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${String(min % 60).padStart(2, "0")}m`;
}

/** "4:12", "0:09" — mm:ss countdown for the permission prompt. */
export function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

function humanize(raw: string): string {
  const words = raw.replace(/[_-]+/g, " ").trim();
  if (words.length === 0) return raw;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}
