import { afterEach, describe, expect, it } from "vitest";
import {
  _resetLiveEventsForTest,
  getAllBufferedEventsSince,
  getBufferedEventsSince,
  getLatestLiveEventId,
  LIVE_EVENTS_BOOT_ID,
  publishLiveEvent,
  subscribeAllCompanyLiveEvents,
} from "./live-events.js";

afterEach(() => {
  _resetLiveEventsForTest();
});

describe("live-events replay buffer", () => {
  it("replays a company's missed events after a since cursor", () => {
    publishLiveEvent({ companyId: "a", type: "activity.logged", payload: { n: 1 } });
    const second = publishLiveEvent({ companyId: "a", type: "activity.logged", payload: { n: 2 } });
    publishLiveEvent({ companyId: "b", type: "activity.logged" });
    const third = publishLiveEvent({ companyId: "a", type: "agent.status" });

    const replay = getBufferedEventsSince("a", second.id - 1);
    expect(replay.bridged).toBe(true);
    expect(replay.events.map((e) => e.id)).toEqual([second.id, third.id]);
  });

  it("does not buffer log-stream events, and skipping them stays bridged", () => {
    publishLiveEvent({ companyId: "a", type: "activity.logged" });
    const log = publishLiveEvent({ companyId: "a", type: "heartbeat.run.log", payload: { chunk: "x" } });
    publishLiveEvent({ companyId: "a", type: "heartbeat.run.event" });

    // A cursor pointing at the (unbuffered) log event replays nothing and
    // is still considered fully caught up.
    const replay = getBufferedEventsSince("a", log.id);
    expect(replay.bridged).toBe(true);
    expect(replay.events).toEqual([]);
  });

  it("reports unbridgeable when the buffer trimmed past the cursor", () => {
    const first = publishLiveEvent({ companyId: "a", type: "activity.logged" });
    for (let i = 0; i < 320; i += 1) {
      publishLiveEvent({ companyId: "a", type: "activity.logged", payload: { i } });
    }
    const replay = getBufferedEventsSince("a", first.id);
    expect(replay.bridged).toBe(false);
    expect(replay.events).toEqual([]);
  });

  it("merges all companies in id order for the portfolio feed", () => {
    const a1 = publishLiveEvent({ companyId: "a", type: "activity.logged" });
    const b1 = publishLiveEvent({ companyId: "b", type: "agent.status" });
    const a2 = publishLiveEvent({ companyId: "a", type: "activity.logged" });

    const replay = getAllBufferedEventsSince(0);
    expect(replay.bridged).toBe(true);
    expect(replay.events.map((e) => e.id)).toEqual([a1.id, b1.id, a2.id]);
  });

  it("fans every company event out to the all-companies channel", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeAllCompanyLiveEvents((event) => {
      seen.push(event.companyId);
    });
    publishLiveEvent({ companyId: "a", type: "activity.logged" });
    publishLiveEvent({ companyId: "b", type: "activity.logged" });
    unsubscribe();
    publishLiveEvent({ companyId: "c", type: "activity.logged" });
    expect(seen).toEqual(["a", "b"]);
  });

  it("exposes a stable boot id and the latest event id", () => {
    expect(LIVE_EVENTS_BOOT_ID).toMatch(/[0-9a-f-]{36}/);
    publishLiveEvent({ companyId: "a", type: "activity.logged" });
    expect(getLatestLiveEventId()).toBeGreaterThan(0);
  });
});
