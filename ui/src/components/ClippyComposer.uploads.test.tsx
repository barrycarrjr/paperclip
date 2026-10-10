// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClippyComposer } from "./ClippyComposer";

/**
 * A file whose upload failed used to be dropped without a word: the next
 * send went out without it and cleared its chip. Now the send tries the
 * upload again, and sends nothing until it works.
 */

const mockChatApi = vi.hoisted(() => ({
  uploadAttachment: vi.fn(),
  listModels: vi.fn(),
}));

vi.mock("../api/chat", () => ({ chatApi: mockChatApi }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: [] }) }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function render(onSend: (text: string, ids: string[]) => Promise<void>) {
  act(() => {
    root.render(
      <ClippyComposer
        sessionId="chat-1"
        permissionMode="ask"
        effort="auto"
        model="example"
        streaming={false}
        onSend={onSend}
        onAbort={() => {}}
        onPatch={() => {}}
      />,
    );
  });
}

async function attach(file: File) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  await act(async () => {
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

async function typeAndSend(text: string) {
  const input = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await flush();
}

describe("a file whose upload failed", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockChatApi.uploadAttachment.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("is uploaded again when the message is sent, and goes with it", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    mockChatApi.uploadAttachment
      .mockRejectedValueOnce(new Error("Upload failed: 502"))
      .mockResolvedValueOnce({ id: "att-9", sessionId: "chat-1", kind: "file", mediaType: "text/plain", name: "notes.txt", sizeBytes: 5, url: "/x" });
    render(onSend);

    const file = new File(["notes"], "notes.txt", { type: "text/plain" });
    await attach(file);
    expect(container.textContent).toContain("Upload failed: 502");

    await typeAndSend("Here are my notes");

    expect(mockChatApi.uploadAttachment).toHaveBeenCalledTimes(2);
    expect(mockChatApi.uploadAttachment).toHaveBeenLastCalledWith("chat-1", file);
    expect(onSend).toHaveBeenCalledWith("Here are my notes", ["att-9"]);
  });

  it("stops the send and keeps the file and the message when it fails again", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    mockChatApi.uploadAttachment.mockRejectedValue(new Error("Upload failed: 502"));
    render(onSend);

    await attach(new File(["notes"], "notes.txt", { type: "text/plain" }));
    await typeAndSend("Here are my notes");

    expect(onSend).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("nothing was sent");
    expect(container.textContent).toContain("notes.txt");
    expect(container.querySelector("textarea")?.value).toBe("Here are my notes");
  });
});
