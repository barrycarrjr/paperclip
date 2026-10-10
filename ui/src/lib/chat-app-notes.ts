/**
 * Notes a chat app's plugin adds to a message before handing it to Clippy.
 *
 * The Slack plugin tells Clippy things the person did not type: that the
 * message is a reply in a thread, with the message it was sent under quoted,
 * and what else came with it ("[Slack: the sender also attached an image
 * ..."). Clippy needs them, so they are stored with the message, but the chat
 * window showed them inside the person's own bubble as if they had typed
 * them. This splits a message's text into the notes and the person's own
 * words, for display only: what is stored, and what Clippy reads, stays the
 * same.
 *
 * Only the plugin's exact layout counts, and only the two notes it writes. A
 * thread reply starts with one note line, "[Slack: this is a reply in a
 * thread ...]", then the replied-to message quoted line by line ("> "), then
 * an empty line. Notes about attachments, "[Slack: the sender also attached
 * ...]", are the last lines, after an empty line, or the whole message when
 * there are no words. Anything else stays as the person's words, so someone
 * who types "[Slack: test]" or "[Note: ...]", or mentions "[Slack: ...]"
 * partway through a message, sees it exactly as they wrote it.
 */

/** Chat apps whose notes are recognised: a note line starts "[<app>: ". */
export const CHAT_APP_NOTE_LABELS: readonly string[] = ["Slack"];

/** How the plugin's note on a thread reply starts. */
const THREAD_NOTE_START = "this is a reply in a thread";
/** How each of the plugin's notes on what came with a message starts. */
const ATTACHMENT_NOTE_START = "the sender also attached ";

export interface ChatAppNotes {
  /** The chat app that added the notes, e.g. "Slack". */
  app: string;
  /** A thread reply's note, and the message it was sent under without the "> " marks. */
  leading: { note: string; quote: string } | null;
  /** What the person wrote. Empty when the message is only notes. */
  text: string;
  /** Notes after the person's words, one per line, such as what they attached. */
  trailing: string[];
}

const NOTE_LINE = /^\[([^\]:]+): (.+)\]$/;

/**
 * A whole line that is one note from a known chat app, starting the way the
 * plugin starts that kind of note, without its brackets and label.
 */
function readNote(line: string | undefined, start: string): { app: string; note: string } | null {
  const match = line === undefined ? null : NOTE_LINE.exec(line);
  if (!match || !CHAT_APP_NOTE_LABELS.includes(match[1]) || !match[2].startsWith(start)) return null;
  return { app: match[1], note: match[2] };
}

/** Null when the message carries no chat app notes, which is most messages. */
export function splitChatAppNotes(message: string): ChatAppNotes | null {
  let lines = message.split("\n");
  let app: string | null = null;

  // A thread reply: the note, the replied-to message quoted line by line, and
  // an empty line before the person's words.
  let leading: ChatAppNotes["leading"] = null;
  const first = readNote(lines[0], THREAD_NOTE_START);
  if (first) {
    let end = 1;
    while (lines[end]?.startsWith("> ")) end += 1;
    if (end > 1 && lines[end] === "") {
      app = first.app;
      leading = { note: first.note, quote: lines.slice(1, end).map((line) => line.slice(2)).join("\n") };
      lines = lines.slice(end + 1);
    }
  }

  // Notes after the words: the last lines, from one chat app, after an empty
  // line, or every line when the person sent no words.
  let start = lines.length;
  while (start > 0) {
    const note = readNote(lines[start - 1], ATTACHMENT_NOTE_START);
    if (!note || (app !== null && note.app !== app)) break;
    app = note.app;
    start -= 1;
  }
  if (start > 0 && lines[start - 1] !== "") start = lines.length;

  if (app === null || (!leading && start === lines.length)) return null;
  // The empty line between the words and the notes belongs to neither.
  const words = start < lines.length ? lines.slice(0, Math.max(0, start - 1)) : lines;
  return {
    app,
    leading,
    text: words.join("\n"),
    trailing: lines.slice(start).map((line) => readNote(line, ATTACHMENT_NOTE_START)!.note),
  };
}

/** One part of the line about a message's notes, such as "thread reply". */
export interface ChatAppNotesPart {
  text: string;
  /** Something Clippy did not get, such as an image it could not open. */
  warning: boolean;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

// The plugin's attachment notes, told apart by how the part after the names
// ends. Images "sent with this message" went to Clippy:
//   "the sender also attached 2 images (a.png, b.png), sent with this message. ..."
const SENT = /^the sender also attached (?:an image|(\d+) images) \(.*\), sent with this message\./;
// The rest did not:
//   "the sender also attached an image (a.png), which could not be opened: <why>. ..."
//   "the sender also attached a file (a.pdf), which cannot be opened from Slack. ..."
const NOT_OPENED =
  /^the sender also attached (?:an? (image|file)|(\d+) (image|file)s) \(.*\), (?:which could not be opened:|which cannot be opened from Slack\.)/;

/**
 * What the notes are about, in a few plain words, for the line about them:
 * "From Slack", then what Clippy could not open, as a warning, then the rest,
 * such as "thread reply" and the images it saw. A note worded some other way
 * is still counted, as a note, so nothing is hidden without a word.
 *
 * `imagesSeen` is how many images the message itself holds, which are the
 * ones Clippy was given. The notes cannot say that: an image the plugin sent
 * can still have been dropped by the server, and then counts as not opened.
 */
export function summarizeChatAppNotes(notes: ChatAppNotes, imagesSeen: number): ChatAppNotesPart[] {
  let imagesSent = 0;
  let imagesNotOpened = 0;
  let filesNotOpened = 0;
  let others = 0;
  for (const note of notes.trailing) {
    const sent = SENT.exec(note);
    if (sent) {
      imagesSent += sent[1] ? Number(sent[1]) : 1;
      continue;
    }
    const notOpened = NOT_OPENED.exec(note);
    if (!notOpened) {
      others += 1;
      continue;
    }
    const count = notOpened[2] ? Number(notOpened[2]) : 1;
    if ((notOpened[1] ?? notOpened[3]) === "image") imagesNotOpened += count;
    else filesNotOpened += count;
  }
  const imagesMissed = imagesNotOpened + Math.max(0, imagesSent - imagesSeen);
  const missed = [
    ...(imagesMissed > 0 ? [plural(imagesMissed, "image", "images")] : []),
    ...(filesNotOpened > 0 ? [plural(filesNotOpened, "file", "files")] : []),
  ];

  const parts: ChatAppNotesPart[] = [{ text: `From ${notes.app}`, warning: false }];
  if (missed.length > 0) parts.push({ text: `Clippy could not open ${missed.join(" and ")}`, warning: true });
  if (notes.leading) parts.push({ text: "thread reply", warning: false });
  if (imagesSeen > 0) parts.push({ text: `Clippy saw ${plural(imagesSeen, "image", "images")}`, warning: false });
  if (others > 0) parts.push({ text: plural(others, "note", "notes"), warning: false });
  return parts;
}
