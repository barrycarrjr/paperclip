import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { errorHandler } from "../middleware/error-handler.js";

function makeReq(): Request {
  return {
    method: "GET",
    originalUrl: "/api/test",
    body: { a: 1 },
    params: { id: "123" },
    query: { q: "x" },
  } as unknown as Request;
}

function makeRes(): Response {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as Response;
  (res.status as unknown as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

describe("errorHandler", () => {
  it("attaches the original Error to res.err for 500s", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new Error("boom");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    expect(res.err).toBe(err);
    expect(res.__errorContext?.error?.message).toBe("boom");
  });

  it("attaches HttpError instances for 500 responses", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new HttpError(500, "db exploded");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "db exploded" });
    expect(res.err).toBe(err);
    expect(res.__errorContext?.error?.message).toBe("db exploded");
  });
});

describe("errorHandler: a body the body reader refuses", () => {
  // The same body reader the app uses, with a small limit so a large body is
  // easy to send.
  function appWithBodyReader() {
    const app = express();
    app.use(express.json({ limit: "1kb" }));
    app.post("/echo", (req, res) => res.json({ received: req.body }));
    app.use(errorHandler);
    return app;
  }

  it("answers 400 in words for malformed JSON, not 500", async () => {
    const res = await request(appWithBodyReader())
      .post("/echo")
      .set("Content-Type", "application/json")
      .send("{destinationId:local-disk}");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "The request body is not valid JSON." });
  });

  it("answers 413 in words for a body over the limit", async () => {
    const res = await request(appWithBodyReader())
      .post("/echo")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ text: "x".repeat(5_000) }));

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "The request body is too large." });
  });

  it("still answers 500 for an error that only looks like one", () => {
    const res = makeRes() as any;
    errorHandler(Object.assign(new Error("odd"), { type: "something.else", status: 400 }), makeReq(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe("app middleware order", () => {
  it("logs a request before reading its body, so a refused body is still logged", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.resolve(here, "..", "app.ts"), "utf8");
    const loggerAt = source.indexOf("app.use(httpLogger)");
    const bodyReaderAt = source.indexOf("app.use(express.json(");

    expect(loggerAt).toBeGreaterThan(-1);
    expect(bodyReaderAt).toBeGreaterThan(-1);
    expect(loggerAt).toBeLessThan(bodyReaderAt);
  });
});
