/**
 * What Clippy knows about the page it is opened on: a short name for the
 * context chip, the longer text a new chat stores as its page context, and a
 * few questions that fit the page.
 *
 * The page context only matters for a new chat. The server puts it in the
 * chat's system prompt when the chat is created ("User's current page when
 * this chat was opened"), and it never changes after that, so the chip is
 * shown only before the first send, while it can still be removed.
 */

export interface ClippyPageContext {
  /** Short words on the chip, e.g. "HQ | Issues". */
  label: string;
  /** What a new chat stores as its page context. */
  value: string;
}

/** The server's create-chat schema caps the page context at 500 characters. */
export const MAX_PAGE_CONTEXT_LENGTH = 500;

interface PageInput {
  pathname: string;
  /** The company prefix in the address, when the page is under one. */
  companyPrefix?: string | null;
  companyName?: string | null;
}

/** The address split into the page's own parts, without the company prefix. */
function pageSegments({ pathname, companyPrefix }: PageInput): string[] {
  const segments = pathname.split("/").filter(Boolean);
  if (companyPrefix && segments[0]?.toUpperCase() === companyPrefix.toUpperCase()) {
    return segments.slice(1);
  }
  return segments;
}

/**
 * The chip and the stored context for a page. Null on the Clippy page
 * itself, and when there is nothing to name.
 */
export function describeClippyPage(
  input: PageInput & { breadcrumbs?: ReadonlyArray<{ label: string }> },
): ClippyPageContext | null {
  const segments = pageSegments(input);
  if (segments[0] === "clippy" || segments[0] === "clippy-popup") return null;
  const crumbs = (input.breadcrumbs ?? []).map((crumb) => crumb.label.trim()).filter(Boolean);
  const companyName = input.companyName?.trim() || null;
  const pageName = crumbs.at(-1) ?? null;
  const label = [companyName, pageName].filter(Boolean).join(" | ");
  if (!label) return null;
  const trail = crumbs.length > 0 ? crumbs.join(" / ") : null;
  const details = [companyName ? `company ${companyName}` : null, trail ? `page ${trail}` : null]
    .filter(Boolean)
    .join(", ");
  const value = details ? `${input.pathname} (${details})` : input.pathname;
  return { label, value: value.slice(0, MAX_PAGE_CONTEXT_LENGTH) };
}

/** Words that sit after the section name in a list address, not a record id. */
const LIST_VIEWS = new Set(["active", "all", "backlog", "done", "recent", "error", "paused", "new", "pending"]);

/**
 * Three questions that fit the page, for the empty state. Matched on the
 * section of the address, so a page added later falls back to general
 * questions rather than to none.
 */
export function suggestedClippyPrompts(input: PageInput): string[] {
  const [section = "", detail] = pageSegments(input);
  const company = input.companyName?.trim() || null;
  const openIssues = company ? `Summarize open issues in ${company}` : "Summarize my open issues";
  const isDetail = Boolean(detail && !LIST_VIEWS.has(detail));

  switch (section) {
    case "issues":
      return isDetail
        ? ["Summarize this issue", "What is blocking this issue?", "What should happen next on this issue?"]
        : ["Which issues are blocked?", openIssues, "What changed in the last day?"];
    case "work":
    case "portfolio-issues":
      return ["Which issues are blocked?", openIssues, "What changed in the last day?"];
    case "agents":
      return isDetail
        ? ["What is this agent working on?", "Why did this agent's last run fail?", "Summarize this agent's recent runs"]
        : ["Which agents are working right now?", "Which agents failed recently, and why?", "Who is idle and could take more work?"];
    case "team":
    case "org":
    case "portfolio-agents":
      return ["Which agents are working right now?", "Which agents failed recently, and why?", "Who is idle and could take more work?"];
    case "projects":
      return ["Summarize this project's progress", "Which issues in this project are blocked?", "What should this project do next?"];
    case "goals":
      return ["How close is this goal to done?", "Which issues move this goal forward?", "What is blocking this goal?"];
    case "approvals":
    case "portfolio-approvals":
      return ["What is waiting for my approval?", "Summarize the oldest pending approval", "Which approvals are urgent?"];
    case "inbox":
      return ["What needs a reply from me?", "Summarize my unread items", "What came in today?"];
    case "email":
    case "portfolio-email":
      return ["Which emails need a reply today?", "Summarize my unread email", "Draft a reply to the latest email"];
    case "calendar":
    case "portfolio-calendar":
      return ["What is on my calendar today?", "Do I have any conflicts this week?", "Find time for a 30 minute meeting this week"];
    case "costs":
    case "portfolio-costs":
      return ["How much have the agents spent this month?", "Which agent costs the most?", "Are we on track with the budget?"];
    case "routines":
    case "portfolio-routines":
      return ["Which automations ran today?", "Did any automation fail recently?", "Set up a weekly summary for me"];
    case "memories":
      return ["What do you remember about me?", "Remember that I prefer short answers", "What did I ask you to keep in mind?"];
    default:
      return ["What needs my attention today?", openIssues, "Remind me to follow up on something tomorrow"];
  }
}

/**
 * The names the server gives the implicit board user of a local instance
 * (server/src/index.ts and middleware/auth.ts). Greeting someone as "Board"
 * reads like a bug, so these get no name at all.
 */
const PLACEHOLDER_USER_NAMES = new Set(["board", "local board"]);

/** The first name to greet the person with, or null to greet without one. */
export function clippyGreetingName(fullName: string | null | undefined): string | null {
  const trimmed = fullName?.trim() ?? "";
  if (!trimmed || PLACEHOLDER_USER_NAMES.has(trimmed.toLowerCase())) return null;
  // A person who never set a display name can be named by an address.
  if (trimmed.includes("@")) return null;
  return trimmed.split(/\s+/)[0] ?? null;
}
