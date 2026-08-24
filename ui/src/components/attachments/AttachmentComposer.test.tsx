// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useComposeAttachments, type ComposeAttachmentsState } from "./AttachmentComposer";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mountState(maxBytes: number) {
  const captured: { current: ComposeAttachmentsState | null } = { current: null };
  function Probe() {
    captured.current = useComposeAttachments(maxBytes);
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Probe />);
  });
  return captured;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

describe("useComposeAttachments.addRemote", () => {
  it("shows a loading chip from the metadata, then goes ready when the bytes arrive", async () => {
    const state = mountState(1024);

    act(() => {
      state.current!.addRemote(
        { name: "report.pdf", mime: "application/pdf", size: 5 },
        () => Promise.resolve("aGVsbG8="),
      );
    });
    expect(state.current!.attachments).toHaveLength(1);
    expect(state.current!.attachments[0].status).toBe("reading");
    expect(state.current!.allReady).toBe(false);

    await settle();
    expect(state.current!.attachments[0].status).toBe("ready");
    expect(state.current!.attachments[0].contentBase64).toBe("aGVsbG8=");
    expect(state.current!.allReady).toBe(true);
  });

  it("turns a failed fetch into an error chip instead of a silent drop", async () => {
    const state = mountState(1024);

    act(() => {
      state.current!.addRemote(
        { name: "report.pdf", mime: "application/pdf", size: 5 },
        () => Promise.reject(new Error("imap down")),
      );
    });
    await settle();

    expect(state.current!.attachments[0].status).toBe("error");
    expect(state.current!.attachments[0].error).toBe("imap down");
  });

  it("rejects an over-limit file up front without ever fetching it", async () => {
    const state = mountState(10);
    let loaded = false;

    act(() => {
      state.current!.addRemote({ name: "big.zip", mime: "application/zip", size: 11 }, () => {
        loaded = true;
        return Promise.resolve("x");
      });
    });
    await settle();

    expect(state.current!.attachments[0].status).toBe("error");
    expect(loaded).toBe(false);
  });
});
