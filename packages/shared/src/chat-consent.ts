/** Only unambiguous replies to one visible pending prompt count as consent. */
export function parseInlineConsentReply(text: string): "approve" | "deny" | null {
  const value = text.trim().toLowerCase().replace(/[.!]+$/g, "").replace(/\s+/g, " ");
  if (["yes", "yes please", "yes, do it", "yes do it", "ok", "okay", "ok do it", "okay do it",
    "ok, do it", "okay, do it", "do it", "go ahead", "approved", "approve", "just fix it"].includes(value)) return "approve";
  if (["no", "no thanks", "no, don't", "don't", "do not", "deny", "stop", "cancel"].includes(value)) return "deny";
  return null;
}
