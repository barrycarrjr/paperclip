// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ClaudeLocalAdvancedFields } from "./config-fields";
import type { AdapterConfigFieldsProps } from "../types";

vi.mock("../../components/RunPermissionDefaults", () => ({ RunPermissionField: () => null }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

function renderFields(config: Record<string, unknown>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const mark = vi.fn();
  const props: AdapterConfigFieldsProps = {
    mode: "edit", isCreate: false, adapterType: "claude_local",
    values: null, set: null, config, models: [], mark,
    eff: (_group, _field, original) => original,
  };
  act(() => root.render(<TooltipProvider><ClaudeLocalAdvancedFields {...props} /></TooltipProvider>));
  return { input: container.querySelector<HTMLInputElement>('input[type="number"]')!, mark };
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
