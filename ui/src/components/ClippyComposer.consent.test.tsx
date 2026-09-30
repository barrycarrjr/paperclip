// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ClippyComposer } from "./ClippyComposer";
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: [] }) }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
async function render(onSend: (text: string, ids: string[]) => Promise<void>) {
  await act(async () => root.render(<ClippyComposer sessionId="chat" permissionMode="ask" effort="auto" model="example"
    streaming awaitingPermission onSend={onSend} onAbort={() => {}} onPatch={() => {}} />));
}
async function answer(text: string) {
  const input = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
}
it("lets a short yes reply submit while the repair stream waits", async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  await render(send);
  await answer("yes, do it");
  expect(send).toHaveBeenCalledWith("yes, do it", []);
});
it("leaves ambiguous instructions unsent and explains how to change the action", async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  await render(send);
  await answer("yes but use another computer");
  expect(send).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Reply yes or no");
  expect(container.querySelector("textarea")?.value).toBe("yes but use another computer");
});
it("shows an expired or failed consent response instead of silently dropping it", async () => {
  await render(vi.fn().mockRejectedValue(new Error("The permission prompt expired")));
  await answer("yes");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("prompt expired");
});
