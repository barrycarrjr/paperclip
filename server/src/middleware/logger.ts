import fs from "node:fs";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { buildFileLogTarget, resolveServerLogDir } from "./log-file-target.js";
import { shouldSilenceHttpSuccessLog } from "./http-log-policy.js";

const logDir = resolveServerLogDir();
fs.mkdirSync(logDir, { recursive: true });

const sharedOpts = {
  translateTime: "SYS:HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

export const logger = pino({
  level: "debug",
  // Every 4xx and 5xx line carries the full request headers (see customProps
  // below), so without `cookie` here a live session token is written to the log
  // file in plaintext on any failed request. Anything that can read the log
  // directory can then sign in as that user. `set-cookie` covers the response
  // side, which is how a freshly issued session would otherwise leak.
  // `reqBody.value` is the one that is easy to miss: the secrets API carries
  // the plaintext credential as `body.value`, and a 400 on that route writes
  // the whole body to the line. The viewer masks these too, but keeping them
  // out of the file is the real fix, since the file outlives the viewer and
  // gets copied around.
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
    "reqBody.value",
    "reqBody.token",
    "reqBody.secret",
    "reqBody.password",
    "reqBody.apiKey",
    "errorContext.reqBody.value",
  ],
  // The explicit generic keeps TS from unifying every target's options into
  // one exact shape (pretty's options and pino-roll's options share nothing).
}, pino.transport<Record<string, unknown>>({
  targets: [
    {
      target: "pino-pretty",
      options: { ...sharedOpts, ignore: "pid,hostname,req,res,responseTime", colorize: true, destination: 1 },
      level: "info",
    },
    // Size-capped rolling files (server.1.log, ...) — the old single
    // server.log grew unbounded. See buildFileLogTarget for the cap policy.
    buildFileLogTarget(logDir),
  ],
}));

export const httpLogger = pinoHttp({
  logger,
  customLogLevel(_req, res, err) {
    if (shouldSilenceHttpSuccessLog(_req.method, _req.url, res.statusCode)) {
      return "silent";
    }
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage(req, res) {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  customErrorMessage(req, res, err) {
    const ctx = (res as any).__errorContext;
    const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
    return `${req.method} ${req.url} ${res.statusCode} — ${errMsg}`;
  },
  customProps(req, res) {
    if (res.statusCode >= 400) {
      const ctx = (res as any).__errorContext;
      if (ctx) {
        return {
          errorContext: ctx.error,
          reqBody: ctx.reqBody,
          reqParams: ctx.reqParams,
          reqQuery: ctx.reqQuery,
        };
      }
      const props: Record<string, unknown> = {};
      const { body, params, query } = req as any;
      if (body && typeof body === "object" && Object.keys(body).length > 0) {
        props.reqBody = body;
      }
      if (params && typeof params === "object" && Object.keys(params).length > 0) {
        props.reqParams = params;
      }
      if (query && typeof query === "object" && Object.keys(query).length > 0) {
        props.reqQuery = query;
      }
      if ((req as any).route?.path) {
        props.routePath = (req as any).route.path;
      }
      return props;
    }
    return {};
  },
});
