import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  menuBarHelperActive, parseDialogResult, pickNext, resolveOpenUrl, resolveSettings, runReminderLoop,
} from "./desktop-reminders.mjs";

test("polls loopback on the configured port and opens the banner address", () => {
  assert.deepEqual(resolveSettings({}, { server: { host: "127.0.0.1", port: 3100 } }), {
    pollBase: "http://127.0.0.1:3100", appUrl: "http://127.0.0.1:3100",
  });
  assert.deepEqual(resolveSettings({ PORT: "3199" }, { server: { host: "0.0.0.0", port: 3100 } }), {
    pollBase: "http://127.0.0.1:3199", appUrl: "http://localhost:3199",
  });
});

test("opens the public address when one is configured, but still polls loopback", () => {
  const settings = resolveSettings({}, {
    server: { host: "0.0.0.0", port: 3100 }, auth: { publicBaseUrl: "https://paperclip.example.test/app" },
  });
  assert.equal(settings.pollBase, "http://127.0.0.1:3100");
  assert.equal(settings.appUrl, "https://paperclip.example.test");
  assert.equal(resolveSettings({ PAPERCLIP_PUBLIC_URL: "http://box.local:3100" }, {}).appUrl, "http://box.local:3100");
});

test("a reminder link opens inside this instance only", () => {
  const app = "http://127.0.0.1:3100";
  assert.equal(resolveOpenUrl(app, "/calendar"), "http://127.0.0.1:3100/calendar");
  assert.equal(resolveOpenUrl(app, "/calendar?event=1#x"), "http://127.0.0.1:3100/calendar?event=1#x");
  for (const outside of ["https://evil.example/x", "//evil.example/x", "javascript:alert(1)", "file:///etc/passwd", "calendar", null, undefined, 7]) {
    assert.equal(resolveOpenUrl(app, outside), "http://127.0.0.1:3100/", String(outside));
  }
});

test("only a pressed button counts as seen", () => {
  assert.deepEqual(parseDialogResult("Dismiss|false\n"), { answered: true, open: false });
  assert.deepEqual(parseDialogResult("Open|false\n"), { answered: true, open: true });
  assert.deepEqual(parseDialogResult("|true\n"), { answered: false });
  assert.deepEqual(parseDialogResult(""), { answered: false });
});

test("an unanswered reminder goes behind the ones not shown yet", () => {
  const pending = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(pickNext(pending, new Map(), new Set()).id, "a");
  assert.equal(pickNext(pending, new Map([["a", 5]]), new Set()).id, "b");
  assert.equal(pickNext(pending, new Map([["a", 5], ["b", 9]]), new Set(["c"])).id, "a");
  assert.equal(pickNext(pending, new Map(), new Set(["a", "b", "c"])), null);
});

// A fake server queue and desktop, driven through a fixed list of answers.
function harness(answers, { failAckOnce = false, handledElsewhere } = {}) {
  const queue = [
    { id: "r1", title: "Pay rent", body: "Due today", url: "/calendar" },
    { id: "r2", title: "Call", body: null, url: "https://evil.example/" },
  ];
  const shown = [], opened = [], acked = [];
  let ackFailures = failAckOnce ? 1 : 0;
  let polls = 0;
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/ack")) {
      if (ackFailures-- > 0) throw new Error("connection reset");
      const { ids } = JSON.parse(init.body);
      acked.push(...ids);
      for (const id of ids) {
        const index = queue.findIndex((item) => item.id === id);
        if (index >= 0) queue.splice(index, 1);
      }
      return { ok: true, json: async () => ({ acknowledged: ids }) };
    }
    polls += 1;
    assert.equal(url, "http://127.0.0.1:3100/api/internal/desktop-notifications/pending?limit=20");
    return { ok: true, json: async () => ({ notifications: queue.map((item) => ({ ...item })) }) };
  };
  const platform = {
    async show(reminder) {
      shown.push(reminder.id);
      return answers.shift() ?? { answered: false };
    },
    open: (url) => opened.push(url),
  };
  return {
    queue, shown, opened, acked,
    run: () => runReminderLoop({
      settings: { pollBase: "http://127.0.0.1:3100", appUrl: "http://127.0.0.1:3100" },
      platform, fetchImpl, sleep: async () => {}, handledElsewhere,
      isStopped: () => polls >= 8 || (queue.length === 0 && answers.length === 0),
    }),
  };
}

test("stays quiet while the menu-bar helper shows reminders for the same server", async () => {
  let passes = 0;
  // The helper is up for three passes, then quits.
  const h = harness([{ answered: true, open: false }, { answered: true, open: false }], {
    handledElsewhere: () => ++passes <= 3,
  });
  await h.run();
  assert.ok(passes > 3);
  assert.deepEqual(h.shown, ["r1", "r2"]);
  assert.deepEqual(h.acked, ["r1", "r2"]);
});

test("the menu-bar marker counts only for a live helper on the same server", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "menubar-"));
  const marker = path.join(dir, "menubar.json");
  const base = "http://127.0.0.1:3100";
  try {
    assert.equal(menuBarHelperActive(marker, base), false, "no marker");
    writeFileSync(marker, JSON.stringify({ pid: process.pid, pollBase: base }));
    assert.equal(menuBarHelperActive(marker, base), true);
    assert.equal(menuBarHelperActive(marker, "http://127.0.0.1:3199"), false, "another server");
    assert.equal(menuBarHelperActive(marker, base, () => false), false, "helper gone");
    writeFileSync(marker, "not json");
    assert.equal(menuBarHelperActive(marker, base), false, "unreadable marker");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Dismiss and Open acknowledge, and Open stays inside the instance", async () => {
  const h = harness([{ answered: true, open: true }, { answered: true, open: true }]);
  await h.run();
  assert.deepEqual(h.shown, ["r1", "r2"]);
  assert.deepEqual(h.acked, ["r1", "r2"]);
  assert.deepEqual(h.opened, ["http://127.0.0.1:3100/calendar", "http://127.0.0.1:3100/"]);
});

test("a dialog that timed out leaves the reminder queued and shows it again", async () => {
  const h = harness([{ answered: false }, { answered: true, open: false }, { answered: true, open: false }]);
  await h.run();
  assert.deepEqual(h.shown, ["r1", "r2", "r1"]);
  assert.deepEqual(h.acked, ["r2", "r1"]);
  assert.deepEqual(h.opened, []);
});

test("a failed acknowledgement is retried and the reminder is not shown twice", async () => {
  const h = harness([{ answered: true, open: false }, { answered: true, open: false }], { failAckOnce: true });
  await h.run();
  assert.deepEqual(h.shown, ["r1", "r2"]);
  assert.deepEqual([...h.acked].sort(), ["r1", "r2"]);
});

test("a desktop that cannot show reminders acknowledges nothing", async () => {
  const h = harness([{ failed: true, reason: "boom" }, { failed: true, reason: "missing" }]);
  await h.run();
  assert.deepEqual(h.acked, []);
  assert.equal(h.queue.length, 2);
});
