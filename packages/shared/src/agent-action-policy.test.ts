import { describe, expect, it } from "vitest";
import {
  AGENT_ACTION_MODES,
  AGENT_ACTION_TYPES,
} from "./constants.js";
import {
  AGENT_ACTION_TYPE_DESCRIPTIONS,
  AGENT_ACTION_TYPE_LABELS,
} from "./agent-action-policy.js";
import {
  patchAgentActionPolicyOverrideSchema,
  patchCompanyActionPolicySchema,
} from "./validators/agent-action-policy.js";
import { createAgentSchema } from "./validators/agent.js";
import {
  pluginOperationDeclarationSchema,
  pluginToolDeclarationSchema,
} from "./validators/plugin.js";

describe("agent action policy contract", () => {
  it("defines the exact action types and modes", () => {
    expect(AGENT_ACTION_TYPES).toEqual([
      "send_message",
      "move_money",
      "change_files",
      "post_publicly",
      "change_knowledge_base",
    ]);
    expect(AGENT_ACTION_MODES).toEqual(["ask_first", "go_ahead"]);
  });

  it("provides a label and description for every action type", () => {
    expect(Object.keys(AGENT_ACTION_TYPE_LABELS)).toEqual([...AGENT_ACTION_TYPES]);
    expect(Object.keys(AGENT_ACTION_TYPE_DESCRIPTIONS)).toEqual([...AGENT_ACTION_TYPES]);
    for (const actionType of AGENT_ACTION_TYPES) {
      expect(AGENT_ACTION_TYPE_LABELS[actionType].length).toBeGreaterThan(0);
      expect(AGENT_ACTION_TYPE_DESCRIPTIONS[actionType].length).toBeGreaterThan(0);
    }
  });

  it("strictly validates company patches", () => {
    expect(patchCompanyActionPolicySchema.safeParse({ actionType: "send_message", mode: "ask_first" }).success).toBe(true);
    expect(patchCompanyActionPolicySchema.safeParse({ actionType: "send_message", mode: null }).success).toBe(false);
    expect(patchCompanyActionPolicySchema.safeParse({ actionType: "send_message", mode: "ask_first", extra: true }).success).toBe(false);
  });

  it("accepts null only for an agent override patch", () => {
    expect(patchAgentActionPolicyOverrideSchema.safeParse({ actionType: "move_money", mode: null }).success).toBe(true);
    expect(patchAgentActionPolicyOverrideSchema.safeParse({ actionType: "unknown", mode: "go_ahead" }).success).toBe(false);
    expect(patchAgentActionPolicyOverrideSchema.safeParse({ actionType: "move_money", mode: null, extra: true }).success).toBe(false);
  });

  it("keeps action modes out of unaudited agent creation", () => {
    expect(createAgentSchema.safeParse({
      name: "Publisher",
      permissions: { actionApprovalModes: { post_publicly: "go_ahead" } },
    }).success).toBe(false);
  });
});

describe("plugin action type metadata", () => {
  const tool = {
    name: "send",
    displayName: "Send",
    description: "Send a message",
    parametersSchema: {},
  };
  const operation = {
    key: "send",
    displayName: "Send",
    description: "Send a message",
    parametersSchema: {},
  };

  it("accepts every action type on tool and operation declarations", () => {
    for (const actionType of AGENT_ACTION_TYPES) {
      expect(pluginToolDeclarationSchema.safeParse({ ...tool, actionType }).success).toBe(true);
      expect(pluginOperationDeclarationSchema.safeParse({ ...operation, actionType }).success).toBe(true);
    }
  });

  it("rejects unknown action types", () => {
    expect(pluginToolDeclarationSchema.safeParse({ ...tool, actionType: "unknown" }).success).toBe(false);
    expect(pluginOperationDeclarationSchema.safeParse({ ...operation, actionType: "unknown" }).success).toBe(false);
  });
});
