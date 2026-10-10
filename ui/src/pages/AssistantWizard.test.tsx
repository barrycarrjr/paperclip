// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../context/ToastContext";
import { ToastViewport } from "../components/ToastViewport";
import { AssistantWizard } from "./AssistantWizard";

vi.mock("@/lib/router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock("../hooks/useRouteCompany", () => ({
  useActiveCompanyId: () => "company-1",
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../api/auth", () => ({
  authApi: { getSession: vi.fn().mockResolvedValue({ user: { name: "Pat" } }) },
}));

vi.mock("../api/agents", () => ({ agentsApi: {} }));
vi.mock("../api/approvals", () => ({ approvalsApi: {} }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/**
 * The phone-tools plugin, as the wizard reaches it through fetch. What saving
 * the operator's number answers is set per test.
 */
let operatorPhoneSaveReply: { status: number; body: unknown };
const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
  const url = new URL(input);
  const path = url.pathname.replace("/api/plugins/phone-tools/api", "");
  const method = init?.method ?? "GET";
  if (path === "/accounts/numbers") {
    return jsonResponse(200, {
      numbers: [{ id: "number-1", e164: "+15550001111", label: "Main line" }],
      engine: "vapi",
      twilioConfigured: true,
    });
  }
  if (path === "/operator-phone" && method === "GET") return jsonResponse(200, { e164: null, verifiedAt: null });
  if (path === "/operator-phone" && method === "POST") {
    return jsonResponse(operatorPhoneSaveReply.status, operatorPhoneSaveReply.body);
  }
  if (path === "/assistants/compose-preview") {
    return jsonResponse(200, { firstMessage: "Hi, this is Pat's assistant.", systemPrompt: "Be brief." });
  }
  return jsonResponse(404, { error: `Unexpected ${method} ${path}` });
});

/**
 * "Save number" on the last step used to say nothing either way: a saved
 * number only greyed the button out, and a refused one did not even do that.
 */
describe("AssistantWizard, saving the number to call for a test", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    operatorPhoneSaveReply = { status: 200, body: { e164: "+15551234567", verifiedAt: null } };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    fetchMock.mockClear();
  });

  function buttonByText(text: string) {
    return Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === text) as
      | HTMLButtonElement
      | undefined;
  }

  async function click(button: HTMLButtonElement) {
    await act(async () => {
      button.click();
    });
    await flushReact();
  }

  /** Renders the wizard and walks it to the last step with the defaults. */
  async function renderAtLastStep() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <AssistantWizard />
            <ToastViewport />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    await click(buttonByText("Next")!); // type
    await act(async () => {
      setInputValue(container.querySelector('input[type="text"]') as HTMLInputElement, "Pat's assistant");
    });
    await click(buttonByText("Next")!); // name
    await vi.waitFor(() => expect(buttonByText("Next")?.disabled).toBe(false));
    await click(buttonByText("Next")!); // who it works for
    await click(buttonByText("Next")!); // tasks
    await click(buttonByText("Next")!); // capabilities
    await click(buttonByText("Next")!); // voice
    // Caller ID: the first number is picked once the list loads.
    await vi.waitFor(() => expect(buttonByText("Next")?.disabled).toBe(false));
    await click(buttonByText("Next")!);
    await vi.waitFor(() => expect(container.textContent).toContain("Step 8 of 8"));
  }

  /**
   * The message viewport's live region, taken before the save. It has to be
   * on the page already: a screen reader often misses a region that appears
   * together with its first message.
   */
  function liveRegion() {
    const region = container.querySelector('aside[aria-live="polite"]');
    expect(region, "the live region is on the page before the save").not.toBeNull();
    return region as HTMLElement;
  }

  async function saveNumber(value: string) {
    await act(async () => {
      setInputValue(container.querySelector('input[type="tel"]') as HTMLInputElement, value);
    });
    await click(buttonByText("Save number")!);
    await flushReact();
  }

  function savedNumberBody() {
    const post = fetchMock.mock.calls.find(
      ([input, init]) => String(input).includes("/operator-phone") && init?.method === "POST",
    );
    return post ? JSON.parse(String(post[1]?.body)) : null;
  }

  it("says the number was saved", async () => {
    await renderAtLastStep();
    const region = liveRegion();

    await saveNumber("+15551234567");

    expect(savedNumberBody()).toEqual({ e164: "+15551234567" });
    await vi.waitFor(() => expect(region.textContent).toContain("Phone number saved"));
  });

  it("says why the number could not be saved, where it used to say nothing", async () => {
    operatorPhoneSaveReply = { status: 400, body: { error: "That number cannot take calls." } };
    await renderAtLastStep();
    const region = liveRegion();

    await saveNumber("+15550000000");

    await vi.waitFor(() => expect(container.textContent).toContain("That number cannot take calls."));
    expect(region.textContent).not.toContain("Phone number saved");
  });
});
