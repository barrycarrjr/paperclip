import { redactSensitive } from "./redact-sensitive.js";

/**
 * Extra fields for a failed request's log line (status 400 and up): the error
 * context the error handler attached, or else the request's body, params and
 * query. Every payload goes through redactSensitive, because a failed save can
 * carry a credential anywhere in its body, such as a stage's env values, and
 * the line is written to the server log file.
 */
export function failedRequestLogProps(req: unknown, res: unknown): Record<string, unknown> {
  const ctx = (res as { __errorContext?: Record<string, unknown> }).__errorContext;
  if (ctx) {
    return {
      errorContext: redactSensitive(ctx.error),
      reqBody: redactSensitive(ctx.reqBody),
      reqParams: redactSensitive(ctx.reqParams),
      reqQuery: redactSensitive(ctx.reqQuery),
    };
  }
  const props: Record<string, unknown> = {};
  const { body, params, query, route } = req as {
    body?: unknown;
    params?: unknown;
    query?: unknown;
    route?: { path?: unknown };
  };
  if (body && typeof body === "object" && Object.keys(body).length > 0) {
    props.reqBody = redactSensitive(body);
  }
  if (params && typeof params === "object" && Object.keys(params).length > 0) {
    props.reqParams = redactSensitive(params);
  }
  if (query && typeof query === "object" && Object.keys(query).length > 0) {
    props.reqQuery = redactSensitive(query);
  }
  if (route?.path) {
    props.routePath = route.path;
  }
  return props;
}
