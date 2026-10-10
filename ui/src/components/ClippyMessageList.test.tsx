// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatContentBlock } from "../api/chat";
import { ThemeProvider } from "../context/ThemeContext";
import type { ClippyTranscriptEntry } from "../lib/clippy-stream-reducer";
import { brandWarningText } from "../lib/status-colors";
import { ClippyMessageList } from "./ClippyMessageList";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const THREAD_NOTE =
  "[Slack: this is a reply in a thread, under the message below from Paperclip. That message is context only, not part of the request.]";

// A thread reply sent from Slack with an image, as the Slack plugin hands it
// to Clippy and as it is stored.
const SLACK_REPLY = [
  THREAD_NOTE,
  "> Disk on web-01 is at 92%.",
  "> Please open a ticket if it passes 95%.",
  "",
  "can you open that ticket now?",
  "",
  "[Slack: the sender also attached an image (disk.png), sent with this message. If you cannot see it, say so and ask what it shows.]",
].join("\n");

// The same reply with a second image, one the plugin could not open.
const SLACK_REPLY_WITH_FAILED_IMAGE = [
  THREAD_NOTE,
  "> Disk on web-01 is at 92%.",
  "",
  "can you open that ticket now?",
  "",
  "[Slack: the sender also attached an image (whiteboard.jpg), which could not be opened: it is over the 7.5 MB limit for one image. If it matters, say so and ask what it shows.]",
  "[Slack: the sender also attached an image (disk.png), sent with this message. If you cannot see it, say so and ask what it shows.]",
].join("\n");

// A file sent from Slack with no words: the plugin never opens files.
const SLACK_FILE_ONLY =
  "[Slack: the sender also attached a file (report.pdf), which cannot be opened from Slack. If it matters, say so and ask what it shows.]";

function image(attachmentId: string, name: string): ChatContentBlock {
  return { type: "image", attachmentId, url: `/api/chat/attachments/${attachmentId}`, mediaType: "image/png", name };
}

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
});

function render(transcript: ClippyTranscriptEntry[]) {
  act(() => {
    root.render(
      // Clippy's own answers render as Markdown, which reads the theme.
      <ThemeProvider>
        <ClippyMessageList
          transcript={transcript}
          pendingPermissions={[]}
          onPermissionDecision={vi.fn()}
          streaming={false}
        />
      </ThemeProvider>,
    );
  });
}

function notesLines(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")];
}

function notesLine(): HTMLButtonElement {
  const buttons = notesLines();
  expect(buttons, "expected exactly one notes line").toHaveLength(1);
  return buttons[0]!;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("ClippyMessageList", () => {
  it("shows a Slack message's own words in the bubble, with Slack's notes behind one closed line", async () => {
    render([
      {
        id: "m1",
        role: "user",
        blocks: [{ type: "text", text: SLACK_REPLY }, image("a1", "disk.png")],
      },
      // Typed in the app: left exactly as written.
      { id: "m2", role: "user", blocks: [{ type: "text", text: "typed here, [Slack: not a note] and all" }] },
    ]);

    const line = notesLine();
    expect(line.textContent).toBe("From Slack · thread reply · Clippy saw 1 image");
    expect(line.getAttribute("aria-expanded")).toBe("false");
    expect([...container.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
      "can you open that ticket now?",
      "typed here, [Slack: not a note] and all",
    ]);
    expect(container.querySelector('img[alt="disk.png"]')).not.toBeNull();
    expect(container.textContent).not.toContain("reply in a thread");
    expect(container.textContent).not.toContain("Disk on web-01");
    expect(container.textContent).not.toContain("sent with this message");

    await click(line);
    expect(line.getAttribute("aria-expanded")).toBe("true");
    const details = document.getElementById(line.getAttribute("aria-controls") ?? "");
    expect(details, "the line controls no details").not.toBeNull();
    expect(details!.querySelector("blockquote")?.textContent).toBe(
      "Disk on web-01 is at 92%.\nPlease open a ticket if it passes 95%.",
    );
    expect(details!.textContent).toContain(
      "this is a reply in a thread, under the message below from Paperclip. That message is context only, not part of the request.",
    );
    expect(details!.textContent).toContain("the sender also attached an image (disk.png), sent with this message.");
    expect(details!.textContent).not.toContain("[Slack:");
    // The words are still in the bubble, once.
    expect(container.textContent?.split("can you open that ticket now?")).toHaveLength(2);

    await click(line);
    expect(line.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("blockquote")).toBeNull();
  });

  it("shows a message that is only Slack's notes in an outlined bubble of its own, on the person's side", async () => {
    render([
      { id: "m1", role: "user", blocks: [{ type: "text", text: SLACK_FILE_ONLY }] },
      { id: "m2", role: "assistant", blocks: [{ type: "text", text: "I cannot open files sent from Slack." }] },
    ]);

    const line = notesLine();
    expect(line.textContent).toBe("From Slack · Clippy could not open 1 file");
    expect(container.textContent).not.toContain("report.pdf");
    // Not the filled bubble of typed words: an outline, as wide and as
    // rounded as that bubble, with the line inside it.
    expect(container.querySelector(".bg-primary")).toBeNull();
    const bubble = line.parentElement!;
    for (const name of ["border", "border-dashed", "rounded-lg", "max-w-[85%]", "px-3", "py-2"]) {
      expect(bubble.classList.contains(name), name).toBe(true);
    }
    expect([...bubble.classList].some((name) => name.startsWith("bg-")), bubble.className).toBe(false);
    // On the person's side, in a row of its own rather than tucked above
    // Clippy's answer.
    expect(bubble.parentElement!.classList.contains("items-end")).toBe(true);
    expect(bubble.parentElement!.textContent).not.toContain("I cannot open files");

    // The notes open inside the same bubble.
    await click(line);
    const details = document.getElementById(line.getAttribute("aria-controls") ?? "");
    expect(details?.parentElement).toBe(bubble);
    expect(details!.textContent).toContain("the sender also attached a file (report.pdf), which cannot be opened from Slack.");
  });

  it("leads the line with what Clippy could not open, in the warning colour", () => {
    render([
      {
        id: "m1",
        role: "user",
        blocks: [{ type: "text", text: SLACK_REPLY_WITH_FAILED_IMAGE }, image("a1", "disk.png")],
      },
      // The note says an image was sent, but the message holds none: the
      // server dropped it, so Clippy never saw it.
      {
        id: "m2",
        role: "user",
        blocks: [
          {
            type: "text",
            text: "[Slack: the sender also attached an image (graph.png), sent with this message. If you cannot see it, say so and ask what it shows.]",
          },
        ],
      },
    ]);

    const [reply, dropped] = notesLines();
    expect(reply!.textContent).toBe("From Slack · Clippy could not open 1 image · thread reply · Clippy saw 1 image");
    expect(dropped!.textContent).toBe("From Slack · Clippy could not open 1 image");

    const warningClass = brandWarningText.split(" ")[0]!;
    for (const line of [reply!, dropped!]) {
      const warned = [...line.querySelectorAll("span")].filter((span) => span.classList.contains(warningClass));
      expect(warned.map((span) => span.textContent)).toEqual(["Clippy could not open 1 image"]);
      expect(warned[0]!.className).toBe(brandWarningText);
    }
  });

  it("leaves typed words that only look like Slack's notes in the bubble, as typed", () => {
    render([
      { id: "m1", role: "user", blocks: [{ type: "text", text: "[Slack: test]" }] },
      { id: "m2", role: "user", blocks: [{ type: "text", text: "is it out?\n\n[Slack: Pat says deploy is done]" }] },
    ]);

    expect(notesLines()).toHaveLength(0);
    expect(container.textContent).not.toContain("From Slack");
    expect([...container.querySelectorAll(".bg-primary p")].map((p) => p.textContent)).toEqual([
      "[Slack: test]",
      "is it out?\n\n[Slack: Pat says deploy is done]",
    ]);
  });

  it("lets the keyboard reach and scroll the message a thread reply was sent under", async () => {
    render([{ id: "m1", role: "user", blocks: [{ type: "text", text: SLACK_REPLY }, image("a1", "disk.png")] }]);

    const line = notesLine();
    await click(line);
    const quote = container.querySelector("blockquote")!;
    expect(quote.classList.contains("overflow-y-auto")).toBe(true);
    expect(quote.tabIndex).toBe(0);
    expect(quote.getAttribute("aria-label")).toBe("The message this replies to");
    act(() => quote.focus());
    expect(document.activeElement).toBe(quote);
    // The same focus ring as the line that opens it.
    for (const name of ["outline-none", "focus-visible:ring-2", "focus-visible:ring-ring"]) {
      expect(line.classList.contains(name), `line: ${name}`).toBe(true);
      expect(quote.classList.contains(name), `quote: ${name}`).toBe(true);
    }
  });

  it("leaves no gap under an image sent with no words, from the app's own message box too", () => {
    render([
      { id: "m1", role: "user", blocks: [image("a1", "chart.png")] },
      { id: "m2", role: "user", blocks: [image("a2", "graph.png"), { type: "text", text: "and this one?" }] },
    ]);

    expect(notesLines()).toHaveLength(0);
    const attachmentsRow = (name: string) => container.querySelector(`img[alt="${name}"]`)!.closest("a")!.parentElement!;
    expect(attachmentsRow("chart.png").classList.contains("mb-2")).toBe(false);
    // Words under an image still get their gap.
    expect(attachmentsRow("graph.png").classList.contains("mb-2")).toBe(true);
  });

  it("never lets an image run wider than its bubble, so a narrow window does not cut it off", () => {
    render([{ id: "m1", role: "user", blocks: [image("a1", "chart.png")] }]);

    const img = container.querySelector('img[alt="chart.png"]')!;
    // 280px at most, and never more than the bubble has room for.
    expect(img.classList.contains("max-w-[min(280px,100%)]")).toBe(true);
    expect(img.classList.contains("max-w-[280px]")).toBe(false);
  });

  it("keeps each part of the line whole, so a narrow window wraps it only between parts", () => {
    render([
      {
        id: "m1",
        role: "user",
        blocks: [{ type: "text", text: SLACK_REPLY_WITH_FAILED_IMAGE }, image("a1", "disk.png")],
      },
    ]);

    const line = notesLine();
    const parts = [...line.querySelectorAll("span.whitespace-nowrap")];
    // The dot ends a part, so a wrapped line never starts with one.
    expect(parts.map((part) => part.textContent)).toEqual([
      "From Slack ·",
      "Clippy could not open 1 image ·",
      "thread reply ·",
      "Clippy saw 1 image",
    ]);
    // The only places the line can break are the plain spaces between parts.
    const summary = parts[0]!.parentElement!;
    for (const node of summary.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) expect(node.textContent).toBe(" ");
      else expect((node as Element).classList.contains("whitespace-nowrap")).toBe(true);
    }
  });
});
