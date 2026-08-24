import { describe, expect, it } from "vitest";
import {
  allAttachmentsReady,
  base64ToBlob,
  createPendingAttachment,
  dataUrlToBase64,
  failPendingAttachment,
  removePendingAttachment,
  resolvePendingAttachment,
  toEmailSendAttachments,
  toHelpScoutSendAttachments,
  visibleEmailAttachments,
  type PendingAttachment,
} from "./attachments";

const file = { name: "report.pdf", type: "application/pdf", size: 1024 };

describe("createPendingAttachment", () => {
  it("starts an in-limit file in the reading state", () => {
    const item = createPendingAttachment(file, 10 * 1024);
    expect(item.status).toBe("reading");
    expect(item.name).toBe("report.pdf");
    expect(item.mime).toBe("application/pdf");
    expect(item.size).toBe(1024);
    expect(item.error).toBeUndefined();
  });

  it("rejects an over-limit file immediately, naming both sizes", () => {
    const item = createPendingAttachment({ ...file, size: 30 * 1024 * 1024 }, 25 * 1024 * 1024);
    expect(item.status).toBe("error");
    expect(item.error).toContain("30.0 MB");
    expect(item.error).toContain("25.0 MB");
  });

  it("accepts a file exactly at the limit", () => {
    expect(createPendingAttachment({ ...file, size: 100 }, 100).status).toBe("reading");
  });

  it("defaults a missing MIME type to octet-stream", () => {
    expect(createPendingAttachment({ ...file, type: "" }, 10_000).mime).toBe(
      "application/octet-stream",
    );
  });

  it("gives two picks of the same file distinct ids", () => {
    const a = createPendingAttachment(file, 10_000);
    const b = createPendingAttachment(file, 10_000);
    expect(a.id).not.toBe(b.id);
  });
});

describe("pending attachment transitions", () => {
  const reading = createPendingAttachment(file, 10_000);

  it("resolves a reading item to ready with its content", () => {
    const [item] = resolvePendingAttachment([reading], reading.id, "QUJD");
    expect(item.status).toBe("ready");
    expect(item.contentBase64).toBe("QUJD");
  });

  it("fails a reading item with the message", () => {
    const [item] = failPendingAttachment([reading], reading.id, "boom");
    expect(item.status).toBe("error");
    expect(item.error).toBe("boom");
  });

  it("leaves other items alone", () => {
    const other = createPendingAttachment({ ...file, name: "other.txt" }, 10_000);
    const next = resolvePendingAttachment([reading, other], reading.id, "QUJD");
    expect(next[1].status).toBe("reading");
  });

  it("removes by id", () => {
    expect(removePendingAttachment([reading], reading.id)).toEqual([]);
  });
});

describe("allAttachmentsReady", () => {
  const ready: PendingAttachment = {
    id: "1",
    name: "a",
    mime: "text/plain",
    size: 1,
    status: "ready",
    contentBase64: "QQ==",
  };

  it("is true for an empty list", () => {
    expect(allAttachmentsReady([])).toBe(true);
  });

  it("is false while anything is still reading", () => {
    expect(allAttachmentsReady([ready, { ...ready, id: "2", status: "reading" }])).toBe(false);
  });

  it("counts error chips as settled: they block nothing, they just aren't sent", () => {
    expect(allAttachmentsReady([ready, { ...ready, id: "2", status: "error" }])).toBe(true);
  });
});

describe("send-shape mappers", () => {
  const list: PendingAttachment[] = [
    { id: "1", name: "a.txt", mime: "text/plain", size: 1, status: "ready", contentBase64: "QQ==" },
    { id: "2", name: "b.txt", mime: "text/plain", size: 1, status: "error", error: "too big" },
    { id: "3", name: "c.txt", mime: "text/plain", size: 1, status: "reading" },
  ];

  it("sends only ready items in the email shape", () => {
    expect(toEmailSendAttachments(list)).toEqual([
      { name: "a.txt", mime: "text/plain", contentBase64: "QQ==" },
    ]);
  });

  it("sends only ready items in the Help Scout shape", () => {
    expect(toHelpScoutSendAttachments(list)).toEqual([
      { fileName: "a.txt", mimeType: "text/plain", contentBase64: "QQ==" },
    ]);
  });
});

describe("visibleEmailAttachments", () => {
  it("hides inline attachments and keeps the rest", () => {
    const rows = [
      { partId: "1", inline: true },
      { partId: "2", inline: false },
      { partId: "3" },
    ];
    expect(visibleEmailAttachments(rows).map((r) => r.partId)).toEqual(["2", "3"]);
  });
});

describe("dataUrlToBase64", () => {
  it("strips the data URL prefix", () => {
    expect(dataUrlToBase64("data:text/plain;base64,SGVsbG8=")).toBe("SGVsbG8=");
  });

  it("keeps commas inside the payload", () => {
    expect(dataUrlToBase64("data:x;base64,a,b")).toBe("a,b");
  });

  it("rejects a non data URL", () => {
    expect(() => dataUrlToBase64("SGVsbG8=")).toThrow();
  });
});

describe("base64ToBlob", () => {
  it("round-trips bytes and carries the MIME type", async () => {
    const blob = base64ToBlob("SGVsbG8=", "text/plain");
    expect(blob.type).toBe("text/plain");
    expect(await blob.text()).toBe("Hello");
  });

  it("defaults a missing MIME type to octet-stream", () => {
    expect(base64ToBlob("SGVsbG8=", "").type).toBe("application/octet-stream");
  });
});
