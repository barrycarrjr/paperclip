import { describe, expect, it, vi } from "vitest";
import {
  commandLineUsesDataDir,
  isEmbeddedPostgresProcess,
  orphanedEmbeddedPostgres,
  parsePosixProcessList,
  parseWindowsProcessList,
  postgresFamilyForDataDir,
  stopEmbeddedPostgresCompletely,
  sweepStaleEmbeddedPostgres,
  type OsProcess,
  type ProcessTools,
} from "./embedded-postgres-processes.js";

/**
 * The fixtures below are copied from a real running instance on Windows, down
 * to the mixed slash directions: the postmaster is spawned with backslashes and
 * its children with forward slashes, in the same cluster. That inconsistency is
 * the whole reason this module normalises paths, so the tests keep it.
 */
const BIN =
  "C:\\Users\\barry\\paperclip\\node_modules\\.pnpm\\@embedded-postgres+windows-x64@18.1.0-beta.16" +
  "\\node_modules\\@embedded-postgres\\windows-x64\\native\\bin\\postgres.exe";
const BIN_FORWARD = BIN.replace(/\\/g, "/");
const DATA_DIR = "C:\\Users\\barry\\.paperclip\\instances\\default\\db";

function postmaster(overrides: Partial<OsProcess> = {}): OsProcess {
  return {
    pid: 19624,
    parentPid: 14500,
    executablePath: BIN,
    commandLine: `${BIN} -D ${DATA_DIR} -p 54329`,
    ...overrides,
  };
}

function worker(pid: number, kind: string, parentPid = 19624): OsProcess {
  return {
    pid,
    parentPid,
    executablePath: BIN,
    commandLine: `"${BIN_FORWARD}" --forkchild="${kind}" ${pid - 1}`,
  };
}

function tools(overrides: Partial<ProcessTools> = {}): ProcessTools {
  return {
    list: vi.fn(async () => []),
    kill: vi.fn(async () => {}),
    isAlive: vi.fn(() => false),
    ...overrides,
  };
}

describe("isEmbeddedPostgresProcess", () => {
  it("recognises the postmaster and its children", () => {
    expect(isEmbeddedPostgresProcess(postmaster())).toBe(true);
    expect(isEmbeddedPostgresProcess(worker(51128, "io_worker"))).toBe(true);
  });

  it("leaves any other postgres on the machine alone", () => {
    // A system install, one in a container, one shipped with another app - all
    // of these have to survive, because this module force-kills what it finds.
    for (const path of [
      "C:\\Program Files\\PostgreSQL\\16\\bin\\postgres.exe",
      "/usr/lib/postgresql/16/bin/postgres",
      "/opt/homebrew/opt/postgresql@16/bin/postgres",
      "C:\\dev\\my-app\\native\\bin\\postgres.exe",
    ]) {
      expect(
        isEmbeddedPostgresProcess({
          pid: 1,
          parentPid: 2,
          executablePath: path,
          commandLine: `${path} -D /var/lib/postgresql/data`,
        }),
      ).toBe(false);
    }
  });
});

describe("commandLineUsesDataDir", () => {
  it("matches whichever way round the slashes go", () => {
    expect(commandLineUsesDataDir(`${BIN} -D ${DATA_DIR} -p 54329`, DATA_DIR)).toBe(true);
    expect(commandLineUsesDataDir(`${BIN} -D ${DATA_DIR.replace(/\\/g, "/")} -p 54329`, DATA_DIR)).toBe(
      true,
    );
  });

  it("does not treat a longer path as the same directory", () => {
    // Otherwise restoring into `db-restore` would kill the live `db`.
    expect(commandLineUsesDataDir(`${BIN} -D ${DATA_DIR}-restore -p 54330`, DATA_DIR)).toBe(false);
    expect(commandLineUsesDataDir(`${BIN} -D ${DATA_DIR}2 -p 54330`, DATA_DIR)).toBe(false);
  });

  it("matches a quoted path at the end of the line", () => {
    expect(commandLineUsesDataDir(`${BIN} -D "${DATA_DIR}"`, DATA_DIR)).toBe(true);
    expect(commandLineUsesDataDir(`${BIN} -D ${DATA_DIR}`, DATA_DIR)).toBe(true);
  });
});

describe("postgresFamilyForDataDir", () => {
  it("collects the postmaster and everything under it", () => {
    const processes = [
      postmaster(),
      worker(51128, "io_worker"),
      worker(72456, "checkpointer"),
      worker(75152, "backend"),
    ];
    expect(postgresFamilyForDataDir(processes, DATA_DIR)).toEqual([19624, 51128, 72456, 75152]);
  });

  it("puts the postmaster first so it dies before its children", () => {
    const family = postgresFamilyForDataDir([worker(51128, "io_worker"), postmaster()], DATA_DIR);
    expect(family[0]).toBe(19624);
  });

  it("follows grandchildren too", () => {
    const processes = [postmaster(), worker(51128, "io_worker"), worker(60001, "backend", 51128)];
    expect(postgresFamilyForDataDir(processes, DATA_DIR)).toContain(60001);
  });

  it("ignores a cluster running from a different data directory", () => {
    // Two paperclip instances on one machine must not stop each other.
    const other = postmaster({
      pid: 900,
      commandLine: `${BIN} -D C:\\Users\\barry\\.paperclip\\instances\\verify\\db -p 54330`,
    });
    expect(postgresFamilyForDataDir([other, worker(901, "io_worker", 900)], DATA_DIR)).toEqual([]);
  });

  it("returns nothing when the postmaster has already gone", () => {
    // The children are unattributable on their own - that is what the orphan
    // sweep is for.
    expect(postgresFamilyForDataDir([worker(51128, "io_worker")], DATA_DIR)).toEqual([]);
  });
});

describe("orphanedEmbeddedPostgres", () => {
  const noParents = () => false;

  it("finds workers whose parent has gone", () => {
    // Exactly the leftover that blocks the next start.
    expect(orphanedEmbeddedPostgres([worker(63832, "io_worker")], noParents)).toEqual([63832]);
  });

  it("leaves a live cluster alone even though its parent is not in the list", () => {
    // The lister only returns postgres, so the paperclip server that owns the
    // postmaster is never among them. Judging parentage by the list alone
    // marked every running cluster an orphan - caught by running the real
    // lister against a healthy instance, not by these fixtures.
    const processes = [postmaster(), worker(51128, "io_worker"), worker(34920, "io_worker")];
    const serverIsRunning = (pid: number) => pid === 14500;
    expect(orphanedEmbeddedPostgres(processes, serverIsRunning)).toEqual([]);
  });

  it("finds a postmaster left behind when its server died", () => {
    expect(orphanedEmbeddedPostgres([postmaster(), worker(51128, "io_worker")], noParents)).toEqual([
      19624,
    ]);
  });

  it("never asks whether process 0 is alive", () => {
    // Signalling pid 0 hits the whole process group on POSIX.
    const isAlive = vi.fn(() => false);
    expect(orphanedEmbeddedPostgres([worker(63832, "io_worker", 0)], isAlive)).toEqual([63832]);
    expect(isAlive).not.toHaveBeenCalled();
  });

  it("leaves an unrelated orphaned postgres alone", () => {
    const stranger: OsProcess = {
      pid: 400,
      parentPid: 401,
      executablePath: "C:\\Program Files\\PostgreSQL\\16\\bin\\postgres.exe",
      commandLine: "postgres.exe -D C:\\pgdata",
    };
    expect(orphanedEmbeddedPostgres([stranger], noParents)).toEqual([]);
  });
});

describe("parseWindowsProcessList", () => {
  it("reads the rows PowerShell emits", () => {
    const json = JSON.stringify([
      {
        ProcessId: 19624,
        ParentProcessId: 14500,
        CommandLine: `${BIN} -D ${DATA_DIR} -p 54329`,
        ExecutablePath: BIN,
      },
    ]);
    expect(parseWindowsProcessList(json)).toEqual([
      {
        pid: 19624,
        parentPid: 14500,
        commandLine: `${BIN} -D ${DATA_DIR} -p 54329`,
        executablePath: BIN,
      },
    ]);
  });

  it("copes with the single row PowerShell sends as a bare object", () => {
    // ConvertTo-Json drops the array when there is one result, which is the
    // shape that turns up precisely when one lone worker is left behind.
    const json = JSON.stringify({ ProcessId: 63832, ParentProcessId: 19624, ExecutablePath: BIN });
    expect(parseWindowsProcessList(json)).toHaveLength(1);
    expect(parseWindowsProcessList(json)[0]!.pid).toBe(63832);
  });

  it("returns nothing rather than throwing when there is no output", () => {
    expect(parseWindowsProcessList("")).toEqual([]);
    expect(parseWindowsProcessList("not json")).toEqual([]);
  });
});

describe("parsePosixProcessList", () => {
  it("keeps the whole command line, spaces and all", () => {
    const rows = parsePosixProcessList(
      "  501   1 /usr/local/bin/postgres -D /Users/b/.paperclip/instances/default/db -p 54329\n" +
        "  502 501 postgres: checkpointer   \n",
    );
    expect(rows).toEqual([
      {
        pid: 501,
        parentPid: 1,
        commandLine: "/usr/local/bin/postgres -D /Users/b/.paperclip/instances/default/db -p 54329",
        executablePath: "/usr/local/bin/postgres",
      },
      { pid: 502, parentPid: 501, commandLine: "postgres: checkpointer", executablePath: "postgres:" },
    ]);
  });
});

describe("stopEmbeddedPostgresCompletely", () => {
  it("lists the family before stopping, not after", async () => {
    // Once the postmaster dies its children are orphans with nothing tying them
    // to this cluster, so the order here is the whole point.
    const order: string[] = [];
    const t = tools({
      list: vi.fn(async () => {
        order.push("list");
        return [postmaster(), worker(51128, "io_worker")];
      }),
    });
    await stopEmbeddedPostgresCompletely({
      dataDir: DATA_DIR,
      tools: t,
      stop: async () => {
        order.push("stop");
      },
    });
    expect(order).toEqual(["list", "stop"]);
  });

  it("ends the worker that outlived the stop", async () => {
    const t = tools({
      list: async () => [postmaster(), worker(51128, "io_worker"), worker(63832, "io_worker")],
      isAlive: (pid) => pid === 63832,
    });
    const result = await stopEmbeddedPostgresCompletely({
      dataDir: DATA_DIR,
      tools: t,
      stop: async () => {},
    });
    expect(result.killedPids).toEqual([63832]);
    expect(t.kill).toHaveBeenCalledWith(63832);
    expect(t.kill).toHaveBeenCalledTimes(1);
  });

  it("kills nothing when the stop did its job", async () => {
    const t = tools({ list: async () => [postmaster(), worker(51128, "io_worker")] });
    const result = await stopEmbeddedPostgresCompletely({
      dataDir: DATA_DIR,
      tools: t,
      stop: async () => {},
    });
    expect(result.killedPids).toEqual([]);
    expect(t.kill).not.toHaveBeenCalled();
  });

  it("still stops the database when the machine will not list processes", async () => {
    // Shutting down matters more than tidying up after it.
    const stop = vi.fn(async () => {});
    const t = tools({
      list: async () => {
        throw new Error("powershell is not available");
      },
    });
    await expect(
      stopEmbeddedPostgresCompletely({ dataDir: DATA_DIR, tools: t, stop }),
    ).resolves.toEqual({ killedPids: [] });
    expect(stop).toHaveBeenCalled();
  });

  it("lets a failing stop surface, so shutdown can log it", async () => {
    const t = tools({ list: async () => [postmaster()] });
    await expect(
      stopEmbeddedPostgresCompletely({
        dataDir: DATA_DIR,
        tools: t,
        stop: async () => {
          throw new Error("taskkill failed");
        },
      }),
    ).rejects.toThrow("taskkill failed");
  });
});

describe("sweepStaleEmbeddedPostgres", () => {
  it("clears the orphan that is holding the cluster", async () => {
    const t = tools({ list: async () => [worker(63832, "io_worker")] });
    const result = await sweepStaleEmbeddedPostgres({ dataDir: DATA_DIR, tools: t });
    expect(result.killedPids).toEqual([63832]);
    expect(t.kill).toHaveBeenCalledWith(63832);
  });

  it("clears a postmaster still sitting on our data directory", async () => {
    const t = tools({ list: async () => [postmaster(), worker(51128, "io_worker")] });
    const result = await sweepStaleEmbeddedPostgres({ dataDir: DATA_DIR, tools: t });
    expect(result.killedPids).toEqual([19624, 51128]);
  });

  it("counts a process once even when it is both ours and an orphan", async () => {
    const t = tools({ list: async () => [postmaster({ parentPid: 999 })] });
    const result = await sweepStaleEmbeddedPostgres({ dataDir: DATA_DIR, tools: t });
    expect(result.killedPids).toEqual([19624]);
    expect(t.kill).toHaveBeenCalledTimes(1);
  });

  it("leaves another instance's healthy cluster running", async () => {
    // Two paperclip instances share a machine during testing. Ours failing to
    // start is no reason to take the other one down.
    const other = postmaster({
      pid: 900,
      parentPid: 8000,
      commandLine: `${BIN} -D C:\\Users\\barry\\.paperclip\\instances\\verify\\db -p 54330`,
    });
    const t = tools({
      list: async () => [other, worker(901, "io_worker", 900)],
      isAlive: (pid) => pid === 8000,
    });
    const result = await sweepStaleEmbeddedPostgres({ dataDir: DATA_DIR, tools: t });
    expect(result.killedPids).toEqual([]);
    expect(t.kill).not.toHaveBeenCalled();
  });

  it("reports nothing to kill so the caller can say so plainly", async () => {
    // The caller turns an empty sweep into an error that names the real
    // situation, rather than retrying a start that cannot succeed.
    const t = tools({ list: async () => [] });
    await expect(sweepStaleEmbeddedPostgres({ dataDir: DATA_DIR, tools: t })).resolves.toEqual({
      killedPids: [],
    });
    expect(t.kill).not.toHaveBeenCalled();
  });
});
