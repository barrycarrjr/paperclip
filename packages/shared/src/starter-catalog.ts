/**
 * The starter catalog: the list of finished outcomes a company can switch on.
 *
 * This is what sits behind the "What do you want done?" button. Two rules
 * shape it, both from the design it implements:
 *
 * 1. **Outcomes, not features.** Cards are named for the job the operator
 *    wants done ("Never lose a lead"), not the vendor that supplies it
 *    ("Financial Services"). Someone who does not yet know Paperclip's
 *    vocabulary can still recognise their own problem in this list.
 *
 * 2. **No dead cards.** Never show something that cannot run end to end. A
 *    card the user switches on that then quietly does nothing is worse than
 *    no card at all. Every entry here names the plugins it genuinely needs,
 *    and the server refuses to pretend a card is ready when they are missing.
 *
 * Deliberately static, in the repo, rather than rows in a database: it is
 * reviewable in a diff, it ships with the code that has to satisfy it, and
 * it is the same on every instance.
 */

/** Priority values a starter routine may request (mirrors ISSUE_PRIORITIES). */
export type StarterPriority = "critical" | "high" | "medium" | "low";

export const STARTER_CATEGORIES = [
  {
    id: "get-found",
    title: "Get found and get chosen",
    blurb: "Show up well where customers are already looking.",
  },
  {
    id: "never-lose-a-lead",
    title: "Never lose a lead",
    blurb: "Reach people while they are still interested.",
  },
  {
    id: "keep-customers-happy",
    title: "Keep customers happy",
    blurb: "Know how support and the phones are actually doing.",
  },
  {
    id: "keep-the-lights-on",
    title: "Keep the lights on",
    blurb: "Find out something broke before a customer tells you.",
  },
  {
    id: "run-the-business",
    title: "Run the business",
    blurb: "The owner-level view across everything.",
  },
] as const;

export type StarterCategoryId = (typeof STARTER_CATEGORIES)[number]["id"];

export interface StarterCard {
  id: string;
  category: StarterCategoryId;
  /** The outcome, phrased as the operator would say it out loud. */
  title: string;
  /** One line: what it actually does. */
  what: string;
  /** One line: when it runs. Plain words, not cron. */
  when: string;
  /**
   * Plugin keys that must be installed and running before this can work.
   * The price of admission, stated up front — the thing the old Routines
   * page never told you until after you had switched something on.
   */
  requiresPlugins: string[];
  /**
   * Extra words the free-text box should match on, beyond the title. These
   * are how someone gets there by typing "reviews" or "missed call" instead
   * of knowing the card's name.
   */
  matches: string[];
  /** The routine this card creates when switched on. */
  routine: {
    title: string;
    description: string;
    priority: StarterPriority;
    /** Standard 5-field cron. */
    cron: string;
    /** IANA zone the cron is read in. */
    timezone: string;
  };
}

/**
 * Every card here is backed by a plugin that exists. The design document
 * lists more ideas (newsletters, invoice chasing, quarterly goal check-ins);
 * they are deliberately absent until something can actually carry them out,
 * because listing them would break rule 2 above.
 */
export const STARTER_CARDS: StarterCard[] = [
  {
    id: "reply-google-reviews",
    category: "get-found",
    title: "Reply to every Google review within a day",
    what: "Drafts a reply in your voice for each new review and puts it up for approval.",
    when: "Checks every morning at 8am",
    requiresPlugins: ["gbp-reviews"],
    matches: ["google", "reviews", "reputation", "stars", "gbp", "business profile"],
    routine: {
      title: "Reply to new Google reviews",
      description: [
        "Check Google Business Profile for reviews that have come in since the last run.",
        "",
        "For each one, draft a reply in the company's voice: thank the reviewer by name,",
        "answer anything specific they raised, and keep it short. Do not send it —",
        "submit it for approval so a person sees it first.",
        "",
        "If a review is under 4 stars, say so clearly at the top of your summary so it",
        "is not buried among the good ones.",
      ].join("\n"),
      priority: "high",
      cron: "0 8 * * *",
      timezone: "America/New_York",
    },
  },
  {
    id: "call-web-form-leads",
    category: "never-lose-a-lead",
    title: "Call new web form leads within 5 minutes",
    what: "Rings a fresh inbound lead, qualifies them, and books the follow-up.",
    when: "Checks every 5 minutes during business hours",
    requiresPlugins: ["phone-tools"],
    matches: ["lead", "leads", "web form", "contact form", "call back", "inbound", "quote"],
    routine: {
      title: "Call new web form leads",
      description: [
        "Look for web form leads that have arrived since the last run and have not been",
        "called yet.",
        "",
        "For each one, place a short outbound call: confirm what they are after, how big",
        "the job is, and whether they are the person who decides. Book a follow-up if",
        "there is interest; mark them disqualified if there plainly isn't.",
        "",
        "Speed is the whole point — a lead contacted within five minutes converts far",
        "better than one called an hour later. If you cannot reach them, leave a message",
        "and try once more later the same day.",
      ].join("\n"),
      priority: "critical",
      cron: "*/5 8-18 * * 1-5",
      timezone: "America/New_York",
    },
  },
  {
    id: "call-back-no-shows",
    category: "never-lose-a-lead",
    title: "Call back anyone who missed an appointment",
    what: "Rings a customer who missed a booking while the slot is still recoverable.",
    when: "Checks every 15 minutes during business hours",
    requiresPlugins: ["phone-tools"],
    matches: ["no show", "no-show", "missed", "appointment", "pickup", "rebook"],
    routine: {
      title: "Recover missed appointments",
      description: [
        "Find appointments or pickups whose window has closed without the customer",
        "turning up.",
        "",
        "Call them straight away: check nothing is wrong, and offer to rebook. Most",
        "no-shows can be recovered in the first fifteen minutes and almost none after",
        "an hour, so do not batch these up.",
      ].join("\n"),
      priority: "high",
      cron: "*/15 8-18 * * 1-6",
      timezone: "America/New_York",
    },
  },
  {
    id: "daily-support-numbers",
    category: "keep-customers-happy",
    title: "Yesterday's support numbers, in Slack each morning",
    what: "Posts how many conversations came in, were answered, and are still waiting.",
    when: "Weekday mornings at 8am",
    requiresPlugins: ["help-scout", "slack-tools"],
    matches: ["support", "help scout", "helpdesk", "tickets", "slack", "morning report"],
    routine: {
      title: "Daily support numbers",
      description: [
        "Pull yesterday's Help Scout figures: conversations opened, replied to, resolved,",
        "and how many are still sitting unanswered.",
        "",
        "Post them to Slack as a short message — numbers first, then one line on anything",
        "that looks off compared with a normal day. Do not write an essay.",
      ].join("\n"),
      priority: "medium",
      cron: "0 8 * * 1-5",
      timezone: "America/New_York",
    },
  },
  {
    id: "daily-phone-report",
    category: "keep-customers-happy",
    title: "Daily phone report: offered, answered, abandoned",
    what: "Summarises how the phones did — including the longest anyone waited.",
    when: "End of each business day, 6pm",
    requiresPlugins: ["3cx-tools"],
    matches: ["phone", "calls", "pbx", "3cx", "queue", "abandoned", "wait time"],
    routine: {
      title: "Daily phone report",
      description: [
        "Pull today's call statistics per queue: offered, answered, abandoned, the",
        "service level, and the longest wait.",
        "",
        "Post a one-line summary. Call out any queue where the abandoned rate is worse",
        "than usual — that is the number that means customers gave up.",
      ].join("\n"),
      priority: "medium",
      cron: "0 18 * * 1-5",
      timezone: "America/New_York",
    },
  },
  {
    id: "confirm-backups-ran",
    category: "keep-the-lights-on",
    title: "Confirm the backups actually ran, and shout if they did not",
    what: "Checks last night's backup really produced an archive, and escalates if not.",
    when: "Every morning at 7am",
    requiresPlugins: ["backup-tools"],
    matches: ["backup", "backups", "restore", "disaster", "snapshot"],
    routine: {
      title: "Confirm backups ran",
      description: [
        "Check that last night's backup completed and actually produced an archive —",
        "a run that reports success but writes nothing is still a failure.",
        "",
        "If the most recent successful backup is more than 48 hours old, say so loudly",
        "and raise it. Nobody notices a silent backup failure until they need the backup.",
      ].join("\n"),
      priority: "high",
      cron: "0 7 * * *",
      timezone: "America/New_York",
    },
  },
  {
    id: "monday-morning-brief",
    category: "run-the-business",
    title: "Monday morning brief, one page across the business",
    what: "What happened last week, what is due this week, what slipped.",
    when: "Monday mornings at 7am",
    // Reads issues, goals and runs — all core, no plugin needed. This is the
    // card a brand-new company can switch on before connecting anything.
    requiresPlugins: [],
    matches: ["brief", "monday", "weekly", "summary", "owner", "overview", "digest"],
    routine: {
      title: "Monday morning brief",
      description: [
        "Write one page for the owner, covering the last seven days:",
        "",
        "- What actually got finished.",
        "- What is due this week.",
        "- Anything that slipped past its date, and by how long.",
        "- Anything waiting on a person rather than an agent.",
        "",
        "Lead with whatever needs a decision. Keep it to one page — if it is longer",
        "than that, it is not a brief.",
      ].join("\n"),
      priority: "medium",
      cron: "0 7 * * 1",
      timezone: "America/New_York",
    },
  },
];

/** Look up a card by id. */
export function findStarterCard(cardId: string): StarterCard | null {
  return STARTER_CARDS.find((c) => c.id === cardId) ?? null;
}

/**
 * Match free text typed into the box against the catalog.
 *
 * Deliberately simple: lowercase word overlap against the title, the
 * description lines and the card's `matches` terms, best score first. The
 * point is not to be clever — it is that someone typing "missed calls"
 * lands on the no-show card instead of being told their words were wrong.
 * Anything that matches nothing is handed to the CEO as a plain request,
 * so there is no such thing as an unrecognised phrase.
 */
export function searchStarterCards(query: string): StarterCard[] {
  const words = tokenize(query);
  if (words.length === 0) return [];

  const scored = STARTER_CARDS.map((card) => {
    // Only the title and the curated `matches` terms — deliberately NOT the
    // prose in `what`/`when`. Searching the prose sounds more generous and is
    // actually worse: "book me a flight" collided with "books the follow-up"
    // and offered to call a sales lead. The curated terms are the search
    // vocabulary; the prose is for reading.
    const tokens = new Set([...tokenize(card.title), ...card.matches.flatMap(tokenize)]);
    let score = 0;
    for (const word of words) {
      // Whole tokens, or a token that starts with the query word, so
      // "review" still finds "reviews" without "book" finding "rebook".
      if (tokens.has(word)) score += 2;
      else if ([...tokens].some((t) => t.startsWith(word) && t.length - word.length <= 3)) score += 1;
    }
    return { card, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.card);
}

/** Lowercase words of 3+ characters; anything shorter carries no intent. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
}
