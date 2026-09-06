import { describe, expect, it, vi } from "vitest";
import { OUTBOUND_TOOL_DRAFT_GATE, OUTBOUND_SELF_RECIPIENT_RULES, outboundToolLabel } from "@paperclipai/shared";

/**
 * Pins every public-posting tool to the approval hold.
 *
 * Until 2026-09-06 the gate held only messaging tools, so a review reply, a
 * social post, a YouTube upload or a KDP publish went to the open internet
 * with no hold at all while an email to one person waited for approval. If
 * any of these ever drops out of the list, this fails rather than the
 * behaviour quietly reverting.
 */
const PUBLIC_POST_TOOLS = [
  "gbp-reviews:gbp_reply_to_review",
  "social-poster:post_to_facebook",
  "social-poster:post_to_instagram",
  "social-poster:post_to_x",
  "social-poster:post_to_tiktok",
  "social-poster:post_to_threads",
  "instagram-tools:instagram_post_photo",
  "instagram-tools:instagram_post_carousel",
  "instagram-tools:instagram_post_reel",
  "instagram-tools:instagram_post_story",
  "youtube-tools:youtube_upload",
  "youtube-tools:youtube_post_comment",
  "kdp-tools:kdp_publish",
] as const;

describe("public posts are held for approval", () => {
  it.each(PUBLIC_POST_TOOLS)("%s is in the outbound gate", (tool) => {
    expect(OUTBOUND_TOOL_DRAFT_GATE).toContain(tool);
  });

  it.each(PUBLIC_POST_TOOLS)("%s can never be treated as self-addressed", (tool) => {
    // The self-recipient map is a BYPASS list. A public post has no
    // recipient address and must never be let through as "a note to myself".
    expect(Object.keys(OUTBOUND_SELF_RECIPIENT_RULES)).not.toContain(tool);
  });

  it.each(PUBLIC_POST_TOOLS)("%s has a readable label, not the raw tool name", (tool) => {
    const label = outboundToolLabel(tool);
    expect(label).not.toBe(tool.split(":").pop());
    expect(label).not.toContain("_");
  });

  it("does not gate a tool that only moves a local file", () => {
    // youtube_mark_posted moves a video between two local folders. Holding
    // it would ask for approval to tidy the operator's own disk.
    expect(OUTBOUND_TOOL_DRAFT_GATE).not.toContain("youtube-tools:youtube_mark_posted");
  });
});

describe("the approval card shows what a public post says", () => {
  // Every gated tool used to summarise to its bare name whenever its field
  // names were not in the messaging-shaped candidate list, so the operator
  // was asked to approve a public post without seeing a word of it.
  async function summarise(tool: string, params: Record<string, unknown>) {
    vi.resetModules();
    vi.doMock("../services/instance-settings.js", () => ({
      instanceSettingsService: () => ({
        getGeneral: async () => ({ outboundToolDraftMode: true, selfNotify: { skipApproval: false, slackUserIds: [], emails: [], phoneNumbers: [] } }),
      }),
    }));
    const created: Array<{ payload: { summary: string } }> = [];
    vi.doMock("../services/approvals.js", () => ({
      approvalService: () => ({
        create: async (_companyId: string, row: { payload: { summary: string } }) => {
          created.push(row);
          return { id: "ap-1", ...row };
        },
      }),
    }));
    vi.doMock("../services/activity-log.js", () => ({ logActivity: async () => {} }));
    const { createDraftGate } = await import("../services/tool-draft-gate.js");
    const gate = createDraftGate({ db: {} as never });
    const result = await gate.intercept(tool, params, {
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    } as never);
    expect(result.intercepted).toBe(true);
    return created[0]?.payload.summary ?? "";
  }

  it("shows the reply text and location for a Google review reply", async () => {
    const summary = await summarise("gbp-reviews:gbp_reply_to_review", {
      reviewName: "accounts/1/locations/2/reviews/x",
      locationKey: "main-st",
      replyText: "Thank you for coming in, we are glad the repair held up.",
    });
    expect(summary).toContain("main-st");
    expect(summary).toContain("Thank you for coming in");
    expect(summary).not.toBe("gbp-reviews:gbp_reply_to_review");
  });

  it("shows the caption for a social post", async () => {
    const summary = await summarise("social-poster:post_to_facebook", {
      page: "acme-shop",
      caption: "Open late this Friday.",
    });
    expect(summary).toContain("acme-shop");
    expect(summary).toContain("Open late this Friday");
  });

  it("shows the title for a YouTube upload", async () => {
    const summary = await summarise("youtube-tools:youtube_upload", {
      account: "main",
      title: "How we resurface a driveway",
      filePath: "/videos/driveway.mp4",
    });
    expect(summary).toContain("How we resurface a driveway");
  });
});
