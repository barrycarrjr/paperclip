// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudAccessGate } from "./CloudAccessGate";

vi.mock("@/lib/router", () => ({
  Navigate: () => null,
  Outlet: () => <div>The app</div>,
  useLocation: () => ({ pathname: "/", search: "", hash: "" }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchMock = vi.fn();
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

async function renderGate() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={client}>
        <CloudAccessGate />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return container.textContent ?? "";
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

/** Answers each call the gate makes by its address, and records what was asked. */
function routeReplies(replies: Record<string, () => Response>) {
  fetchMock.mockImplementation(async (input: string) => {
    const path = String(input).split("?")[0]!;
    const replyFor = replies[path];
    if (!replyFor) throw new Error(`unexpected request to ${path}`);
    return replyFor();
  });
}

function askedFor(path: string) {
  return fetchMock.mock.calls.filter(([input]) => String(input).split("?")[0] === path);
}

const AUTHENTICATED_HEALTH = { status: "ok", deploymentMode: "authenticated", bootstrapStatus: "ready" };

function sessionReply(accountStatus?: "pending" | "approved") {
  return reply(200, {
    session: { id: "session-1", userId: "user-1" },
    user: { id: "user-1", email: "pat@example.com", name: "Pat", image: null },
    ...(accountStatus ? { accountStatus } : {}),
  });
}

describe("CloudAccessGate, for an account waiting for an admin to approve it", () => {
  it("shows only the waiting screen, and never asks for anything the server refuses it", async () => {
    routeReplies({
      "/api/health": () => reply(200, AUTHENTICATED_HEALTH),
      "/api/auth/get-session": () => sessionReply("pending"),
    });

    const text = await renderGate();

    expect(text).toContain("Your account is waiting for an admin to approve it");
    expect(text).toContain("You are signed in as pat@example.com.");
    expect(text).toContain("Sign out");
    expect(text).not.toContain("The app");
    expect(askedFor("/api/cli-auth/me")).toEqual([]);
  });

  it("signs out from the waiting screen", async () => {
    let signedOut = false;
    routeReplies({
      "/api/health": () => reply(200, AUTHENTICATED_HEALTH),
      "/api/auth/get-session": () => (signedOut ? reply(401, { error: "Unauthorized" }) : sessionReply("pending")),
      "/api/auth/sign-out": () => {
        signedOut = true;
        return reply(200, { success: true });
      },
    });
    await renderGate();

    const button = Array.from(container!.querySelectorAll("button")).find((item) => item.textContent === "Sign out");
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
    });
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    const signOutCalls = askedFor("/api/auth/sign-out");
    expect(signOutCalls).toHaveLength(1);
    expect((signOutCalls[0]![1] as RequestInit).method).toBe("POST");
    expect(container!.textContent).not.toContain("Your account is waiting");
  });

  it("opens the app for an approved account", async () => {
    routeReplies({
      "/api/health": () => reply(200, AUTHENTICATED_HEALTH),
      "/api/auth/get-session": () => sessionReply("approved"),
      "/api/cli-auth/me": () =>
        reply(200, { userId: "user-1", isInstanceAdmin: false, companyIds: ["company-1"], source: "session" }),
    });

    const text = await renderGate();

    expect(text).toContain("The app");
    expect(text).not.toContain("waiting for an admin");
  });
});

describe("CloudAccessGate, when Paperclip's health check fails", () => {
  it("says the database cannot be reached in words, where it showed database_unreachable", async () => {
    // The health check's answer with the database down, as it was before it
    // carried a message: the code alone.
    fetchMock.mockResolvedValue(reply(503, { status: "unhealthy", version: "1.0.0", error: "database_unreachable" }));

    const text = await renderGate();

    expect(text).toContain("Paperclip cannot reach its database.");
    expect(text).not.toContain("database_unreachable");
  });

  it("says Paperclip could not be reached, where it showed Failed to fetch", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const text = await renderGate();

    expect(text).toContain("Could not reach Paperclip. Check your connection and try again.");
    expect(text).not.toContain("Failed to fetch");
  });
});
