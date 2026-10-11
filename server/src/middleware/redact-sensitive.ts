// Redaction for HTTP log payloads, ported from upstream Paperclip.
//
// A failed request's log line carries its body, params and query so operators
// can diagnose it (see http-log-props.ts). Credentials can sit anywhere in
// those payloads: a secret's `value`, a password on a sign-in form, or a
// stage's env bindings (`env.OPENAI_API_KEY.value`). pino's own redact paths
// only match fixed positions, so this walker returns a copy with the values of
// sensitive-looking keys replaced by "[REDACTED]" at any depth. Depth is
// capped so a deep or cyclic payload cannot pin the logger.

const SENSITIVE_KEYS = new Set<string>([
  "credential",
  "credentials",
  "password",
  "currentpassword",
  "newpassword",
  "passwordconfirmation",
  "password_confirmation",
  "confirmpassword",
  "confirm_password",
  // Secret bodies and env bindings use a generic `value` field. Failure logs
  // must prefer losing that diagnostic value over keeping credential material.
  // `token` is likewise ambiguous but often carries a credential.
  "value",
  "token",
  "secret",
  "client_secret",
  "clientsecret",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "id_token",
  "idtoken",
  "api_key",
  "apikey",
  "authorization",
  "auth_token",
  "authtoken",
  "session_token",
  "sessiontoken",
  "private_key",
  "privatekey",
  "app_secret",
  "appsecret",
  "bot_token",
  "bottoken",
  "signing_secret",
  "signingsecret",
  "webhook_secret",
  "webhooksecret",
  "authorization_code",
  "code_verifier",
  "codeverifier",
]);

// Fields that hold an address. Their query string, fragment and any
// user:password part are dropped, since tokens often travel there.
const URLISH_KEYS = new Set<string>(["href", "uri", "url", "source_url", "sourceurl"]);

const MAX_DEPTH = 6;
const REDACTED = "[REDACTED]";

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

function isUrlishKey(key: string): boolean {
  return URLISH_KEYS.has(key.toLowerCase());
}

export function stripSecretBearingUrlParts(value: string): string {
  const suffixStart = value.search(/[?#]/);
  const withoutQueryOrFragment = suffixStart === -1 ? value : value.slice(0, suffixStart);

  try {
    const url = new URL(withoutQueryOrFragment);
    if (!url.username && !url.password && suffixStart === -1) return value;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    // Not an absolute address (for example a path). The query and fragment
    // still go.
    return withoutQueryOrFragment;
  }
}

export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    if (depth + 1 > MAX_DEPTH) return undefined;
    return value.map((entry) => redactSensitive(entry, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    if (typeof entry === "string" && isUrlishKey(key)) {
      out[key] = stripSecretBearingUrlParts(entry);
      continue;
    }
    out[key] = redactSensitive(entry, depth + 1);
  }
  return out;
}
