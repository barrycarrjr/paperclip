// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClippyComposer } from "./ClippyComposer";

vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: [] }) }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** Stands in for the browser's speech recognition, which jsdom does not have. */
class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = "";
  continuous = false;
  interimResults = false;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn(() => {
    FakeRecognition.instances.push(this);
  });
  stop = vi.fn(() => {
    this.onend?.();
  });
  abort = vi.fn();

  /** The browser hands back one finished phrase. */
  say(text: string) {
    const result = Object.assign([{ transcript: text }], { isFinal: true });
    this.onresult?.({ resultIndex: 0, results: [result] });
  }
}

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root.render(
      <ClippyComposer
        sessionId="chat"
        permissionMode="ask"
        effort="auto"
        model="example"
        streaming={false}
        onSend={vi.fn()}
        onAbort={() => {}}
        onPatch={() => {}}
      />,
    );
  });
}

/** A toggle keeps one name; aria-pressed says whether it is on. */
function micButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('button[aria-label="Dictate"]');
}

describe("dictating into Clippy", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    FakeRecognition.instances = [];
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).webkitSpeechRecognition;
  });

  it("shows no microphone in a browser that cannot dictate", () => {
    render();
    expect(micButton()).toBeNull();
  });

  it("types what is said into the message box, and stops on a second press", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).webkitSpeechRecognition = FakeRecognition;
    render();

    const mic = micButton();
    expect(mic?.getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      mic!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(FakeRecognition.instances).toHaveLength(1);
    // Still called "Dictate" while on; only aria-pressed changes.
    expect(micButton()).toBe(mic);
    expect(micButton()?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      FakeRecognition.instances[0]!.say("Remind me to call Pat");
    });
    expect(container.querySelector("textarea")?.value).toBe("Remind me to call Pat");

    await act(async () => {
      FakeRecognition.instances[0]!.say("tomorrow at nine");
    });
    expect(container.querySelector("textarea")?.value).toBe("Remind me to call Pat tomorrow at nine");

    await act(async () => {
      micButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(FakeRecognition.instances[0]!.stop).toHaveBeenCalled();
    expect(micButton()?.getAttribute("aria-pressed")).toBe("false");
  });

  it("explains a blocked microphone instead of failing silently", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).webkitSpeechRecognition = FakeRecognition;
    render();

    await act(async () => {
      micButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      FakeRecognition.instances[0]!.onerror?.({ error: "not-allowed" });
      FakeRecognition.instances[0]!.onend?.();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("blocked the microphone");
    expect(micButton()?.getAttribute("aria-pressed")).toBe("false");
  });
});
