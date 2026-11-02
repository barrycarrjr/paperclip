// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmailSnooze } from "@/api/emailTools";
import { EmailSnoozedList, snoozeStatusText } from "./EmailSnoozedList";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-11-02T15:00:00");

function snooze(overrides: Partial<EmailSnooze> = {}): EmailSnooze {
  return {
    id: "s1",
    company_id: "co",
    mailbox_key: "personal",
    folder: "INBOX",
    snooze_folder: "_paperclip/snoozed",
    snooze_uid: 7,
    message_id: "<a@example.com>",
    subject: "Quote for business cards",
    sender: "Someone <someone@example.com>",
    wake_at: new Date("2026-11-03T08:00:00").toISOString(),
    attempts: 0,
    last_error: null,
    ...overrides,
  };
}

describe("snoozeStatusText", () => {
  it("says when the email comes back", () => {
    const status = snoozeStatusText(snooze(), NOW);
    expect(status.problem).toBe(false);
    expect(status.text.startsWith("Comes back ")).toBe(true);
    expect(status.text).toContain(" at ");
  });

  it("says it is about to come back once the time has passed", () => {
    const status = snoozeStatusText(snooze({ wake_at: new Date("2026-11-02T14:59:00").toISOString() }), NOW);
    expect(status).toEqual({ text: "Coming back within a minute", problem: false });
  });

  it("flags a return that keeps failing, and says what to do once it has given up", () => {
    const retrying = snoozeStatusText(snooze({ attempts: 2, last_error: "mailbox offline" }), NOW);
    expect(retrying.problem).toBe(true);
    expect(retrying.text).toContain("trying again");
    const gaveUp = snoozeStatusText(snooze({ attempts: 5, last_error: "mailbox offline" }), NOW);
    expect(gaveUp.problem).toBe(true);
    expect(gaveUp.text).toContain("Bring back now");
  });
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

function render(ui: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(ui);
  });
  return container;
}

describe("EmailSnoozedList", () => {
  it("lists each snoozed email and brings one back on request", () => {
    const onUnsnooze = vi.fn();
    const second = snooze({ id: "s2", subject: "Invoice", sender: "Billing <billing@example.com>" });
    const el = render(
      <EmailSnoozedList
        fill={false}
        snoozes={[snooze(), second]}
        loading={false}
        error={null}
        onUnsnooze={onUnsnooze}
        unsnoozingId={null}
      />,
    );
    expect(el.textContent).toContain("Quote for business cards");
    expect(el.textContent).toContain("Invoice");
    const buttons = Array.from(el.querySelectorAll("button")).filter((b) => b.textContent?.includes("Bring back now"));
    expect(buttons).toHaveLength(2);
    act(() => {
      buttons[1]!.click();
    });
    expect(onUnsnooze).toHaveBeenCalledWith(second);
  });

  it("says plainly when nothing is snoozed, and when the list could not be read", () => {
    const empty = render(
      <EmailSnoozedList fill={false} snoozes={[]} loading={false} error={null} onUnsnooze={vi.fn()} unsnoozingId={null} />,
    );
    expect(empty.textContent).toContain("No snoozed emails in this mailbox.");
    act(() => {
      root!.render(
        <EmailSnoozedList
          fill={false}
          snoozes={[]}
          loading={false}
          error={new Error("plugin not running")}
          onUnsnooze={vi.fn()}
          unsnoozingId={null}
        />,
      );
    });
    expect(empty.textContent).toContain("Could not read the snoozed emails. plugin not running");
  });

  it("disables the button of the email being brought back", () => {
    const el = render(
      <EmailSnoozedList fill={false} snoozes={[snooze()]} loading={false} error={null} onUnsnooze={vi.fn()} unsnoozingId="s1" />,
    );
    const button = Array.from(el.querySelectorAll("button")).find((b) => b.textContent?.includes("Bring back now"))!;
    expect(button.disabled).toBe(true);
  });
});
