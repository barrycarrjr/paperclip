// @vitest-environment jsdom

/**
 * The plugin manager's approval dialog says in words what the capabilities
 * that reach the whole instance allow, instead of a bare name, and it is the
 * dialog a first install now gets as well as an upgrade.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilityApprovalDialog } from "./PluginManager";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function details(escalated: string[], previousCapabilities: string[] = []) {
  return {
    code: "capability_escalation" as const,
    error: "approval needed",
    escalated,
    previousCapabilities,
    nextCapabilities: [...previousCapabilities, ...escalated],
  };
}

function show(escalated: string[], installedVersion: string | null, previous: string[] = []) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <CapabilityApprovalDialog
        prompt={{ pluginKey: "backup-tools", details: details(escalated, previous) }}
        unifiedRows={[
          {
            pluginKey: "backup-tools",
            displayName: "Backups",
            libraryEntry: { version: "0.1.33" },
            installedPlugin: installedVersion ? ({ version: installedVersion } as never) : null,
          },
        ]}
        isPending={false}
        onCancel={() => {}}
        onApprove={() => {}}
      />,
    );
  });
  return document.body.textContent ?? "";
}

describe("CapabilityApprovalDialog", () => {
  it("asks before a first install and says what each database capability can do", () => {
    const text = show(["system.snapshot.read", "system.snapshot.restore"], null);

    expect(text).toContain("asks for capabilities that need your approval before it is installed");
    expect(text).toContain("Can copy this instance's whole database, every company's data included.");
    expect(text).toContain("Can replace this instance's whole database.");
    expect(text).toContain("Approve & install");
  });

  it("puts the sentence beside a capability an upgrade adds", () => {
    const text = show(["system.snapshot.restore"], "0.1.32", ["system.snapshot.read"]);

    expect(text).toContain("system.snapshot.restore");
    expect(text).toContain("Can replace this instance's whole database.");
    expect(text).toContain("Approve & upgrade");
  });
});
