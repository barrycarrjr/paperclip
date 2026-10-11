// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Space } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpaceSettingsDialog } from "./SpaceSettingsDialog";

const mockSpacesApi = vi.hoisted(() => ({ update: vi.fn() }));

vi.mock("../api/spaces", () => ({ spacesApi: mockSpacesApi }));

// A plain box stands in for the dialog, so what it holds is drawn in the test's container.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, type = "button", ...props }: ComponentProps<"button">) => (
    <button type={type} onClick={onClick} {...props}>{children}</button>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const SPACE: Space = {
  id: "space-1",
  companyId: "company-1",
  name: "Handbook",
  urlKey: "handbook",
  description: "How we work",
  sortOrder: 0,
  archivedAt: null,
  createdByAgentId: null,
  createdByUserId: "user-1",
  createdAt: new Date("2026-10-11T09:00:00.000Z"),
  updatedAt: new Date("2026-10-11T09:00:00.000Z"),
};

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonNamed(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);
}

describe("SpaceSettingsDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  const onOpenChange = vi.fn();

  beforeEach(() => {
    mockSpacesApi.update.mockReset().mockImplementation(async (_id: string, change: object) => ({ ...SPACE, ...change }));
    onOpenChange.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    queryClient.clear();
  });

  async function render(space: Space = SPACE) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SpaceSettingsDialog space={space} open onOpenChange={onOpenChange} />
        </QueryClientProvider>,
      );
    });
  }

  it("renames a Space and changes its description", async () => {
    await render();
    const save = buttonNamed(container, "Save")!;
    expect(save.disabled).toBe(true);

    await act(async () => {
      setInputValue(container.querySelector<HTMLInputElement>("#space-settings-name")!, "  Standing rules ");
      setInputValue(container.querySelector<HTMLTextAreaElement>("#space-settings-description")!, "");
    });
    await act(async () => {
      buttonNamed(container, "Save")!.click();
    });
    await flush();

    expect(mockSpacesApi.update).toHaveBeenCalledWith("space-1", { name: "Standing rules", description: null });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("archives a Space", async () => {
    await render();
    await act(async () => {
      buttonNamed(container, "Archive")!.click();
    });
    await flush();

    expect(mockSpacesApi.update).toHaveBeenCalledWith("space-1", { archived: true });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not archive while a rename typed above is unsaved, which archiving would lose", async () => {
    await render();
    await act(async () => {
      setInputValue(container.querySelector<HTMLInputElement>("#space-settings-name")!, "Old pricing (2025)");
    });

    expect(buttonNamed(container, "Archive")!.disabled).toBe(true);
    expect(container.textContent).toContain("Save or cancel the changes above first.");
    await act(async () => {
      buttonNamed(container, "Save")!.click();
    });
    await flush();
    expect(mockSpacesApi.update).toHaveBeenCalledWith("space-1", { name: "Old pricing (2025)", description: "How we work" });
    expect(mockSpacesApi.update).not.toHaveBeenCalledWith("space-1", { archived: true });
  });

  it("offers an archived Space only being unarchived", async () => {
    await render({ ...SPACE, archivedAt: new Date("2026-10-11T10:00:00.000Z") });

    expect(container.textContent).toContain("This Space is archived. Unarchive it to change it.");
    expect(container.querySelector<HTMLInputElement>("#space-settings-name")!.disabled).toBe(true);
    expect(container.querySelector<HTMLTextAreaElement>("#space-settings-description")!.disabled).toBe(true);
    expect(buttonNamed(container, "Save")!.disabled).toBe(true);
    await act(async () => {
      buttonNamed(container, "Unarchive")!.click();
    });
    await flush();
    expect(mockSpacesApi.update).toHaveBeenCalledWith("space-1", { archived: false });
  });

  it("says why a change failed, and stays open", async () => {
    mockSpacesApi.update.mockRejectedValue(new Error("Viewer access is read-only"));
    await render();
    await act(async () => {
      buttonNamed(container, "Archive")!.click();
    });
    await flush();

    expect(container.querySelector('[role="status"]')?.textContent).toBe("Could not change the Space. Viewer access is read-only");
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
