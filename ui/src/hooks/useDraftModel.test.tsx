// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDraftModel } from "./useDraftModel";

const mockChatApi = vi.hoisted(() => ({ listModels: vi.fn() }));
vi.mock("../api/chat", () => ({ chatApi: mockChatApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type DraftModelState = ReturnType<typeof useDraftModel>;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** Two consumers at once, like the Email page and the pop-out on top of it. */
async function mountTwo() {
  const page: { current: DraftModelState | null } = { current: null };
  const popout: { current: DraftModelState | null } = { current: null };
  function Page() {
    page.current = useDraftModel();
    return null;
  }
  function Popout() {
    popout.current = useDraftModel();
    return null;
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <Page />
        <Popout />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return { page, popout };
}

beforeEach(() => {
  localStorage.removeItem("email-draftModel");
  mockChatApi.listModels.mockReset();
  mockChatApi.listModels.mockResolvedValue({
    models: [{ provider: "anthropic", model: "claude-sonnet-5" }],
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  vi.restoreAllMocks();
});

describe("useDraftModel", () => {
  it("starts on Auto when nothing has been picked", async () => {
    const { page } = await mountTwo();

    expect(page.current!.draftModel).toBe("");
  });

  it("starts on the model saved from an earlier visit", async () => {
    localStorage.setItem("email-draftModel", "claude-sonnet-5");
    const { page } = await mountTwo();

    expect(page.current!.draftModel).toBe("claude-sonnet-5");
  });

  it("offers the models the server lists", async () => {
    const { page } = await mountTwo();

    expect(page.current!.draftModels.map((m) => m.model)).toEqual(["claude-sonnet-5"]);
  });

  // The bug a per-component copy would have: the pop-out stays mounted under
  // the Email page, so it would keep drafting with the model saved at page
  // load after the operator had picked another one in the page's composer.
  it("hands a pick made in one place to every other place at once", async () => {
    const { page, popout } = await mountTwo();

    await act(async () => {
      page.current!.setDraftModel("claude-sonnet-5");
    });

    expect(popout.current!.draftModel).toBe("claude-sonnet-5");
    expect(localStorage.getItem("email-draftModel")).toBe("claude-sonnet-5");
  });

  it("keeps the pick for the session when the browser will not store it", async () => {
    const { page, popout } = await mountTwo();
    // vitest.setup.ts swaps in a plain object when the runtime's own storage is
    // unusable (it is on Node 25), so break whichever one is really installed.
    const storage = Object.prototype.hasOwnProperty.call(localStorage, "setItem")
      ? localStorage
      : Storage.prototype;
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    await act(async () => {
      page.current!.setDraftModel("claude-sonnet-5");
    });

    expect(page.current!.draftModel).toBe("claude-sonnet-5");
    expect(popout.current!.draftModel).toBe("claude-sonnet-5");

    // Storage works again: the next pick is saved and the held one let go.
    vi.restoreAllMocks();
    await act(async () => {
      page.current!.setDraftModel("");
    });
    expect(localStorage.getItem("email-draftModel")).toBe("");
    expect(popout.current!.draftModel).toBe("");
  });
});
