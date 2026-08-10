// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventDialog } from "./EventDialog";

vi.mock("@/api/calendar", () => ({
  calendarApi: { createEvent: vi.fn(), updateEvent: vi.fn() },
}));

vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY_CHOICES = [
  { value: "company-a", label: "Industry Bureau LLC" },
  { value: "company-b", label: "Print Shop" },
];

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(props: { companyChoices?: typeof COMPANY_CHOICES; startOn?: Date } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <EventDialog
          open
          onOpenChange={vi.fn()}
          companyId="company-a"
          companyChoices={props.companyChoices}
          startOn={props.startOn ?? null}
        />
      </QueryClientProvider>,
    );
  });
}

function createButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "Create reminder",
  );
  if (!button) throw new Error("no Create reminder button");
  return button as HTMLButtonElement;
}

function typeTitle(text: string) {
  const input = document.getElementById("calendar-event-title") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("EventDialog", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("does not ask which company when one is already fixed", async () => {
    await render();

    expect(document.getElementById("calendar-event-company")).toBeNull();
    typeTitle("Renew licence");
    expect(createButton().disabled).toBe(false);
  });

  // The portfolio calendar has no single company in view, so a reminder there
  // has to say which one it belongs to before it can be saved.
  it("asks which company on the portfolio calendar and blocks saving until told", async () => {
    await render({ companyChoices: COMPANY_CHOICES });

    expect(document.getElementById("calendar-event-company")).not.toBeNull();
    typeTitle("Renew licence");
    expect(createButton().disabled).toBe(true);
  });

  it("starts empty rather than defaulting to the first company", async () => {
    await render({ companyChoices: COMPANY_CHOICES });

    expect(document.body.textContent).toContain("Choose a company");
  });

  it("seeds the schedule from the day picked on the grid", async () => {
    await render({ startOn: new Date(2026, 7, 26) });

    const onceAt = document.querySelector("input[type='datetime-local']") as HTMLInputElement;
    expect(onceAt.value).toBe("2026-08-26T09:00");
  });

  it("falls back to the next hour when no day was picked", async () => {
    await render();

    const onceAt = document.querySelector("input[type='datetime-local']") as HTMLInputElement;
    expect(onceAt.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00$/);
  });
});
