// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";

vi.mock("@/lib/router", () => ({
  useParams: () => ({ companyPrefix: "ACME", pluginId: "plugin-1" }),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate" data-to={to} />,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "company-1", name: "Acme Printing" },
    selectedCompanyId: "company-1",
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/plugins/slots", () => ({
  usePluginSlots: () => ({ slots: [] }),
  PluginSlotMount: () => <div data-testid="slot-mount" />,
}));

vi.mock("@/components/PageTabBar", () => ({
  PageTabBar: ({
    items,
    onValueChange,
  }: {
    items: { value: string; label: ReactNode }[];
    onValueChange?: (value: string) => void;
  }) => (
    <div>
      {items.map((item) => (
        <button key={item.value} data-testid={`tab-${item.value}`} onClick={() => onValueChange?.(item.value)}>
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// A stand-in form: shows the values it was given, and one button that edits them.
vi.mock("@/components/JsonSchemaForm", () => ({
  JsonSchemaForm: ({
    values,
    onChange,
    disabled,
  }: {
    values: Record<string, unknown>;
    onChange: (next: Record<string, unknown>) => void;
    disabled?: boolean;
  }) => (
    <div data-testid="config-form" data-disabled={disabled ? "true" : "false"}>
      <output data-testid="config-values">{JSON.stringify(values)}</output>
      <button
        type="button"
        data-testid="edit-config"
        disabled={disabled}
        onClick={() => onChange({ ...values, pollMinutes: 10 })}
      >
        Edit
      </button>
    </div>
  ),
  validateJsonSchemaForm: () => ({}),
  getDefaultValues: () => ({}),
}));

const loadedCopy: { value: Record<string, unknown> | null } = { value: null };
const saveConfig = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("@/api/plugins", () => ({
  pluginsApi: {
    get: async () => ({
      id: "plugin-1",
      pluginKey: "email-tools",
      packageName: "@paperclipai/email-tools",
      version: "1.0.0",
      status: "ready",
      categories: [],
      lastError: null,
      manifestJson: {
        displayName: "Email Tools",
        version: "1.0.0",
        author: "Paperclip",
        description: "Mailboxes for agents.",
        capabilities: [],
        instanceConfigSchema: { type: "object", properties: { pollMinutes: { type: "number" } } },
      },
    }),
    health: async () => null,
    dashboard: async () => null,
    logs: async () => [],
    getConfig: async () => loadedCopy.value,
    saveConfig,
    testConfig: async () => ({}),
  },
}));

vi.mock("@/api/secrets", () => ({ secretsApi: { list: async () => [] } }));
vi.mock("@/api/companies", () => ({ companiesApi: { list: async () => [] } }));

const { PluginSettings } = await import("./PluginSettings");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const MEMBER_COVERAGE = { companyIds: ["company-1"], admin: false };
const ADMIN_COVERAGE = { companyIds: ["company-1", "company-2"], admin: true };

function copy(configJson: Record<string, unknown>, extra: Record<string, unknown>) {
  return { id: "config-1", pluginId: "plugin-1", configJson, lastError: null, ...extra };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("PluginSettings: saving a copy of the config", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  async function openConfiguration() {
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PluginSettings />
        </QueryClientProvider>,
      );
    });
    await settle();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="tab-configuration"]')?.click();
    });
    await settle();
  }

  /** The server hands out a different copy, and the page fetches it again. */
  async function serverNowSends(next: Record<string, unknown>) {
    loadedCopy.value = next;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.plugins.config("plugin-1") });
    });
    await settle();
  }

  function shownValues() {
    return container.querySelector('[data-testid="config-values"]')?.textContent;
  }

  function saveButton() {
    return Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Save Configuration",
    );
  }

  async function edit() {
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="edit-config"]')?.click();
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    saveConfig.mockClear();
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
  });

  it("shows a copy the person cannot save read-only, with no way to save it", async () => {
    loadedCopy.value = copy({ pollMinutes: 5 }, { editable: false, trimmed: true, coverage: MEMBER_COVERAGE });
    await openConfiguration();

    expect(container.querySelector('[data-testid="config-form"]')?.getAttribute("data-disabled")).toBe("true");
    expect(saveButton()).toBeUndefined();
    expect(container.textContent).toContain("Only an instance admin can change these settings.");
  });

  it("starts again from a copy that can be saved, carrying nothing over from one that could not", async () => {
    loadedCopy.value = copy({ pollMinutes: 5 }, { editable: false, trimmed: true, coverage: MEMBER_COVERAGE });
    await openConfiguration();
    await edit();

    // Made an instance admin: the next copy holds more, and can be saved.
    await serverNowSends(copy({ pollMinutes: 7 }, { editable: true, trimmed: false, coverage: null }));

    expect(shownValues()).toBe(JSON.stringify({ pollMinutes: 7 }));
    expect(saveButton()).toBeDefined();
  });

  it("edits a copy that can be saved as that copy, even when it looks like the read-only one before it", async () => {
    loadedCopy.value = copy({ pollMinutes: 5 }, { editable: false, trimmed: false, coverage: MEMBER_COVERAGE });
    await openConfiguration();

    await serverNowSends(copy({ pollMinutes: 5 }, { editable: true, trimmed: false, coverage: ADMIN_COVERAGE }));
    await edit();
    await act(async () => {
      saveButton()?.click();
    });
    await settle();

    expect(saveConfig).toHaveBeenCalledWith("plugin-1", { pollMinutes: 10 }, ADMIN_COVERAGE);
  });

  it("saves with the coverage of the copy that was edited, even when a fuller copy has arrived since", async () => {
    loadedCopy.value = copy({ pollMinutes: 5 }, { editable: true, trimmed: true, coverage: ADMIN_COVERAGE });
    await openConfiguration();
    await edit();

    await serverNowSends(copy({ pollMinutes: 5, digest: true }, { editable: true, trimmed: false, coverage: null }));
    await act(async () => {
      saveButton()?.click();
    });
    await settle();

    expect(saveConfig).toHaveBeenCalledWith("plugin-1", { pollMinutes: 10 }, ADMIN_COVERAGE);
  });

  it("tells an admin that other people's Personal settings are left out and kept", async () => {
    loadedCopy.value = copy({ pollMinutes: 5 }, { editable: true, trimmed: true, coverage: ADMIN_COVERAGE });
    await openConfiguration();

    expect(container.querySelector('[data-testid="config-form"]')?.getAttribute("data-disabled")).toBe("false");
    expect(container.textContent).toContain(
      "Settings for other people's Personal companies are left out. Saving keeps them as they are.",
    );
  });
});
