/**
 * check-secrets.mjs
 *
 * Blocks credentials and other sensitive material from entering git.
 *
 * Three modes, all pure Node with no third-party dependency, so every
 * contributor gets the same check on clone without installing anything:
 *
 *   node scripts/check-secrets.mjs --staged
 *       Lines the pending commit would ADD, plus the names of staged files.
 *       Wired into .githooks/pre-commit.
 *
 *   node scripts/check-secrets.mjs --range <base> <head>
 *       Lines added between two commits. Used by the PR workflow.
 *
 *   node scripts/check-secrets.mjs
 *       Every tracked file in the working tree. For a one-off audit.
 *
 * What it looks for (see RULES below): well-known credential formats (cloud
 * provider keys, GitHub/Slack/Stripe/OpenAI/Anthropic tokens, private key
 * blocks, signed JWTs), URLs carrying a password, assignments of a literal
 * value to something credential-shaped, and files that should never be
 * committed at all (.env files, private key files).
 *
 * A line that is a deliberate, harmless example can carry the marker
 * `secret-scan: allow` (in a comment) and is skipped. Use it for docs and
 * tests; never for a real value.
 *
 * Why not gitleaks or trufflehog: both are fine tools, but they are binaries
 * that each contributor would have to install, and a hook that fails because
 * a tool is missing gets bypassed with --no-verify. A small script that ships
 * in the repo and runs under the Node every contributor already has cannot be
 * missing.
 *
 * No shebang on purpose: vitest imports this module and inlines it into a
 * function wrapper where "#!" is a syntax error.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOW_MARKER = "secret-scan: allow";

/**
 * Values that are obviously not a real credential. Matched case-insensitively
 * against the captured value of a generic assignment or URL rule, so a README
 * showing `API_KEY=your-api-key-here` or `postgres://user:password@localhost`
 * does not block anyone.
 */
const PLACEHOLDER_VALUE = new RegExp(
  [
    "\\$\\{", // ${VAR}
    "\\$[A-Z_]", // $VAR
    "process\\.env",
    "<[^>]*>", // <your-key>
    "\\[[^\\]]*\\]", // [redacted]
    "^x+$",
    "^\\*+$",
    "^\\.+$",
    "example",
    "placeholder",
    "redacted",
    "changeme",
    "change-me",
    "change_me",
    "your[-_ ]?",
    "dummy",
    "sample",
    "fake",
    "pass", // password, env-pass, proxy-password
    "secret",
    "^postgres$",
    "^root$",
    "^admin$",
    "^test$",
    "^localhost$",
    "^null$",
    "^undefined$",
    "^true$",
    "^false$",
  ].join("|"),
  "i",
);

function isPlaceholder(value) {
  return PLACEHOLDER_VALUE.test(value);
}

/**
 * Test suites in this repo hold sample tokens on purpose (redaction tests,
 * token-restore tests). They are built from words a real token never contains
 * or from one repeated character, and that is what separates them here. A
 * real token is random: many distinct characters and no English in it.
 */
const FAKE_TOKEN_WORDS =
  /example|fake|sample|dummy|pretend|placeholder|never|should|must|existing|value|secret|test|desktop|lane|session|redact/i;
const SEQUENTIAL = /abcdefghij|1234567890|0123456789|ABCDEFGHIJ|xyz/;
// AAAAAAAA, or AAAABBBBCCCC: padding, not randomness.
const REPEATED = /(.)\1{5,}|([A-Za-z0-9])\2{3}([A-Za-z0-9])\3{3}/;
// The token from the jwt.io front page, used by every redaction test.
const KNOWN_SAMPLES = ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0"];

export function looksFake(value) {
  if (FAKE_TOKEN_WORDS.test(value)) return true;
  if (SEQUENTIAL.test(value)) return true;
  if (REPEATED.test(value)) return true;
  if (KNOWN_SAMPLES.some((sample) => value.includes(sample))) return true;
  return new Set(value).size <= 8;
}

/** The whole match is a token; veto it if it is an obvious sample. */
const notFake = (m) => !looksFake(m[0]);

/**
 * A real secret is a random string. "Mixed character classes or long" is a
 * cheap stand-in for entropy that separates `hunter2abcdef` style test values
 * from `kX9!mQ2$vL7pZ4rT` style real ones without a maths library.
 */
export function looksRandom(value) {
  if (/\s/.test(value)) return false; // prose, not a key
  if (!/[0-9]/.test(value)) return false; // generated keys carry digits
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  return classes >= 3 || (classes >= 2 && value.length >= 20);
}

/**
 * Each rule: a name, a regex, and (optionally) a `check` that gets the match
 * and can veto it. `check` is where placeholder and entropy filtering live, so
 * the regexes stay readable.
 *
 * The regex sources are written so that this file does not match its own
 * rules when scanned (nothing here is a complete credential).
 */
export const RULES = [
  {
    name: "aws-access-key-id",
    pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
    check: notFake,
  },
  {
    name: "github-token",
    pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/,
    check: notFake,
  },
  {
    name: "anthropic-key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/,
    check: notFake,
  },
  {
    name: "openai-key",
    pattern: /\bsk-(proj-|svcacct-)?[A-Za-z0-9_-]{32,}/,
    check: (m) => !m[0].startsWith("sk-ant-") && !looksFake(m[0]),
  },
  {
    name: "slack-token",
    pattern: /\bxox[abprse]-[0-9A-Za-z-]{10,}/,
    check: notFake,
  },
  {
    name: "slack-webhook",
    pattern: /hooks\.slack\.com\/services\/T[0-9A-Z]+\/B[0-9A-Z]+\/[0-9A-Za-z]+/,
    check: notFake,
  },
  {
    name: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
    check: notFake,
  },
  {
    name: "stripe-key",
    pattern: /\b[sr]k_(live|test)_[0-9A-Za-z]{20,}\b/,
    check: notFake,
  },
  {
    name: "sendgrid-key",
    pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/,
    check: notFake,
  },
  {
    name: "twilio-key",
    pattern: /\bSK[0-9a-fA-F]{32}\b/,
    check: notFake,
  },
  {
    name: "private-key-block",
    // Built from parts so the literal header never appears in this file.
    // Group 2 is whatever follows the header on the same line.
    pattern: new RegExp("-----BEGIN " + "(RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?" + "PRIVATE KEY-----(.*)$"),
    // A header that a string literal ends right after ("...KEY-----\n" +) is
    // a test fixture or an error message, not a key. A pasted key continues
    // with its base64 body, which a quote never follows directly.
    check: (m) => !/^(\\[nrt]|\s)*["'`]/.test(m[2]) && (m[2].trim() === "" || !looksFake(m[2])),
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
    check: notFake,
  },
  {
    name: "url-with-password",
    // scheme://user:password@host - the password is group 2. A password that
    // equals the username (postgres://paperclip:paperclip@...) is the local
    // dev convention, not a secret.
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/([^\s/:@"']+):([^\s/@"']{4,})@/i,
    check: (m) => !isPlaceholder(m[2]) && m[1].toLowerCase() !== m[2].toLowerCase(),
  },
  {
    name: "credential-assignment",
    // password = "literal", api_key: 'literal'. Quoted on both sides, so an
    // expression (apiKey: opts.apiKey) or a reference (secret: ENV_NAME)
    // cannot match; only a literal value can.
    pattern:
      /\b(password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret|_authToken|bearer)\b\s*[:=]\s*(["'`])([^"'`]{12,})\2/i,
    check: (m) => !isPlaceholder(m[3]) && looksRandom(m[3]) && !looksFake(m[3]),
  },
  {
    name: "env-credential",
    // SOME_PASSWORD=literal or export SOME_TOKEN=literal, at the start of a
    // line, as a .env or shell file would have it.
    pattern:
      /^\s*(export\s+)?[A-Z][A-Z0-9_]*(PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|APIKEY|PRIVATE_KEY)\s*=\s*["']?([^\s"']{12,})["']?\s*$/,
    check: (m) => !isPlaceholder(m[3]) && looksRandom(m[3]) && !looksFake(m[3]),
  },
];

/**
 * Files that must not be committed whatever they contain. Matched against the
 * repo-relative path.
 */
export const FORBIDDEN_FILES = [
  {
    name: "dotenv-file",
    pattern: /(^|\/)\.env(\.[A-Za-z0-9_-]+)?$/,
    allow: /\.env\.(example|sample|template|dist)$/,
  },
  { name: "private-key-file", pattern: /\.(pem|key|p12|pfx|ppk|jks|keystore)$/ },
  { name: "ssh-key-file", pattern: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/ },
  {
    name: "credentials-file",
    pattern: /(^|\/)(\.netrc|\.pypirc|credentials\.json|service-account[^/]*\.json)$/,
  },
];

export function scanLine(line) {
  if (line.includes(ALLOW_MARKER)) return [];
  const hits = [];
  for (const rule of RULES) {
    const m = rule.pattern.exec(line);
    if (!m) continue;
    if (rule.check && !rule.check(m)) continue;
    hits.push(rule.name);
  }
  return hits;
}

export function scanPath(path) {
  const normalized = path.replace(/\\/g, "/");
  const hits = [];
  for (const rule of FORBIDDEN_FILES) {
    if (!rule.pattern.test(normalized)) continue;
    if (rule.allow && rule.allow.test(normalized)) continue;
    hits.push(rule.name);
  }
  return hits;
}

/**
 * Turn a unified diff (with -U0) into { file, line } entries for the added
 * lines only. "+++ b/path" headers are file names, not content.
 */
export function addedLinesFromDiff(diff) {
  const out = [];
  let file = "";
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.replace(/^\+\+\+ b\//, "").replace(/^\+\+\+ /, "");
      continue;
    }
    if (raw.startsWith("---") || raw.startsWith("@@") || raw.startsWith("diff ")) continue;
    if (raw.startsWith("+")) out.push({ file, line: raw.slice(1) });
  }
  return out;
}

const SKIP_FILES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]);

export function scanAddedLines(entries) {
  const findings = [];
  for (const { file, line } of entries) {
    if (SKIP_FILES.has(file)) continue;
    for (const rule of scanLine(line)) {
      findings.push({ rule, file, line: line.slice(0, 160) });
    }
  }
  return findings;
}

export function scanPaths(paths) {
  const findings = [];
  for (const file of paths) {
    for (const rule of scanPath(file)) {
      findings.push({ rule, file, line: "(file should not be committed)" });
    }
  }
  return findings;
}

export function report(findings, { error = console.error, log = console.log, what }) {
  if (findings.length === 0) {
    log(`  OK  No secrets found in ${what}.`);
    return 0;
  }
  error(`ERROR: Possible secrets found in ${what}:\n`);
  for (const f of findings.slice(0, 30)) {
    error(`  [${f.rule}] ${f.file}: ${f.line}`);
  }
  if (findings.length > 30) error(`  ... and ${findings.length - 30} more`);
  error("");
  error("If a value is real: remove it, and rotate it if it was ever pushed.");
  error(`If it is a harmless example: add the comment marker "${ALLOW_MARKER}" to that line.`);
  return 1;
}

function git(cmd, cwd) {
  return execSync(cmd, {
    encoding: "utf8",
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

export function runStaged({ repoRoot, log, error }) {
  let diff = "";
  let names = "";
  try {
    diff = git("git diff --cached --diff-filter=ACMR -U0", repoRoot);
    names = git("git diff --cached --name-only --diff-filter=ACMR", repoRoot);
  } catch {
    return 0;
  }
  const findings = [
    ...scanPaths(names.split("\n").filter(Boolean)),
    ...scanAddedLines(addedLinesFromDiff(diff)),
  ];
  return report(findings, { log, error, what: "staged changes" });
}

export function runRange({ repoRoot, base, head, log, error }) {
  const diff = git(`git diff --diff-filter=ACMR -U0 ${base} ${head}`, repoRoot);
  const names = git(`git diff --name-only --diff-filter=ACMR ${base} ${head}`, repoRoot);
  const findings = [
    ...scanPaths(names.split("\n").filter(Boolean)),
    ...scanAddedLines(addedLinesFromDiff(diff)),
  ];
  return report(findings, { log, error, what: `${base}..${head}` });
}

export function runTree({ repoRoot, log, error }) {
  const files = git("git ls-files", repoRoot).split("\n").filter(Boolean);
  const findings = scanPaths(files);
  for (const file of files) {
    if (SKIP_FILES.has(file)) continue;
    let text;
    try {
      text = readFileSync(resolve(repoRoot, file), "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue; // binary
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const rule of scanLine(lines[i])) {
        findings.push({ rule, file: `${file}:${i + 1}`, line: lines[i].slice(0, 160) });
      }
    }
  }
  return report(findings, { log, error, what: "tracked files" });
}

function main() {
  const repoRoot = git("git rev-parse --show-toplevel").trim();
  const args = process.argv.slice(2);
  if (args.includes("--staged")) {
    process.exit(runStaged({ repoRoot }));
  }
  const rangeAt = args.indexOf("--range");
  if (rangeAt !== -1) {
    const base = args[rangeAt + 1];
    const head = args[rangeAt + 2];
    if (!base || !head) {
      console.error("Usage: check-secrets.mjs --range <base> <head>");
      process.exit(2);
    }
    process.exit(runRange({ repoRoot, base, head }));
  }
  process.exit(runTree({ repoRoot }));
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main();
}
