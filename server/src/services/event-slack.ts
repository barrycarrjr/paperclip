import type { Db } from "@paperclipai/db";
import { secretService } from "./secrets.js";

/**
 * Send a Slack direct message (or channel post) on behalf of a calendar event
 * reminder. Resolves the company's `SLACK_BOT_TOKEN` secret and calls Slack's
 * `chat.postMessage` Web API.
 *
 * This never throws on a normal failure: a missing token, a non-ok Slack
 * response, or a network error all resolve to `{ ok: false, error }` so the
 * caller can record a delivery failure without aborting the fire.
 */
export async function sendEventSlackDm(
  db: Db,
  companyId: string,
  target: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  const secrets = secretService(db);
  try {
    const secret = await secrets.getByName(companyId, "SLACK_BOT_TOKEN");
    if (!secret) {
      return { ok: false, error: "SLACK_BOT_TOKEN secret not configured" };
    }
    const token = await secrets.resolveSecretValue(companyId, secret.id, "latest");

    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel: target, text }),
    });

    const data = (await response.json().catch(() => null)) as
      | { ok?: boolean; error?: string }
      | null;

    if (data?.ok === true) {
      return { ok: true };
    }
    return { ok: false, error: data?.error ?? `Slack request failed (${response.status})` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
