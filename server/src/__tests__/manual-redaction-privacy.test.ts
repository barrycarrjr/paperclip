import { connect, type AddressInfo } from "node:net";
import express, { type Request, type Response } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { errorHandler, markBodyReaderErrors } from "../middleware/error-handler.js";
import { failedRequestLogProps } from "../middleware/http-log-props.js";

describe("manual redaction request privacy", () => {
  for (const endpoint of ["redact", "redact-delegated", "redaction-authorizations", "redaction-preview"]) {
    const url = `/api/issues/example/comments/example/${endpoint}`;
    it(`omits the entire failed ${endpoint} request, even before routing`, async () => {
      const app = express();
      let logged: unknown;
      app.use((req, res, next) => {
        res.on("finish", () => { logged = failedRequestLogProps(req, res); });
        next();
      });
      app.use(express.json());
      app.post(url, () => { throw new Error("driver bound value example-private-value"); });
      app.use(errorHandler);
      const response = await request(app).post(url).send({ targets: ["example-private-value"], expectedBody: "example-private-value" });
      expect(response.status).toBe(500);
      expect(JSON.stringify(logged)).toBe('{"manualRedaction":true}');
      expect(JSON.stringify(response.body)).not.toContain("example-private-value");
      const malformed = await request(app).post(url).set("Content-Type", "application/json").send('{"targets":["example-private-value"');
      expect(malformed.status).toBe(400);
      expect(logged).toEqual({ manualRedaction: true });
      expect(JSON.stringify(malformed.body)).not.toContain("example-private-value");
      expect(failedRequestLogProps({ originalUrl: url, body: { raw: "example-private-value" } }, {})).toEqual({ manualRedaction: true });
      expect(failedRequestLogProps({ originalUrl: `${url.toUpperCase()}/`, body: { raw: "example-private-value" } }, {})).toEqual({ manualRedaction: true });
    });
  }
});

it("keeps actual Express fast and fallback routes private over raw HTTP", async () => {
  const app = express();
  const observations: Array<{
    routed?: string; body?: unknown; props: unknown; hasError: boolean; hasContext: boolean;
  }> = [];
  app.use((req, res, next) => {
    res.on("finish", () => observations.push({
      routed: res.locals.redactionAction,
      body: req.body,
      props: failedRequestLogProps(req, res),
      hasError: Object.prototype.hasOwnProperty.call(res, "err"),
      hasContext: Object.prototype.hasOwnProperty.call(res, "__errorContext"),
    }));
    next();
  });
  app.use(markBodyReaderErrors(express.json()));
  const api = express.Router();
  const issues = express.Router();
  issues.param("id", (_req, _res, next) => next());
  const failures = [
    ["redact", new Error("driver bound value example-private-selection"), 500],
    ["redact-delegated", new HttpError(403, "Request refused"), 403],
    ["redaction-authorizations", new HttpError(404, "Request refused"), 404],
    ["redaction-preview", new HttpError(500, "driver bound value example-private-comment"), 500],
  ] as const;
  for (const [action, error] of failures) {
    issues.post(`/issues/:id/comments/:commentId/${action}`, (_req, res, next) => {
      res.locals.redactionAction = action;
      next(error);
    });
  }
  api.use(issues);
  app.use("/api", api);
  app.use((_req, res) => { res.status(404).json({ error: "Not found" }); });
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const port = (server.address() as AddressInfo).port;
    expect([3100, 54329]).not.toContain(port);
    // Write the target bytes directly. URL-based clients normalize away the
    // raw backslashes which Express's parseurl fast path leaves inside ids.
    async function send(target: string, body: string) {
      return new Promise<{ status: number; text: string }>((resolve, reject) => {
        const socket = connect(port, "127.0.0.1");
        let response = "";
        socket.setEncoding("utf8");
        socket.setTimeout(5000, () => socket.destroy(new Error("Raw privacy request timed out")));
        socket.on("error", reject);
        socket.on("data", (chunk) => { response += chunk; });
        socket.on("end", () => resolve({
          status: Number(/^HTTP\/1\.1 (\d{3})/.exec(response)?.[1]),
          text: response.split("\r\n\r\n").slice(1).join("\r\n\r\n"),
        }));
        socket.write(`POST ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`
          + `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`
          + `Connection: close\r\n\r\n${body}`);
      });
    }
    const body = { targets: ["example-private-selection"], expectedBody: "example-private-comment" };
    for (const [action, , status] of failures) {
      for (const [name, target] of requestTargets) {
        for (const malformed of [false, true]) {
          const before = observations.length;
          const response = await send(target(`/api/issues/example/comments/example/${action}`),
            malformed ? JSON.stringify(body).slice(0, -1) : JSON.stringify(body));
          expect(response.status, `${action} ${name}`).toBe(malformed ? 400 : status);
          expect(JSON.parse(response.text)).toEqual({ error: malformed
            ? "The request body is not valid JSON."
            : status < 500 ? "Request refused" : "The manual redaction request could not be completed." });
          expect(observations).toHaveLength(before + 1);
          const observation = observations[before]!;
          // Handler reach is established independently of the privacy matcher.
          expect(observation.routed, `${action} ${name}`).toBe(malformed ? undefined : action);
          expect(observation.body).toEqual(malformed ? undefined : body);
          expect(observation.props, `${action} ${name}`).toEqual({ manualRedaction: true });
          expect(observation.hasError).toBe(false);
          expect(observation.hasContext).toBe(false);
        }
      }
    }
    for (const target of [
      "/api/other", "/api/issues/example/comments/example/redaction-preview-extra#x",
      "/api/issues/example/comments/example/redaction-preview%23x",
    ]) {
      const response = await send(target, JSON.stringify(body));
      expect(response.status).toBe(404);
      expect(observations.at(-1)).toMatchObject({ props: { reqBody: body } });
      expect(observations.at(-1)?.routed).toBeUndefined();
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

// Set the raw request fields directly: HTTP client URL serialization can drop
// fragments before they reach Express, hiding the privacy classifier regression.
const requestTargets = [
  ["plain", (url: string) => url],
  ["fragment", (url: string) => `${url}#x`],
  ["empty fragment", (url: string) => `${url}#`],
  ["trailing slash and fragment", (url: string) => `${url}/#x`],
  ["backslash and fragment", (url: string) => `${url.replace(/\/([^/]+)$/, "\\$1")}#x`],
  ["query before fragment", (url: string) => `${url}?a=1#x`],
  ["fragment before query", (url: string) => `${url}#x?a=1`],
  ["uppercase and trailing slash", (url: string) => `${url.toUpperCase()}/`],
  ["uppercase, trailing slash and fragment", (url: string) => `${url.toUpperCase()}/#x`],
  ["absolute form", (url: string) => `http://127.0.0.1:12345${url}`],
  ["absolute form and fragment", (url: string) => `http://127.0.0.1:12345${url}#x`],
  ...["issues", "comments"].flatMap((segment) => [
    [`backslash in ${segment} id`, (url: string) => url.replace(`/${segment}/example/`, `/${segment}/example\\x/`)],
    [`backslash in ${segment} id and query`, (url: string) => `${url.replace(`/${segment}/example/`, `/${segment}/example\\x/`)}?a=1`],
    [`backslash in ${segment} id and trailing slash`, (url: string) => `${url.replace(`/${segment}/example/`, `/${segment}/example\\x/`)}/`],
  ] as const),
] as const;

describe("raw manual redaction request targets", () => {
  for (const endpoint of ["redact", "redact-delegated", "redaction-authorizations", "redaction-preview"]) {
    const url = `/api/issues/example/comments/example/${endpoint}`;
    for (const field of ["originalUrl", "url"] as const) {
      it.each(requestTargets)(`protects ${endpoint} %s through ${field}`, (_name, target) => {
        const req = {
          [field]: target(url),
          method: "POST",
          body: { targets: ["example-private-selection"], expectedBody: "example-private-comment" },
          params: { id: "example" },
          query: { a: "example-private-query" },
        } as Request;
        expect(failedRequestLogProps(req, {})).toEqual({ manualRedaction: true });

        for (const error of [
          new Error("driver bound value example-private-selection"),
          Object.assign(new SyntaxError("example-private-comment"), {
            type: "entity.parse.failed", status: 400, body: "example-private-comment",
          }),
        ]) {
          const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
          errorHandler(error, req, res as unknown as Response, vi.fn());
          expect(res.status).toHaveBeenCalledWith(error instanceof SyntaxError ? 400 : 500);
          expect(res.json).toHaveBeenCalledWith({ error: error instanceof SyntaxError
            ? "The request body is not valid JSON."
            : "The manual redaction request could not be completed." });
          expect(res).not.toHaveProperty("err");
          expect(res).not.toHaveProperty("__errorContext");
          expect(failedRequestLogProps(req, res)).toEqual({ manualRedaction: true });
        }
        for (const status of [403, 404, 500]) {
          const error = new HttpError(status, "Request refused", { body: req.body });
          const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
          errorHandler(error, req, res as unknown as Response, vi.fn());
          expect(res.status).toHaveBeenCalledWith(status);
          expect(res.json).toHaveBeenCalledWith({ error: status < 500
            ? "Request refused" : "The manual redaction request could not be completed." });
          expect(res).not.toHaveProperty("err");
          expect(res).not.toHaveProperty("__errorContext");
          expect(failedRequestLogProps(req, res)).toEqual({ manualRedaction: true });
        }
      });
    }
  }

  it.each([
    "/api/issues/example/comments/example",
    "/api/issues/example/comments/example/redaction-preview-extra#x",
    "/api/issues/example/comments/example/redaction-preview%23x",
    "/api/issues/example/comments/example/other#redaction-preview",
    "/api/other?a=/issues/example/comments/example/redaction-preview",
  ])("keeps ordinary failed-request diagnostics for %s", (originalUrl) => {
    const body = { targets: ["example-ordinary-value"] };
    const req = { originalUrl, method: "POST", body } as Request;
    expect(failedRequestLogProps(req, {})).toEqual({ reqBody: body });
    const error = new Error("ordinary driver failure");
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    errorHandler(error, req, res as unknown as Response, vi.fn());
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    expect(res).toHaveProperty("err", error);
    expect(failedRequestLogProps(req, res)).toMatchObject({
      errorContext: { message: "ordinary driver failure" }, reqBody: body,
    });
  });
});
