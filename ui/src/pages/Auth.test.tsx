// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
  signInEmail: vi.fn(),
  signUpEmail: vi.fn(),
}));
const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock("../api/auth", () => ({ authApi: mockAuthApi }));

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [new URLSearchParams()],
}));

vi.mock("@/components/AsciiArtAnimation", () => ({
  AsciiArtAnimation: () => null,
}));

const { AuthPage } = await import("./Auth");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function typeInto(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setValue.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("AuthPage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAuthApi.getSession.mockResolvedValue(null);
    mockAuthApi.signInEmail.mockResolvedValue(undefined);
  });

  afterEach(() => {
    container.remove();
    vi.clearAllMocks();
  });

  it("forgets everything loaded for whoever used the tab before signing in", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Left behind by the last person, whose session simply ran out.
    queryClient.setQueryData(queryKeys.plugins.config("plugin-1"), {
      configJson: { mailboxes: [] },
      editable: false,
    });
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AuthPage />
        </QueryClientProvider>,
      );
    });
    await settle();

    await act(async () => {
      typeInto(container.querySelector<HTMLInputElement>("#email")!, "admin@example.com");
      typeInto(container.querySelector<HTMLInputElement>("#password")!, "correct horse");
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
    await settle();

    expect(mockAuthApi.signInEmail).toHaveBeenCalledWith({ email: "admin@example.com", password: "correct horse" });
    expect(queryClient.getQueryData(queryKeys.plugins.config("plugin-1"))).toBeUndefined();
    expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true });

    await act(async () => {
      root.unmount();
    });
  });
});
