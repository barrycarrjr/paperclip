// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { EmailBodyFrame, emailBodyFrameDoc } from "./EmailBodyFrame";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

function render(node: React.ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

const HOSTILE = '<p>Hello</p><img src="x" onerror="alert(1)"><script>alert(2)</script>';

describe("EmailBodyFrame", () => {
  it("draws the message in a frame that cannot run its scripts", () => {
    const el = render(<EmailBodyFrame html={HOSTILE} title="Message from Sam" />);
    const frame = el.querySelector("iframe")!;
    const sandbox = frame.getAttribute("sandbox") ?? "";
    expect(sandbox.split(/\s+/)).not.toContain("allow-scripts");
    expect(sandbox).toContain("allow-popups-to-escape-sandbox");
    expect(frame.getAttribute("title")).toBe("Message from Sam");
    // Nothing from the email lands in the page itself.
    expect(document.body.querySelector("img[onerror]")).toBeNull();
    expect(frame.getAttribute("srcdoc")).toContain('onerror="alert(1)"');
  });
});

describe("emailBodyFrameDoc", () => {
  it("wraps the message in a light page and keeps its text", () => {
    const doc = emailBodyFrameDoc("<p>Line one</p>");
    expect(doc.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(doc).toContain("color-scheme:light");
    expect(doc).toContain("<body><p>Line one</p></body>");
  });

  it("sends the message's links to a new browser tab", () => {
    const doc = emailBodyFrameDoc('<a href="https://example.com">site</a>');
    expect(doc).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">site</a>');
  });
});
