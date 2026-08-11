/**
 * @fileoverview Frontend API client for the print-tools plugin's UI bridge.
 *
 * The print-tools plugin registers a `print_text` bridge action alongside its
 * agent tools (same parameters, same company allow-list gate) so operator
 * surfaces can print without an agent run. This module wraps that action the
 * same way `emailTools.ts` wraps the email-tools bridge handlers.
 *
 * Requires print-tools v0.1.24 or later; older versions only expose the agent
 * tool and the bridge call fails with a "handler not found" error.
 */

import { pluginsApi } from "./plugins";

export const PRINT_TOOLS_PLUGIN_KEY = "print-tools";

export interface PrintTextResult {
  ok: boolean;
  /** The resolved printer the job was spooled to (name or "Windows default"). */
  printer: string;
}

function extract<T>(result: { data: unknown }): T {
  return result.data as T;
}

export function makePrintToolsApi(pluginId: string, companyId: string) {
  return {
    /**
     * Spool plain text to the configured default printer. Fire-and-forget:
     * resolves once Windows accepts the job, not when paper comes out.
     */
    printText: async (
      content: string,
      opts?: { jobTitle?: string },
    ): Promise<PrintTextResult> => {
      const result = await pluginsApi.bridgePerformAction(
        pluginId,
        "print_text",
        { companyId, content, ...(opts?.jobTitle ? { jobTitle: opts.jobTitle } : {}) },
        companyId,
      );
      return extract(result);
    },
  };
}
