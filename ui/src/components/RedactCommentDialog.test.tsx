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

const impact = { counts: { comment: 1, runContexts: 2 }, impactToken: "a".repeat(64), estimated: true, oversizedFields: 0, skippedFields: 0, residualMatches: 0, cutoffCheckComplete: true } as any;
const preview = vi.fn(async () => impact);
const previewCopies = async () => act(async () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Preview stored copies")!.click());
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
      root.render(<RedactCommentDialog onPreview={preview} open body={BODY} pending={false} onOpenChange={() => {}} onConfirm={onConfirm} />);
    });
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    const redact = () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Redact") as HTMLButtonElement;
    expect(redact().disabled).toBe(true);

    await act(async () => setTextarea(textarea, "1111222233"));
    expect(document.body.textContent).toContain("does not appear in this comment");
    expect(redact().disabled).toBe(true);

    await act(async () => setTextarea(textarea, "9000001234"));
    expect(document.querySelector("pre")?.textContent).toBe("Loan [redacted …1234] at Example Bank.");
    expect(document.body.textContent).toContain("Some run log files may require separate cleanup");
    expect(redact().disabled).toBe(true);
    await previewCopies();
    expect(document.body.textContent).toContain("Estimated matching records");
    expect(redact().disabled).toBe(false);
    await act(async () => redact().click());
    expect(onConfirm).toHaveBeenCalledWith(["9000001234"], true, undefined, impact.impactToken);
  });

  it("supports exact multiline selections and agent authorization with full replacement", async () => {
    const onConfirm = vi.fn();
    const exact = ' Example "private"\\text\nsecond line ';
    await act(async () => {
      root.render(<RedactCommentDialog onPreview={preview} open body={`Before${exact}After`} agents={[{ id: "agent-1", name: "Test Agent" }]} pending={false} onOpenChange={() => {}} onConfirm={onConfirm} />);
    });
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => setTextarea(textarea, exact));
    const select = document.querySelector("select")!;
    await act(async () => { select.value = "agent-1"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => (document.querySelector('[role="checkbox"]') as HTMLButtonElement).click());
    expect(document.querySelector("pre")!.textContent).toBe("Before[redacted]After");
    expect(document.body.textContent).toContain("expires in 30 minutes");
    const confirm = [...document.querySelectorAll("button")].find((b) => b.textContent === "Authorize agent")!;
    await previewCopies();
    await act(async () => confirm.click());
    expect(onConfirm).toHaveBeenCalledWith([exact], false, "agent-1", impact.impactToken);
  });

  it.each(["PIN 4821", "CVV 123"])("fully hides the short labelled selection %s with last-four still enabled", async (body) => {
    const onConfirm = vi.fn();
    await act(async () => root.render(<RedactCommentDialog onPreview={preview} open body={body} pending={false} onOpenChange={() => {}} onConfirm={onConfirm} />));
    await act(async () => setTextarea(document.querySelector("textarea")!, body));
    expect(document.querySelector("pre")!.textContent).toBe("[redacted]");
    expect(document.body.textContent).toContain("eight or fewer letters or digits are fully hidden");
    expect(document.body.textContent).toContain("preview shows exactly what remains");
    await previewCopies();
    await act(async () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Redact")!.click());
    expect(onConfirm).toHaveBeenCalledWith([body], true, undefined, impact.impactToken);
  });

  it("shows preserved residuals and the private-chat limit without hiding confirmation", async () => {
    await act(async () => root.render(<RedactCommentDialog onPreview={async () => ({ ...impact, residualMatches: 3, skippedFields: 2, cutoffCheckComplete: false })} open body={BODY} pending={false} onOpenChange={() => {}} onConfirm={() => {}} />));
    await act(async () => setTextarea(document.querySelector("textarea")!, "9000001234"));
    await previewCopies();
    expect(document.body.textContent).toContain("3 matches or possible cut-off pieces will remain");
    expect(document.body.textContent).toContain("Overall cleanup always reports incomplete");
    expect(document.body.textContent).toContain("2 deeply nested fields will be skipped");
    expect(document.body.textContent).toContain("cut-off copy check did not finish");
    expect([...document.querySelectorAll("button")].find((button) => button.textContent === "Redact")!.disabled).toBe(false);
  });

  it("does not confirm a whitespace-only, absent or pending selection", async () => {
    await act(async () => root.render(<RedactCommentDialog onPreview={preview} open body={BODY} pending={false} onOpenChange={() => {}} onConfirm={() => {}} />));
    await act(async () => setTextarea(document.querySelector("textarea")!, " "));
    expect([...document.querySelectorAll("button")].find((b) => b.textContent === "Redact")!.disabled).toBe(true);
    await act(async () => root.render(<RedactCommentDialog onPreview={preview} open body={BODY} pending onOpenChange={() => {}} onConfirm={() => {}} />));
    expect(document.querySelector("textarea")!.disabled).toBe(true);
  });
});

it("previews million-character comments with bounded DOM text and permits confirmation", async () => {
  const onConfirm = vi.fn();
  const body = "x".repeat(1_000_490) + "9000001234";
  const node = document.createElement("div");
  document.body.append(node);
  const largeRoot = createRoot(node);
  try {
    await act(async () => largeRoot.render(<RedactCommentDialog onPreview={preview} open body={body} pending={false} onOpenChange={() => {}} onConfirm={onConfirm} />));
    await act(async () => setTextarea(document.querySelector("textarea")!, "9000001234"));
    expect(document.querySelector("pre")!.textContent!.length).toBeLessThanOrEqual(16_000);
    expect(document.querySelector("pre")!.textContent).toContain("[redacted");
    expect(document.body.textContent).not.toContain("Select 4 to 2000");
    await previewCopies();
    await act(async () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Redact")!.click());
    expect(onConfirm).toHaveBeenCalled();
  } finally { act(() => largeRoot.unmount()); node.remove(); }
});

it("explains the UTF-8 body limit without blaming the selected text", async () => {
  const node = document.createElement("div"); document.body.append(node);
  const largeRoot = createRoot(node);
  try {
    await act(async () => largeRoot.render(<RedactCommentDialog onPreview={preview} open body={"\u00e9".repeat(16 * 1024 * 1024)} pending={false} onOpenChange={() => {}} onConfirm={() => {}} />));
    expect(document.body.textContent).toContain("30 MiB UTF-8 limit");
    expect(document.body.textContent).not.toContain("Select 4 to 2000");
    expect(document.querySelector("pre")!.textContent!.length).toBeLessThanOrEqual(16_000);
    expect([...document.querySelectorAll("button")].find((b) => b.textContent === "Preview stored copies")!.disabled).toBe(true);
  } finally { act(() => largeRoot.unmount()); node.remove(); }
});
