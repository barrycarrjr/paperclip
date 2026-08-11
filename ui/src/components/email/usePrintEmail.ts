import { useMutation } from "@tanstack/react-query";
import { makePrintToolsApi } from "../../api/printTools";
import {
  usePrintToolsPlugin,
  type PrintToolsAvailability,
} from "../../hooks/usePrintToolsPlugin";
import type { ParsedEmailMessage } from "../../api/emailTools";

/**
 * Plain-text rendering of an email for the printer: a short header block,
 * then the body. HTML-only messages fall back to the markdown conversion the
 * email-tools plugin already produces, so what prints matches what the
 * operator reads in the text view.
 */
export function buildEmailPrintText(msg: ParsedEmailMessage): string {
  return [
    `From: ${msg.from}`,
    msg.to.length > 0 ? `To: ${msg.to.join(", ")}` : null,
    `Date: ${new Date(msg.date).toLocaleString()}`,
    `Subject: ${msg.subject || "(no subject)"}`,
    "",
    msg.text || msg.markdown || "(no body)",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** Hover text for the Print control in each availability state. */
export function printTooltip(availability: PrintToolsAvailability): string {
  switch (availability) {
    case "ready":
      return "Print";
    case "inactive":
      return "To print, turn the Print Tools extension back on (Plugins page).";
    case "missing":
      return "To print, install the Print Tools extension (Plugins page).";
  }
}

export interface PrintEmailHooks {
  /** One-line outcome for the operator ("Sent to printer ..." or the failure). */
  onDone?: (text: string) => void;
}

/**
 * The email viewer's Print control, shared by every surface that shows an
 * open message (the pop-out dialog and the Email page's detail pane).
 *
 * The button always renders. When the print-tools plugin is off it greys out
 * with a hint saying how to turn it on, instead of vanishing — a missing
 * button reads as "Paperclip cannot print" and hides the feature. When the
 * plugin is on, clicking prints the open message through the plugin's UI
 * bridge action, scoped to the mailbox's company.
 */
export function usePrintEmail(
  companyId: string | null | undefined,
  hooks: PrintEmailHooks = {},
) {
  const { pluginId, availability, isLoading } = usePrintToolsPlugin();

  const print = useMutation({
    mutationFn: async (msg: ParsedEmailMessage) => {
      if (!pluginId || availability !== "ready") {
        throw new Error("The Print Tools extension is not active.");
      }
      if (!companyId) throw new Error("No company selected.");
      const api = makePrintToolsApi(pluginId, companyId);
      return api.printText(buildEmailPrintText(msg), {
        jobTitle: msg.subject || "Email",
      });
    },
    onSuccess: (result) => {
      hooks.onDone?.(`Sent to printer (${result.printer})`);
    },
    onError: (err) => {
      hooks.onDone?.(
        `Print failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    },
  });

  return {
    availability,
    isLoading,
    tooltip: printTooltip(availability),
    /** True when the operator can click Print right now. */
    canPrint: availability === "ready",
    print,
  };
}
