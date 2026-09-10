// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/router", () => ({
  useParams: () => ({ companyPrefix: "ACME", pluginId: "plugin-1" }),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate" data-to={to} />,
}));

const selected: { id: string | null; name: string } = { id: "company-1", name: "Acme Printing" };
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: selected.id, name: selected.name },
    selectedCompanyId: selected.id,
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/plugins/slots", () => ({
  usePluginSlots: () => ({ slots: [] }),
  PluginSlotMount: () => <div data-testid="slot-mount" />,
}));

// The tab strip needs sidebar context we do not care about here. Swap it for
// plain buttons so a test can move to the Configuration tab.
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

vi.mock("@/components/JsonSchemaForm", () => ({
  JsonSchemaForm: () => <div data-testid="config-form" />,
  validateJsonSchemaForm: () => ({}),
  getDefaultValues: () => ({}),
}));

const pluginRecord: { value: Record<string, unknown> } = { value: {} };
const savedConfig: { value: Record<string, unknown> | undefined } = { value: undefined };

vi.mock("@/api/plugins", () => ({
  pluginsApi: {
    get: async () => pluginRecord.value,
    health: async () => null,
    dashboard: async () => null,
    logs: async () => [],
    getConfig: async () => savedConfig.value,
    saveConfig: async () => ({}),
    testConfig: async () => ({}),
  },
}));

vi.mock("@/api/secrets", () => ({ secretsApi: { list: async () => [] } }));
vi.mock("@/api/companies", () => ({ companiesApi: { list: async () => [] } }));

const { PluginSettings } = await import("./PluginSettings");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = "company-1";
const OTHER_COMPANY = "company-2";

const companyAllowList = {
  type: "array",
  items: { type: "string", format: "company-id" },
};

const slackTools = [
  {
    name: "slack_send_dm",
    displayName: "Send Slack DM",
    description:
      "Send a direct message to a Slack user. Defaults the recipient to the workspace's defaultDmTarget so skills can omit userId.",
    parametersSchema: { type: "object" },
  },
  {
    name: "slack_list_channels",
    displayName: "List Slack channels",
    description: "List channels in the workspace, filtered by query.",
    parametersSchema: { type: "object" },
  },
];

function makePlugin(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "plugin-1",
    pluginKey: "slack-tools",
    packageName: "@paperclipai/slack-tools",
    version: "1.0.0",
    status: "ready",
    categories: [],
    lastError: null,
    manifestJson: {
      displayName: "Slack Tools",
      version: "1.0.0",
      author: "Paperclip",
      description: "Slack messaging for agents.",
      capabilities: [],
      tools: slackTools,
      instanceConfigSchema: {
        type: "object",
        properties: { allowedCompanies: companyAllowList },
      },
    },
    ...over,
  };
}

describe("PluginSettings: what an add-on can do", () => {
  let container: HTMLDivElement;

  async function renderConfigurationTab() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PluginSettings />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const tab = container.querySelector<HTMLButtonElement>('[data-testid="tab-configuration"]');
    await act(async () => {
      tab?.click();
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    return root;
  }

  function click(text: string) {
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === text,
    );
    if (!button) throw new Error(`no button labelled "${text}"`);
    return act(async () => {
      button.click();
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    selected.id = COMPANY;
    selected.name = "Acme Printing";
    pluginRecord.value = makePlugin();
    savedConfig.value = { configJson: { allowedCompanies: [COMPANY] } };
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("lists what the add-on's tools do, in the add-on's own words", async () => {
    await renderConfigurationTab();

    expect(container.textContent).toContain("What this add-on can do");
    expect(container.textContent).toContain("2 things your agents can do with Slack Tools");
    expect(container.textContent).toContain("Send Slack DM");
    expect(container.textContent).toContain("Send a direct message to a Slack user.");
    expect(container.textContent).toContain("List Slack channels");
  });

  it("keeps the tool name an agent calls visible for reference", async () => {
    await renderConfigurationTab();
    expect(container.textContent).toContain("slack_send_dm");
  });

  it("holds the agent-facing notes back until asked for", async () => {
    await renderConfigurationTab();
    expect(container.textContent).not.toContain("defaultDmTarget");

    await click("Show the full notes");
    expect(container.textContent).toContain("defaultDmTarget");

    await click("Hide the full notes");
    expect(container.textContent).not.toContain("defaultDmTarget");
  });

  it("says the add-on is set up for the company being viewed", async () => {
    await renderConfigurationTab();
    expect(container.textContent).toContain("Set up for Acme Printing, so agents there can use these.");
  });

  it("warns when the add-on serves other companies and not this one", async () => {
    savedConfig.value = { configJson: { allowedCompanies: [OTHER_COMPANY] } };

    await renderConfigurationTab();

    expect(container.textContent).toContain("Not set up for Acme Printing");
    expect(container.textContent).toContain("serves other companies only");
    // The list is still shown: an operator judging the add-on needs to see
    // what it would do once it is switched on here.
    expect(container.textContent).toContain("Send Slack DM");
  });

  it("warns when nobody has chosen which companies the add-on serves", async () => {
    savedConfig.value = { configJson: { allowedCompanies: [] } };

    await renderConfigurationTab();

    expect(container.textContent).toContain("Not set up for any company yet");
  });

  it("says nothing about companies for an add-on that serves every company", async () => {
    savedConfig.value = { configJson: { allowedCompanies: ["*"] } };

    await renderConfigurationTab();

    expect(container.textContent).not.toContain("Not set up for");
    expect(container.textContent).toContain("Set up for Acme Printing");
  });

  it("says nothing about companies for an add-on with no company list at all", async () => {
    pluginRecord.value = makePlugin({
      manifestJson: {
        ...(makePlugin().manifestJson as Record<string, unknown>),
        instanceConfigSchema: { type: "object", properties: { apiKey: { type: "string" } } },
      },
    });
    savedConfig.value = { configJson: {} };

    await renderConfigurationTab();

    expect(container.textContent).toContain("Send Slack DM");
    expect(container.textContent).not.toContain("Not set up for");
    expect(container.textContent).not.toContain("so agents there can use these");
  });

  it("shows the list for an add-on that has a page of its own as well as tools", async () => {
    // Tool-only add-ons were the reported gap, but an add-on with a page has
    // the same unanswered question about its tools.
    const withPage = makePlugin();
    (withPage.manifestJson as Record<string, unknown>).ui = {
      slots: [{ type: "page", id: "page-1", entry: "index.js" }],
    };
    pluginRecord.value = withPage;

    await renderConfigurationTab();

    expect(container.textContent).toContain("What this add-on can do");
    expect(container.textContent).toContain("Send Slack DM");
  });

  it("shows no heading at all for an add-on that contributes no tools", async () => {
    pluginRecord.value = makePlugin({
      manifestJson: {
        ...(makePlugin().manifestJson as Record<string, unknown>),
        displayName: "Notepad",
        tools: [],
      },
    });

    await renderConfigurationTab();

    expect(container.textContent).not.toContain("What this add-on can do");
  });

  it("counts a single tool in words that read properly", async () => {
    pluginRecord.value = makePlugin({
      manifestJson: {
        ...(makePlugin().manifestJson as Record<string, unknown>),
        tools: [slackTools[0]],
      },
    });

    await renderConfigurationTab();

    expect(container.textContent).toContain("One thing your agents can do with Slack Tools");
  });
});
