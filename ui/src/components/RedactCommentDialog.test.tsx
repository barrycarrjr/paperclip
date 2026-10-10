// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RedactCommentDialog } from "./RedactCommentDialog";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function setTextarea(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const BODY = "Loan 9000001234 at Example Bank."; // made up

describe("RedactCommentDialog", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("previews the redaction keeping the last 4 and confirms only valid text found in the comment", async () => {
    const onConfirm = vi.fn();
    await act(async () => {
      root.render(<RedactCommentDialog open body={BODY} pending={false} onOpenChange={() => {}} onConfirm={onConfirm} />);
    });
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    const redact = () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Redact") as HTMLButtonElement;
    expect(redact().disabled).toBe(true);

    await act(async () => setTextarea(textarea, "1111222233"));
    expect(document.body.textContent).toContain("does not appear in this comment");
    expect(redact().disabled).toBe(true);

    await act(async () => setTextarea(textarea, "9000001234"));
    expect(document.querySelector("pre")?.textContent).toBe("Loan [redacted …1234] at Example Bank.");
    expect(redact().disabled).toBe(false);
    await act(async () => redact().click());
    expect(onConfirm).toHaveBeenCalledWith(["9000001234"], true);
  });

  it("refuses text with quotes or under 4 characters", async () => {
    await act(async () => {
      root.render(<RedactCommentDialog open body={BODY} pending={false} onOpenChange={() => {}} onConfirm={() => {}} />);
    });
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => setTextarea(textarea, "Loa"));
    expect(document.body.textContent).toContain("Each text must be 4 to 200 characters");
  });
});
