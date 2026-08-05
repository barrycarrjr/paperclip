import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { LiveEvent, LiveEventType } from "@paperclipai/shared";

type LiveEventPayload = Record<string, unknown>;
type LiveEventListener = (event: LiveEvent) => void;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let nextEventId = 0;

/**
 * Identifies this process's event-id namespace. Event ids reset to 0 on
 * every boot, so a client's "give me everything after id N" cursor is only
 * meaningful while the boot id it was minted under still matches. The
 * websocket hello frame carries it; a mismatch means the client must do a
 * cold resync instead of trusting replay.
 */
export const LIVE_EVENTS_BOOT_ID = randomUUID();

/**
 * Internal channel that receives every company's events, powering the
 * portfolio-wide feed. Company ids are UUIDs so the name can't collide.
 */
const ALL_COMPANIES_CHANNEL = "__all__";

/**
 * Bounded per-company replay buffers so a reconnecting client can catch up
 * on what it missed instead of losing it. Log/tool-stream events are
 * deliberately NOT buffered: they dominate volume (one event per output
 * chunk, up to 8 KiB each), the provider ignores them anyway, and the run
 * transcript has its own REST catch-up (afterSeq).
 *
 * The buffer lives in process memory on purpose: today a single server
 * process owns every publish and every socket. If a second process ever
 * writes to the same database, its events will be invisible here (not just
 * delayed) and this buffer becomes a correctness bug - revisit then.
 */
const REPLAY_BUFFER_MAX_PER_COMPANY = 300;
const UNBUFFERED_EVENT_TYPES = new Set<LiveEventType>([
  "heartbeat.run.log",
  "heartbeat.run.event",
]);

interface CompanyReplayBuffer {
  events: LiveEvent[];
  /** Highest event id ever evicted; a since-cursor below this is unbridgeable. */
  trimmedBelowId: number;
}

const replayBuffers = new Map<string, CompanyReplayBuffer>();

function bufferEvent(event: LiveEvent) {
  if (UNBUFFERED_EVENT_TYPES.has(event.type)) return;
  let buffer = replayBuffers.get(event.companyId);
  if (!buffer) {
    buffer = { events: [], trimmedBelowId: 0 };
    replayBuffers.set(event.companyId, buffer);
  }
  buffer.events.push(event);
  while (buffer.events.length > REPLAY_BUFFER_MAX_PER_COMPANY) {
    const evicted = buffer.events.shift();
    if (evicted) buffer.trimmedBelowId = evicted.id;
  }
}

export interface ReplayResult {
  events: LiveEvent[];
  /**
   * True when the buffer provably covers everything after the cursor
   * (ignoring unbuffered log-stream types). False means the gap cannot be
   * bridged and the client must cold-resync.
   */
  bridged: boolean;
}

/** Buffered events after `sinceId` for one company. */
export function getBufferedEventsSince(companyId: string, sinceId: number): ReplayResult {
  const buffer = replayBuffers.get(companyId);
  if (!buffer) return { events: [], bridged: true };
  if (sinceId < buffer.trimmedBelowId) return { events: [], bridged: false };
  return { events: buffer.events.filter((event) => event.id > sinceId), bridged: true };
}

/** Buffered events after `sinceId` across every company, merged in id order. */
export function getAllBufferedEventsSince(sinceId: number): ReplayResult {
  const merged: LiveEvent[] = [];
  let bridged = true;
  for (const buffer of replayBuffers.values()) {
    if (sinceId < buffer.trimmedBelowId) bridged = false;
    for (const event of buffer.events) {
      if (event.id > sinceId) merged.push(event);
    }
  }
  merged.sort((a, b) => a.id - b.id);
  return { events: bridged ? merged : [], bridged };
}

export function getLatestLiveEventId(): number {
  return nextEventId;
}

/** Test-only: clears buffers and the id counter. */
export function _resetLiveEventsForTest() {
  replayBuffers.clear();
  nextEventId = 0;
  emitter.removeAllListeners();
}

function toLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}): LiveEvent {
  nextEventId += 1;
  return {
    id: nextEventId,
    companyId: input.companyId,
    type: input.type,
    createdAt: new Date().toISOString(),
    payload: input.payload ?? {},
  };
}

export function publishLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  const event = toLiveEvent(input);
  bufferEvent(event);
  emitter.emit(input.companyId, event);
  emitter.emit(ALL_COMPANIES_CHANNEL, event);
  return event;
}

export function publishGlobalLiveEvent(input: {
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  const event = toLiveEvent({ companyId: "*", type: input.type, payload: input.payload });
  emitter.emit("*", event);
  return event;
}

export function subscribeCompanyLiveEvents(companyId: string, listener: LiveEventListener) {
  emitter.on(companyId, listener);
  return () => emitter.off(companyId, listener);
}

/** Every company's events, for the portfolio-wide feed. */
export function subscribeAllCompanyLiveEvents(listener: LiveEventListener) {
  emitter.on(ALL_COMPANIES_CHANNEL, listener);
  return () => emitter.off(ALL_COMPANIES_CHANNEL, listener);
}

export function subscribeGlobalLiveEvents(listener: LiveEventListener) {
  emitter.on("*", listener);
  return () => emitter.off("*", listener);
}
