import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createLocalAgentJwt, verifyLocalAgentJwt } from "../agent-auth-jwt.js";

describe("agent local JWT", () => {
  const secretEnv = "PAPERCLIP_AGENT_JWT_SECRET";
  const betterAuthSecretEnv = "BETTER_AUTH_SECRET";
  const ttlEnv = "PAPERCLIP_AGENT_JWT_TTL_SECONDS";
  const issuerEnv = "PAPERCLIP_AGENT_JWT_ISSUER";
  const audienceEnv = "PAPERCLIP_AGENT_JWT_AUDIENCE";
  const instanceEnv = "PAPERCLIP_INSTANCE_ID";
  const legacyEnv = "PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK";

  const originalEnv = {
    secret: process.env[secretEnv],
    betterAuthSecret: process.env[betterAuthSecretEnv],
    ttl: process.env[ttlEnv],
    issuer: process.env[issuerEnv],
    audience: process.env[audienceEnv],
    instance: process.env[instanceEnv],
    legacy: process.env[legacyEnv],
  };

  beforeEach(() => {
    process.env[secretEnv] = "test-secret";
    delete process.env[betterAuthSecretEnv];
    process.env[ttlEnv] = "3600";
    delete process.env[issuerEnv];
    delete process.env[audienceEnv];
    process.env[instanceEnv] = "default";
    delete process.env[legacyEnv];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalEnv.secret === undefined) delete process.env[secretEnv];
    else process.env[secretEnv] = originalEnv.secret;
    if (originalEnv.betterAuthSecret === undefined) delete process.env[betterAuthSecretEnv];
    else process.env[betterAuthSecretEnv] = originalEnv.betterAuthSecret;
    if (originalEnv.ttl === undefined) delete process.env[ttlEnv];
    else process.env[ttlEnv] = originalEnv.ttl;
    if (originalEnv.issuer === undefined) delete process.env[issuerEnv];
    else process.env[issuerEnv] = originalEnv.issuer;
    if (originalEnv.audience === undefined) delete process.env[audienceEnv];
    else process.env[audienceEnv] = originalEnv.audience;
    if (originalEnv.instance === undefined) delete process.env[instanceEnv];
    else process.env[instanceEnv] = originalEnv.instance;
    if (originalEnv.legacy === undefined) delete process.env[legacyEnv];
    else process.env[legacyEnv] = originalEnv.legacy;
  });

  it("creates and verifies a token", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(typeof token).toBe("string");

    const claims = verifyLocalAgentJwt(token!);
    expect(claims).toMatchObject({
      sub: "agent-1",
      company_id: "company-1",
      adapter_type: "claude_local",
      run_id: "run-1",
      iss: "paperclip",
      aud: "paperclip-api",
    });
  });

  it("returns null when secret is missing", () => {
    process.env[secretEnv] = "";
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(token).toBeNull();
    expect(verifyLocalAgentJwt("abc.def.ghi")).toBeNull();
  });

  it("falls back to BETTER_AUTH_SECRET when PAPERCLIP_AGENT_JWT_SECRET is absent", () => {
    delete process.env[secretEnv];
    process.env[betterAuthSecretEnv] = "fallback-secret";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(typeof token).toBe("string");

    const claims = verifyLocalAgentJwt(token!);
    expect(claims).toMatchObject({
      sub: "agent-1",
      company_id: "company-1",
      adapter_type: "claude_local",
      run_id: "run-1",
    });
  });

  it("rejects expired tokens", () => {
    process.env[ttlEnv] = "1";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");

    vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
    expect(verifyLocalAgentJwt(token!)).toBeNull();
  });

  it("rejects issuer/audience mismatch", () => {
    process.env[issuerEnv] = "custom-issuer";
    process.env[audienceEnv] = "custom-audience";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "codex_local", "run-1");

    process.env[issuerEnv] = "paperclip";
    process.env[audienceEnv] = "paperclip-api";
    expect(verifyLocalAgentJwt(token!)).toBeNull();
  });

  it("rejects company changes signed with another company's derived key", () => {
    const token = createLocalAgentJwt("agent-1", "company-a", "codex_local", "run-1")!;
    const [header, payload] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
    claims.company_id = "company-b";
    const input = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
    const companyAKey = createHmac("sha256", "test-secret").update("jwt:default:company-a").digest("hex");
    const forged = `${input}.${createHmac("sha256", companyAKey).update(input).digest("base64url")}`;
    expect(verifyLocalAgentJwt(forged)).toBeNull();
  });

  it("rejects worktree tokens on another instance sharing the master secret", () => {
    process.env[instanceEnv] = "review-worktree";
    const token = createLocalAgentJwt("agent-1", "company-1", "codex_local", "run-1")!;
    expect(verifyLocalAgentJwt(token)?.instance_id).toBe("review-worktree");
    process.env[instanceEnv] = "default";
    expect(verifyLocalAgentJwt(token)).toBeNull();
  });

  it("supports old master-signed tokens only during the compatibility window", () => {
    const token = createLocalAgentJwt("agent-1", "company-1", "codex_local", "run-1")!;
    const [header, payload] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
    delete claims.instance_id;
    const input = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
    const legacy = `${input}.${createHmac("sha256", "test-secret").update(input).digest("base64url")}`;
    expect(verifyLocalAgentJwt(legacy)?.company_id).toBe("company-1");
    process.env[legacyEnv] = "true";
    expect(verifyLocalAgentJwt(legacy)).toBeNull();
    expect(verifyLocalAgentJwt(token)?.company_id).toBe("company-1");
  });

  it("preserves the fork's human tool-session attribution and 48-hour default TTL", () => {
    delete process.env[ttlEnv];
    const token = createLocalAgentJwt("clippy:session-1", "company-1", "codex_local", "run-1", {
      userId: "board-user-1",
    })!;
    const claims = verifyLocalAgentJwt(token)!;
    expect(claims.user_id).toBe("board-user-1");
    expect(claims.exp - claims.iat).toBe(48 * 60 * 60);
  });

  it("does not downgrade instance-bound tokens to the legacy master key", () => {
    const token = createLocalAgentJwt("agent-1", "company-1", "codex_local", "run-1")!;
    const input = token.split(".").slice(0, 2).join(".");
    const forged = `${input}.${createHmac("sha256", "test-secret").update(input).digest("base64url")}`;
    expect(verifyLocalAgentJwt(forged)).toBeNull();
  });
});
