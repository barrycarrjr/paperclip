// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../context/ToastContext";
import { ToastViewport } from "../components/ToastViewport";
import { ProfileSettings } from "./ProfileSettings";

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
  signInEmail: vi.fn(),
  signUpEmail: vi.fn(),
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
  signOut: vi.fn(),
}));

const mockAssetsApi = vi.hoisted(() => ({
  uploadImage: vi.fn(),
  uploadCompanyLogo: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("@/api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("@/api/assets", () => ({
  assetsApi: mockAssetsApi,
}));

vi.mock("@/api/channelLinks", () => ({
  channelLinksApi: { list: vi.fn().mockResolvedValue([]), preview: vi.fn(), claim: vi.fn(), remove: vi.fn() },
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP" },
  }),
}));

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

describe("ProfileSettings", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        name: "Jane Example",
        email: "jane@example.com",
        image: "https://example.com/jane.png",
      },
    });
    mockAssetsApi.uploadImage.mockResolvedValue({
      assetId: "asset-1",
      contentPath: "/api/assets/asset-1/content",
    });
    mockAuthApi.updateProfile.mockImplementation(async (input: { name: string; image: string | null }) => ({
      id: "user-1",
      name: input.name,
      email: "jane@example.com",
      image: input.image,
    }));
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("uploads a clicked avatar into Paperclip storage and persists the returned asset path", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ProfileSettings />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).not.toContain("Avatar image URL");

    const avatarInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(avatarInput).not.toBeNull();

    const file = new File(["avatar"], "avatar.png", { type: "image/png" });
    Object.defineProperty(avatarInput, "files", {
      configurable: true,
      value: [file],
    });

    await act(async () => {
      avatarInput?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(mockAssetsApi.uploadImage).toHaveBeenCalledWith("company-1", file, "profiles/user-1");
    expect(mockAuthApi.updateProfile).toHaveBeenCalledWith({
      name: "Jane Example",
      image: "/api/assets/asset-1/content",
    });

    await act(async () => {
      root.unmount();
    });
  });

  // The form keeps showing what was typed, so a save that worked looks exactly
  // like a save that never happened unless something says so.
  describe("saving the profile", () => {
    async function renderWithToasts() {
      const root = createRoot(container);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <ToastProvider>
              <ProfileSettings />
              <ToastViewport />
            </ToastProvider>
          </QueryClientProvider>,
        );
      });
      await flushReact();
      await flushReact();
      return root;
    }

    async function saveName(value: string) {
      const nameInput = container.querySelector("#profile-name") as HTMLInputElement;
      await act(async () => {
        setInputValue(nameInput, value);
      });
      await act(async () => {
        nameInput.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      await flushReact();
      await flushReact();
    }

    /**
     * The live region, taken before the save. It has to be on the page
     * already: a screen reader often misses a region that appears together
     * with its first message.
     */
    function liveRegion() {
      const region = container.querySelector('aside[aria-live="polite"]');
      expect(region, "the live region is on the page before the save").not.toBeNull();
      return region as HTMLElement;
    }

    it("says the profile was saved once the save goes through", async () => {
      const root = await renderWithToasts();
      const region = liveRegion();

      await saveName("Pat Example");

      expect(mockAuthApi.updateProfile).toHaveBeenCalledWith({
        name: "Pat Example",
        image: "https://example.com/jane.png",
      });
      expect(region.textContent).toContain("Profile saved");

      await act(async () => {
        root.unmount();
      });
    });

    it("does not say it was saved when the save fails, and shows why", async () => {
      mockAuthApi.updateProfile.mockRejectedValueOnce(new Error("Display name is not allowed."));
      const root = await renderWithToasts();
      const region = liveRegion();

      await saveName("Pat Example");

      expect(container.textContent).toContain("Display name is not allowed.");
      expect(region.textContent).not.toContain("Profile saved");

      await act(async () => {
        root.unmount();
      });
    });
  });
});
