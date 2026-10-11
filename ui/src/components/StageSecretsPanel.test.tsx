// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CompanySecret } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StageSecretsPanel, type StageSecretsPanelProps } from "./StageSecretsPanel";

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    className,
  }: {
    children: React.ReactNode;
    to: string;
    className?: string;
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const secret: CompanySecret = {
  id: "secret-1",
  companyId: "company-1",
  name: "DEPLOY_TOKEN",
  provider: "local_encrypted",
  externalRef: null,
  latestVersion: 1,
  description: null,
  createdByAgentId: null,
  createdByUserId: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

function props(overrides: Partial<StageSecretsPanelProps> = {}): StageSecretsPanelProps {
  return {
    hasAutomation: true,
    agentName: null,
    secrets: [secret],
    secretsLoading: false,
    value: { DEPLOY_TOKEN: { type: "secret_ref", secretId: "secret-1", version: "latest" } },
    onChange: vi.fn(),
    onCreateSecret: vi.fn(),
    onSetupAutomation: vi.fn(),
    onSave: vi.fn(),
    saving: false,
    dirty: true,
    ...overrides,
  };
}

function saveButton(container: HTMLElement) {
  return Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Save secrets") || button.textContent?.includes("Saving"),
  ) as HTMLButtonElement;
}

describe("StageSecretsPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("keeps Save secrets off while another save on the stage is running, then lets it through", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<StageSecretsPanel {...props({ otherSavePending: true })} />);
    });

    // The stage is saving, not the secrets: the button keeps its own label
    // and the unsaved secrets are still shown as unsaved.
    expect(saveButton(container).disabled).toBe(true);
    expect(saveButton(container).textContent).toContain("Save secrets");
    expect(container.textContent).toContain("Unsaved changes");

    await act(async () => {
      root.render(<StageSecretsPanel {...props({ otherSavePending: false })} />);
    });

    expect(saveButton(container).disabled).toBe(false);
  });
});
