/**
 * What a person is told when something they asked for fails.
 *
 * The server says what went wrong in its own words, in `error` (or `message`,
 * from the plugin bridge and the sign-in routes), and those are kept as they
 * are. Some failures reached people as something else, though: a bare code
 * such as skill_local_import_admin_required, a block of JSON, "Internal server
 * error", the browser's "Failed to fetch", or "Request failed: 502". This is
 * the one place that turns each of those into a sentence.
 *
 * The API client words every failed request with failedResponseMessage, so a
 * page that shows error.message already gets a sentence. describeError is for
 * the places that show a caught error of any kind.
 */

type Fields = Record<string, unknown>;

/** Said when a request got no answer at all: Paperclip is stopped or restarting, or the network dropped. */
export const NETWORK_FAILURE_MESSAGE = "Could not reach Paperclip. Check your connection and try again.";

/** Said when nothing more specific can be worded. */
export const GENERIC_FAILURE_MESSAGE = "Something went wrong. Try again.";

/** Said when an answer came back that could not be read, such as a web page where data was expected. */
const UNREADABLE_ANSWER_MESSAGE = "Paperclip sent back an answer that could not be read. Try again.";

const SERVER_FAILURE_MESSAGE = "Something went wrong on the server. Try again in a moment.";

const REFUSED_MESSAGE = "That could not be done. Check what you entered and try again.";

/** For a failure that said nothing but its HTTP status. */
const STATUS_MESSAGES: Record<number, string> = {
  400: "That request could not be used. Check what you entered and try again.",
  401: "Paperclip did not accept your sign-in. Sign in and try again.",
  403: "You do not have permission to do that.",
  404: "That could not be found. It may have been moved or deleted.",
  408: "That took too long. Try again.",
  409: "That clashes with a change made since the page loaded. Reload and try again.",
  413: "That is too large to send.",
  422: "That could not be used. Check what you entered and try again.",
  429: "Too many requests. Wait a moment and try again.",
  502: "A service Paperclip depends on did not answer. Try again in a moment.",
  503: "Paperclip is not available right now. Try again in a moment.",
  504: "That took too long to answer. Try again in a moment.",
};

/**
 * The stock words for a status, which say nothing about what went wrong, and
 * the status each one stands for. "Internal server error" is what the server
 * answers for any failure it did not expect.
 */
const PLACEHOLDER_STATUS = new Map<string, number | null>([
  ["internal server error", 500],
  ["internal error", 500],
  ["server error", 500],
  ["bad request", 400],
  ["validation error", 400],
  ["unauthorized", 401],
  ["forbidden", 403],
  ["not found", 404],
  ["conflict", 409],
  ["unprocessable entity", 422],
  ["too many requests", 429],
  ["bad gateway", 502],
  ["service unavailable", 503],
  ["gateway timeout", 504],
  ["error", null],
  ["unknown error", null],
  ["[object object]", null],
  ["undefined", null],
  ["null", null],
]);

/**
 * Codes the server sends beside a refusal, worded for a reply that carries
 * the code but no words of its own. The server's words win whenever it sends
 * them, and they say more (the stage refusal also says why the names are
 * kept back).
 */
const CODE_MESSAGES = new Map<string, (details: Fields | null) => string>([
  ["skill_local_import_admin_required", () =>
    "Only an instance admin can import skills from folders on this computer."],
  ["skill_source_path_not_supported", () =>
    "Skills cannot be imported from a network share or a device path."],
  ["skill_file_boundary_denied", () => "Skill file paths must stay inside the skill folder."],
  ["stage_env_name_protected", (details) => {
    const names = stringList(details?.names);
    return names.length > 0
      ? `These names cannot be set for a stage: ${names.join(", ")}.`
      : "One or more of these names cannot be set for a stage.";
  }],
  ["database_unreachable", () => "Paperclip cannot reach its database. Try again in a moment."],
]);

/** How many problems of a failed validation are named. */
const PROBLEMS_SHOWN = 3;

function fields(value: unknown): Fields | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function withStop(sentence: string) {
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

function withoutStop(sentence: string) {
  return sentence.trim().replace(/[.\s]+$/, "");
}

/** A machine code standing in for words: skill_local_import_admin_required, INVALID_EMAIL_OR_PASSWORD, TIMEOUT. */
function isBareCode(value: string) {
  return /^[A-Za-z][A-Za-z0-9]*(?:[_.:-][A-Za-z0-9]+)+$/.test(value) || /^[A-Z][A-Z0-9]{3,}$/.test(value);
}

function placeholderKey(value: string) {
  return withoutStop(value).toLowerCase();
}

/** The JSON a message is made of, when it is nothing but JSON. */
function parseJson(value: string): unknown {
  if (!/^[[{]/.test(value)) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a message is words a person can read, rather than a code, JSON, a web page or stock words. */
function readsAsWords(value: string) {
  return value.length > 0
    && !isBareCode(value)
    && !PLACEHOLDER_STATUS.has(placeholderKey(value))
    && parseJson(value) === undefined
    && !/^<(?:!doctype|html|\?xml)/i.test(value);
}

/** A list of problems, as a failed validation sends it, as one sentence. Field names are kept. */
function problemsMessage(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const problems = value.flatMap((item): string[] => {
    if (typeof item === "string") return item.trim() ? [withoutStop(item)] : [];
    const issue = fields(item);
    const message = text(issue?.message);
    if (!message) return [];
    const field = Array.isArray(issue?.path)
      ? issue.path.filter((part) => typeof part === "string" || typeof part === "number").join(".")
      : "";
    return [field ? `${field}: ${withoutStop(message)}` : withoutStop(message)];
  });
  if (problems.length === 0) return null;
  const more = problems.length > PROBLEMS_SHOWN ? `, and ${problems.length - PROBLEMS_SHOWN} more` : "";
  return `Some details are not valid. ${problems.slice(0, PROBLEMS_SHOWN).join("; ")}${more}.`;
}

/** Adds the server's advice on what to do instead, when it gave some the sentence does not already hold. */
function withRemediation(sentence: string, reply: Fields, details: Fields | null) {
  const remediation = text(reply.remediation) ?? text(details?.remediation);
  if (!remediation || !readsAsWords(remediation) || sentence.includes(remediation)) return sentence;
  return `${withStop(sentence)} ${remediation}`;
}

/**
 * Words for what a failed request sent back, or null when it held none: the
 * server's own words, else words dug out of JSON, else the words for a code it
 * named, else the problems a validation found.
 */
function describeReply(reply: unknown): string | null {
  if (typeof reply === "string") return describeReply({ error: reply });
  const body = fields(reply);
  if (!body) return null;
  const details = fields(body.details);
  const nested = fields(body.error);
  const said = [body.error, nested?.message, body.message]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim());

  const words = said.find(readsAsWords);
  if (words) return withRemediation(words, body, details);

  for (const value of said) {
    const json = parseJson(value);
    if (json === undefined) continue;
    const inner = Array.isArray(json) ? problemsMessage(json) : describeReply(json);
    if (inner) return inner;
  }

  for (const code of [body.code, details?.code, nested?.code, ...said]) {
    const word = typeof code === "string" ? CODE_MESSAGES.get(code) : undefined;
    if (word) return withRemediation(word(details), body, details);
  }

  return problemsMessage(body.details) ?? problemsMessage(body.issues) ?? problemsMessage(body.errors);
}

/** The sentence for a failure that said nothing but its HTTP status, or null for a status that is not a failure. */
export function statusFailureMessage(status: number): string | null {
  if (STATUS_MESSAGES[status]) return STATUS_MESSAGES[status];
  if (status >= 500) return SERVER_FAILURE_MESSAGE;
  if (status >= 400) return REFUSED_MESSAGE;
  return null;
}

/**
 * The browser's error for a request that got no answer at all. Each browser
 * words it differently, and none of them says anything a person can use.
 */
export function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError
    && /^(?:failed to fetch|fetch failed|load failed|network request failed|networkerror when attempting to fetch resource\.?)$/i
      .test(error.message.trim());
}

/** The sentence for a request the server answered with a failure, from its status and what it sent back. */
export function failedResponseMessage(status: number, body: unknown): string {
  return describeReply(body) ?? statusFailureMessage(status) ?? GENERIC_FAILURE_MESSAGE;
}

/**
 * The sentence to show for a caught error of any kind: an ApiError, a plain
 * Error, a string, or whatever a library threw. `fallback` is said when the
 * error holds nothing that can be worded.
 */
export function describeError(error: unknown, fallback: string = GENERIC_FAILURE_MESSAGE): string {
  if (isNetworkFailure(error)) return NETWORK_FAILURE_MESSAGE;
  if (error instanceof SyntaxError) return UNREADABLE_ANSWER_MESSAGE;
  const thrown = fields(error);
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : thrown?.message;
  const status = typeof thrown?.status === "number" && thrown.status > 0 ? thrown.status : null;
  const placeholder = typeof message === "string" ? PLACEHOLDER_STATUS.get(placeholderKey(message)) : undefined;
  return describeReply({ error: message, code: thrown?.code })
    ?? describeReply(thrown?.body)
    ?? statusFailureMessage(status ?? placeholder ?? 0)
    ?? fallback;
}
