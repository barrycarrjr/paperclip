import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { HttpError } from "../errors.js";

export interface ErrorContext {
  error: { message: string; stack?: string; name?: string; details?: unknown; raw?: unknown };
  method: string;
  url: string;
  reqBody?: unknown;
  reqParams?: unknown;
  reqQuery?: unknown;
}

function attachErrorContext(
  req: Request,
  res: Response,
  payload: ErrorContext["error"],
  rawError?: Error,
) {
  (res as any).__errorContext = {
    error: payload,
    method: req.method,
    url: req.originalUrl,
    reqBody: req.body,
    reqParams: req.params,
    reqQuery: req.query,
  } satisfies ErrorContext;
  if (rawError) {
    (res as any).err = rawError;
  }
}

/**
 * Errors the body reader (express.json) raises for a body it cannot use,
 * keyed by its `type`. Each carries its own 4xx status; answering 500 blamed
 * the server for the caller's request.
 */
const BODY_READER_ERRORS: Record<string, string> = {
  "entity.parse.failed": "The request body is not valid JSON.",
  "entity.too.large": "The request body is too large.",
  "entity.verify.failed": "The request body could not be read.",
  "encoding.unsupported": "The request body uses an encoding this server does not read.",
  "charset.unsupported": "The request body uses a character set this server does not read.",
  "request.aborted": "The request ended before its body arrived.",
  "request.size.invalid": "The request body was not the size it said.",
  "parameters.too.many": "The request has too many parameters.",
};

function bodyReaderError(err: unknown): { status: number; message: string } | null {
  if (!err || typeof err !== "object") return null;
  const { type, status, statusCode } = err as { type?: unknown; status?: unknown; statusCode?: unknown };
  if (typeof type !== "string" || !Object.prototype.hasOwnProperty.call(BODY_READER_ERRORS, type)) return null;
  const code = typeof status === "number" ? status : typeof statusCode === "number" ? statusCode : 400;
  if (code < 400 || code >= 500) return null;
  return { status: code, message: BODY_READER_ERRORS[type]! };
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof HttpError) {
    if (err.status >= 500) {
      attachErrorContext(
        req,
        res,
        { message: err.message, stack: err.stack, name: err.name, details: err.details },
        err,
      );
    }
    const details = err.details && typeof err.details === "object" && !Array.isArray(err.details)
      ? (err.details as Record<string, unknown>)
      : null;
    res.status(err.status).json({
      error: err.message,
      ...(typeof details?.code === "string" ? { code: details.code } : {}),
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({ error: "Validation error", details: err.errors });
    return;
  }

  const bodyError = bodyReaderError(err);
  if (bodyError) {
    res.status(bodyError.status).json({ error: bodyError.message });
    return;
  }

  const rootError = err instanceof Error ? err : new Error(String(err));
  attachErrorContext(
    req,
    res,
    err instanceof Error
      ? { message: err.message, stack: err.stack, name: err.name }
      : { message: String(err), raw: err, stack: rootError.stack, name: rootError.name },
    rootError,
  );

  res.status(500).json({ error: "Internal server error" });
}
