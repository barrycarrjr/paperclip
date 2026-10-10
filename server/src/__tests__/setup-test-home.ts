import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Everything the server does not get an explicit path for (its config file,
// logs, secrets key, storage and adapter settings) lives under PAPERCLIP_HOME,
// which defaults to the developer's own ~/.paperclip. A test run must never
// read that instance's settings or write into its logs, so each test file
// gets a throwaway home. Tests that need a particular home still set
// PAPERCLIP_HOME themselves. The homes sit in the run's folder, which
// global-setup-test-home.ts removes when the run finishes.
const parentDir = process.env.PAPERCLIP_VITEST_RUN_DIR || os.tmpdir();
process.env.PAPERCLIP_HOME = fs.mkdtempSync(path.join(parentDir, "paperclip-vitest-home-"));
