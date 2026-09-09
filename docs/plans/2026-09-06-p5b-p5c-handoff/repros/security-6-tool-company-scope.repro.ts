// Throwaway verification for review finding security-6. Deleted after the run.
import { test, before, after, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { OAuth2Client } from "google-auth-library";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "./src/manifest.js";
import plugin from "./src/worker.js";
import type { GbpReview, InstanceConfig, LocationConfig } from "./src/types.js";

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const COMPANY_B = "22222222-2222-2222-2222-222222222222";

const MAIN_ST: LocationConfig = { key: "main-st", displayName: "Main St Store", googleAccountId: "111", locationId: "222", accountKey: "owner", targetCompanyId: COMPANY_A };
const BETA: LocationConfig = { key: "beta", displayName: "Beta Shop", googleAccountId: "111", locationId: "333", accountKey: "owner", targetCompanyId: COMPANY_B };

function config(allowedCompanies: string[]): InstanceConfig {
  return {
    allowReplies: true,
    accounts: [{ key: "owner", userEmail: "owner@example.com", clientIdRef: "ref-id", clientSecretRef: "ref-secret", refreshTokenRef: "ref-token", allowedCompanies }],
    locations: [MAIN_ST, BETA],
  } as InstanceConfig;
}

const BETA_REVIEW: GbpReview = {
  name: "accounts/111/locations/333/reviews/beta-1",
  reviewId: "beta-1",
  reviewer: { displayName: "Beta Customer", isAnonymous: false },
  starRating: "ONE",
  comment: "Company B private-ish review text",
  createTime: "2026-09-01T10:00:00Z",
  updateTime: "2026-09-01T10:00:00Z",
};

const fetchLog: Array<{ method: string; url: string }> = [];
const originalFetch = globalThis.fetch;
const originalGetAccessToken = OAuth2Client.prototype.getAccessToken;

before(() => {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = init?.method ?? "GET";
    fetchLog.push({ method, url });
    if (method === "GET" && url.includes("/locations/333/reviews")) {
      return new Response(JSON.stringify({ reviews: [BETA_REVIEW], totalReviewCount: 1 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`unexpected Google call ${method} ${url}`);
  }) as typeof fetch;
  OAuth2Client.prototype.getAccessToken = (async () => ({ token: "test-token", res: null })) as typeof originalGetAccessToken;
});
after(() => {
  globalThis.fetch = originalFetch;
  OAuth2Client.prototype.getAccessToken = originalGetAccessToken;
});
beforeEach(() => { fetchLog.length = 0; });

async function makeHarness(cfg: InstanceConfig) {
  const harness = createTestHarness({ manifest, config: cfg as unknown as Record<string, unknown> });
  harness.ctx.db.query = (async () => []) as typeof harness.ctx.db.query;
  harness.ctx.db.execute = async () => ({ rowCount: 1 });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

const A_AGENT = { companyId: COMPANY_A, agentId: "agent-a", runId: "run-a" };

test("gbp_list_reviews: agent of A reads B's live reviews when the account allows both", async () => {
  const harness = await makeHarness(config([COMPANY_A, COMPANY_B]));
  const result = await harness.executeTool<{ content: string; error?: string; data?: unknown }>("gbp_list_reviews", { locationKey: BETA.key }, A_AGENT);
  console.log("list_reviews result:", JSON.stringify(result.content));
  assert.equal(result.error, undefined);
  assert.match(result.content, /Beta Customer/);
  assert.match(result.content, /Company B private-ish review text/);
  assert.ok(fetchLog.some((c) => c.url.includes("/locations/333/reviews")), "Google WAS called for B's location");
});

test("gbp_get_review (sibling): agent of A is refused for B's location with no Google call", async () => {
  const harness = await makeHarness(config([COMPANY_A, COMPANY_B]));
  const result = await harness.executeTool<{ content: string; error?: string }>("gbp_get_review", { reviewName: BETA_REVIEW.name, locationKey: BETA.key }, A_AGENT);
  console.log("get_review result:", JSON.stringify(result.content));
  assert.match(result.content, /^\[ECOMPANY_NOT_ALLOWED\]/);
  assert.equal(fetchLog.length, 0);
});

test("gbp_sync_location: agent of A syncs B's location and issues are created in B", async () => {
  const harness = await makeHarness(config([COMPANY_A, COMPANY_B]));
  const created: Array<{ companyId: string; title: string }> = [];
  const realCreate = harness.ctx.issues.create.bind(harness.ctx.issues);
  harness.ctx.issues.create = async (input) => { created.push({ companyId: input.companyId, title: input.title }); return realCreate(input); };
  const result = await harness.executeTool<{ content: string; error?: string }>("gbp_sync_location", { locationKey: BETA.key }, A_AGENT);
  console.log("sync_location result:", JSON.stringify(result.content), "issues:", JSON.stringify(created));
  assert.equal(result.error, undefined);
  assert.match(result.content, /Synced reviews for Beta Shop/);
  assert.equal(created.length, 1);
  assert.equal(created[0]!.companyId, COMPANY_B);
});

test("gbp_sync_location: caller company is never consulted, so even an account allowing ONLY B lets A trigger it", async () => {
  const harness = await makeHarness(config([COMPANY_B]));
  const created: Array<{ companyId: string }> = [];
  const realCreate = harness.ctx.issues.create.bind(harness.ctx.issues);
  harness.ctx.issues.create = async (input) => { created.push({ companyId: input.companyId }); return realCreate(input); };
  const result = await harness.executeTool<{ content: string; error?: string }>("gbp_sync_location", { locationKey: BETA.key }, A_AGENT);
  console.log("sync_location (allow B only) result:", JSON.stringify(result.content), "issues:", JSON.stringify(created));
  assert.equal(result.error, undefined);
  assert.match(result.content, /Synced reviews for Beta Shop/);
  assert.equal(created[0]?.companyId, COMPANY_B);
});

test("gbp_list_reviews: with the account allowing ONLY B, A is stopped by the account allow-list (the only line of defence)", async () => {
  const harness = await makeHarness(config([COMPANY_B]));
  const result = await harness.executeTool<{ content: string; error?: string }>("gbp_list_reviews", { locationKey: BETA.key }, A_AGENT);
  console.log("list_reviews (allow B only) result:", JSON.stringify(result.content));
  assert.match(result.content, /^\[ECOMPANY_NOT_ALLOWED\]/);
  assert.equal(fetchLog.length, 0);
});
