// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AvailableModel } from "../api/chat";
import { chatModelEntry, type ModelPickerGroup } from "../lib/model-display";
import { ClippyChatOptions } from "./ClippyChatOptions";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SONNET = "adapter:claude_local:claude-sonnet-5-5";
const MODELS: AvailableModel[] = [
  { provider: "adapter", model: SONNET, source: "claude_local", label: "Claude Sonnet 5.5" },
  { provider: "anthropic", model: "claude-opus-5", label: "Claude Opus 5" },
];
const GROUPS: ModelPickerGroup[] = [{ key: "all", models: MODELS.map(chatModelEntry) }];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function render(props: Partial<Parameters<typeof ClippyChatOptions>[0]> = {}) {
  const onChange = props.onChange ?? vi.fn();
  act(() => {
    root.render(
      <ClippyChatOptions
        model="claude-opus-5"
        permissionMode="ask"
        effort="auto"
        models={MODELS}
        modelGroups={GROUPS}
        {...props}
        onChange={onChange}
      />,
    );
  });
  return { onChange };
}

function trigger(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[aria-label^="Chat options"]');
  expect(button, "no chat options control").not.toBeNull();
  return button!;
}

async function openOptions() {
  await act(async () => {
    trigger().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function radio(group: string, label: string): HTMLButtonElement {
  const radiogroup = document.querySelector(`[role="radiogroup"][aria-label="${group}"]`);
  expect(radiogroup, `no ${group} choices`).not.toBeNull();
  const option = [...radiogroup!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (candidate) => candidate.textContent === label,
  );
  expect(option, `no "${label}" in ${group}`).toBeDefined();
  return option!;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("ClippyChatOptions", () => {
  it("shows the model by its readable name, never the stored adapter id", () => {
    render({ model: SONNET, permissionMode: "bypass" });
    expect(trigger().textContent).toBe("Claude Sonnet 5.5");
    expect(trigger().getAttribute("aria-label")).toBe(
      "Chat options: Claude Sonnet 5.5, Bypass permissions, effort Auto",
    );
    expect(container.textContent).not.toContain("adapter:");
  });

  it("holds the model, permissions and effort behind the one control", async () => {
    render();
    expect(document.querySelector('[role="radiogroup"]')).toBeNull();

    await openOptions();

    expect(document.querySelector('button[aria-label^="Model:"]')?.textContent).toContain("Claude Opus 5");
    expect(radio("Permissions", "Ask permission").getAttribute("aria-checked")).toBe("true");
    expect(radio("Effort", "Auto").getAttribute("aria-checked")).toBe("true");
  });

  it("changes effort and permissions from inside the control", async () => {
    const { onChange } = render();
    await openOptions();

    await click(radio("Effort", "High"));
    expect(onChange).toHaveBeenLastCalledWith({ effort: "high" });

    await click(radio("Permissions", "Bypass permissions"));
    expect(onChange).toHaveBeenLastCalledWith({ permissionMode: "bypass" });
  });

  it("moves through a choice with the arrow keys, as a radio group does", async () => {
    const { onChange } = render();
    await openOptions();

    const auto = radio("Effort", "Auto");
    await act(async () => {
      auto.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith({ effort: "low" });
  });

  it("says a CLI model always bypasses permissions, rather than offering a choice it ignores", async () => {
    render({ model: SONNET, permissionMode: "ask" });
    await openOptions();

    expect(radio("Permissions", "Bypass permissions").getAttribute("aria-checked")).toBe("true");
    expect(radio("Permissions", "Ask permission").disabled).toBe(true);
    expect(document.body.textContent).toContain("CLI models run unattended and bypass permission prompts.");
  });

  it("offers the server's default model for a new chat", async () => {
    render({ model: "", allowDefaultModel: true });
    expect(trigger().textContent).toBe("Default model");
  });
});
