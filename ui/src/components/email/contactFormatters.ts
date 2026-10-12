import type { EmailContact, ImportContactItem } from "../../api/emailTools";

/**
 * Escapes a single CSV field following RFC 4180.
 * Always encloses in quotes to ensure compatibility across all CSV parsers.
 */
function escapeCsvField(field: string | null | undefined): string {
  if (field == null) return '""';
  const str = String(field);
  return `"${str.replace(/"/g, '""')}"`;
}

/**
 * Exports an array of EmailContact to standard CSV format.
 */
export function exportContactsAsCsv(contacts: EmailContact[]): string {
  const header = "Name,Email,Notes";
  const rows = contacts.map((c) =>
    [escapeCsvField(c.name), escapeCsvField(c.email), escapeCsvField(c.notes)].join(","),
  );
  return [header, ...rows].join("\r\n");
}

/**
 * Exports an array of EmailContact to vCard 3.0 format (.vcf).
 */
export function exportContactsAsVCard(contacts: EmailContact[]): string {
  return contacts
    .map((c) => {
      const lines = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        c.name ? `FN:${c.name}` : `FN:${c.email}`,
      ];
      if (c.email) {
        lines.push(`EMAIL;TYPE=INTERNET:${c.email}`);
      }
      if (c.notes) {
        const escapedNote = c.notes
          .replace(/\\/g, "\\\\")
          .replace(/\n/g, "\\n")
          .replace(/,/g, "\\,")
          .replace(/;/g, "\\;");
        lines.push(`NOTE:${escapedNote}`);
      }
      lines.push("END:VCARD");
      return lines.join("\r\n");
    })
    .join("\r\n");
}

/**
 * Exports an array of EmailContact to pretty-printed JSON.
 */
export function exportContactsAsJson(contacts: EmailContact[]): string {
  const clean = contacts.map((c) => ({
    name: c.name ?? null,
    email: c.email,
    notes: c.notes ?? null,
  }));
  return JSON.stringify(clean, null, 2);
}

/**
 * Triggers a browser download of a given string content as a file.
 */
export function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Splits a CSV line into fields respecting quotes.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++; // skip next quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Normalizes email address.
 */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Checks basic email validity.
 */
function isValidEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizeEmail(email));
}

/**
 * Parses contacts from CSV text.
 */
export function parseContactsFromCsv(csvText: string): { contacts: ImportContactItem[]; errors: string[] } {
  const lines = csvText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { contacts: [], errors: ["CSV file is empty"] };

  const contacts: ImportContactItem[] = [];
  const errors: string[] = [];

  const firstFields = parseCsvLine(lines[0]);
  const lowerFields = firstFields.map((f) => f.toLowerCase().replace(/[\s_-]+/g, ""));

  let emailIdx = lowerFields.findIndex((f) => f === "email" || f === "emailaddress" || f === "mail" || f === "e-mail");
  let nameIdx = lowerFields.findIndex((f) => f === "name" || f === "fullname" || f === "displayname" || f === "contactname");
  let firstNameIdx = lowerFields.findIndex((f) => f === "firstname" || f === "givenname");
  let lastNameIdx = lowerFields.findIndex((f) => f === "lastname" || f === "familyname" || f === "surname");
  let notesIdx = lowerFields.findIndex((f) => f === "notes" || f === "note" || f === "description" || f === "comments");

  let startRow = 1;

  // Fallback: If no headers found and line 0 contains an email, treat as headerless
  if (emailIdx === -1) {
    const hasEmailInFirstRow = firstFields.findIndex((f) => isValidEmail(f));
    if (hasEmailInFirstRow !== -1) {
      emailIdx = hasEmailInFirstRow;
      nameIdx = hasEmailInFirstRow === 0 ? 1 : 0;
      notesIdx = 2;
      startRow = 0;
    } else {
      return { contacts: [], errors: ["Could not detect an 'Email' column in CSV header"] };
    }
  }

  for (let i = startRow; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const rawEmail = fields[emailIdx];
    if (!rawEmail) continue;

    if (!isValidEmail(rawEmail)) {
      errors.push(`Row ${i + 1}: Invalid email address "${rawEmail}"`);
      continue;
    }

    let name: string | null = null;
    if (nameIdx !== -1 && fields[nameIdx]) {
      name = fields[nameIdx];
    } else if (firstNameIdx !== -1 || lastNameIdx !== -1) {
      const parts = [
        firstNameIdx !== -1 ? fields[firstNameIdx] : "",
        lastNameIdx !== -1 ? fields[lastNameIdx] : "",
      ].filter(Boolean);
      if (parts.length > 0) name = parts.join(" ");
    }

    const notes = notesIdx !== -1 && fields[notesIdx] ? fields[notesIdx] : null;

    contacts.push({
      email: normalizeEmail(rawEmail),
      name: name || null,
      notes: notes || null,
    });
  }

  return { contacts, errors };
}

/**
 * Parses contacts from vCard (.vcf) text.
 */
export function parseContactsFromVCard(vcardText: string): { contacts: ImportContactItem[]; errors: string[] } {
  const contacts: ImportContactItem[] = [];
  const errors: string[] = [];

  const cards = vcardText.split(/BEGIN:VCARD/i).slice(1);
  if (cards.length === 0) {
    return { contacts: [], errors: ["No valid vCard records found"] };
  }

  for (let idx = 0; idx < cards.length; idx++) {
    const card = cards[idx];
    const lines = card.split(/\r?\n/);

    let name: string | null = null;
    let email: string | null = null;
    let notes: string | null = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.toUpperCase() === "END:VCARD") continue;

      if (/^FN(\;[^:]*)?:/i.test(line)) {
        name = line.substring(line.indexOf(":") + 1).trim();
      } else if (!name && /^N(\;[^:]*)?:/i.test(line)) {
        // N:Last;First;Middle;Prefix;Suffix
        const nValue = line.substring(line.indexOf(":") + 1);
        const parts = nValue.split(";").map((p) => p.trim());
        const last = parts[0] || "";
        const first = parts[1] || "";
        name = [first, last].filter(Boolean).join(" ") || null;
      } else if (/^EMAIL(\;[^:]*)?:/i.test(line)) {
        const val = line.substring(line.indexOf(":") + 1).trim();
        if (isValidEmail(val) && !email) {
          email = normalizeEmail(val);
        }
      } else if (/^NOTE(\;[^:]*)?:/i.test(line)) {
        let noteVal = line.substring(line.indexOf(":") + 1);
        noteVal = noteVal
          .replace(/\\n/gi, "\n")
          .replace(/\\,/g, ",")
          .replace(/\\;/g, ";")
          .replace(/\\\\/g, "\\");
        notes = noteVal.trim();
      }
    }

    if (email) {
      contacts.push({
        email,
        name: name || null,
        notes: notes || null,
      });
    } else {
      errors.push(`Record ${idx + 1}: Contact omitted because no valid email was found`);
    }
  }

  return { contacts, errors };
}

/**
 * Parses contacts from JSON text.
 */
export function parseContactsFromJson(jsonText: string): { contacts: ImportContactItem[]; errors: string[] } {
  const contacts: ImportContactItem[] = [];
  const errors: string[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return { contacts: [], errors: ["Invalid JSON format: " + (err as Error).message] };
  }

  let list: unknown[] = [];
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.contacts)) {
      list = obj.contacts;
    } else if (Array.isArray(obj.data)) {
      list = obj.data;
    } else {
      list = [obj];
    }
  }

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const emailVal = r.email || r.Email || r.mail || r.emailAddress;
    const nameVal = r.name || r.Name || r.fullName || r.displayName;
    const notesVal = r.notes || r.Notes || r.note || r.description;

    if (typeof emailVal !== "string" || !isValidEmail(emailVal)) {
      errors.push(`Item ${i + 1}: Missing or invalid email address`);
      continue;
    }

    contacts.push({
      email: normalizeEmail(emailVal),
      name: typeof nameVal === "string" && nameVal.trim() ? nameVal.trim() : null,
      notes: typeof notesVal === "string" && notesVal.trim() ? notesVal.trim() : null,
    });
  }

  return { contacts, errors };
}

/**
 * Autodetects format from filename or content and parses contacts.
 */
export function parseContactsFile(
  content: string,
  filename?: string,
): { contacts: ImportContactItem[]; errors: string[]; format: "csv" | "vcard" | "json" } {
  const ext = filename?.split(".").pop()?.toLowerCase();
  const trimmed = content.trim();

  if (ext === "json" || (trimmed.startsWith("{") || trimmed.startsWith("["))) {
    const res = parseContactsFromJson(content);
    return { ...res, format: "json" };
  }

  if (ext === "vcf" || ext === "vcard" || trimmed.toUpperCase().startsWith("BEGIN:VCARD")) {
    const res = parseContactsFromVCard(content);
    return { ...res, format: "vcard" };
  }

  // Default to CSV
  const res = parseContactsFromCsv(content);
  return { ...res, format: "csv" };
}
