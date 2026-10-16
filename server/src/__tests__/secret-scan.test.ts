import { describe, expect, it, vi } from "vitest";

const { scanLine, scanPath, addedLinesFromDiff, scanAddedLines, scanPaths, report, looksFake, looksRandom, ALLOW_MARKER } =
  await import("../../../scripts/check-secrets.mjs");

/**
 * A deterministic stand-in for a random token. Many distinct characters, digits
 * mixed in, no repeated runs and no English, so the scanner's "obvious sample"
 * veto does not fire on it. Built at runtime so this file never contains a
 * complete token-shaped string, which matters because the pre-commit hook
 * scans this file too.
 */
const ALPHABET = "Qm7kW3vP9nL2tR8cJ6hB1sD5fG0aE4uN";
const rnd = (n: number) => Array.from({ length: n }, (_, i) => ALPHABET[(i * 7) % ALPHABET.length]).join("");

const PEM_HEADER = ["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" ");

describe("secret scan: token formats", () => {
  it("flags well-known credential formats", () => {
    expect(scanLine(`token = "${"ghp_" + rnd(36)}"`)).toContain("github-token");
    expect(scanLine(`${"github_pat_" + rnd(30)}`)).toContain("github-token");
    expect(scanLine(`ANTHROPIC_API_KEY=${"sk-ant-api03-" + rnd(40)}`)).toContain("anthropic-key");
    expect(scanLine(`OPENAI_API_KEY=${"sk-proj-" + rnd(40)}`)).toContain("openai-key");
    expect(scanLine(`aws_access_key_id = ${"AKIA" + "Q7M3KW9VP2NL8TR4"}`)).toContain("aws-access-key-id");
    expect(scanLine(`SLACK_TOKEN=${"xoxb-" + rnd(12) + "-" + rnd(24)}`)).toContain("slack-token");
    expect(scanLine(`${"AIza" + rnd(35)}`)).toContain("google-api-key");
    expect(scanLine(`${"sk_live_" + rnd(24)}`)).toContain("stripe-key");
  });

  it("flags a private key block followed by its body", () => {
    expect(scanLine(`${PEM_HEADER}\\n${rnd(40)}`)).toContain("private-key-block");
    expect(scanLine(PEM_HEADER)).toContain("private-key-block");
  });

  it("does not flag a private key header used as a bare string in a test or message", () => {
    expect(scanLine(`  "${PEM_HEADER}\\n" +`)).toEqual([]);
    expect(scanLine(`  message: "starting with a line like '${PEM_HEADER}'.",`)).toEqual([]);
    expect(scanLine(`  key: "${PEM_HEADER}\\npretend\\n-----END RSA PRIVATE KEY-----",`)).toEqual([]);
  });

  it("flags a real-looking JWT but not the jwt.io sample", () => {
    const real = `eyJ${rnd(20)}.eyJ${rnd(30)}.${rnd(32)}`;
    expect(scanLine(`const t = "${real}";`)).toContain("jwt");
    const sample = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0." + rnd(32);
    expect(scanLine(`const t = "${sample}";`)).toEqual([]);
  });

  it("ignores obvious test fixtures", () => {
    expect(scanLine(`const t = "sk-ant-oat01-${"A".repeat(30)}";`)).toEqual([]);
    expect(scanLine(`const t = "sk-ant-oat01-FAKE-must-not-surface";`)).toEqual([]);
    expect(scanLine(`const t = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";`)).toEqual([]);
    expect(scanLine(`const t = "sk-ant-oat01-${"AAAABBBBCCCCDDDDEEEE"}";`)).toEqual([]);
  });
});

describe("secret scan: generic rules", () => {
  it("flags a URL carrying a real password", () => {
    expect(scanLine(`DATABASE_URL=postgres://app:${rnd(16)}@db.internal:5432/app`)).toContain("url-with-password");
  });

  it("does not flag placeholder or same-as-user URL passwords", () => {
    expect(scanLine("DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip")).toEqual([]);
    expect(scanLine("postgres://user:password@localhost/db")).toEqual([]);
    expect(scanLine("postgres://env-user:env-pass@db.example.com/db")).toEqual([]);
    expect(scanLine("postgres://user:${DB_PASSWORD}@localhost/db")).toEqual([]);
    expect(scanLine("postgres://user:<your-password>@localhost/db")).toEqual([]);
  });

  it("flags a literal random value assigned to a credential-shaped name", () => {
    expect(scanLine(`  apiKey: "${rnd(24)}",`)).toContain("credential-assignment");
    expect(scanLine(`password = '${rnd(16)}'`)).toContain("credential-assignment");
    expect(scanLine(`CLIENT_SECRET=${rnd(32)}`)).toContain("env-credential");
    expect(scanLine(`export GITHUB_TOKEN="${rnd(40)}"`)).toContain("env-credential");
  });

  it("does not flag expressions, references, prose or placeholders", () => {
    expect(scanLine("this.apiKey = opts.apiKey?.trim() || undefined;")).toEqual([]);
    expect(scanLine("  - `secret: CURSOR_WEBHOOK_SECRET`")).toEqual([]);
    expect(scanLine('const PASSWORD = "correct horse battery";')).toEqual([]);
    expect(scanLine('  apiKey: "resolved-provider-key",')).toEqual([]);
    expect(scanLine('  bearer: "Expect a shared bearer token in the Authorization header.",')).toEqual([]);
    expect(scanLine("API_KEY=your-api-key-here")).toEqual([]);
    expect(scanLine("API_KEY=${API_KEY}")).toEqual([]);
    expect(scanLine('  apiKey: process.env.API_KEY,')).toEqual([]);
    expect(scanLine('"valueFrom": "arn:aws:secretsmanager:<REGION>:<ACCOUNT_ID>:secret:paperclip/github-token"')).toEqual([]);
  });

  it("skips a line that carries the allow marker", () => {
    expect(scanLine(`token = "${"ghp_" + rnd(36)}" // ${ALLOW_MARKER}`)).toEqual([]);
  });
});

describe("secret scan: files", () => {
  it("blocks env and key files but not their example variants", () => {
    expect(scanPath(".env")).toEqual(["dotenv-file"]);
    expect(scanPath("server/.env.local")).toEqual(["dotenv-file"]);
    expect(scanPath(".env.example")).toEqual([]);
    expect(scanPath("deploy/server.pem")).toEqual(["private-key-file"]);
    expect(scanPath("keys/id_ed25519")).toEqual(["ssh-key-file"]);
    expect(scanPath("gcp/service-account-prod.json")).toEqual(["credentials-file"]);
    expect(scanPath("packages/db/src/schema/issue.ts")).toEqual([]);
    expect(scanPath(".npmrc")).toEqual([]);
  });
});

describe("secret scan: diffs and reporting", () => {
  it("reads only added lines and attributes them to the right file", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,0 +1,2 @@",
      "+const keep = 1;",
      "-const removed = 2;",
      "+const added = 3;",
      "diff --git a/b.md b/b.md",
      "--- /dev/null",
      "+++ b/b.md",
      "@@ -0,0 +1 @@",
      "+# title",
    ].join("\n");
    expect(addedLinesFromDiff(diff)).toEqual([
      { file: "a.ts", line: "const keep = 1;" },
      { file: "a.ts", line: "const added = 3;" },
      { file: "b.md", line: "# title" },
    ]);
  });

  it("skips lockfiles when scanning added lines", () => {
    const token = "ghp_" + rnd(36);
    expect(scanAddedLines([{ file: "pnpm-lock.yaml", line: token }])).toEqual([]);
    expect(scanAddedLines([{ file: "src/x.ts", line: token }])).toHaveLength(1);
  });

  it("reports findings with the rule and file, and returns 1", () => {
    const error = vi.fn();
    const log = vi.fn();
    const findings = [...scanPaths([".env"]), ...scanAddedLines([{ file: "src/x.ts", line: `key: "${"ghp_" + rnd(36)}"` }])];
    expect(report(findings, { error, log, what: "staged changes" })).toBe(1);
    expect(error).toHaveBeenCalledWith("ERROR: Possible secrets found in staged changes:\n");
    expect(error.mock.calls.some(([line]) => String(line).includes("[dotenv-file] .env"))).toBe(true);
    expect(error.mock.calls.some(([line]) => String(line).includes("[github-token] src/x.ts"))).toBe(true);
  });

  it("returns 0 and logs OK when nothing is found", () => {
    const error = vi.fn();
    const log = vi.fn();
    expect(report([], { error, log, what: "staged changes" })).toBe(0);
    expect(log).toHaveBeenCalledWith("  OK  No secrets found in staged changes.");
    expect(error).not.toHaveBeenCalled();
  });
});

describe("secret scan: heuristics", () => {
  it("looksFake catches padding, sequences and English", () => {
    expect(looksFake("A".repeat(30))).toBe(true);
    expect(looksFake("AAAABBBBCCCCDDDD")).toBe(true);
    expect(looksFake("abcdefghijklmnop")).toBe(true);
    expect(looksFake("sk-ant-oat01-should-never-appear")).toBe(true);
    expect(looksFake(rnd(32))).toBe(false);
  });

  it("looksRandom wants digits, no spaces, and mixed classes", () => {
    expect(looksRandom("correct horse battery")).toBe(false);
    expect(looksRandom("resolved-provider-key")).toBe(false);
    expect(looksRandom(rnd(24))).toBe(true);
  });
});
