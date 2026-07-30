// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailSearchBar } from "./MailSearchBar";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("MailSearchBar", () => {
  let container: HTMLDivElement;

  async function render(props: Partial<React.ComponentProps<typeof MailSearchBar>> = {}) {
    container = document.createElement("div");
    document.body.appendChild(container);
    const handlers = {
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      onClear: vi.fn(),
    };
    const root = createRoot(container);
    await act(async () => {
      root.render(<MailSearchBar value="" {...handlers} {...props} />);
    });
    return {
      ...handlers,
      input: container.querySelector("input") as HTMLInputElement,
      form: container.querySelector("form") as HTMLFormElement,
    };
  }

  afterEach(() => {
    container?.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("reports typing without running the search", async () => {
    // The whole point of the submit-driven design: typing must not fire a
    // server-side query per keystroke.
    const { input, onChange, onSubmit } = await render();

    await act(async () => {
      setInputValue(input, "invoice");
    });

    expect(onChange).toHaveBeenLastCalledWith("invoice");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("runs the search when the form is submitted", async () => {
    const { form, onSubmit } = await render({ value: "invoice" });

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does not reload the page on submit", async () => {
    const { form } = await render({ value: "invoice" });
    const submitEvent = new Event("submit", { bubbles: true, cancelable: true });

    await act(async () => {
      form.dispatchEvent(submitEvent);
    });

    expect(submitEvent.defaultPrevented).toBe(true);
  });

  it("clears on Escape", async () => {
    const { input, onClear } = await render({ value: "invoice" });

    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });

    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("hides the clear button until there is something to clear", async () => {
    await render({ value: "" });
    expect(container.querySelector('[aria-label="Clear search"]')).toBeNull();
  });

  it("clears from the clear button", async () => {
    const { onClear } = await render({ value: "invoice" });
    const clearButton = container.querySelector('[aria-label="Clear search"]') as HTMLButtonElement;
    expect(clearButton).not.toBeNull();

    await act(async () => {
      clearButton.click();
    });
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("shows the result summary and any coverage note", async () => {
    await render({
      value: "invoice",
      summary: "12 results",
      note: "Could not search personal/Archive. Results may be incomplete.",
    });

    expect(container.textContent).toContain("12 results");
    expect(container.textContent).toContain("Results may be incomplete");
  });

  it("labels the input for assistive tech", async () => {
    const { input } = await render({ "aria-label": "Search Help Scout conversations" });
    expect(input.getAttribute("aria-label")).toBe("Search Help Scout conversations");
  });
});
