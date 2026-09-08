// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScheduleEditor } from "./ScheduleEditor";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: React.ReactElement) {
  act(() => {
    root.render(node);
  });
}

describe("ScheduleEditor", () => {
  it("says which clock the time is on", () => {
    render(
      <ScheduleEditor
        value="0 9 * * *"
        onChange={() => {}}
        timeZone="America/New_York"
        onTimeZoneChange={() => {}}
      />,
    );

    expect(container.textContent).toContain("Every day at 9:00 AM, America/New_York");
  });

  it("shows the saved zone as the chosen one, so it is never a guess", () => {
    render(
      <ScheduleEditor
        value="0 9 * * *"
        onChange={() => {}}
        timeZone="Europe/London"
        onTimeZoneChange={() => {}}
      />,
    );

    const picker = container.querySelector('[aria-label="Time zone"]');
    expect(picker).not.toBeNull();
    expect(picker?.textContent).toContain("Europe/London");
  });

  it("offers no zone at all when the caller does not pass one", () => {
    render(<ScheduleEditor value="0 9 * * *" onChange={() => {}} />);

    expect(container.querySelector('[aria-label="Time zone"]')).toBeNull();
    expect(container.textContent).toContain("Every day at 9:00 AM");
    expect(container.textContent).not.toContain("America/New_York");
  });
});
