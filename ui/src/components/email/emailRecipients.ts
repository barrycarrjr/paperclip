/**
 * Recipient lists for an open email, shown the way Outlook shows them.
 *
 * The email-tools plugin sends each of `to` and `cc` as an array, but usually
 * with ONE entry holding the whole header joined by commas
 * (`"Jordan A. Lee" <jordan@example.com>, Sam Rivera <sam@example.com>`).
 * Splitting on every comma would break a quoted name such as
 * `"Lee, Jordan" <jordan@example.com>`, so commas inside quotes or angle
 * brackets are left alone.
 */
export function splitAddressList(entries: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const entry of entries ?? []) {
    let current = "";
    let inQuotes = false;
    let inAngle = false;
    for (let i = 0; i < entry.length; i++) {
      const ch = entry[i];
      if (ch === "\\" && inQuotes && i + 1 < entry.length) {
        current += ch + entry[i + 1];
        i++;
        continue;
      }
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === "<" && !inQuotes) inAngle = true;
      else if (ch === ">" && !inQuotes) inAngle = false;
      if (ch === "," && !inQuotes && !inAngle) {
        if (current.trim()) out.push(current.trim());
        current = "";
        continue;
      }
      current += ch;
    }
    if (current.trim()) out.push(current.trim());
  }
  return out;
}

/**
 * What Outlook prints for one recipient: the person's name when the header
 * carries one, otherwise the bare address. The full form stays available as
 * the hover text, so nothing is hidden.
 */
export function recipientDisplayName(recipient: string): string {
  const match = /^(.*?)\s*<([^>]*)>\s*$/.exec(recipient.trim());
  if (!match) return recipient.trim();
  const name = match[1].trim().replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1").trim();
  const address = match[2].trim();
  return name || address || recipient.trim();
}
