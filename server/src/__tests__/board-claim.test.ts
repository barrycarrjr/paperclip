import { describe, expect, it } from "vitest";
import {
  getBoardClaimWarningUrl,
  initializeBoardClaimChallenge,
} from "../board-claim.js";
import type { Db } from "@paperclipai/db";

describe("board-claim warning URL", () => {
  it("normalizes loopback hosts (127.0.0.1, ::1, 0.0.0.0) to localhost", async () => {
    // Mock db with only local-board as admin
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ userId: "local-board" }]),
        }),
      }),
    } as unknown as Db;

    await initializeBoardClaimChallenge(fakeDb, { deploymentMode: "authenticated" });

    const url127 = getBoardClaimWarningUrl("127.0.0.1", 3100);
    expect(url127).toBeTruthy();
    expect(url127).toMatch(/^http:\/\/localhost:3100\/board-claim\//);

    const urlWildcard = getBoardClaimWarningUrl("0.0.0.0", 3100);
    expect(urlWildcard).toMatch(/^http:\/\/localhost:3100\/board-claim\//);

    const urlIpv6 = getBoardClaimWarningUrl("::1", 3100);
    expect(urlIpv6).toMatch(/^http:\/\/localhost:3100\/board-claim\//);

    const urlExternal = getBoardClaimWarningUrl("192.168.1.50", 3100);
    expect(urlExternal).toMatch(/^http:\/\/192.168.1.50:3100\/board-claim\//);
  });
});
