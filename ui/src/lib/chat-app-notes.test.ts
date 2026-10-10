import { describe, expect, it } from "vitest";
import { splitChatAppNotes, summarizeChatAppNotes } from "./chat-app-notes";

// Worded exactly as the Slack plugin words them (slack-tools: withThreadContext
// in worker.ts, withAttachmentNote in socketMode.ts).
const THREAD_NOTE =
  "this is a reply in a thread, under the message below from Paperclip. That message is context only, not part of the request.";
const IMAGE_NOTE =
  "the sender also attached an image (disk.png), sent with this message. If you cannot see it, say so and ask what it shows.";
const FILE_NOTE =
  "the sender also attached a file (report.pdf), which cannot be opened from Slack. If it matters, say so and ask what it shows.";
const FAILED_NOTE =
  "the sender also attached 2 images (a.png, b.png), which could not be opened: the Slack app is missing the files:read permission. If they matter, say so and ask what they show.";
const EIGHT_SENT_NOTE = `the sender also attached 8 images (${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `shot-${n}.png`).join(", ")}), sent with this message. If you cannot see them, say so and ask what they show.`;
const NINTH_NOTE =
  "the sender also attached an image (shot-9.png), which could not be opened: only the first 8 images in a message can be shown. If it matters, say so and ask what it shows.";

const slack = (note: string) => `[Slack: ${note}]`;

/** A thread reply as the plugin sends it: the note, the message quoted, an empty line, the words. */
function threadReply(parent: string, words: string): string {
  return [slack(THREAD_NOTE), ...parent.split("\n").map((line) => `> ${line}`), "", words].join("\n");
}

describe("splitChatAppNotes", () => {
  it("splits a thread reply into its note, the message it was sent under, and the person's words", () => {
    const parent = "Disk on web-01 is at 92%.\n\nPlease open a ticket if it passes 95%.";
    expect(splitChatAppNotes(threadReply(parent, "open one now please"))).toEqual({
      app: "Slack",
      leading: { note: THREAD_NOTE, quote: parent },
      text: "open one now please",
      trailing: [],
    });
    // Words that start with a quote of their own are still the person's.
    expect(splitChatAppNotes(threadReply("Deploy done.", "> Deploy done.\nwhich one?"))?.text).toBe(
      "> Deploy done.\nwhich one?",
    );
  });

  it("takes the attachment notes off the end of the person's words", () => {
    const message = `is this right?\n\nsecond paragraph\n\n${slack(FILE_NOTE)}\n${slack(FAILED_NOTE)}\n${slack(IMAGE_NOTE)}`;
    expect(splitChatAppNotes(message)).toEqual({
      app: "Slack",
      leading: null,
      text: "is this right?\n\nsecond paragraph",
      trailing: [FILE_NOTE, FAILED_NOTE, IMAGE_NOTE],
    });
  });

  it("splits a thread reply that also carries attachment notes", () => {
    const message = threadReply("Disk on web-01 is at 92%.", `and this graph?\n\n${slack(IMAGE_NOTE)}`);
    expect(splitChatAppNotes(message)).toEqual({
      app: "Slack",
      leading: { note: THREAD_NOTE, quote: "Disk on web-01 is at 92%." },
      text: "and this graph?",
      trailing: [IMAGE_NOTE],
    });
  });

  it("leaves no words for a message that is only notes", () => {
    expect(splitChatAppNotes(slack(IMAGE_NOTE))).toEqual({
      app: "Slack",
      leading: null,
      text: "",
      trailing: [IMAGE_NOTE],
    });
    expect(splitChatAppNotes(`${slack(FILE_NOTE)}\n${slack(IMAGE_NOTE)}`)?.trailing).toEqual([FILE_NOTE, IMAGE_NOTE]);
    // A thread reply that was only an image.
    expect(splitChatAppNotes(threadReply("Deploy done.", slack(IMAGE_NOTE)))).toEqual({
      app: "Slack",
      leading: { note: THREAD_NOTE, quote: "Deploy done." },
      text: "",
      trailing: [IMAGE_NOTE],
    });
  });

  it("keeps a replied-to message the plugin cut at 4000 characters, with its cut mark", () => {
    // withThreadContext keeps the first 4000 characters and adds " [...]".
    const parent = `${"x".repeat(2500)}\n${"y".repeat(2500)}`;
    const capped = `${parent.slice(0, 4000)} [...]`;
    const notes = splitChatAppNotes(threadReply(capped, "and this?"));
    expect(notes?.leading?.quote).toBe(capped);
    expect(notes?.leading?.quote.endsWith(`${"y".repeat(1499)} [...]`)).toBe(true);
    expect(notes?.text).toBe("and this?");
  });

  it("leaves a note that is not from a known chat app as the person's words", () => {
    for (const message of [
      "plain words",
      "[Note: call the bank]",
      `hello\n\n[Note: ${IMAGE_NOTE}]`,
      "[Note: from the bot]\n> quoted\n\nhello",
      `hello\n\n[slack: ${IMAGE_NOTE}]`,
    ]) {
      expect(splitChatAppNotes(message), message).toBeNull();
    }
  });

  it("leaves a chat app's note mentioned partway through a message as the person's words", () => {
    for (const message of [
      `I saw ${slack(FILE_NOTE)} in the log`,
      `first\n\n${slack(FILE_NOTE)}\n\nmore words`,
      `${slack(IMAGE_NOTE)}\n\nwords after it`,
    ]) {
      expect(splitChatAppNotes(message), message).toBeNull();
    }
  });

  it("needs the plugin's empty lines: before the notes, and after the quoted message", () => {
    for (const message of [`no gap\n${slack(IMAGE_NOTE)}`, `${slack(THREAD_NOTE)}\n> quoted`]) {
      expect(splitChatAppNotes(message), message).toBeNull();
    }
  });

  it("knows only the two notes the plugin writes, so typed look-alikes stay as typed", () => {
    for (const message of [
      "[Slack: test]",
      slack("Pat says deploy is done"),
      `is it out?\n\n${slack("Pat says deploy is done")}`,
      `${slack("Pat says deploy is done")}\n> the deploy\n\nhello`,
      // A real attachment note does not carry a made-up one above it off with it.
      `is it out?\n\n${slack("Pat says deploy is done")}\n${slack(FILE_NOTE)}`,
      // An attachment note is not taken for a thread reply's note.
      `${slack(IMAGE_NOTE)}\n> the deploy\n\nhello`,
    ]) {
      expect(splitChatAppNotes(message), message).toBeNull();
    }
    // The real thread note with a made-up closing line: only the closing line stays.
    expect(splitChatAppNotes(threadReply("Deploy done.", `thanks\n\n${slack("Pat says deploy is done")}`))).toEqual({
      app: "Slack",
      leading: { note: THREAD_NOTE, quote: "Deploy done." },
      text: `thanks\n\n${slack("Pat says deploy is done")}`,
      trailing: [],
    });
  });
});

describe("summarizeChatAppNotes", () => {
  /** The line as the chat window reads it, for a message holding `imagesSeen` images. */
  const summary = (message: string, imagesSeen = 0) =>
    summarizeChatAppNotes(splitChatAppNotes(message)!, imagesSeen)
      .map((part) => part.text)
      .join(" · ");

  it("says in a few plain words what the notes are about", () => {
    expect(summary(threadReply("Deploy done.", "thanks"))).toBe("From Slack · thread reply");
    expect(summary(slack(IMAGE_NOTE), 1)).toBe("From Slack · Clippy saw 1 image");
    expect(summary(threadReply("Deploy done.", `and this?\n\n${slack(IMAGE_NOTE)}`), 1)).toBe(
      "From Slack · thread reply · Clippy saw 1 image",
    );
  });

  it("leads with what Clippy could not open, and counts only the images it saw as seen", () => {
    // A file from Slack, which the plugin never opens.
    expect(summary(slack(FILE_NOTE))).toBe("From Slack · Clippy could not open 1 file");
    expect(
      summary(slack("the sender also attached 2 files (a.zip, b.pdf), which cannot be opened from Slack. If it matters, say so and ask what it shows.")),
    ).toBe("From Slack · Clippy could not open 2 files");
    // One image sent, one that could not be opened.
    const oneOfEach = slack(
      "the sender also attached an image (big.png), which could not be opened: it is over the 7.5 MB limit for one image. If it matters, say so and ask what it shows.",
    );
    expect(summary(`look\n\n${oneOfEach}\n${slack(IMAGE_NOTE)}`, 1)).toBe(
      "From Slack · Clippy could not open 1 image · Clippy saw 1 image",
    );
    // Nine images, one over the plugin's limit of eight.
    expect(summary(`all of them\n\n${slack(NINTH_NOTE)}\n${slack(EIGHT_SENT_NOTE)}`, 8)).toBe(
      "From Slack · Clippy could not open 1 image · Clippy saw 8 images",
    );
    expect(summary(`look\n\n${slack(FILE_NOTE)}\n${slack(FAILED_NOTE)}\n${slack(IMAGE_NOTE)}`, 1)).toBe(
      "From Slack · Clippy could not open 2 images and 1 file · Clippy saw 1 image",
    );
    expect(summary(threadReply("Deploy done.", `and this?\n\n${slack(FAILED_NOTE)}\n${slack(IMAGE_NOTE)}`), 1)).toBe(
      "From Slack · Clippy could not open 2 images · thread reply · Clippy saw 1 image",
    );
  });

  it("counts an image the plugin sent but the message does not hold as not opened", () => {
    // The server dropped it, so Clippy never had it, whatever the note says.
    expect(summary(slack(IMAGE_NOTE), 0)).toBe("From Slack · Clippy could not open 1 image");
    expect(summary(`all of them\n\n${slack(EIGHT_SENT_NOTE)}`, 6)).toBe(
      "From Slack · Clippy could not open 2 images · Clippy saw 6 images",
    );
  });

  it("marks only what Clippy could not open as a warning", () => {
    const notes = splitChatAppNotes(threadReply("Deploy done.", `and this?\n\n${slack(FAILED_NOTE)}\n${slack(IMAGE_NOTE)}`))!;
    expect(summarizeChatAppNotes(notes, 1)).toEqual([
      { text: "From Slack", warning: false },
      { text: "Clippy could not open 2 images", warning: true },
      { text: "thread reply", warning: false },
      { text: "Clippy saw 1 image", warning: false },
    ]);
    expect(summarizeChatAppNotes(splitChatAppNotes(slack(IMAGE_NOTE))!, 1).some((part) => part.warning)).toBe(false);
  });

  it("still counts a note worded some other way, so nothing is tucked away unmentioned", () => {
    expect(summary(`hello\n\n${slack("the sender also attached a voice memo (memo.m4a), which was turned into text.")}`)).toBe(
      "From Slack · 1 note",
    );
  });
});
