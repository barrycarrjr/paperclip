/**
 * Making sure the embedded database is really gone.
 *
 * `embedded-postgres` stops a cluster on Windows by running
 * `taskkill /pid <postmaster> /f /t`. That is a force kill rather than a
 * postgres shutdown, and postgres's own helper processes (io_worker,
 * checkpointer, bgwriter, wal_writer, the per-connection backends) do not
 * reliably die with their parent. Any one of them that survives still holds
 * the cluster's shared memory, so the NEXT start fails with:
 *
 *   FATAL:  pre-existing shared memory block is still in use
 *   HINT:   Terminate any old server processes associated with data directory "..."
 *
 * which is how a restart turns into an outage: the old server is gone, the new
 * one refuses to boot, and nothing on screen explains why. The same thing
 * happens after a machine crash or a force-kill from Task Manager, where no
 * shutdown code runs at all.
 *
 * So this module does two jobs. On the way down it takes a snapshot of the
 * whole postgres family before the stop and kills anything still breathing
 * afterwards. On the way up, if a start fails for exactly this reason, it
 * clears the leftovers so the retry can succeed.
 *
 * How a process is recognised as ours
 * ===================================
 * The postmaster carries the data directory on its command line
 * (`postgres.exe -D <dataDir> -p <port>`), but its children do not - they look
 * like `postgres.exe --forkchild="io_worker" 5860` and carry no data dir at
 * all. So children are found by parentage, not by matching text.
 *
 * When the postmaster is already dead there is no parentage left to follow,
 * and the only marker on an orphan is the binary it was launched from:
 * `.../@embedded-postgres/<platform>/native/bin/postgres`. That path belongs to
 * the embedded-postgres package and to nothing else, so matching on it cannot
 * touch a system postgres, one in Docker, or another application's database.
 * Combined with "its parent process is gone", it also cannot touch a healthy
 * cluster, whose postmaster and workers both still have living parents.
 */

import { spawn } from "node:child_process";

/** One running process, in the only detail this module needs. */
export interface OsProcess {
  pid: number;
  parentPid: number;
  commandLine: string;
  executablePath: string;
}

/**
 * Path fragments carried only by the binaries embedded-postgres ships. Both
 * must be present, so a directory that merely happens to be called `postgres`
 * is not enough.
 */
const EMBEDDED_POSTGRES_PATH_MARKERS = ["@embedded-postgres", "/native/bin/postgres"] as const;

/**
 * Windows spawns the postmaster with backslashes and its children with forward
 * slashes, in the same cluster, so every comparison here goes through this.
 */
function normalizePath(text: string): string {
  return text.replace(/\\/g, "/").toLowerCase();
}

export function isEmbeddedPostgresProcess(proc: OsProcess): boolean {
  const haystack = normalizePath(`${proc.executablePath} ${proc.commandLine}`);
  return EMBEDDED_POSTGRES_PATH_MARKERS.every((marker) => haystack.includes(marker));
}

/**
 * Does this command line name that exact data directory?
 *
 * Checked as a whole path rather than a substring, so a cluster at
 * `.../instances/default/db` is never confused with one at
 * `.../instances/default/db-restore`.
 */
export function commandLineUsesDataDir(commandLine: string, dataDir: string): boolean {
  const needle = normalizePath(dataDir).replace(/\/+$/, "");
  const haystack = normalizePath(commandLine);
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    const after = haystack[at + needle.length];
    if (after === undefined || after === " " || after === '"' || after === "'") return true;
    from = at + 1;
  }
}

/**
 * The postmaster for one data directory plus every process descended from it.
 *
 * Returned deepest-last so a caller that kills in order takes the parent down
 * first, the same order `taskkill /t` uses.
 */
export function postgresFamilyForDataDir(
  processes: readonly OsProcess[],
  dataDir: string,
): number[] {
  const ours = processes.filter(isEmbeddedPostgresProcess);
  const postmaster = ours.find((proc) => commandLineUsesDataDir(proc.commandLine, dataDir));
  if (!postmaster) return [];

  const family = [postmaster.pid];
  const seen = new Set(family);
  for (let cursor = 0; cursor < family.length; cursor += 1) {
    const parentPid = family[cursor]!;
    for (const proc of ours) {
      if (proc.parentPid !== parentPid || seen.has(proc.pid)) continue;
      seen.add(proc.pid);
      family.push(proc.pid);
    }
  }
  return family;
}

/**
 * Embedded-postgres processes whose parent has gone.
 *
 * These are the leftovers of a crash or a force-kill. They cannot be attributed
 * to a data directory - a worker's command line does not carry one - so this is
 * only called once a start has already failed for the shared-memory reason,
 * where the offending processes are ours by definition. Another instance's
 * orphans getting swept along is harmless: an orphan is already lost work.
 *
 * `isParentAlive` is asked for, not assumed, because `processes` holds only
 * postgres. A healthy postmaster's parent is the paperclip server, which is
 * never in that list, so judging parentage by the list alone declares every
 * live cluster an orphan - and this function decides what gets killed.
 */
export function orphanedEmbeddedPostgres(
  processes: readonly OsProcess[],
  isParentAlive: (pid: number) => boolean,
): number[] {
  const inList = new Set(processes.map((proc) => proc.pid));
  return processes
    .filter(isEmbeddedPostgresProcess)
    .filter((proc) => {
      if (inList.has(proc.parentPid)) return false;
      // Signalling pid 0 means "the whole process group" on POSIX, so a
      // missing or nonsense parent id never reaches the liveness check.
      if (!Number.isInteger(proc.parentPid) || proc.parentPid <= 0) return true;
      return !isParentAlive(proc.parentPid);
    })
    .map((proc) => proc.pid);
}

/** Parse `Get-CimInstance ... | ConvertTo-Json`, which drops the array for one row. */
export function parseWindowsProcessList(stdout: string): OsProcess[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const result: OsProcess[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const pid = Number(record.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    result.push({
      pid,
      parentPid: Number(record.ParentProcessId) || 0,
      commandLine: typeof record.CommandLine === "string" ? record.CommandLine : "",
      executablePath: typeof record.ExecutablePath === "string" ? record.ExecutablePath : "",
    });
  }
  return result;
}

/** Parse `ps -Ao pid=,ppid=,args=`. The command line is everything after the two numbers. */
export function parsePosixProcessList(stdout: string): OsProcess[] {
  const result: OsProcess[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const commandLine = match[3]!.trim();
    if (!commandLine) continue;
    result.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      commandLine,
      executablePath: commandLine.split(/\s+/)[0] ?? "",
    });
  }
  return result;
}

function runCommand(command: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], { windowsHide: true });
    } catch {
      finish("");
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      finish("");
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      finish(stdout);
    });
  });
}

const PROCESS_LIST_TIMEOUT_MS = 10_000;

/** How the module reaches the operating system. Swapped out wholesale in tests. */
export interface ProcessTools {
  list: () => Promise<OsProcess[]>;
  kill: (pid: number) => Promise<void>;
  isAlive: (pid: number) => boolean;
}

export const systemProcessTools: ProcessTools = {
  async list() {
    if (process.platform === "win32") {
      const stdout = await runCommand(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "Get-CimInstance Win32_Process -Filter \"Name LIKE 'postgres%'\" | " +
            "Select-Object ProcessId,ParentProcessId,CommandLine,ExecutablePath | ConvertTo-Json -Compress",
        ],
        PROCESS_LIST_TIMEOUT_MS,
      );
      return parseWindowsProcessList(stdout);
    }
    const stdout = await runCommand("ps", ["-Ao", "pid=,ppid=,args="], PROCESS_LIST_TIMEOUT_MS);
    return parsePosixProcessList(stdout);
  },

  async kill(pid) {
    // Force, deliberately. Everything this module kills has already refused a
    // polite stop or lost its parent, and a half-dead postgres worker is
    // exactly the thing that blocks the next start.
    if (process.platform === "win32") {
      await runCommand("taskkill", ["/PID", String(pid), "/T", "/F"], PROCESS_LIST_TIMEOUT_MS);
      return;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  },

  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // Not ours to signal, but running - which is all we asked.
      return (err as NodeJS.ErrnoException)?.code === "EPERM";
    }
  },
};

type LogFn = (message: string, detail?: Record<string, unknown>) => void;

const noopLog: LogFn = () => {};

/**
 * Stop the embedded database and make sure it stayed stopped.
 *
 * The family is listed BEFORE the stop, because once the postmaster dies its
 * children are orphans and there is nothing left tying them to this cluster.
 */
export async function stopEmbeddedPostgresCompletely(input: {
  dataDir: string;
  stop: () => Promise<void>;
  tools?: ProcessTools;
  log?: LogFn;
}): Promise<{ killedPids: number[] }> {
  const tools = input.tools ?? systemProcessTools;
  const log = input.log ?? noopLog;

  let family: number[] = [];
  try {
    family = postgresFamilyForDataDir(await tools.list(), input.dataDir);
  } catch (err) {
    log("Could not list postgres processes before stopping; continuing", { err });
  }

  await input.stop();

  const survivors = family.filter((pid) => tools.isAlive(pid));
  if (survivors.length === 0) return { killedPids: [] };

  log("Embedded PostgreSQL left processes running after stopping; ending them", {
    pids: survivors,
  });
  for (const pid of survivors) {
    await tools.kill(pid);
  }
  return { killedPids: survivors };
}

/**
 * Clear embedded-postgres leftovers that are stopping a fresh start.
 *
 * Called only after a start has failed with the shared-memory conflict, never
 * speculatively, so a healthy cluster is never in scope.
 */
export async function sweepStaleEmbeddedPostgres(input: {
  dataDir: string;
  tools?: ProcessTools;
  log?: LogFn;
}): Promise<{ killedPids: number[] }> {
  const tools = input.tools ?? systemProcessTools;
  const log = input.log ?? noopLog;

  let processes: OsProcess[];
  try {
    processes = await tools.list();
  } catch (err) {
    log("Could not list postgres processes while clearing leftovers", { err });
    return { killedPids: [] };
  }

  // A postmaster still holding our data directory counts too: it is reachable
  // parentage-wise, but it is the thing occupying the cluster.
  const targets = new Set([
    ...postgresFamilyForDataDir(processes, input.dataDir),
    ...orphanedEmbeddedPostgres(processes, tools.isAlive),
  ]);
  if (targets.size === 0) return { killedPids: [] };

  const killedPids = [...targets];
  log("Ending leftover embedded PostgreSQL processes holding the cluster", { pids: killedPids });
  for (const pid of killedPids) {
    await tools.kill(pid);
  }
  return { killedPids };
}
