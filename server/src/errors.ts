import type { ZodError } from "zod";

export class HttpError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function badRequest(message: string, details?: unknown) {
  return new HttpError(400, message, details);
}

export function unauthorized(message = "Unauthorized") {
  return new HttpError(401, message);
}

export function forbidden(message = "Forbidden", details?: unknown) {
  return new HttpError(403, message, details);
}

export function notFound(message = "Not found") {
  return new HttpError(404, message);
}

export function conflict(message: string, details?: unknown) {
  return new HttpError(409, message, details);
}

export function unprocessable(message: string, details?: unknown) {
  return new HttpError(422, message, details);
}

/**
 * The instance cannot do this right now for want of something the operator
 * has to set up (an AI model, most often). Kept distinct from 422 so a
 * client can tell "set something up" apart from "your input could not be
 * used".
 */
export function serviceUnavailable(message: string, details?: unknown) {
  return new HttpError(503, message, details);
}

export function tooManyRequests(message = "Too many requests", details?: unknown) {
  return new HttpError(429, message, details);
}

/** How many of a failed validation's problems its message names. */
const VALIDATION_PROBLEMS_SHOWN = 3;

/**
 * A request body that did not match its schema, said in words. A ZodError's
 * own message is its list of problems as JSON, and the routes that sent that
 * as `error` showed people a block of JSON. This names each field and what is
 * wrong with it, the first few of them.
 */
export function validationErrorMessage(error: ZodError): string {
  const problems = error.issues.map((issue) => {
    const field = issue.path.join(".");
    const problem = issue.message.trim().replace(/[.\s]+$/, "");
    return field ? `${field}: ${problem}` : problem;
  });
  if (problems.length === 0) return "Some details are not valid.";
  const more = problems.length > VALIDATION_PROBLEMS_SHOWN
    ? `, and ${problems.length - VALIDATION_PROBLEMS_SHOWN} more`
    : "";
  return `Some details are not valid. ${problems.slice(0, VALIDATION_PROBLEMS_SHOWN).join("; ")}${more}.`;
}
