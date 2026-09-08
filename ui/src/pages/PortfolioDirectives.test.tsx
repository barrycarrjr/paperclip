// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Company, DirectivePreview } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PortfolioDirectives } from "./PortfolioDirectives";

const mockIssuesApi = vi.hoisted(() => ({
  listPortfolioDirectives: vi.fn(),
  previewDirective: vi.fn(),
  broadcastDirective: vi.fn(),
}));

const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../hooks/useRouteCompany", () => ({
  useActiveCompanyId: () => "hq-1",
  useIsActiveCompanyPortfolioRoot: () => true,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: mockPushToast }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
}));

// Radix portals and pointer-event plumbing jsdom does not have. The panel's
// own behaviour is what these tests pin, not the dialog shell.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children, ...props }: ComponentProps<"div">) => <div {...props}>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const INTENT = "Reply to every Google review within a day";

function company(id: string, name: string, isPortfolioRoot = false): Company {
  return {
    id,
    name,
    isPortfolioRoot,
    issuePrefix: name.slice(0, 3).toUpperCase(),
    logoUrl: null,
    brandColor: null,
    status: "active",
  } as unknown as Company;
}

function previewResponse(overrides: Partial<DirectivePreview> = {}): DirectivePreview {
  return {
    previewId: "preview-abc",
    intent: INTENT,
    title: `Directive: ${INTENT}`,
    willReceive: [
      { companyId: "c1", companyName: "Acme", lead: { id: "ceo-1", name: "Ada" } },
      { companyId: "c2", companyName: "Globex", lead: { id: "ceo-2", name: "Bao" } },
    ],
    skipped: [
      { companyId: "c3", companyName: "Initech", reason: "No CEO or top-level agent to delegate to" },
    ],
    guardrails: { outboundHold: true },
    summaryLines: [
      "Goes to 2 companies, named below with the lead who receives it.",
      "Creates one request in each of them. Nothing else exists until each lead acts on it.",
      "1 company is left out. The reasons are below.",
      "Emails, messages, calls and public posts the agents draft will wait for your approval first.",
      "Nothing has been sent yet. Nothing happens until you send it.",
    ],
    ...overrides,
  };
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function teardown() {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
}

async function renderPage() {
  mockIssuesApi.listPortfolioDirectives.mockResolvedValue({
    directives: [],
    companies: [
      company("hq-1", "HQ", true),
      company("c1", "Acme"),
      company("c2", "Globex"),
      company("c3", "Initech"),
    ],
  });

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <PortfolioDirectives />
      </QueryClientProvider>,
    );
  });
  await flush();
  return container!;
}

function buttonNamed(label: string): HTMLButtonElement | undefined {
  return [...(container?.querySelectorAll("button") ?? [])].find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
}

function click(el: Element | undefined) {
  if (!el) throw new Error("nothing to click");
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function typeIntent(value: string) {
  const textarea = container?.querySelector("textarea") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openDialogAndPreview() {
  click(buttonNamed("New directive"));
  await flush();
  typeIntent(INTENT);
  click(buttonNamed("Preview"));
  await flush();
}

beforeEach(() => {
  mockIssuesApi.listPortfolioDirectives.mockReset();
  mockIssuesApi.previewDirective.mockReset();
  mockIssuesApi.broadcastDirective.mockReset();
  mockPushToast.mockReset();
  mockIssuesApi.previewDirective.mockResolvedValue(previewResponse());
  mockIssuesApi.broadcastDirective.mockResolvedValue({
    directiveId: "d-1",
    intent: INTENT,
    title: `Directive: ${INTENT}`,
    dispatched: [
      { companyId: "c1", companyName: "Acme", ceoAgentId: "ceo-1", ceoAgentName: "Ada", issueId: "i1", issueIdentifier: "ACM-1" },
      { companyId: "c2", companyName: "Globex", ceoAgentId: "ceo-2", ceoAgentName: "Bao", issueId: "i2", issueIdentifier: "GLO-1" },
    ],
    skipped: [],
  });
});

afterEach(() => {
  teardown();
  vi.clearAllMocks();
});

describe("Portfolio directives: the preview before a broadcast", () => {
  it("asks the server what would happen, and sends nothing while doing it", async () => {
    await renderPage();
    await openDialogAndPreview();

    expect(mockIssuesApi.previewDirective).toHaveBeenCalledTimes(1);
    expect(mockIssuesApi.previewDirective).toHaveBeenCalledWith("hq-1", {
      intent: INTENT,
      companyIds: undefined,
    });
    // Asking must not send.
    expect(mockIssuesApi.broadcastDirective).not.toHaveBeenCalled();
  });

  it("shows the companies that get it, who receives it in each, who is left out and why, and the approval hold", async () => {
    const el = await renderPage();
    await openDialogAndPreview();
    const text = el.textContent ?? "";

    expect(text).toContain("Before this goes out");
    expect(text).toContain("Goes to 2 companies, named below with the lead who receives it.");
    expect(text).toContain("Creates one request in each of them. Nothing else exists until each lead acts on it.");
    expect(text).toContain(
      "Emails, messages, calls and public posts the agents draft will wait for your approval first.",
    );
    expect(text).toContain("Nothing has been sent yet. Nothing happens until you send it.");

    // Named companies, and the agent in each one who picks it up.
    expect(text).toContain("Who receives it");
    expect(text).toContain("Acme");
    expect(text).toContain("Ada");
    expect(text).toContain("Globex");
    expect(text).toContain("Bao");

    // The skip reason is the server's, shown word for word.
    expect(text).toContain("Left out, and why");
    expect(text).toContain("Initech: No CEO or top-level agent to delegate to");

    // The send button counts the leads the server named, not the picker.
    expect(buttonNamed("Send to 2 leads")).toBeDefined();
  });

  it("sends only what the preview answered for, carrying that preview's id", async () => {
    await renderPage();
    await openDialogAndPreview();

    click(buttonNamed("Send to 2 leads"));
    await flush();

    expect(mockIssuesApi.broadcastDirective).toHaveBeenCalledTimes(1);
    expect(mockIssuesApi.broadcastDirective).toHaveBeenCalledWith("hq-1", {
      intent: INTENT,
      companyIds: undefined,
      previewId: "preview-abc",
    });
  });

  it("leaves nothing behind when the owner cancels at the preview", async () => {
    const el = await renderPage();
    await openDialogAndPreview();

    click(buttonNamed("Cancel"));
    await flush();

    expect(mockIssuesApi.broadcastDirective).not.toHaveBeenCalled();
    expect(mockPushToast).not.toHaveBeenCalled();
    // The dialog is gone, and nothing was created to have to undo.
    expect(el.textContent ?? "").not.toContain("Before this goes out");
  });

  it("drops the preview when the owner goes back to edit, so a stale one cannot be sent", async () => {
    const el = await renderPage();
    await openDialogAndPreview();

    click(buttonNamed("Back"));
    await flush();

    expect(el.querySelector("textarea")).not.toBeNull();
    expect(buttonNamed("Send to 2 leads")).toBeUndefined();
    expect(mockIssuesApi.broadcastDirective).not.toHaveBeenCalled();
  });

  it("will not offer to send when the server says no company would receive it", async () => {
    mockIssuesApi.previewDirective.mockResolvedValue(
      previewResponse({
        willReceive: [],
        summaryLines: [
          "No company will receive this, so nothing would be sent.",
          "1 company is left out. The reasons are below.",
          "Emails, messages, calls and public posts the agents draft will wait for your approval first.",
          "Nothing has been sent yet. Nothing happens until you send it.",
        ],
      }),
    );
    const el = await renderPage();
    await openDialogAndPreview();

    expect(el.textContent).toContain("No company will receive this, so nothing would be sent.");
    expect(buttonNamed("Send to 0 leads")?.disabled).toBe(true);
  });

  it("says what went wrong when the preview itself fails, and still sends nothing", async () => {
    mockIssuesApi.previewDirective.mockRejectedValue(new Error("Portfolio root access required"));
    const el = await renderPage();
    await openDialogAndPreview();

    expect(el.textContent).toContain("Portfolio root access required");
    expect(mockIssuesApi.broadcastDirective).not.toHaveBeenCalled();
  });
});
