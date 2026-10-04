import assert from "node:assert/strict";
import { test } from "node:test";
import { needsSecurityReview } from "./check-upstream-security.mjs";
test("flags auth and tenant changes even when the subject does not say security", () => {
  assert.ok(needsSecurityReview("Correct request handling", ["server/src/routes/access.ts"]));
  assert.ok(needsSecurityReview("Adjust log persistence", ["packages/db/src/schema/plugin_logs.ts"]));
  assert.ok(needsSecurityReview("Correct bridge handling", ["server/src/routes/plugins.ts"]));
  assert.ok(needsSecurityReview("Fix CVE-2026-1234", ["pnpm-lock.yaml"]));
  assert.equal(needsSecurityReview("Adjust dashboard spacing", ["ui/src/pages/Dashboard.tsx"]), false);
});
