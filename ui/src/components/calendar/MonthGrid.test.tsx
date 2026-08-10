// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { CalendarOccurrence } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MonthGrid } from "./MonthGrid";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const VIEW_MONTH = new Date(2026, 7, 1); // August 2026

function occurrence(overrides: Partial<CalendarOccurrence> = {}): CalendarOccurrence {
  return {
    eventId: "event-1",
    companyId: "company-a",
    source: "paperclip",
    kind: "reminder",
    title: "IB Payroll",
    body: null,
    start: new Date(2026, 7, 12, 16, 30).toISOString(),
    end: null,
    allDay: false,
    ownerUserId: "user-1",
    status: "active",
    notify: true,
    channels: ["desktop"],
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(props: Partial<Parameters<typeof MonthGrid>[0]> = {}) {
  await act(async () => {
    root.render(
      <MonthGrid
        viewMonth={VIEW_MONTH}
        occurrences={[occurrence()]}
        hiddenSources={new Set()}
        onSelectOccurrence={props.onSelectOccurrence ?? vi.fn()}
        onAddOnDay={props.onAddOnDay}
      />,
    );
  });
}

/** The cell holding a given day-of-month number in the current month. */
function dayCell(day: number): HTMLElement {
  const cells = [...container.querySelectorAll("div.group\\/day, div.flex.min-h-\\[96px\\]")];
  const match = cells.find((cell) => cell.querySelector("span")?.textContent === String(day));
  if (!match) throw new Error(`no cell for day ${day}`);
  return match as HTMLElement;
}

describe("MonthGrid", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("stays read-only when no add handler is given", async () => {
    await render();

    expect(container.querySelector("[aria-label^='Add a reminder']")).toBeNull();
    // Clicking a day must do nothing rather than throw.
    act(() => {
      dayCell(5).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  });

  it("starts a reminder on the day whose blank space was clicked", async () => {
    const onAddOnDay = vi.fn();
    await render({ onAddOnDay });

    act(() => {
      dayCell(5).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onAddOnDay).toHaveBeenCalledTimes(1);
    const picked = onAddOnDay.mock.calls[0][0] as Date;
    expect(picked.getFullYear()).toBe(2026);
    expect(picked.getMonth()).toBe(7);
    expect(picked.getDate()).toBe(5);
  });

  it("offers a labelled add button on every day", async () => {
    const onAddOnDay = vi.fn();
    await render({ onAddOnDay });

    const button = dayCell(12).querySelector("[aria-label^='Add a reminder']") as HTMLElement;
    expect(button.getAttribute("aria-label")).toContain("August 12");

    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect((onAddOnDay.mock.calls[0][0] as Date).getDate()).toBe(12);
  });

  // Without the guard, opening an existing reminder would also open the new
  // reminder form behind it, because the pill's click bubbles to the cell.
  it("does not start a reminder when an existing one is clicked", async () => {
    const onAddOnDay = vi.fn();
    const onSelectOccurrence = vi.fn();
    await render({ onAddOnDay, onSelectOccurrence });

    const pill = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("IB Payroll"),
    );
    act(() => {
      pill?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onSelectOccurrence).toHaveBeenCalledTimes(1);
    expect(onAddOnDay).not.toHaveBeenCalled();
  });
});
