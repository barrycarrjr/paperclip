// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelPickerEntry, ModelPickerGroup } from "../lib/model-display";
import { ModelPicker, type ModelPickerProps } from "./ModelPicker";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Shaped like the real claude_local answer: current first, then older.
const CLAUDE: ModelPickerEntry[] = [
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    status: "current",
    isDefault: true,
    isNew: true,
    aliases: ["opus", "claude-opus-5-5[1m]"],
  },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", status: "current" },
  { id: "claude-opus-5", label: "Claude Opus 5", status: "legacy", replacementId: "claude-opus-5-5" },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", status: "legacy" },
];

const CODEX: ModelPickerEntry[] = [
  { id: "gpt-6-sol", label: "GPT-6-Sol", status: "current", isDefault: true },
  { id: "gpt-5.5", label: "GPT-5.5", status: "deprecated", retiresAt: "2026-10-14T12:00:00.000Z" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", status: "legacy" },
];

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

function render(props: Partial<ModelPickerProps> = {}) {
  const onChange = props.onChange ?? vi.fn();
  act(() => {
    root.render(<ModelPicker models={CLAUDE} value="" onChange={onChange} {...props} />);
  });
  return { onChange, trigger: container.querySelector("button") as HTMLButtonElement };
}

async function open(trigger: HTMLButtonElement) {
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function rows(): string[] {
  return [...document.querySelectorAll("[data-picker-model]")].map(
    (row) => row.querySelector("span")?.textContent ?? "",
  );
}

function olderToggles(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].filter((b) =>
    b.textContent?.startsWith("Older models"),
  );
}

function typeSearch(text: string) {
  const input = document.querySelector('input[aria-label="Search models"]') as HTMLInputElement;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

describe("ModelPicker", () => {
  it("lists models in the server's order with their tags, older ones folded away", async () => {
    const { trigger } = render();
    await open(trigger);

    expect(rows()).toEqual(["Claude Opus 5.5", "Claude Sonnet 5"]);
    const opus = document.querySelector('[data-picker-model][title="claude-opus-5-5"]');
    expect([...(opus?.querySelectorAll("[data-model-tag]") ?? [])].map((t) => t.textContent)).toEqual([
      "New",
      "Used by default",
    ]);

    const [toggle] = olderToggles();
    expect(toggle.textContent).toBe("Older models (2)");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      toggle.click();
    });
    expect(rows()).toEqual(["Claude Opus 5.5", "Claude Sonnet 5", "Claude Opus 5", "Claude Sonnet 4.5"]);
    expect(olderToggles()[0].getAttribute("aria-expanded")).toBe("true");
  });

  it("opens with older models showing when the saved model is one of them", async () => {
    const { trigger } = render({ value: "claude-opus-5" });
    expect(trigger.textContent).toContain("Claude Opus 5");
    await open(trigger);

    expect(olderToggles()[0].getAttribute("aria-expanded")).toBe("true");
    const saved = document.querySelector('[data-picker-model][title="claude-opus-5"]');
    expect(saved?.getAttribute("aria-current")).toBe("true");
  });

  it("finds older models when searching, without opening the fold first", async () => {
    const { trigger } = render();
    await open(trigger);
    typeSearch("sonnet 4");

    expect(rows()).toEqual(["Claude Sonnet 4.5"]);
    expect(olderToggles()).toHaveLength(0);
  });

  it("dates a retiring model", async () => {
    const { trigger } = render({ models: CODEX });
    await open(trigger);

    const retiring = document.querySelector('[data-picker-model][title="gpt-5.5"] [data-model-tag]');
    expect(retiring?.textContent).toMatch(/^Retires Oct 14/);
  });

  it("marks a saved model the provider no longer offers as Not available", async () => {
    const { trigger } = render({ value: "claude-opus-4-7" });
    expect(trigger.textContent).toContain("claude-opus-4-7");
    await open(trigger);

    const saved = document.querySelector("[data-picker-saved-value]");
    expect(saved?.textContent).toContain("claude-opus-4-7");
    expect(saved?.querySelector("[data-model-tag]")?.textContent).toBe("Not available");
  });

  it("does not call a saved model missing while the list is still loading", async () => {
    const { trigger } = render({ models: [], value: "claude-opus-5", loading: true });
    await open(trigger);

    expect(document.querySelector("[data-picker-saved-value]")?.textContent).toContain("claude-opus-5");
    expect(document.querySelector("[data-picker-saved-value] [data-model-tag]")).toBeNull();
    expect(document.body.textContent).toContain("Loading models");
  });

  it("names a saved id by the model it means, however it was spelled", () => {
    const { trigger } = render({ value: "opus" });
    expect(trigger.textContent).toBe("Claude Opus 5.5");
  });

  it("picks a row and closes", async () => {
    const { trigger, onChange } = render();
    await open(trigger);

    const sonnet = document.querySelector<HTMLButtonElement>('[data-picker-model][title="claude-sonnet-5"]');
    await act(async () => {
      sonnet?.click();
    });
    expect(onChange).toHaveBeenCalledWith("claude-sonnet-5");
    expect(document.querySelector("[data-picker-model]")).toBeNull();
  });

  it("offers the empty option, and picks it as an empty id", async () => {
    const { trigger, onChange } = render({
      value: "claude-sonnet-5",
      emptyOption: { label: "Default", hint: "adapter CLI fallback", triggerLabel: "Default (adapter CLI fallback)" },
    });
    await open(trigger);

    const defaultRow = [...document.querySelectorAll<HTMLButtonElement>("[data-picker-item]")].find((b) =>
      b.textContent?.startsWith("Default"),
    );
    await act(async () => {
      defaultRow?.click();
    });
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("folds older models inside each provider group, under its heading", async () => {
    const groups: ModelPickerGroup[] = [
      { key: "claude_local", label: "Claude (local CLI)", description: "Your Claude CLI session.", models: CLAUDE },
      { key: "codex_local", label: "Codex (local CLI)", models: CODEX },
    ];
    const { trigger } = render({ models: undefined, groups });
    await open(trigger);

    expect(document.body.textContent).toContain("Claude (local CLI)");
    expect(document.body.textContent).toContain("Your Claude CLI session.");
    expect(olderToggles().map((b) => b.textContent)).toEqual(["Older models (2)", "Older models (1)"]);
    expect(rows()).toEqual(["Claude Opus 5.5", "Claude Sonnet 5", "GPT-6-Sol", "GPT-5.5"]);
  });

  it("moves down the rows with the arrow keys and picks the first match with Enter", async () => {
    const { trigger, onChange } = render();
    await open(trigger);
    const input = document.querySelector('input[aria-label="Search models"]') as HTMLInputElement;
    input.focus();

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.activeElement?.getAttribute("title")).toBe("claude-opus-5-5");

    input.focus();
    typeSearch("sonnet");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("claude-sonnet-5");
  });

  it("offers a typed id the list lacks when creatable", async () => {
    const { trigger, onChange } = render({ creatable: true });
    await open(trigger);
    typeSearch("claude-custom-1");

    const manual = [...document.querySelectorAll<HTMLButtonElement>("[data-picker-item]")].find((b) =>
      b.textContent?.startsWith("Use manual model"),
    );
    await act(async () => {
      manual?.click();
    });
    expect(onChange).toHaveBeenCalledWith("claude-custom-1");
  });
});
