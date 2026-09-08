import { describe, it, expect } from "vitest";
import type { PluginToolDeclaration } from "@paperclipai/shared";
import type { JsonSchemaNode } from "@/components/JsonSchemaForm";
import {
  humanizeToolName,
  resolvePluginCompanyAccess,
  splitToolDescription,
  summarizePluginTools,
} from "./plugin-tool-summary";

const tool = (over: Partial<PluginToolDeclaration>): PluginToolDeclaration => ({
  name: "slack_send_dm",
  displayName: "Send Slack DM",
  description: "Send a direct message to a Slack user.",
  parametersSchema: { type: "object" },
  ...over,
});

describe("splitToolDescription", () => {
  it("keeps the first sentence as the summary and holds the rest back", () => {
    const { summary, detail } = splitToolDescription(
      "Edit a message previously sent by the bot. Useful for status messages. Gated by allowMutations.",
    );
    expect(summary).toBe("Edit a message previously sent by the bot.");
    expect(detail).toBe("Useful for status messages. Gated by allowMutations.");
  });

  it("does not cut a sentence short at an abbreviation", () => {
    const { summary } = splitToolDescription(
      "Search messages using Slack syntax, e.g. in:#channel or from:@user. Requires a user token.",
    );
    expect(summary).toBe("Search messages using Slack syntax, e.g. in:#channel or from:@user.");
  });

  it("removes the markdown an author used so it does not show as punctuation", () => {
    const { summary, detail } = splitToolDescription(
      "List Slack channels. **Requires user token** and returns `id` per channel.",
    );
    expect(summary).toBe("List Slack channels.");
    expect(detail).toBe("Requires user token and returns id per channel.");
  });

  it("flattens line breaks into one readable line", () => {
    const { summary } = splitToolDescription("Print plain text\n   to a Windows printer.");
    expect(summary).toBe("Print plain text to a Windows printer.");
  });

  it("uses the whole text when the author wrote no full stop", () => {
    const { summary, detail } = splitToolDescription("Return every printer we can see");
    expect(summary).toBe("Return every printer we can see");
    expect(detail).toBe("");
  });

  it("returns nothing for an empty description", () => {
    expect(splitToolDescription("")).toEqual({ summary: "", detail: "" });
  });
});

describe("humanizeToolName", () => {
  it("turns an underscored tool name into words", () => {
    expect(humanizeToolName("slack_send_dm")).toBe("Slack send dm");
  });

  it("handles hyphens and dots the same way", () => {
    expect(humanizeToolName("search-issues.fast")).toBe("Search issues fast");
  });
});

describe("summarizePluginTools", () => {
  it("leads with the display name the add-on gave, not the tool name", () => {
    const [first] = summarizePluginTools([tool({})]);
    expect(first.title).toBe("Send Slack DM");
    expect(first.name).toBe("slack_send_dm");
    expect(first.summary).toBe("Send a direct message to a Slack user.");
  });

  it("falls back to the tool name when no display name was given", () => {
    const [first] = summarizePluginTools([tool({ displayName: "   " })]);
    expect(first.title).toBe("Slack send dm");
  });

  it("returns an empty list for an add-on that contributes no tools", () => {
    expect(summarizePluginTools(undefined)).toEqual([]);
    expect(summarizePluginTools([])).toEqual([]);
  });

  it("skips a malformed entry rather than rendering a blank row", () => {
    const tools = [tool({}), { name: "" }] as PluginToolDeclaration[];
    expect(summarizePluginTools(tools)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Company scoping
// ---------------------------------------------------------------------------

const COMPANY = "9fdeeed5-6379-479e-8f21-77e68cfd3b79";
const OTHER_COMPANY = "7af16a88-e5fc-4766-a89a-dbdd17999242";

/** The shape print-tools uses: one allow list at the top of its settings. */
const topLevelSchema: JsonSchemaNode = {
  type: "object",
  properties: {
    defaultPrinter: { type: "string" },
    allowedCompanies: { type: "array", items: { type: "string", format: "company-id" } },
  },
};

/** The shape slack-tools uses: one allow list per connected workspace. */
const perAccountSchema: JsonSchemaNode = {
  type: "object",
  properties: {
    workspaces: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          allowedCompanies: { type: "array", items: { type: "string", format: "company-id" } },
        },
      },
    },
  },
};

describe("resolvePluginCompanyAccess", () => {
  it("treats an add-on that names no companies as available everywhere", () => {
    const schema: JsonSchemaNode = { type: "object", properties: { apiKey: { type: "string" } } };
    expect(resolvePluginCompanyAccess(schema, {}, COMPANY)).toEqual({
      scoped: false,
      configured: true,
      allowed: true,
    });
  });

  it("treats an add-on with no settings schema at all as available everywhere", () => {
    expect(resolvePluginCompanyAccess(undefined, undefined, COMPANY).allowed).toBe(true);
  });

  it("allows the company named in a top-level list", () => {
    const access = resolvePluginCompanyAccess(
      topLevelSchema,
      { allowedCompanies: [COMPANY] },
      COMPANY,
    );
    expect(access).toEqual({ scoped: true, configured: true, allowed: true });
  });

  it("refuses a company that is not on the list", () => {
    const access = resolvePluginCompanyAccess(
      topLevelSchema,
      { allowedCompanies: [OTHER_COMPANY] },
      COMPANY,
    );
    expect(access).toEqual({ scoped: true, configured: true, allowed: false });
  });

  it("reads a star as every company", () => {
    const access = resolvePluginCompanyAccess(topLevelSchema, { allowedCompanies: ["*"] }, COMPANY);
    expect(access.allowed).toBe(true);
  });

  it("reports an empty list as set up for nobody", () => {
    const access = resolvePluginCompanyAccess(topLevelSchema, { allowedCompanies: [] }, COMPANY);
    expect(access).toEqual({ scoped: true, configured: false, allowed: false });
  });

  it("still counts the add-on as scoped when nothing has been saved yet", () => {
    const access = resolvePluginCompanyAccess(perAccountSchema, {}, COMPANY);
    expect(access).toEqual({ scoped: true, configured: false, allowed: false });
  });

  it("allows the company when any one connected account covers it", () => {
    const settings = {
      workspaces: [
        { key: "main", allowedCompanies: [OTHER_COMPANY] },
        { key: "carr-rock", allowedCompanies: [COMPANY] },
      ],
    };
    const access = resolvePluginCompanyAccess(perAccountSchema, settings, COMPANY);
    expect(access).toEqual({ scoped: true, configured: true, allowed: true });
  });

  it("refuses when every connected account serves somebody else", () => {
    const settings = { workspaces: [{ key: "main", allowedCompanies: [OTHER_COMPANY] }] };
    const access = resolvePluginCompanyAccess(perAccountSchema, settings, COMPANY);
    expect(access).toEqual({ scoped: true, configured: true, allowed: false });
  });

  it("ignores a single company field that is not an allow list", () => {
    const schema: JsonSchemaNode = {
      type: "object",
      properties: { alertOnFailureToCompanyId: { type: "string", format: "company-id" } },
    };
    const access = resolvePluginCompanyAccess(schema, { alertOnFailureToCompanyId: COMPANY }, COMPANY);
    expect(access.scoped).toBe(false);
  });

  it("does not claim access when no company is selected", () => {
    const access = resolvePluginCompanyAccess(
      topLevelSchema,
      { allowedCompanies: ["*"] },
      undefined,
    );
    expect(access.allowed).toBe(false);
  });
});
