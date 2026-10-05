/**
 * Email HTML with every web link set to open in a new browser tab, the way
 * Outlook hands links to the browser.
 *
 * The reading pane draws a message in a frame that does not run scripts, on
 * purpose: nothing in an email is to be trusted. A link with no target of its
 * own opened inside that frame, replacing the message with the linked site,
 * and most sites need scripts, so all that showed was a "JavaScript must be
 * enabled" notice. In the Help Scout view, which draws the message straight
 * into the page, the same click navigated Paperclip itself away.
 *
 * `noopener` stops the opened site reaching back to the page that opened it,
 * and `noreferrer` keeps Paperclip's own address out of what the site is told.
 * Links that are not web addresses (mailto:, in-page #anchors) are left alone.
 *
 * Pass `fragment: true` for HTML that goes inside an element of the page
 * rather than into a frame of its own: that returns just the body's contents.
 */
export function openEmailLinksInNewTab(html: string, { fragment = false }: { fragment?: boolean } = {}): string {
  if (!html || typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!retargetEmailLinks(doc)) return html;
  if (fragment) return doc.body.innerHTML;
  // Keep the message's own doctype, or none if it had none: it decides how
  // the browser lays out old-style email tables.
  const doctype = doc.doctype ? `${new XMLSerializer().serializeToString(doc.doctype)}\n` : "";
  return doctype + doc.documentElement.outerHTML;
}

/**
 * The same change on a document already parsed. True when any link changed.
 */
export function retargetEmailLinks(root: ParentNode): boolean {
  let changed = false;
  for (const link of root.querySelectorAll("a[href], area[href]")) {
    const href = link.getAttribute("href")?.trim() ?? "";
    if (!/^(https?:)?\/\//i.test(href)) continue;
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
    changed = true;
  }
  return changed;
}
