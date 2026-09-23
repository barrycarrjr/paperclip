// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelListEntry } from "@paperclipai/shared";
import { SavedModelNotice } from "./SavedModelNotice";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Trimmed from the real codex_local answer.
const MODELS: ModelListEntry[] = [
  { id: "gpt-6-astra", label: "GPT-6-Astra", status: "current", isDefault: true, isNew: true },
  { id: "gpt-6-sol", label: "GPT-6-Sol", status: "current" },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    status: "deprecated",
    retiresAt: "2026-10-14T19:00:00.000Z",
    replacementId: "gpt-5.6-sol",
    notice: "GPT-5.5 retires on October 14, 2026. Switch to GPT-5.6 Sol to continue working in Codex.",
  },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", status: "legacy", replacementId: "gpt-6-sol" },
];

const mounted: Array<{ container: HTMLDivElement; root: Root }> = [];

function render(node: React.ReactNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  act(() => {
    root.render(node);
  });
  return container;
}

function switchButton(el: HTMLElement): HTMLButtonElement | null {
  return [...el.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Switch to")) ?? null;
}

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("SavedModelNotice", () => {
  it("says an older model has been replaced, and switches to the replacement", () => {
    const onSwitch = vi.fn();
    const el = render(<SavedModelNotice models={MODELS} value="gpt-5.6-sol" onSwitch={onSwitch} />);

    expect(el.textContent).toContain("GPT-5.6 Sol has been replaced by GPT-6-Sol.");
    const button = switchButton(el);
    expect(button?.textContent).toBe("Switch to GPT-6-Sol");
    act(() => {
      button?.click();
    });
    expect(onSwitch).toHaveBeenCalledWith("gpt-6-sol");
  });

  it("shows the provider's own notice for a retiring model, and offers the current model its successor leads to", () => {
    const onSwitch = vi.fn();
    const el = render(<SavedModelNotice models={MODELS} value="gpt-5.5" onSwitch={onSwitch} />);

    expect(el.textContent).toContain(MODELS[2].notice!);
    expect(el.querySelector("[data-saved-model-notice]")?.getAttribute("data-saved-model-notice")).toBe("warning");
    act(() => {
      switchButton(el)?.click();
    });
    // Codex names GPT-5.6 Sol, which GPT-6 Sol has since replaced, so the
    // button offers GPT-6 Sol rather than a model that is already older.
    expect(onSwitch).toHaveBeenCalledWith("gpt-6-sol");
  });

  it("says when the provider no longer offers the saved model, and offers the default", () => {
    const onSwitch = vi.fn();
    const el = render(<SavedModelNotice models={MODELS} value="gpt-5.3-codex" onSwitch={onSwitch} />);

    expect(el.textContent).toContain("gpt-5.3-codex is not in the models this provider offers right now.");
    expect(el.querySelector("[data-saved-model-notice]")?.getAttribute("data-saved-model-notice")).toBe("danger");
    act(() => {
      switchButton(el)?.click();
    });
    expect(onSwitch).toHaveBeenCalledWith("gpt-6-astra");
  });

  it("shows the words without a button when there is nothing to call", () => {
    const el = render(<SavedModelNotice models={MODELS} value="gpt-5.3-codex" />);
    expect(el.textContent).toContain("is not in the models");
    expect(switchButton(el)).toBeNull();
  });

  it("makes no suggestion from a list that says nothing about releases or defaults", () => {
    const plain: ModelListEntry[] = [
      { id: "anthropic/claude-sonnet-5", label: "anthropic/claude-sonnet-5" },
      { id: "openai/gpt-6-sol", label: "openai/gpt-6-sol" },
    ];
    const el = render(<SavedModelNotice models={plain} value="openai/gpt-4.1" onSwitch={vi.fn()} />);
    expect(el.textContent).toContain("openai/gpt-4.1 is not in the models this provider offers right now.");
    expect(switchButton(el)).toBeNull();
  });

  it("says nothing for the default, a model that is fine, or a list that has not loaded", () => {
    expect(render(<SavedModelNotice models={MODELS} value="" onSwitch={vi.fn()} />).innerHTML).toBe("");
    expect(render(<SavedModelNotice models={MODELS} value="gpt-6-sol" onSwitch={vi.fn()} />).innerHTML).toBe("");
    // A saved id the list knows by another spelling is the same model.
    expect(render(<SavedModelNotice models={MODELS} value="GPT-6-SOL" onSwitch={vi.fn()} />).innerHTML).toBe("");
    expect(render(<SavedModelNotice models={[]} value="gpt-5.5" onSwitch={vi.fn()} />).innerHTML).toBe("");
  });
});
