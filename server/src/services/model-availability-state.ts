/**
 * What the daily model check saw last time, kept so it can say what changed:
 * which models are new since yesterday, and which agents it has already told
 * about a retiring or replaced model (so each is told once, not every day).
 *
 * A small JSON file in the instance's data folder. Losing it is harmless: the
 * next check records a fresh baseline without announcing anything, and
 * re-flags agents whose model still needs attention.
 *
 * @module server/services/model-availability-state
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";

export interface SeenModel {
  label?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  status?: string;
  retiresAt?: string;
}

export interface AgentModelNotice {
  /** `<model>|<state>`: a notice is logged again only when this changes. */
  key: string;
  notedAt: string;
}

export interface ModelAvailabilityState {
  version: 1;
  adapters: Record<string, { checkedAt: string; models: Record<string, SeenModel> }>;
  agentNotices: Record<string, AgentModelNotice>;
}

export function emptyModelAvailabilityState(): ModelAvailabilityState {
  return { version: 1, adapters: {}, agentNotices: {} };
}

export function modelAvailabilityStateFile(): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "data", "model-availability.json");
}

export async function readModelAvailabilityState(file = modelAvailabilityStateFile()): Promise<ModelAvailabilityState> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<ModelAvailabilityState>;
    if (parsed?.version !== 1 || typeof parsed.adapters !== "object" || parsed.adapters === null) {
      return emptyModelAvailabilityState();
    }
    return {
      version: 1,
      adapters: parsed.adapters,
      agentNotices: typeof parsed.agentNotices === "object" && parsed.agentNotices !== null ? parsed.agentNotices : {},
    };
  } catch {
    return emptyModelAvailabilityState();
  }
}

export async function writeModelAvailabilityState(
  state: ModelAvailabilityState,
  file = modelAvailabilityStateFile(),
): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(temp, file);
  } catch (err) {
    logger.warn({ err, file }, "could not save what the model check saw; the next check starts a fresh baseline");
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}
