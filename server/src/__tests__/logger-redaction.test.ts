import { describe, expect, it } from "vitest";
import pino from "pino";

/**
 * The server logs the full request headers on any 4xx or 5xx response (see
 * customProps in middleware/logger.ts). Without redaction that writes a live
 * session cookie into the log file in plaintext, and anything that can read
 * the log directory can then sign in as that user. Found by reading the real
 * log while building the Logs page: a 502 line carried a working
 * `paperclip-default.session_token`.
 *
 * These paths are also load-bearing in a second way: pino validates redact
 * paths at construction, so a malformed one throws while the logger module is
 * being imported, which takes the whole server down at boot with a stack that
 * points nowhere useful. Worth a test that constructs a real logger.
 */
const REDACTED_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
];

describe("server log redaction", () => {
  it("accepts every redact path, so the logger cannot throw at import time", () => {
    // Sink rather than a file: there is no /dev/null on Windows, and this test
    // only cares whether pino accepts the paths.
    expect(() => pino({ redact: REDACTED_PATHS }, { write: () => {} })).not.toThrow();
  });

  it("keeps a session cookie out of the written line", () => {
    const written: string[] = [];
    const log = pino(
      { redact: REDACTED_PATHS },
      { write: (chunk: string) => written.push(chunk) },
    );

    log.info(
      {
        req: {
          headers: {
            cookie: "paperclip-default.session_token=REAL_SESSION_VALUE",
            authorization: "Bearer sk-ant-oat01-REAL",
            referer: "http://paperclip.local:3100/IND/email",
          },
        },
      },
      "POST /plugins/x/data/email.list-messages 502",
    );

    const line = written.join("");
    expect(line).not.toContain("REAL_SESSION_VALUE");
    expect(line).not.toContain("sk-ant-oat01-REAL");
    // Still useful: the parts that are not credentials must survive, otherwise
    // the redaction has quietly destroyed the diagnostic value of the line.
    expect(line).toContain("/IND/email");
    expect(line).toContain("email.list-messages");
  });

  it("keeps a freshly issued session out of the response headers", () => {
    const written: string[] = [];
    const log = pino(
      { redact: REDACTED_PATHS },
      { write: (chunk: string) => written.push(chunk) },
    );

    log.info(
      { res: { headers: { "set-cookie": "paperclip-default.session_token=NEW_SESSION" } } },
      "POST /api/auth/sign-in 200",
    );

    expect(written.join("")).not.toContain("NEW_SESSION");
  });
});
