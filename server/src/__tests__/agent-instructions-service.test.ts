import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentInstructionsBundleMode, agentInstructionsService } from "../services/agent-instructions.js";

type TestAgent = {
  id: string;
  companyId: string;
  name: string;
  adapterConfig: Record<string, unknown>;
};

async function makeTempDir(prefix: string) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeAgent(adapterConfig: Record<string, unknown>): TestAgent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Agent 1",
    adapterConfig,
  };
}

describe("agent instructions service", () => {
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;

    await Promise.all([...cleanupDirs].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }));
  });

  function managedRootUnder(paperclipHome: string) {
    return path.join(paperclipHome, "instances", "test-instance", "companies", "company-1", "agents", "agent-1", "instructions");
  }

  function bundleAt(mode: string, rootPath: string) {
    return makeAgent({
      instructionsBundleMode: mode,
      instructionsRootPath: rootPath,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(rootPath, "AGENTS.md"),
    });
  }

  async function managedReadFixture() {
    const paperclipHome = await makeTempDir("paperclip-instructions-safe-read-");
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    const root = managedRootUnder(paperclipHome);
    const outside = path.join(paperclipHome, "private-other-company");
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(path.join(root, "AGENTS.md"), "Core instructions.");
    await fs.writeFile(path.join(root, "docs", "checks.md"), "Managed checks.");
    await fs.writeFile(path.join(outside, "AGENTS.md"), "PRIVATE OUTSIDE CONTENT");
    return { paperclipHome, root, outside, agent: bundleAt("managed", root) };
  }

  async function makeLink(target: string, link: string, type: "file" | "junction") {
    try {
      await fs.symlink(target, link, type);
      return true;
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      throw error;
    }
  }

  it("reads ordinary nested managed companions and keeps missing-file errors", async () => {
    const { agent, root } = await managedReadFixture();
    const svc = agentInstructionsService();
    await expect(svc.readFile(agent, "docs/checks.md")).resolves.toMatchObject({ content: "Managed checks.", path: "docs/checks.md" });
    await expect(svc.readFile(agent, "docs/missing.md")).rejects.toMatchObject({ status: 404 });
    // Legacy nested entry paths keep the same actual managed root.
    await expect(svc.readFile(makeAgent({ instructionsFilePath: path.join(root, "docs", "checks.md") }), "docs/checks.md"))
      .resolves.toMatchObject({ content: "Managed checks." });
  });

  it("keeps legitimate instance storage aliases usable", async (ctx) => {
    const { paperclipHome } = await managedReadFixture();
    const aliasParent = await makeTempDir("paperclip-instructions-storage-alias-");
    cleanupDirs.add(aliasParent);
    const aliasHome = path.join(aliasParent, "storage");
    if (!await makeLink(paperclipHome, aliasHome, "junction")) { ctx.skip(); return; }
    process.env.PAPERCLIP_HOME = aliasHome;
    const agent = bundleAt("managed", managedRootUnder(aliasHome));
    await expect(agentInstructionsService().readFile(agent, "docs/checks.md"))
      .resolves.toMatchObject({ content: "Managed checks." });
  });

  it.each(["file", "directory", "root"] as const)("refuses a managed %s link escaping its actual folder", async (kind, ctx) => {
    const { agent, root, outside } = await managedReadFixture();
    let filePath: string;
    let linked: boolean;
    if (kind === "file") {
      linked = await makeLink(path.join(outside, "AGENTS.md"), path.join(root, "private.md"), "file");
      filePath = "private.md";
    } else if (kind === "directory") {
      linked = await makeLink(outside, path.join(root, "references"), "junction");
      filePath = "references/AGENTS.md";
    } else {
      await fs.rename(root, `${root}-original`);
      linked = await makeLink(outside, root, "junction");
      filePath = "AGENTS.md";
    }
    if (!linked) { ctx.skip(); return; }
    await expect(agentInstructionsService().readFile(agent, filePath)).rejects.toMatchObject({
      status: 422, message: "Instructions file path must stay within the bundle root",
    });
  });

  it.each(["file", "directory"] as const)("refuses managed %s links even when their target is inside the folder", async (kind, ctx) => {
    const { agent, root } = await managedReadFixture();
    const linked = kind === "file"
      ? await makeLink(path.join(root, "docs", "checks.md"), path.join(root, "linked.md"), "file")
      : await makeLink(path.join(root, "docs"), path.join(root, "references"), "junction");
    if (!linked) { ctx.skip(); return; }
    await expect(agentInstructionsService().readFile(agent, kind === "file" ? "linked.md" : "references/checks.md"))
      .rejects.toMatchObject({ status: 422, message: "Managed instruction files must not use linked paths" });
  });

  it("refuses a managed companion replaced with a link during open", async (ctx) => {
    const { agent, root, outside } = await managedReadFixture();
    const file = path.join(root, "docs", "checks.md");
    const outsideFile = path.join(outside, "AGENTS.md");
    const probe = path.join(root, "probe.md");
    if (!await makeLink(outsideFile, probe, "file")) { ctx.skip(); return; }
    await fs.unlink(probe);
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) === await fs.realpath(file)) {
        await fs.rename(file, `${file}.original`);
        await fs.symlink(outsideFile, file, "file");
      }
      return open(...args);
    });
    await expect(agentInstructionsService().readFile(agent, "docs/checks.md")).rejects.toMatchObject({
      status: 422, message: "Managed instruction files must not use linked paths",
    });
  });

  it("refuses an ancestor swapped outside before open and restored before final resolution", async (ctx) => {
    const { agent, root, outside } = await managedReadFixture();
    const directory = path.join(root, "docs");
    const savedDirectory = `${directory}-original`;
    const file = await fs.realpath(path.join(directory, "checks.md"));
    await fs.writeFile(path.join(outside, "checks.md"), "OUTSIDE_MARKER");
    const probe = path.join(root, "probe");
    if (!await makeLink(outside, probe, "junction")) { ctx.skip(); return; }
    await fs.unlink(probe);
    const lstat = fs.lstat.bind(fs);
    const open = fs.open.bind(fs);
    let swapped = false;
    let restored = false;
    vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]) === file && !swapped) {
        swapped = true;
        await fs.rename(directory, savedDirectory);
        await fs.symlink(outside, directory, "junction");
      }
      return lstat(...args);
    });
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]) === file && swapped && !restored) {
        await fs.unlink(directory);
        await fs.rename(savedDirectory, directory);
        restored = true;
      }
      return handle;
    });
    await expect(agentInstructionsService().readFile(agent, "docs/checks.md")).rejects.toMatchObject({
      status: 422, message: "Instructions file path must stay within the bundle root",
    });
    expect(swapped).toBe(true);
    expect(restored).toBe(true);
    expect(await fs.readFile(file, "utf8")).toBe("Managed checks.");
  });

  it("preserves explicitly external bundle reads for the route's authorized administrator", async (ctx) => {
    const { root, outside } = await managedReadFixture();
    if (!await makeLink(path.join(root, "docs", "checks.md"), path.join(outside, "linked.md"), "file")) { ctx.skip(); return; }
    await expect(agentInstructionsService().readFile(bundleAt("external", outside), "linked.md"))
      .resolves.toMatchObject({ content: "Managed checks." });
  });

  it("calls a bundle external whenever its folder is outside Paperclip's managed folder", async () => {
    const paperclipHome = path.join(os.tmpdir(), "paperclip-bundle-mode-home");
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    const managedRoot = managedRootUnder(paperclipHome);
    const outsideRoot = path.join(os.tmpdir(), "paperclip-bundle-mode-outside");

    expect(await agentInstructionsBundleMode(bundleAt("managed", managedRoot))).toBe("managed");
    expect(await agentInstructionsBundleMode(bundleAt("external", outsideRoot))).toBe("external");
    expect(await agentInstructionsBundleMode(bundleAt("managed", outsideRoot))).toBe("external");
    expect(await agentInstructionsBundleMode(makeAgent({ instructionsFilePath: path.join(outsideRoot, "AGENTS.md") })))
      .toBe("external");
    expect(await agentInstructionsBundleMode(makeAgent({ instructionsFilePath: path.join(managedRoot, "AGENTS.md") })))
      .toBe("managed");
    expect(await agentInstructionsBundleMode(makeAgent({}))).toBeNull();
  });

  it("calls the managed folder managed when its saved path differs only in letter case, where that is the same folder", async () => {
    const paperclipHome = path.join(os.tmpdir(), "paperclip-bundle-mode-home");
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    // C: becomes c:, Users becomes uSERS, and so on.
    const otherCase = [...managedRootUnder(paperclipHome)]
      .map((char) => (char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase()))
      .join("");

    // Windows ignores letter case in paths. Elsewhere this really is another folder.
    expect(await agentInstructionsBundleMode(bundleAt("managed", otherCase)))
      .toBe(process.platform === "win32" ? "managed" : "external");
  });

  it("calls a managed folder saved before the instance moved managed once the service reads the current one", async () => {
    const oldHome = path.join(os.tmpdir(), "paperclip-bundle-mode-old-home");
    const paperclipHome = await makeTempDir("paperclip-bundle-mode-moved-home-");
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    const agent = bundleAt("managed", managedRootUnder(oldHome));

    // Nothing in the current managed folder: the service reads the saved
    // path, which is outside this instance's storage now.
    expect(await agentInstructionsBundleMode(agent)).toBe("external");

    // With instructions in the current managed folder, the service reads
    // those in its place, so the agent counts as managed.
    const currentRoot = managedRootUnder(paperclipHome);
    await fs.mkdir(currentRoot, { recursive: true });
    await fs.writeFile(path.join(currentRoot, "AGENTS.md"), "# Agent\n", "utf8");
    expect(await agentInstructionsBundleMode(agent)).toBe("managed");
    await expect(agentInstructionsService().readFile(agent, "AGENTS.md")).resolves.toMatchObject({
      content: "# Agent\n",
    });
  });

  it("calls an old-style instructions file in a subfolder of the managed folder managed", async () => {
    const paperclipHome = await makeTempDir("paperclip-bundle-mode-legacy-home-");
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    const managedRoot = managedRootUnder(paperclipHome);
    await fs.mkdir(path.join(managedRoot, "team"), { recursive: true });
    await fs.writeFile(path.join(managedRoot, "team", "AGENTS.md"), "# Team agent\n", "utf8");
    const agent = makeAgent({ instructionsFilePath: path.join(managedRoot, "team", "AGENTS.md") });

    expect(await agentInstructionsBundleMode(agent)).toBe("managed");
    // As upstream: the managed folder stays the root and the file keeps its subfolder.
    const bundle = await agentInstructionsService().getBundle(agent);
    expect(bundle.rootPath).toBe(managedRoot);
    expect(bundle.entryFile).toBe("team/AGENTS.md");
  });

  it("refuses an import writing a file name that leaves the managed folder", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-import-home-");
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    const svc = agentInstructionsService();

    // A company import hands its file names to materializeManagedBundle.
    // Rooted names on this drive come first: without the check they land
    // inside the folder, so the test stops there and never writes elsewhere.
    for (const filePath of [
      "/escape-check.md",
      "\\escape-check.md",
      "\\\\server\\share\\escape-check.md",
      "\\\\?\\C:\\escape-check.md",
      "C:\\Windows\\paperclip-instructions-escape-check.md",
      "E:/paperclip-instructions-escape-check.md",
    ]) {
      await expect(
        svc.materializeManagedBundle(makeAgent({}), { "AGENTS.md": "# Agent\n", [filePath]: "x" }),
        filePath,
      ).rejects.toMatchObject({ status: 422 });
    }
  });

  it("copies the existing bundle into the managed root when switching to managed mode", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-home-");
    const externalRoot = await makeTempDir("paperclip-agent-instructions-external-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(externalRoot);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    await fs.writeFile(path.join(externalRoot, "AGENTS.md"), "# External Agent\n", "utf8");
    await fs.mkdir(path.join(externalRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(externalRoot, "docs", "TOOLS.md"), "## Tools\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "external",
      instructionsRootPath: externalRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(externalRoot, "AGENTS.md"),
    });

    const result = await svc.updateBundle(agent, { mode: "managed" });

    expect(result.bundle.mode).toBe("managed");
    expect(result.bundle.managedRootPath).toBe(
      path.join(
        paperclipHome,
        "instances",
        "test-instance",
        "companies",
        "company-1",
        "agents",
        "agent-1",
        "instructions",
      ),
    );
    expect(result.bundle.files.map((file) => file.path)).toEqual(["AGENTS.md", "docs/TOOLS.md"]);
    await expect(fs.readFile(path.join(result.bundle.managedRootPath, "AGENTS.md"), "utf8")).resolves.toBe("# External Agent\n");
    await expect(fs.readFile(path.join(result.bundle.managedRootPath, "docs", "TOOLS.md"), "utf8")).resolves.toBe("## Tools\n");
  });

  it("creates the target entry file when switching to a new external root", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-home-");
    const managedRoot = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "instructions",
    );
    const externalRoot = await makeTempDir("paperclip-agent-instructions-new-external-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(externalRoot);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Managed Agent\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "managed",
      instructionsRootPath: managedRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(managedRoot, "AGENTS.md"),
    });

    const result = await svc.updateBundle(agent, {
      mode: "external",
      rootPath: externalRoot,
      entryFile: "docs/AGENTS.md",
    });

    expect(result.bundle.mode).toBe("external");
    expect(result.bundle.rootPath).toBe(externalRoot);
    await expect(fs.readFile(path.join(externalRoot, "docs", "AGENTS.md"), "utf8")).resolves.toBe("# Managed Agent\n");
  });

  it("filters junk files, dependency bundles, and python caches from bundle listings and exports", async () => {
    const externalRoot = await makeTempDir("paperclip-agent-instructions-ignore-");
    cleanupDirs.add(externalRoot);

    await fs.writeFile(path.join(externalRoot, "AGENTS.md"), "# External Agent\n", "utf8");
    await fs.writeFile(path.join(externalRoot, ".gitignore"), "node_modules/\n", "utf8");
    await fs.writeFile(path.join(externalRoot, ".DS_Store"), "junk", "utf8");
    await fs.mkdir(path.join(externalRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(externalRoot, "docs", "TOOLS.md"), "## Tools\n", "utf8");
    await fs.writeFile(path.join(externalRoot, "docs", "module.pyc"), "compiled", "utf8");
    await fs.writeFile(path.join(externalRoot, "docs", "._TOOLS.md"), "appledouble", "utf8");
    await fs.mkdir(path.join(externalRoot, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(externalRoot, "node_modules", "pkg", "index.js"), "export {};\n", "utf8");
    await fs.mkdir(path.join(externalRoot, "python", "__pycache__"), { recursive: true });
    await fs.writeFile(
      path.join(externalRoot, "python", "__pycache__", "module.cpython-313.pyc"),
      "compiled",
      "utf8",
    );
    await fs.mkdir(path.join(externalRoot, ".pytest_cache"), { recursive: true });
    await fs.writeFile(path.join(externalRoot, ".pytest_cache", "README.md"), "cache", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "external",
      instructionsRootPath: externalRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(externalRoot, "AGENTS.md"),
    });

    const bundle = await svc.getBundle(agent);
    const exported = await svc.exportFiles(agent);

    expect(bundle.files.map((file) => file.path)).toEqual([".gitignore", "AGENTS.md", "docs/TOOLS.md"]);
    expect(Object.keys(exported.files).sort((left, right) => left.localeCompare(right))).toEqual([
      ".gitignore",
      "AGENTS.md",
      "docs/TOOLS.md",
    ]);
  });

  it("recovers a managed bundle from disk when bundle config metadata is missing", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-recover-");
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    const managedRoot = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "instructions",
    );
    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Recovered Agent\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({});

    const bundle = await svc.getBundle(agent);
    const exported = await svc.exportFiles(agent);

    expect(bundle.mode).toBe("managed");
    expect(bundle.rootPath).toBe(managedRoot);
    expect(bundle.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
    expect(exported.files).toEqual({ "AGENTS.md": "# Recovered Agent\n" });
  });

  it("prefers the managed bundle on disk when managed metadata points at a stale root", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-stale-managed-");
    const staleRoot = await makeTempDir("paperclip-agent-instructions-stale-root-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(staleRoot);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    const managedRoot = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "instructions",
    );
    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Managed Agent\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "managed",
      instructionsRootPath: staleRoot,
      instructionsEntryFile: "docs/MISSING.md",
      instructionsFilePath: path.join(staleRoot, "docs", "MISSING.md"),
    });

    const bundle = await svc.getBundle(agent);
    const exported = await svc.exportFiles(agent);

    expect(bundle.mode).toBe("managed");
    expect(bundle.rootPath).toBe(managedRoot);
    expect(bundle.entryFile).toBe("AGENTS.md");
    expect(bundle.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
    expect(bundle.warnings).toEqual([
      `Recovered managed instructions from disk at ${managedRoot}; ignoring stale configured root ${staleRoot}.`,
      "Recovered managed instructions entry file from disk as AGENTS.md; previous entry docs/MISSING.md was missing.",
    ]);
    expect(exported.files).toEqual({ "AGENTS.md": "# Managed Agent\n" });
  });

  it("heals stale managed metadata when writing bundle files", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-heal-write-");
    const staleRoot = await makeTempDir("paperclip-agent-instructions-heal-write-stale-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(staleRoot);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    const managedRoot = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "instructions",
    );
    await fs.mkdir(path.join(managedRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Managed Agent\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "managed",
      instructionsRootPath: staleRoot,
      instructionsEntryFile: "docs/MISSING.md",
      instructionsFilePath: path.join(staleRoot, "docs", "MISSING.md"),
    });

    const result = await svc.writeFile(agent, "docs/TOOLS.md", "## Tools\n");

    expect(result.adapterConfig).toMatchObject({
      instructionsBundleMode: "managed",
      instructionsRootPath: managedRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(managedRoot, "AGENTS.md"),
    });
    await expect(fs.readFile(path.join(managedRoot, "docs", "TOOLS.md"), "utf8")).resolves.toBe("## Tools\n");
  });

  it("heals stale managed metadata when deleting bundle files", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-heal-delete-");
    const staleRoot = await makeTempDir("paperclip-agent-instructions-heal-delete-stale-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(staleRoot);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    const managedRoot = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "instructions",
    );
    await fs.mkdir(path.join(managedRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Managed Agent\n", "utf8");
    await fs.writeFile(path.join(managedRoot, "docs", "TOOLS.md"), "## Tools\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "managed",
      instructionsRootPath: staleRoot,
      instructionsEntryFile: "docs/MISSING.md",
      instructionsFilePath: path.join(staleRoot, "docs", "MISSING.md"),
    });

    const result = await svc.deleteFile(agent, "docs/TOOLS.md");

    expect(result.adapterConfig).toMatchObject({
      instructionsBundleMode: "managed",
      instructionsRootPath: managedRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(managedRoot, "AGENTS.md"),
    });
    await expect(fs.stat(path.join(managedRoot, "docs", "TOOLS.md"))).rejects.toThrow();
    expect(result.bundle.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
  });

  it("recovers the managed bundle when stale root metadata is present but mode is missing", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-partial-managed-");
    const staleRoot = await makeTempDir("paperclip-agent-instructions-partial-root-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(staleRoot);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    const managedRoot = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "instructions",
    );
    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Managed Agent\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsRootPath: staleRoot,
      instructionsEntryFile: "docs/MISSING.md",
    });

    const bundle = await svc.getBundle(agent);
    const exported = await svc.exportFiles(agent);

    expect(bundle.mode).toBe("managed");
    expect(bundle.rootPath).toBe(managedRoot);
    expect(bundle.entryFile).toBe("AGENTS.md");
    expect(bundle.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
    expect(bundle.warnings).toEqual([
      `Recovered managed instructions from disk at ${managedRoot}; ignoring stale configured root ${staleRoot}.`,
      "Recovered managed instructions entry file from disk as AGENTS.md; previous entry docs/MISSING.md was missing.",
    ]);
    expect(exported.files).toEqual({ "AGENTS.md": "# Managed Agent\n" });
  });
});
