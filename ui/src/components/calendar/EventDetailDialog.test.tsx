// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CalendarEventDetail } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventDetailDialog } from "./EventDetailDialog";

vi.mock("@/api/calendar", () => ({
  calendarApi: {
    getEvent: vi.fn(async () => eventFixture),
    deleteEvent: vi.fn(),
  },
}));

vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A long unbreakable URL in the notes is what widened the dialog past its own
 * max-width, so the fixture keeps a real one (the reminder Barry hit it on).
 */
const LONG_URL =
  "https://autoprint-software.atlassian.net/wiki/spaces/AUTO/blog/2022/09/26/4344315909/Pay+schedule+2022-2023+calendar";

let eventFixture: CalendarEventDetail;

function createEvent(): CalendarEventDetail {
  const now = new Date("2026-08-09T12:00:00.000Z");
  return {
    id: "event-1",
    companyId: "company-1",
    userId: "user-1",
    kind: "reminder",
    title: "IB Payroll",
    body: LONG_URL,
    status: "active",
    scheduleKind: "interval",
    anchorAt: now,
    intervalUnit: "week",
    intervalCount: 2,
    timeOfDay: "17:00",
    cronExpression: null,
    timezone: "America/New_York",
    endAt: null,
    maxOccurrences: null,
    allDay: false,
    durationMinutes: null,
    nextRunAt: new Date("2026-08-12T20:30:00.000Z"),
    lastFiredAt: new Date("2026-07-29T20:30:00.000Z"),
    occurrenceCount: 3,
    notify: true,
    channels: ["desktop"],
    leadTimeMinutes: 0,
    slackTarget: null,
    source: "paperclip",
    externalId: null,
    externalCalendarId: null,
    createdByUserId: "user-1",
    createdByAgentId: null,
    updatedByUserId: null,
    createdAt: now,
    updatedAt: now,
    recentDeliveries: [],
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <EventDetailDialog
          open
          onOpenChange={vi.fn()}
          eventId="event-1"
          currentUserId="user-1"
          onEdit={vi.fn()}
          companyLabel="Industry Bureau LLC"
        />
      </QueryClientProvider>,
    );
  });

  // Let the react-query fetch settle so the rows render instead of the spinner.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (document.body.textContent?.includes("Industry Bureau LLC")) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  throw new Error("EventDetailDialog never left its loading state");
}

describe("EventDetailDialog", () => {
  beforeEach(() => {
    eventFixture = createEvent();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the reminder detail", async () => {
    await renderDialog();

    const dialog = document.querySelector("[data-slot='dialog-content']");
    expect(dialog?.textContent).toContain("IB Payroll");
    expect(dialog?.textContent).toContain("Industry Bureau LLC");
    expect(dialog?.textContent).toContain(LONG_URL);
  });

  // jsdom does no layout, so this asserts the classes that keep the panel from
  // being widened past its max-width rather than the pixels themselves. The real
  // check is the browser repro; this exists so the guard cannot be dropped silently.
  it("keeps long values inside the dialog panel", async () => {
    await renderDialog();

    const notes = [...document.querySelectorAll("p")].find((p) =>
      p.textContent?.includes(LONG_URL),
    );
    expect(notes?.className).toContain("wrap-anywhere");

    const scheduleValue = [...document.querySelectorAll("span")].find((span) =>
      span.textContent?.includes("America/New_York"),
    );
    expect(scheduleValue?.className).toContain("min-w-0");
    expect(scheduleValue?.className).toContain("break-words");
  });
});
