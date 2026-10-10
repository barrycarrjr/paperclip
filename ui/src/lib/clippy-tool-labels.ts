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

interface BuiltInTool {
  label: string;
  /** What was done, for a finished step: "Created an issue". */
  done?: string;
  /** The same, when the result names an issue, which is linked after it: "Created issue". */
  doneWithIssue?: string;
  /** The input field worth naming after `done`, such as a memory's name. */
  detailFromInput?: string;
  sentence?: SentenceBuilder;
}

const BUILT_IN: Record<string, BuiltInTool> = {
  list_companies: { label: "Look up your companies", done: "Looked up your companies" },
  get_company: { label: "Look up a company", done: "Looked up a company" },
  list_agents: { label: "Look up agents", done: "Looked up agents" },
  get_agent: { label: "Look up an agent", done: "Looked up an agent" },
  list_issues: { label: "Look up issues", done: "Looked up issues" },
  get_issue: { label: "Look up an issue", done: "Looked up an issue", doneWithIssue: "Looked up issue" },
  create_issue: {
    label: "Create an issue",
    done: "Created an issue",
    doneWithIssue: "Created issue",
    sentence: (input) => {
      const title = asString(input.title);
      return title
        ? `This creates a new issue called "${truncate(title, 80)}".`
        : "This creates a new issue.";
    },
  },
  add_comment: {
    label: "Comment on an issue",
    done: "Added a comment",
    doneWithIssue: "Commented on",
    sentence: () =>
      "This posts a comment on an issue. Agents watching the issue will see it and may act on it.",
  },
  broadcast_directive: {
    label: "Send a directive to companies",
    done: "Sent a directive to companies",
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
    done: "Set a reminder",
    sentence: () => "This schedules a reminder that will fire on its own later.",
  },
  cancel_reminder: {
    label: "Cancel a reminder",
    done: "Cancelled a reminder",
    sentence: () => "This cancels a reminder so it stops firing.",
  },
  remember: {
    label: "Remember something",
    done: "Remembered",
    detailFromInput: "name",
    sentence: (input) => {
      const name = asString(input.name);
      return name
        ? `This saves "${truncate(name, 80)}" to this company's memories. It is stored encrypted and shared with everyone who has access to the company.`
        : "This saves a memory for this company. It is stored encrypted and shared with everyone who has access to the company.";
    },
  },
  recall_memories: { label: "Look up memories", done: "Looked up memories" },
  forget_memory: {
    label: "Forget a memory",
    done: "Forgot",
    detailFromInput: "name",
    sentence: (input) => {
      const name = asString(input.name);
      return name
        ? `This permanently deletes the memory "${truncate(name, 80)}".`
        : "This permanently deletes a stored memory.";
    },
  },
};

export function describeChatTool(name: string, input: unknown): ToolPresentation {
  const inputObj =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const supportName = name.replace("customer-support:", "customer-support__");
  if (supportName === "customer-support__support_send_message") {
    const destination = inputObj.destination as Record<string,unknown> | undefined;
    return { label: "Send the reviewed support message",via: "Support Desk",
      sentence: `Send to ${asString(destination?.to) || asString(destination?.channelId) || "the saved destination"}${destination?.threadTs ? ` in thread ${destination.threadTs}` : ""}${destination?.subject ? `, subject: ${destination.subject}` : ""}. Message: ${asString(inputObj.body) || "see the saved draft"}. This sends one external message; repair delegation does not approve it.` };
  }
  if (supportName === "customer-support__support_run_repair") return {
    label: "Run the proposed repair", via: "Support Desk",
    sentence: `On ${asString(inputObj.target) || "the case computer"}: ${asString(inputObj.expectedEffect) || "run the proposed repair"}. Recovery: ${asString(inputObj.recoveryNotes) || "see the proposal"}. The repair and verification scripts are available below.`,
  };
  if (supportName === "customer-support__support_delegate_case") return {
    label: "Handle repairs for this case", via: "Support Desk",
    sentence: `Authorize repairs on ${asString(inputObj.target) || "the case computer"} for this case and conversation for one hour, without a prompt for each change. ${asString(inputObj.purpose) || ""}`,
  };
  if (supportName === "customer-support__support_record_outcome") return {
    label: "Record the support outcome", via: "Support Desk",
    sentence: `For ${asString(inputObj.target) || "the case computer"}, record the problem as ${(asString(inputObj.outcome) || "reviewed").replaceAll("_", " ")}. ${asString(inputObj.summary) || ""} Evidence: ${asString(inputObj.evidence) || "see the details"}. This ends the case's previous repair delegation.`,
  };

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

/**
 * One line saying what a tool step did, for the collapsed step in a
 * conversation: "Created issue HQ-1 · Send the IRS letter" rather than the
 * tool's raw input and raw JSON result, which stay behind its details toggle.
 */
export interface ToolStepSummary {
  /** The words, e.g. "Created issue", "Could not look up issues". */
  text: string;
  /** An issue the step made or found, shown linked after the words. */
  issueIdentifier?: string;
  /** A short, muted detail after that: the issue's title, "3 found", why it failed. */
  detail?: string;
}

export type ToolStepState = "running" | "done" | "failed" | "denied" | "interrupted";

const ISSUE_IDENTIFIER_RE = /^[A-Z][A-Z0-9]+-\d+$/;

/** The list a lookup returned, whether bare or under one key such as `issues`. */
function resultList(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return null;
  const lists = Object.values(data as Record<string, unknown>).filter(Array.isArray);
  return lists.length === 1 ? (lists[0] as unknown[]) : null;
}

/** The most useful part of a finished step's result. */
function resultHighlights(data: unknown): { issueIdentifier?: string; detail?: string } {
  if (typeof data === "string") {
    const line = data.trim();
    // A short sentence back ("Reminder set for Friday 9:00") is worth showing;
    // anything long or multi-line stays in the details.
    return line && line.length <= 80 && !line.includes("\n") ? { detail: line } : {};
  }
  const list = resultList(data);
  if (list) return { detail: `${list.length} found` };
  if (!data || typeof data !== "object") return {};
  const obj = data as Record<string, unknown>;
  const identifier = asString(obj.identifier);
  const title = asString(obj.title) ?? asString(obj.name);
  return {
    ...(identifier && ISSUE_IDENTIFIER_RE.test(identifier) ? { issueIdentifier: identifier } : {}),
    ...(title ? { detail: truncate(title, 80) } : {}),
  };
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** The first line of an error result, short. */
function errorLine(data: unknown): string | undefined {
  const text =
    typeof data === "string"
      ? data
      : data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : "";
  const line = text.replace(/^\[[^\]]*\]\s*/, "").split(/\r?\n/, 1)[0]?.trim();
  return line ? truncate(line, 80) : undefined;
}

export function summarizeToolStep(
  name: string,
  input: unknown,
  state: ToolStepState,
  resultData?: unknown,
): ToolStepSummary {
  const presentation = describeChatTool(name, input);
  const label = presentation.label;
  switch (state) {
    case "running":
      return { text: `${label}…` };
    case "failed":
      return { text: `Could not ${lowerFirst(label)}`, detail: errorLine(resultData) };
    case "denied":
      return { text: `Did not ${lowerFirst(label)}`, detail: "you said no" };
    case "interrupted":
      return { text: label, detail: "no result" };
    case "done": {
      const builtIn = BUILT_IN[name];
      const highlights = resultHighlights(resultData);
      const inputObj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
      const inputDetail = builtIn?.detailFromInput ? asString(inputObj[builtIn.detailFromInput]) : null;
      if (highlights.issueIdentifier) {
        return {
          text: builtIn?.doneWithIssue ?? builtIn?.done ?? label,
          issueIdentifier: highlights.issueIdentifier,
          detail: highlights.detail,
        };
      }
      return {
        text: builtIn?.done ?? label,
        detail: inputDetail ? truncate(inputDetail, 80) : highlights.detail,
      };
    }
  }
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
