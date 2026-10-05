import { useEffect, useMemo, useRef } from "react";
import { cn } from "../../lib/utils";
import { retargetEmailLinks } from "./emailLinks";

/**
 * White, dark text, small type, and the wrapping the old in-page rendering
 * had, so a message reads the same as it did before it moved into a frame.
 * Put first in the head, so the message's own styles still win.
 */
const BASE_CSS = [
  "html{color-scheme:light}",
  "body{margin:0;padding:8px;background:#fff;color:#18181b;",
  "font:12px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;",
  "white-space:pre-wrap;overflow-wrap:anywhere}",
  "img{max-width:100%;height:auto}",
].join("");

/**
 * The document the frame shows for one message body: the message, its links
 * sent to a new browser tab (see openEmailLinksInNewTab), and the base look
 * above.
 */
export function emailBodyFrameDoc(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  retargetEmailLinks(doc);
  const style = doc.createElement("style");
  style.textContent = BASE_CSS;
  doc.head.prepend(style);
  return `<!DOCTYPE html>${doc.documentElement.outerHTML}`;
}

/**
 * One message body inside a frame that runs no scripts, grown to the height
 * of what it shows, for lists of messages that scroll as a whole (a Help
 * Scout conversation).
 *
 * The body used to go straight into the page, so anything in the email that
 * runs code (an `onerror` on an image, a script tag) ran inside Paperclip
 * with the operator signed in. A frame without `allow-scripts` stops that, the
 * same way the IMAP reading pane already draws its messages. `allow-same-origin`
 * stays so the page can measure the frame's contents for its height; it gives
 * scripts nothing, because none run.
 */
export function EmailBodyFrame({ html, title, className }: { html: string; title: string; className?: string }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const srcDoc = useMemo(() => emailBodyFrameDoc(html), [html]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let observer: ResizeObserver | null = null;
    const fit = () => {
      const doc = frame.contentDocument;
      if (!doc?.documentElement) return;
      frame.style.height = `${doc.documentElement.scrollHeight}px`;
    };
    const onLoad = () => {
      fit();
      // Images arrive after the load and change the height.
      observer?.disconnect();
      const body = frame.contentDocument?.body;
      if (body && typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(fit);
        observer.observe(body);
      }
    };
    frame.addEventListener("load", onLoad);
    return () => {
      frame.removeEventListener("load", onLoad);
      observer?.disconnect();
    };
  }, [srcDoc]);

  return (
    <iframe
      ref={frameRef}
      srcDoc={srcDoc}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      title={title}
      // Email HTML is authored for a white background; keep the app's dark
      // theme out of it.
      style={{ colorScheme: "light" }}
      className={cn("block w-full rounded border-0 bg-white", className)}
    />
  );
}
