/**
 * Turns an add-on's declared agent tools into something an operator can read.
 *
 * The host keeps a registry of every tool a plugin contributes
 * (`server/src/services/plugin-tool-registry.ts`). It is built straight from
 * the plugin manifest at load time, so each entry carries four things: the
 * name agents call (`slack_send_dm`), a human display name ("Send Slack DM"),
 * a description written for the agent, and the JSON Schema for its inputs.
 *
 * A raw tool name is not a sentence, and the description is written to tell an
 * agent when to reach for the tool, so it often runs on into caveats. This
 * module leads with the display name, keeps the first sentence of the
 * description as the short answer to "what does this do", and holds the rest
 * back as an optional note.
 *
 * It also answers the second question an operator has: does this apply to the
 * company I am looking at? Add-ons say which companies they serve with an
 * allow list in their settings, declared in the manifest as an array of
 * `format: "company-id"` values. An empty list serves nobody, and `"*"` serves
 * every company. See PLUGIN_SPEC.md section 10.1 for the fail-safe deny rule
 * that plugins apply to those lists.
 */

import type { PluginToolDeclaration } from "@paperclipai/shared";
import { isCompanyAllowed } from "@paperclipai/shared";
import type { JsonSchemaNode } from "@/components/JsonSchemaForm";

/** One tool, rewritten for a person rather than an agent. */
export interface PluginToolSummary {
  /** The name agents call, e.g. `"slack_send_dm"`. Shown small, for reference. */
  name: string;
  /** The heading a person reads, e.g. "Send Slack DM". */
  title: string;
  /** One sentence saying what it does. */
  summary: string;
  /** Anything the add-on author wrote after that first sentence. Empty when there is none. */
  detail: string;
}

/**
 * Words that end in a full stop without ending the sentence. Without this a
 * description like "Address by channelId (e.g. C123) or name." would be cut
 * after "e.g.".
 */
const ABBREVIATIONS = new Set([
  "e.g.",
  "i.e.",
  "etc.",
  "vs.",
  "approx.",
  "no.",
  "fig.",
  "mr.",
  "mrs.",
  "ms.",
  "dr.",
]);

/**
 * Strip the light markdown add-on authors use in descriptions and flatten
 * whitespace, so the text reads as a plain sentence in the settings page.
 * Wording is left alone: these are the author's own words.
 */
function toPlainText(raw: string): string {
  return raw
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when `text` ends on something like "e.g." rather than a real full stop. */
function endsOnAbbreviation(text: string): boolean {
  const lastWord = text.slice(text.lastIndexOf(" ") + 1).toLowerCase();
  return ABBREVIATIONS.has(lastWord);
}

/**
 * Split a tool description into its first sentence and whatever follows.
 *
 * The first sentence is nearly always the plain "what it does"; the rest is
 * advice aimed at the agent (which parameter to pass, which switch gates it).
 */
export function splitToolDescription(description: string): { summary: string; detail: string } {
  const text = toPlainText(description ?? "");
  if (text.length === 0) return { summary: "", detail: "" };

  const boundary = /[.!?](?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(text)) !== null) {
    const end = match.index + 1;
    const head = text.slice(0, end);
    if (endsOnAbbreviation(head)) continue;
    return { summary: head, detail: text.slice(end).trim() };
  }

  return { summary: text, detail: "" };
}

/**
 * Fallback heading when an add-on declares a tool with no display name:
 * `"slack_send_dm"` becomes "Slack send dm". Every add-on installed today
 * does give a display name, so this is a safety net, not the normal path.
 */
export function humanizeToolName(name: string): string {
  const words = name.replace(/[_.-]+/g, " ").trim();
  if (words.length === 0) return name;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Everything an add-on's tools say about themselves, in reading order.
 *
 * Returns an empty array for an add-on that contributes no tools, which is a
 * normal thing for an add-on to do (some only contribute a page).
 */
export function summarizePluginTools(
  tools: PluginToolDeclaration[] | undefined | null,
): PluginToolSummary[] {
  if (!Array.isArray(tools)) return [];

  const summaries: PluginToolSummary[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool.name !== "string" || tool.name.length === 0) continue;
    const title =
      typeof tool.displayName === "string" && tool.displayName.trim().length > 0
        ? tool.displayName.trim()
        : humanizeToolName(tool.name);
    const { summary, detail } = splitToolDescription(
      typeof tool.description === "string" ? tool.description : "",
    );
    summaries.push({ name: tool.name, title, summary, detail });
  }
  return summaries;
}

/** Where the company an operator is looking at stands with an add-on. */
export interface PluginCompanyAccess {
  /** True when the add-on's settings name the companies it serves. */
  scoped: boolean;
  /**
   * True when somebody has actually filled one of those lists in. False means
   * the add-on is installed but nobody has said who it is for yet.
   */
  configured: boolean;
  /** True when this company is covered. Always true when the add-on is not scoped. */
  allowed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A schema node that holds a list of company ids, i.e. an allow list. */
function isCompanyAllowList(schema: JsonSchemaNode): boolean {
  return schema.items?.format === "company-id";
}

/**
 * Walk the settings schema and the saved settings side by side, collecting
 * every company allow list. Following the schema rather than guessing at key
 * names means an add-on that keeps its lists per account (Slack keeps one per
 * workspace, Help Scout one per account) is read the same way as one with a
 * single list at the top.
 */
function collectAllowLists(
  schema: JsonSchemaNode | undefined,
  value: unknown,
  found: string[][],
  declared: { any: boolean },
): void {
  if (!schema || typeof schema !== "object") return;

  if (isCompanyAllowList(schema)) {
    declared.any = true;
    if (Array.isArray(value)) {
      found.push(value.filter((entry): entry is string => typeof entry === "string"));
    }
    return;
  }

  if (schema.properties) {
    for (const [key, child] of Object.entries(schema.properties)) {
      collectAllowLists(child, isRecord(value) ? value[key] : undefined, found, declared);
    }
  }

  const items = schema.items;
  if (items) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        collectAllowLists(items, entry, found, declared);
      }
    } else {
      // No saved entries yet, but still walk the shape so a nested allow list
      // counts as declared.
      collectAllowLists(items, undefined, found, declared);
    }
  }
}

/**
 * Work out whether an add-on's tools apply to the company being viewed.
 *
 * An add-on that names no companies at all is available everywhere, so it gets
 * `scoped: false` and nothing needs saying on screen.
 */
export function resolvePluginCompanyAccess(
  schema: JsonSchemaNode | undefined | null,
  savedSettings: Record<string, unknown> | undefined | null,
  companyId: string | undefined | null,
): PluginCompanyAccess {
  const found: string[][] = [];
  const declared = { any: false };
  collectAllowLists(schema ?? undefined, savedSettings ?? undefined, found, declared);

  if (!declared.any) {
    return { scoped: false, configured: true, allowed: true };
  }

  const configured = found.some((list) => list.length > 0);
  if (!companyId) {
    return { scoped: true, configured, allowed: false };
  }

  const allowed = found.some((list) => isCompanyAllowed(list, companyId));
  return { scoped: true, configured, allowed };
}
