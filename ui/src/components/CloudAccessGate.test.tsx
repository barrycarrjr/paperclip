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
