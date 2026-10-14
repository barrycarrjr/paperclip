// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ClaudeLocalAdvancedFields } from "./config-fields";
import type { AdapterConfigFieldsProps } from "../types";
import { defaultCreateValues } from "../../components/agent-config-defaults";
import { buildClaudeLocalConfig } from "@paperclipai/adapter-claude-local/ui";
import { buildAgentUpdatePatch } from "../../lib/agent-config-patch";
import type { Agent } from "@paperclipai/shared";

vi.mock("../../components/RunPermissionDefaults", () => ({ RunPermissionField: () => null }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

function renderFields(config: Record<string, unknown>, overrides: Partial<AdapterConfigFieldsProps> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const mark = vi.fn();
  const props: AdapterConfigFieldsProps = {
    mode: "edit", isCreate: false, adapterType: "claude_local",
    values: null, set: null, config, models: [], mark,
    eff: (_group, _field, original) => original,
    ...overrides,
  };
  act(() => root.render(<TooltipProvider><ClaudeLocalAdvancedFields {...props} /></TooltipProvider>));
  return { container, input: container.querySelector<HTMLInputElement>('input[type="number"]')!, advisor: container.querySelector<HTMLInputElement>('input[aria-label="Advisor model"]')!, mark };
}

function enter(input: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Claude run turn cap editing", () => {
  it.each([0, 1000])("shows the saved cap %s unchanged", (maxTurnsPerRun) => {
    const { input, mark } = renderFields({ maxTurnsPerRun });
    expect(input.value).toBe(String(maxTurnsPerRun));
    expect(mark).not.toHaveBeenCalled();
  });

  it("shows the shared default when a cap is missing and allows explicit zero", () => {
    const { input, mark } = renderFields({});
    expect(input.value).toBe("100");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "0");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(mark).toHaveBeenCalledWith("adapterConfig", "maxTurnsPerRun", 0);
  });
});

describe("Claude optional advisor editing and creation", () => {
  it("shows no advisor for a new agent and saves an explicit selection through the real config builder", () => {
    const values = { ...defaultCreateValues, model: "light-main-model" };
    const set = vi.fn((patch) => Object.assign(values, patch));
    const { advisor } = renderFields({}, { isCreate: true, mode: "create", values, set });
    expect(advisor.value).toBe("");
    expect(set).not.toHaveBeenCalled();
    expect(buildClaudeLocalConfig(values)).not.toHaveProperty("advisorModel");
    enter(advisor, "  opus  ");
    expect(set).toHaveBeenCalledWith({ advisorModel: "opus" });
    expect(buildClaudeLocalConfig(values)).toMatchObject({ model: "light-main-model", advisorModel: "opus", timeoutSec: 300, maxTurnsPerRun: 100 });
  });

  it("displays a saved advisor unchanged without marking config dirty", () => {
    const { advisor, mark } = renderFields({ advisorModel: "provider/strong-model", model: "light-main-model" });
    expect(advisor.value).toBe("provider/strong-model");
    expect(advisor.maxLength).toBe(200);
    expect(mark).not.toHaveBeenCalled();
  });

  it("writes the edited advisor separately and clearing it removes only that saved field", () => {
    const config = { advisorModel: "opus", model: "light-main-model", timeoutSec: 99 };
    const { advisor, mark } = renderFields(config);
    enter(advisor, "  provider/stronger-model  ");
    expect(mark).toHaveBeenLastCalledWith("adapterConfig", "advisorModel", "provider/stronger-model");
    enter(advisor, "  ");
    expect(mark).toHaveBeenLastCalledWith("adapterConfig", "advisorModel", undefined);
    const patch = buildAgentUpdatePatch({ adapterConfig: config } as unknown as Agent, {
      identity: {}, adapterConfig: { advisorModel: mark.mock.calls.at(-1)![2] }, heartbeat: {}, runtime: {},
    });
    expect(patch.adapterConfig).toEqual({ model: "light-main-model", timeoutSec: 99 });
    expect(config.advisorModel).toBe("opus");
  });

  it("uses the effective edited advisor instead of the saved value", () => {
    const { advisor } = renderFields({ advisorModel: "saved-advisor" }, {
      eff: (_group, field, original) => field === "advisorModel" ? "draft-advisor" as typeof original : original,
    });
    expect(advisor.value).toBe("draft-advisor");
  });
});
