// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedEmailMessage } from "../../api/emailTools";
import { buildEmailPrintText, usePrintEmail } from "./usePrintEmail";

const mockPluginsApi = vi.hoisted(() => ({
  list: vi.fn(),
  bridgePerformAction: vi.fn(),
}));

vi.mock("../../api/plugins", () => ({ pluginsApi: mockPluginsApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = "c1";

function parsed(overrides: Partial<ParsedEmailMessage> = {}): ParsedEmailMessage {
  return {
    uid: 42,
    messageId: "<m1>",
    inReplyTo: null,
    references: [],
    from: "sender@example.com",
    fromAddress: "sender@example.com",
    to: ["me@example.com"],
    cc: [],
    subject: "Quarterly numbers",
    date: "2026-08-01T10:00:00.000Z",
    text: "The numbers are attached.",
    html: "",
    markdown: "The numbers are attached.",
    attachments: [],
    ...overrides,
  };
}

function printToolsRecord(status: string) {
  return { id: "pt-1", pluginKey: "print-tools", status };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
type PrintHook = ReturnType<typeof usePrintEmail>;

function mountPrint(onDone?: (text: string) => void) {
  const captured: { current: PrintHook | null } = { current: null };
  function Probe() {
    captured.current = usePrintEmail(COMPANY, { onDone });
    return null;
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  return captured;
}

async function settle() {
  // Two timer rounds: one for the query fetch to resolve, one for the
  // resulting state update to reach the hook's render.
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  mockPluginsApi.list.mockReset();
  mockPluginsApi.bridgePerformAction.mockReset();
  mockPluginsApi.list.mockResolvedValue([printToolsRecord("ready")]);
  mockPluginsApi.bridgePerformAction.mockResolvedValue({
    data: { ok: true, printer: "Brother HL-L2350DW series" },
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

describe("buildEmailPrintText", () => {
  it("renders a header block followed by the text body", () => {
    const out = buildEmailPrintText(parsed());
    expect(out).toContain("From: sender@example.com");
    expect(out).toContain("To: me@example.com");
    expect(out).toContain("Subject: Quarterly numbers");
    expect(out).toContain("The numbers are attached.");
    // Header and body are separated by a blank line.
    expect(out).toMatch(/Subject: Quarterly numbers\n\n/);
  });

  it("falls back to the markdown conversion for html-only messages", () => {
    const out = buildEmailPrintText(parsed({ text: "", markdown: "MD body here" }));
    expect(out).toContain("MD body here");
  });

  it("copes with empty subject, recipients, and body", () => {
    const out = buildEmailPrintText(parsed({ subject: "", to: [], text: "", markdown: "" }));
    expect(out).toContain("Subject: (no subject)");
    expect(out).not.toContain("To: ");
    expect(out).toContain("(no body)");
  });
});

describe("usePrintEmail", () => {
  it("is clickable with a plain Print tooltip when the plugin is ready", async () => {
    const hook = mountPrint();
    await settle();
    expect(hook.current!.canPrint).toBe(true);
    expect(hook.current!.availability).toBe("ready");
    expect(hook.current!.tooltip).toBe("Print");
  });

  it("greys out with a turn-on hint when the plugin is installed but off", async () => {
    mockPluginsApi.list.mockResolvedValue([printToolsRecord("disabled")]);
    const hook = mountPrint();
    await settle();
    expect(hook.current!.canPrint).toBe(false);
    expect(hook.current!.availability).toBe("inactive");
    expect(hook.current!.tooltip).toContain("turn the Print Tools extension back on");
  });

  it("greys out with an install hint when the plugin is not installed", async () => {
    mockPluginsApi.list.mockResolvedValue([]);
    const hook = mountPrint();
    await settle();
    expect(hook.current!.canPrint).toBe(false);
    expect(hook.current!.availability).toBe("missing");
    expect(hook.current!.tooltip).toContain("install the Print Tools extension");
  });

  it("treats an uninstalled (soft-deleted) plugin as missing", async () => {
    mockPluginsApi.list.mockResolvedValue([printToolsRecord("uninstalled")]);
    const hook = mountPrint();
    await settle();
    expect(hook.current!.availability).toBe("missing");
  });

  it("prints the open message through the plugin bridge, scoped to the company", async () => {
    const onDone = vi.fn();
    const hook = mountPrint(onDone);
    await settle();

    act(() => hook.current!.print.mutate(parsed()));
    await settle();

    expect(mockPluginsApi.bridgePerformAction).toHaveBeenCalledTimes(1);
    const [pluginId, key, params, companyId] =
      mockPluginsApi.bridgePerformAction.mock.calls[0];
    expect(pluginId).toBe("pt-1");
    expect(key).toBe("print_text");
    expect(companyId).toBe(COMPANY);
    expect(params.companyId).toBe(COMPANY);
    expect(params.jobTitle).toBe("Quarterly numbers");
    expect(params.content).toContain("From: sender@example.com");
    expect(params.content).toContain("The numbers are attached.");
    expect(onDone).toHaveBeenCalledWith("Sent to printer (Brother HL-L2350DW series)");
  });

  it("refuses to print when the plugin is off instead of calling the bridge", async () => {
    mockPluginsApi.list.mockResolvedValue([printToolsRecord("disabled")]);
    const onDone = vi.fn();
    const hook = mountPrint(onDone);
    await settle();

    act(() => hook.current!.print.mutate(parsed()));
    await settle();

    expect(mockPluginsApi.bridgePerformAction).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledWith(
      "Print failed: The Print Tools extension is not active.",
    );
  });

  it("surfaces a bridge failure as a print-failed note", async () => {
    mockPluginsApi.bridgePerformAction.mockRejectedValue(
      new Error("[EPRINT_NO_PRINTER] Printer \"X\" not found."),
    );
    const onDone = vi.fn();
    const hook = mountPrint(onDone);
    await settle();

    act(() => hook.current!.print.mutate(parsed()));
    await settle();

    expect(onDone).toHaveBeenCalledWith(
      'Print failed: [EPRINT_NO_PRINTER] Printer "X" not found.',
    );
  });
});
