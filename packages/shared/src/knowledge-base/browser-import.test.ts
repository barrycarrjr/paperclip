import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("browser shared note helpers", () => {
  it("bundles the public shared entry and runs without process, Buffer or Node builtins", async () => {
    const bundle = await build({
      stdin: {
        contents: `import * as shared from "./index.ts";
          globalThis.result = {
            exported: Object.keys(shared),
            header: shared.validateMemoryFileHeader("---\\nname: Example\\nkind: reference\\nupdated: 2026-10-14\\n---\\nBody"),
            references: shared.documentReferences("[Example](target.md) (Drive-ID: FakeIdentity_123)"),
            identity: shared.driveIdFromUrl("https://drive.google.com/file/d/FakeIdentity_123/view"),
            declared: shared.declaredDriveFileId({drive_file_id: "FakeIdentity_123"}),
            target: shared.relativeDocumentTarget("areas/note.md", "target", true, new Map([["areas/target.md", "areas/target.md"]])),
            link: shared.documentLink("Example", "areas/note.md", "target.md", "FakeIdentity_123"),
          };`,
        resolveDir: fileURLToPath(new URL("../", import.meta.url)), loader: "ts",
      },
      platform: "browser", bundle: true, format: "iife", write: false, metafile: true,
    });
    expect(bundle.errors).toEqual([]);
    expect(Object.keys(bundle.metafile!.inputs).some(file => file.startsWith("node:"))).toBe(false);
    const sandbox: { result?: unknown; URL: typeof URL } = { URL };
    runInNewContext(bundle.outputFiles[0]!.text, sandbox, { timeout: 5000 });
    const result = JSON.parse(JSON.stringify(sandbox.result));
    expect(result.exported).toEqual(expect.arrayContaining(["validateMemoryFileHeader", "documentReferences", "driveIdFromUrl", "relativeDocumentTarget", "documentPath", "documentLink"]));
    expect(result.header.valid).toBe(true);
    expect(result.header.updated).toBe("2026-10-14T00:00:00.000Z");
    expect(result.references[0].driveFileId).toBe("FakeIdentity_123");
    expect(result.identity).toBe("FakeIdentity_123");
    expect(result.declared).toEqual({ id: "FakeIdentity_123", problem: null });
    expect(result.target).toEqual({ resolved: "areas/target.md", valid: true });
    expect(result.link).toBe("[Example](../target.md) (Drive-ID: FakeIdentity_123)");
  });
});
