import { describe, expect, it } from "vitest";
import { threadAttachments } from "./helpscout-attachments";

describe("threadAttachments", () => {
  it("maps embedded attachments to render shape", () => {
    const thread = {
      _embedded: {
        attachments: [
          { id: 123, filename: "invoice.pdf", mimeType: "application/pdf", size: 2048 },
        ],
      },
    };
    expect(threadAttachments(thread)).toEqual([
      { id: "123", filename: "invoice.pdf", mimeType: "application/pdf", size: 2048 },
    ]);
  });

  it("returns an empty list when nothing is embedded", () => {
    expect(threadAttachments({})).toEqual([]);
    expect(threadAttachments({ _embedded: {} })).toEqual([]);
    expect(threadAttachments({ _embedded: { attachments: [] } })).toEqual([]);
  });

  it("drops rows without an id, since they cannot be downloaded", () => {
    const thread = { _embedded: { attachments: [{ filename: "x.png" }, { id: 5 }] } };
    expect(threadAttachments(thread).map((a) => a.id)).toEqual(["5"]);
  });

  it("fills missing fields with honest placeholders", () => {
    const [item] = threadAttachments({ _embedded: { attachments: [{ id: "9" }] } });
    expect(item).toEqual({
      id: "9",
      filename: "attachment",
      mimeType: "application/octet-stream",
      size: 0,
    });
  });

  it("survives junk rows and non-numeric sizes", () => {
    const thread = {
      _embedded: {
        attachments: [null as never, { id: 1, size: Number.NaN }, { id: 2, size: "big" as never }],
      },
    };
    const items = threadAttachments(thread);
    expect(items.map((a) => a.size)).toEqual([0, 0]);
  });
});
