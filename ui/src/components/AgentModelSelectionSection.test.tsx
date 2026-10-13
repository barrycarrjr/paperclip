// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentModelSelection } from "@paperclipai/shared";
import { AgentModelSelectionSection } from "./AgentModelSelectionSection";
import { TooltipProvider } from "./ui/tooltip";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const START: AgentModelSelection = {
  enabled: true,
  allowedModels: ["light-model", "strong-model"],
  rules: [{ labels: [], priorities: [], model: "light-model" }],
  fallbackModel: null,
};

function setInputValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
}

describe("AgentModelSelectionSection", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: AgentModelSelection;

  function Host() {
    const [value, setValue] = useState(START);
    latest = value;
    return (
      <AgentModelSelectionSection
        value={value}
        onChange={(apply) => setValue(apply)}
        models={[]}
        agentModel="light-model"
        labelNames={[]}
      />
    );
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <TooltipProvider>
          <Host />
        </TooltipProvider>,
      ),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps labels typed into a rule when its model changes in the same moment", () => {
    const rule = container.querySelector('[data-testid="agent-model-selection-rule-0"]')!;
    const labelsInput = rule.querySelector("input")!;
    const modelSelect = rule.querySelector("select")!;

    act(() => {
      setInputValue(labelsInput, "legal");
      labelsInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      labelsInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      setInputValue(modelSelect, "strong-model");
      modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(latest.rules[0]).toEqual({ labels: ["legal"], priorities: [], model: "strong-model" });
  });
});
