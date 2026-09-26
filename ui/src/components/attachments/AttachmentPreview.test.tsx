// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueAttachment } from "@paperclipai/shared";
import {
  AttachmentPreviewBody,
  AttachmentViewerModal,
  attachmentPreviewKind,
  describeAttachmentUploader,
  readTextPreview,
  TEXT_PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_MAX_LINES,
} from "./AttachmentPreview";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  vi.unstubAllGlobals();
});

function attachment(overrides: Partial<IssueAttachment> & { id: string; contentType: string }): IssueAttachment {
  return {
    companyId: "c1",
    issueId: "i1",
    issueCommentId: null,
    assetId: `asset-${overrides.id}`,
    provider: "local",
    objectKey: `k/${overrides.id}`,
    byteSize: 2048,
    sha256: "x",
    originalFilename: `${overrides.id}.bin`,
    createdByAgentId: null,
    createdByUserId: "u1",
    createdAt: new Date("2026-09-20T12:00:00Z"),
    updatedAt: new Date("2026-09-20T12:00:00Z"),
    contentPath: `/api/attachments/${overrides.id}/content`,
    ...overrides,
  } as IssueAttachment;
}

function streamResponse(text: string, chunkSize = 1000) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
    cancel,
  });
  return { response: new Response(body, { status: 200 }), cancel, pulled: () => offset };
}

describe("attachmentPreviewKind", () => {
  it("sorts files into the preview they can get", () => {
    expect(attachmentPreviewKind("application/pdf")).toBe("pdf");
    expect(attachmentPreviewKind("image/png")).toBe("image");
    expect(attachmentPreviewKind("text/plain")).toBe("text");
    expect(attachmentPreviewKind("text/markdown; charset=utf-8")).toBe("text");
    expect(attachmentPreviewKind("text/csv")).toBe("text");
    expect(attachmentPreviewKind("application/json")).toBe("text");
    expect(attachmentPreviewKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("none");
    expect(attachmentPreviewKind("application/zip")).toBe("none");
    expect(attachmentPreviewKind("text/html")).toBe("none");
    expect(attachmentPreviewKind(null)).toBe("none");
  });
});

describe("describeAttachmentUploader", () => {
  const agents = new Map([["a1", { name: "Corporate Operations" }]]);
  const users = new Map([["u1", { label: "Pat" }]]);
  it("names the agent or person who uploaded the file", () => {
    expect(describeAttachmentUploader({ createdByAgentId: "a1", createdByUserId: null }, agents, users)).toBe("Corporate Operations");
    expect(describeAttachmentUploader({ createdByAgentId: null, createdByUserId: "u1" }, agents, users)).toBe("Pat");
  });
  it("falls back when the uploader is not in the directory", () => {
    expect(describeAttachmentUploader({ createdByAgentId: "gone", createdByUserId: null }, agents, users)).toBe("an agent");
    expect(describeAttachmentUploader({ createdByAgentId: null, createdByUserId: "gone" }, agents, null)).toBe("a person");
    expect(describeAttachmentUploader({ createdByAgentId: null, createdByUserId: null }, agents, users)).toBe("unknown");
  });
});

describe("readTextPreview", () => {
  it("stops reading after the byte limit and cancels the rest of the download", async () => {
    const { response, cancel, pulled } = streamResponse("x".repeat(100_000));
    const preview = await readTextPreview("/f", { fetchImpl: vi.fn().mockResolvedValue(response) });
    expect(preview.text.length).toBe(TEXT_PREVIEW_MAX_BYTES);
    expect(preview.truncated).toBe(true);
    expect(pulled()).toBeLessThan(10_000);
    expect(cancel).toHaveBeenCalled();
  });

  it("caps the number of lines", async () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const { response } = streamResponse(text);
    const preview = await readTextPreview("/f", { fetchImpl: vi.fn().mockResolvedValue(response) });
    expect(preview.text.split("\n")).toHaveLength(TEXT_PREVIEW_MAX_LINES);
    expect(preview.truncated).toBe(true);
  });

  it("does not mark a short file, or one exactly at the limit, as cut short", async () => {
    const small = await readTextPreview("/f", { fetchImpl: vi.fn().mockResolvedValue(streamResponse("a,b\n1,2").response) });
    expect(small).toEqual({ text: "a,b\n1,2", truncated: false });
    const exact = await readTextPreview("/f", {
      fetchImpl: vi.fn().mockResolvedValue(streamResponse("y".repeat(TEXT_PREVIEW_MAX_BYTES), 512).response),
    });
    expect(exact.truncated).toBe(false);
  });

  it("reports a failed load", async () => {
    await expect(
      readTextPreview("/f", { fetchImpl: vi.fn().mockResolvedValue(new Response("nope", { status: 404 })) }),
    ).rejects.toThrow("404");
  });
});

describe("AttachmentPreviewBody", () => {
  it("shows a PDF's first page without the viewer toolbar", () => {
    mount(<AttachmentPreviewBody attachment={attachment({ id: "p", contentType: "application/pdf" })} />);
    const frame = container!.querySelector<HTMLIFrameElement>("[data-testid=attachment-pdf-preview]");
    expect(frame?.getAttribute("src")).toBe("/api/attachments/p/content#page=1&toolbar=0&navpanes=0&view=FitH");
    expect(frame?.getAttribute("loading")).toBe("lazy");
  });

  it("shows the start of a text file", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse("hello\nworld").response));
    mount(<AttachmentPreviewBody attachment={attachment({ id: "t", contentType: "text/plain" })} />);
    await settle();
    await settle();
    expect(container!.querySelector("[data-testid=attachment-text-preview]")?.textContent).toBe("hello\nworld");
  });

  it("says when a file type has no preview", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    mount(<AttachmentPreviewBody attachment={attachment({ id: "d", contentType: "application/msword" })} />);
    expect(container!.querySelector("[data-testid=attachment-no-preview]")?.textContent).toContain("No preview for this file type");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("AttachmentViewerModal", () => {
  const files = [
    attachment({ id: "img", contentType: "image/png", originalFilename: "photo.png" }),
    attachment({ id: "pdf", contentType: "application/pdf", originalFilename: "report.pdf" }),
    attachment({ id: "doc", contentType: "application/msword", originalFilename: "letter.doc" }),
  ];

  function position() {
    return document.querySelector("[data-testid=attachment-viewer-position]")?.textContent;
  }
  function title() {
    return document.querySelector("[data-testid=attachment-viewer] h2")?.textContent;
  }

  it("steps through every attachment with the buttons and arrow keys, wrapping at the ends", () => {
    mount(<AttachmentViewerModal attachments={files} initialIndex={1} open onOpenChange={() => {}} />);
    expect(position()).toBe("2 / 3");
    expect(title()).toBe("report.pdf");

    act(() => {
      document.querySelector<HTMLButtonElement>("button[aria-label='Next attachment']")!.click();
    });
    expect(title()).toBe("letter.doc");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    });
    expect(position()).toBe("1 / 3");
    expect(title()).toBe("photo.png");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    });
    expect(title()).toBe("letter.doc");
  });

  it("offers a download of the current file instead of opening it", () => {
    mount(<AttachmentViewerModal attachments={files} initialIndex={1} open onOpenChange={() => {}} />);
    const link = document.querySelector<HTMLAnchorElement>("a[aria-label='Download report.pdf']");
    expect(link?.getAttribute("href")).toBe("/api/attachments/pdf/content");
    expect(link?.getAttribute("download")).toBe("report.pdf");
    expect(link?.getAttribute("target")).toBeNull();
  });

  it("closes on Escape", () => {
    const onOpenChange = vi.fn();
    mount(<AttachmentViewerModal attachments={files} initialIndex={0} open onOpenChange={onOpenChange} />);
    act(() => {
      document
        .querySelector("[data-testid=attachment-viewer]")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
