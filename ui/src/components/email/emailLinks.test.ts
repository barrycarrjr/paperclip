// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { openEmailLinksInNewTab } from "./emailLinks";

function linksIn(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return [...doc.querySelectorAll("a, area")].map((a) => ({
    href: a.getAttribute("href"),
    target: a.getAttribute("target"),
    rel: a.getAttribute("rel"),
  }));
}

describe("openEmailLinksInNewTab", () => {
  it("sends web links to a new tab, with no way back to the page", () => {
    const out = openEmailLinksInNewTab(
      '<html><body><a href="https://console.example.com/billing">Update card</a>'
        + '<a href="//cdn.example.com/x" target="_self">x</a>'
        + '<map><area href="http://example.com/map"></map></body></html>',
    );
    expect(linksIn(out)).toEqual([
      { href: "https://console.example.com/billing", target: "_blank", rel: "noopener noreferrer" },
      { href: "//cdn.example.com/x", target: "_blank", rel: "noopener noreferrer" },
      { href: "http://example.com/map", target: "_blank", rel: "noopener noreferrer" },
    ]);
  });

  it("leaves mail links and in-page anchors alone", () => {
    const out = openEmailLinksInNewTab(
      '<a href="mailto:support@example.com">Mail us</a><a href="#top">Top</a><a href="https://example.com">Site</a>',
    );
    const links = linksIn(out);
    expect(links[0]).toEqual({ href: "mailto:support@example.com", target: null, rel: null });
    expect(links[1]).toEqual({ href: "#top", target: null, rel: null });
    expect(links[2].target).toBe("_blank");
  });

  it("keeps the message's own doctype, and adds none it did not have", () => {
    const withDoctype = openEmailLinksInNewTab(
      '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">'
        + '<html><body><a href="https://example.com">x</a></body></html>',
    );
    expect(withDoctype.startsWith('<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"')).toBe(true);
    const without = openEmailLinksInNewTab('<html><body><a href="https://example.com">x</a></body></html>');
    expect(without.startsWith("<html>")).toBe(true);
  });

  it("returns a message with no web links untouched", () => {
    const html = '<p>No links here, just <a href="mailto:a@example.com">mail</a>.</p>';
    expect(openEmailLinksInNewTab(html)).toBe(html);
    expect(openEmailLinksInNewTab("")).toBe("");
  });

  it("returns just the body's contents for HTML that goes inside the page", () => {
    const out = openEmailLinksInNewTab('<p>See <a href="https://example.com">this</a></p>', { fragment: true });
    expect(out).toBe('<p>See <a href="https://example.com" target="_blank" rel="noopener noreferrer">this</a></p>');
  });
});
