// Shows desktop reminders on macOS and Linux, the job the system tray does on
// Windows. installed-service.ts starts it next to the server and stops it with
// the server.
//
// Every 10 seconds it asks the server for reminders fired on the `desktop`
// channel, shows one at a time, and acknowledges a reminder only once the user
// has seen it. On macOS that means a button was pressed in the dialog: an
// unanswered dialog closes after ten minutes and the reminder stays queued to
// be shown again. (`display notification` is not used because it exits 0 and
// shows nothing when notifications are off or a Focus mode is on.) On Linux a
// reminder is acknowledged once notify-send has accepted it.
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const POLL_INTERVAL_MS = 10_000;
// After a dialog or notify-send fails, wait longer before trying again.
export const FAILURE_BACKOFF_MS = 60_000;
export const DIALOG_TIMEOUT_SECONDS = 600;

// Reminder text arrives as arguments, never spliced into the script.
const DIALOG_SCRIPT = [
  "on run argv",
  `set answer to display dialog (item 2 of argv) with title (item 1 of argv) buttons {"Dismiss", "Open"} default button "Open" with icon note giving up after ${DIALOG_TIMEOUT_SECONDS}`,
  'return (button returned of answer) & "|" & (gave up of answer)',
  "end run",
];

function readConfig(configPath) {
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Where to poll and what to open. The queue only trusts a tokenless request
 * over loopback, so polling always goes to 127.0.0.1 on the configured port.
 * Open uses the address the user reaches this instance by, chosen the way the
 * server does: an explicit public URL, otherwise the address in the startup
 * banner.
 */
export function resolveSettings(env, config) {
  const server = config?.server ?? {};
  const port = Number(env.PORT) || Number(server.port) || 3100;
  const host = env.HOST || server.host || "127.0.0.1";
  const publicUrl = [
    env.PAPERCLIP_AUTH_PUBLIC_BASE_URL,
    env.BETTER_AUTH_URL,
    env.BETTER_AUTH_BASE_URL,
    env.PAPERCLIP_PUBLIC_URL,
    config?.auth?.publicBaseUrl,
  ].find((value) => typeof value === "string" && value.trim())?.trim();
  let appUrl = `http://${host === "0.0.0.0" || host === "::" ? "localhost" : host}:${port}`;
  if (publicUrl) {
    try {
      appUrl = new URL(publicUrl).origin;
    } catch {
      // Keep the banner address when the configured URL does not parse.
    }
  }
  return { pollBase: `http://127.0.0.1:${port}`, appUrl };
}

/**
 * A reminder's url is a path in this instance, such as `/calendar`. Resolve it
 * against the instance's address, and open the instance's home page instead of
 * anything that would land outside it.
 */
export function resolveOpenUrl(appUrl, reminderUrl) {
  const home = new URL(appUrl);
  if (typeof reminderUrl !== "string" || !reminderUrl.startsWith("/") || reminderUrl.startsWith("//")) {
    return home.href;
  }
  try {
    const target = new URL(reminderUrl, home);
    return target.origin === home.origin ? target.href : home.href;
  } catch {
    return home.href;
  }
}

/** Reads the `button|gaveUp` line the dialog script returns. */
export function parseDialogResult(stdout) {
  const [button = "", gaveUp = ""] = String(stdout).trim().split("|");
  if (gaveUp.trim() === "true" || !button) return { answered: false };
  return { answered: true, open: button === "Open" };
}

/**
 * The next reminder to show: the one shown least recently, so a reminder left
 * unanswered goes to the back instead of blocking the ones behind it.
 */
export function pickNext(pending, lastShown, skip) {
  let best = null;
  for (const item of pending) {
    if (skip.has(item.id)) continue;
    if (!best || (lastShown.get(item.id) ?? 0) < (lastShown.get(best.id) ?? 0)) best = item;
  }
  return best;
}

function dialogText(reminder) {
  const body = typeof reminder.body === "string" ? reminder.body.trim() : "";
  return body ? `${reminder.title}\n\n${body}` : String(reminder.title ?? "Reminder");
}

/** Platform pieces, kept apart so the loop can be tested without a desktop. */
export function createPlatform(platform = process.platform) {
  let current = null;
  const run = (command, args) =>
    new Promise((resolve) => {
      const child = execFile(command, args, { encoding: "utf8" }, (error, stdout) => {
        if (current === child) current = null;
        resolve({ error, stdout });
      });
      current = child;
    });
  const opener = platform === "darwin" ? "open" : "xdg-open";
  return {
    supported: platform === "darwin" || platform === "linux",
    async show(reminder) {
      if (platform === "darwin") {
        const args = DIALOG_SCRIPT.flatMap((line) => ["-e", line]);
        const { error, stdout } = await run("osascript", [...args, "Paperclip reminder", dialogText(reminder)]);
        if (error) return { failed: true, reason: error.code === "ENOENT" ? "missing" : error.message };
        return parseDialogResult(stdout);
      }
      const body = typeof reminder.body === "string" ? reminder.body : "";
      const { error } = await run("notify-send", ["--app-name=Paperclip", "--", String(reminder.title ?? "Reminder"), body]);
      if (error) return { failed: true, reason: error.code === "ENOENT" ? "missing" : error.message };
      return { answered: true, open: false };
    },
    open(url) {
      const child = spawn(opener, [url], { stdio: "ignore", detached: true });
      child.on("error", () => {});
      child.unref();
    },
    // Closes an open dialog by ending the process that owns it.
    close() {
      current?.kill("SIGTERM");
      current = null;
    },
  };
}

/** The poll, show, acknowledge loop. Resolves once `isStopped()` is true. */
export async function runReminderLoop({ settings, platform, fetchImpl = fetch, sleep, isStopped, log = () => {} }) {
  const lastShown = new Map();
  // Answered, but the acknowledgement has not reached the server yet. These
  // are retried and never shown twice.
  const unacked = new Set();
  let serverReachable = true;
  let showFailing = false;

  const ack = async (ids) => {
    try {
      const response = await fetchImpl(`${settings.pollBase}/api/internal/desktop-notifications/ack`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids }),
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) for (const id of ids) unacked.delete(id);
    } catch {
      // Retried on the next pass.
    }
  };

  while (!isStopped()) {
    if (unacked.size) await ack([...unacked]);
    let pending = null;
    try {
      const response = await fetchImpl(`${settings.pollBase}/api/internal/desktop-notifications/pending?limit=20`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) pending = (await response.json())?.notifications ?? [];
      else if (serverReachable) log(`Desktop reminders: the server answered ${response.status}; will keep trying.`);
      serverReachable = response.ok;
    } catch {
      serverReachable = false;
    }
    const next = pending ? pickNext(pending, lastShown, unacked) : null;
    if (!next) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    lastShown.set(next.id, Date.now());
    const result = await platform.show(next);
    if (isStopped()) break;
    if (result.failed) {
      if (result.reason === "missing") {
        log("Desktop reminders: notify-send is not installed, so reminders will not be shown on this desktop.");
        return;
      }
      if (!showFailing) log(`Desktop reminders: could not show a reminder (${result.reason}); will try again.`);
      showFailing = true;
      await sleep(FAILURE_BACKOFF_MS);
      continue;
    }
    showFailing = false;
    if (!result.answered) {
      // Left unanswered: keep it queued and show it again on a later pass.
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    unacked.add(next.id);
    await ack([next.id]);
    if (result.open) platform.open(resolveOpenUrl(settings.appUrl, next.url));
  }
}

async function main() {
  const platform = createPlatform();
  if (!platform.supported) return;
  const configPath = process.env.PAPERCLIP_CONFIG
    || path.join(os.homedir(), ".paperclip", "instances", process.env.PAPERCLIP_INSTANCE_ID || "default", "config.json");
  const settings = resolveSettings(process.env, readConfig(configPath));

  let stopped = false;
  let wake = null;
  const stop = () => {
    stopped = true;
    platform.close();
    wake?.();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);
  // Exit with whatever started us, even if it could not say goodbye.
  const parent = process.ppid;
  const watch = setInterval(() => {
    if (process.ppid !== parent) stop();
  }, 2_000);
  watch.unref();

  const sleep = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  await runReminderLoop({ settings, platform, sleep, isStopped: () => stopped, log: (line) => console.log(line) });
  clearInterval(watch);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
