// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { EmailRecipientLines } from "./EmailRecipientLines";
import { recipientDisplayName, splitAddressList } from "./emailRecipients";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(node: React.ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

describe("splitAddressList", () => {
  it("splits the one joined string the plugin sends into one entry per person", () => {
    expect(splitAddressList(['"Jordan A. Lee" <jordan@example.com>, Sam Rivera <sam@example.com>'])).toEqual([
      '"Jordan A. Lee" <jordan@example.com>',
      "Sam Rivera <sam@example.com>",
    ]);
  });

  it("keeps a comma inside a quoted name as part of that name", () => {
    expect(splitAddressList(['"Lee, Jordan" <jordan@example.com>, ops@example.com'])).toEqual([
      '"Lee, Jordan" <jordan@example.com>',
      "ops@example.com",
    ]);
  });

  it("handles separate entries, blanks, and a missing list", () => {
    expect(splitAddressList(["a@example.com", " ", "b@example.com,"])).toEqual(["a@example.com", "b@example.com"]);
    expect(splitAddressList([])).toEqual([]);
    expect(splitAddressList(undefined)).toEqual([]);
  });
});

describe("recipientDisplayName", () => {
  it("shows the name when the header carries one, as Outlook does", () => {
    expect(recipientDisplayName('"Jordan A. Lee" <jordan@example.com>')).toBe("Jordan A. Lee");
    expect(recipientDisplayName("Sam Rivera <sam@example.com>")).toBe("Sam Rivera");
    expect(recipientDisplayName('"Lee, Jordan" <jordan@example.com>')).toBe("Lee, Jordan");
  });

  it("falls back to the address when there is no name", () => {
    expect(recipientDisplayName("orders@example.com")).toBe("orders@example.com");
    expect(recipientDisplayName("<ops@example.com>")).toBe("ops@example.com");
    expect(recipientDisplayName('"" <ops@example.com>')).toBe("ops@example.com");
  });
});

describe("EmailRecipientLines", () => {
  it("shows the To and Cc rows Outlook shows, names separated by semicolons", () => {
    const el = render(
      <EmailRecipientLines
        from="Alex Morgan <alex@example.com>"
        to={["orders@example.com"]}
        cc={['"Jordan A. Lee" <jordan@example.com>, Sam Rivera <sam@example.com>']}
      />,
    );
    const rows = [...el.firstElementChild!.children].map((n) => n.textContent);
    expect(rows).toEqual([
      "Alex Morgan <alex@example.com>",
      "Toorders@example.com",
      "CcJordan A. Lee; Sam Rivera",
    ]);
  });

  it("keeps each full address on hover", () => {
    const el = render(
      <EmailRecipientLines from="a@example.com" cc={['"Jordan A. Lee" <jordan@example.com>, c@example.com']} />,
    );
    const titles = [...el.querySelectorAll("[title]")].map((n) => n.getAttribute("title"));
    expect(titles).toEqual(['"Jordan A. Lee" <jordan@example.com>', "c@example.com"]);
  });

  it("leaves off a row with nobody on it", () => {
    const el = render(<EmailRecipientLines from="a@example.com" to={["me@example.com"]} cc={[]} />);
    expect(el.textContent).toContain("To");
    expect(el.textContent).not.toContain("Cc");
    const noRecipients = render(<EmailRecipientLines from="a@example.com" />);
    expect(noRecipients.textContent).toBe("a@example.com");
  });
});
