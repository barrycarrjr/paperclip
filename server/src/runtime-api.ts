import os from "node:os";

function normalizeHost(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host).toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function isWildcardHost(host: string): boolean {
  const normalized = normalizeHost(host).toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::";
}

function formatOrigin(protocol: string, host: string, port: number): string {
  const normalizedHost = host.includes(":") && !host.startsWith("[") && !host.endsWith("]")
    ? `[${host}]`
    : host;
  return `${protocol}//${normalizedHost}:${port}`;
}

function pushCandidate(
  candidates: string[],
  seen: Set<string>,
  rawUrl: string | null | undefined,
): void {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return;
  try {
    const normalized = new URL(trimmed).origin;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  } catch {
    // Ignore malformed candidates.
  }
}

/**
 * The public base URL, corrected when it cannot actually reach this process.
 *
 * The public base URL is a browser-facing address (it is what auth callbacks
 * are built from), and it is allowed to point at a reverse proxy. The runtime
 * API URL has a different job: it is handed to agents so they can call back
 * into THIS server. When the two disagree, agents lose.
 *
 * They disagree in one specific, silent way. A base URL written without a
 * port (`http://paperclip.local`) means port 80, and port 80 on that host may
 * belong to something else entirely — on the machine this was found on it was
 * a different web server that answered every agent request with a redirect to
 * a hostname that does not resolve. The agent's REST fallback was dead and the
 * only symptom was the agent reporting it could not reach Paperclip.
 *
 * So: keep the hostname, swap in the port we are actually listening on, but
 * only when all of these hold, because each one rules out a case where the
 * written address is the right one:
 *
 * - the scheme is `http:` — an `https:` base URL is a proxy or a real public
 *   address, and this server is not the one terminating TLS
 * - no port was written — a port that was written down was meant
 * - we are not listening on 80 — otherwise there is nothing to correct
 * - the hostname is one we serve (`allowedHostnames`) — if we do not answer
 *   for that name, a direct connection to it is a guess, and the proxy in
 *   front of it is the only route in
 */
function reachableRuntimeOrigin(
  rawBaseUrl: string,
  allowedHostnames: string[],
  port: number,
): string | null {
  let url: URL;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    return null;
  }
  const written = url.origin;
  if (url.protocol !== "http:") return written;
  if (url.port) return written;
  if (port === 80) return written;

  const hostname = url.hostname.trim().toLowerCase();
  const serveThisName = allowedHostnames.some(
    (value) => normalizeHost(value).toLowerCase() === hostname,
  );
  if (!serveThisName) return written;

  return formatOrigin(url.protocol, url.hostname, port);
}

export function choosePrimaryRuntimeApiUrl(input: {
  authPublicBaseUrl?: string | null;
  allowedHostnames: string[];
  bindHost: string;
  port: number;
}): string {
  const explicitPublicBaseUrl = input.authPublicBaseUrl?.trim();
  if (explicitPublicBaseUrl) {
    const corrected = reachableRuntimeOrigin(
      explicitPublicBaseUrl,
      input.allowedHostnames,
      input.port,
    );
    // A null here means config parsing drifted; fall through to the derived
    // candidates rather than handing out an address nothing can parse.
    if (corrected) return corrected;
  }

  const allowedHostname = input.allowedHostnames
    .map((value) => value.trim())
    .find(Boolean);
  if (allowedHostname) {
    return formatOrigin("http:", allowedHostname, input.port);
  }

  const bindHost = normalizeHost(input.bindHost);
  if (bindHost && !isWildcardHost(bindHost)) {
    return formatOrigin("http:", bindHost, input.port);
  }

  return formatOrigin("http:", "localhost", input.port);
}

export function buildRuntimeApiCandidateUrls(input: {
  authPublicBaseUrl?: string | null;
  allowedHostnames: string[];
  bindHost: string;
  port: number;
  networkInterfacesMap?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
}): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const explicitPublicBaseUrl = input.authPublicBaseUrl?.trim() ?? "";
  // Corrected the same way the primary is, so a base URL that cannot reach
  // this process does not get to be the first thing every caller tries.
  const explicitOrigin = explicitPublicBaseUrl
    ? reachableRuntimeOrigin(explicitPublicBaseUrl, input.allowedHostnames, input.port)
    : null;
  const protocol = explicitOrigin ? new URL(explicitOrigin).protocol : "http:";

  pushCandidate(candidates, seen, explicitOrigin);

  for (const rawHost of input.allowedHostnames) {
    const host = normalizeHost(rawHost);
    if (!host) continue;
    pushCandidate(candidates, seen, formatOrigin(protocol, host, input.port));
  }

  const bindHost = normalizeHost(input.bindHost);
  if (bindHost && !isWildcardHost(bindHost)) {
    pushCandidate(candidates, seen, formatOrigin(protocol, bindHost, input.port));
  }

  if (explicitOrigin) {
    const hostname = new URL(explicitOrigin).hostname;
    if (isLoopbackHost(hostname)) {
      pushCandidate(candidates, seen, formatOrigin(protocol, "host.docker.internal", input.port));
    }
  }

  const interfaces = input.networkInterfacesMap ?? os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      const host = normalizeHost(entry.address);
      if (!host || isLoopbackHost(host) || isWildcardHost(host)) continue;
      pushCandidate(candidates, seen, formatOrigin(protocol, host, input.port));
    }
  }

  if (candidates.length === 0) {
    pushCandidate(
      candidates,
      seen,
      choosePrimaryRuntimeApiUrl({
        authPublicBaseUrl: input.authPublicBaseUrl,
        allowedHostnames: input.allowedHostnames,
        bindHost: input.bindHost,
        port: input.port,
      }),
    );
  }

  return candidates;
}
