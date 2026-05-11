import { describe, expect, it } from "vitest";
import {
  dismissReviewSender,
  graduateSender,
  keepAlwaysSender,
  parseReviewQueue,
} from "./email-triage-rules";

const PERSONAL_FORMAT = `# rules
## Auto-triage senders

emails@pro.crexi.com

## Keep-always senders

alerts@td.com

## Review queue

5 messages from no-reply@nextdoor.com
2 messages from info@coversandall.com
`;

// Matches the format the IND/M3/C3 COOs have been writing.
const BULLETED_RICH_FORMAT = `# rules
## Auto-triage senders

- abc@someemail.net

## Keep-always senders

## Review queue

<!-- Added by COO routine run -->
- no-reply@rs.email.nextdoor.com | Nextdoor neighborhood post digest | likely auto-triage candidate
- info@coversandall.com | CoversAndAll promotional emails | likely auto-triage candidate
- 6 messages from no-reply@pbslabelsolutions.com
`;

describe("parseReviewQueue", () => {
  it("parses the canonical Personal '<count> messages from <sender>' format", () => {
    expect(parseReviewQueue(PERSONAL_FORMAT)).toEqual([
      { count: 5, sender: "no-reply@nextdoor.com" },
      { count: 2, sender: "info@coversandall.com" },
    ]);
  });

  it("parses the bulleted '- <sender> | <desc> | <rec>' format the other COOs use", () => {
    const entries = parseReviewQueue(BULLETED_RICH_FORMAT);
    // sorted by count desc; the bullet+pipe entries default to count 1
    expect(entries).toEqual([
      { count: 6, sender: "no-reply@pbslabelsolutions.com" },
      { count: 1, sender: "no-reply@rs.email.nextdoor.com" },
      { count: 1, sender: "info@coversandall.com" },
    ]);
  });

  it("ignores comments, blank lines, and the placeholder hint line", () => {
    const body = `## Review queue

<!-- Added by COO routine run -->

\`<count> messages from <sender>\`
`;
    expect(parseReviewQueue(body)).toEqual([]);
  });
});

describe("review-queue mutations", () => {
  it("adds sender with bullet prefix when graduating", () => {
    const next = graduateSender(BULLETED_RICH_FORMAT, "no-reply@rs.email.nextdoor.com");
    const autoSection = next.slice(
      next.indexOf("## Auto-triage senders"),
      next.indexOf("## Keep-always senders"),
    );
    expect(autoSection).toContain("- no-reply@rs.email.nextdoor.com");
    // not added without bullet
    expect(autoSection).not.toMatch(/^[^-].*no-reply@rs\.email\.nextdoor\.com/m);
  });

  it("adds sender with bullet prefix when keeping always", () => {
    const next = keepAlwaysSender(PERSONAL_FORMAT, "no-reply@nextdoor.com");
    const keepSection = next.slice(next.indexOf("## Keep-always senders"));
    expect(keepSection).toContain("- no-reply@nextdoor.com");
  });

  it("removes bulleted-rich entries when graduating a sender", () => {
    const next = graduateSender(BULLETED_RICH_FORMAT, "no-reply@rs.email.nextdoor.com");
    // dropped from Review queue (the bulleted+piped line is gone)
    const reviewSectionStart = next.indexOf("## Review queue");
    expect(next.slice(reviewSectionStart)).not.toContain("Nextdoor neighborhood post digest");
  });

  it("removes counted Personal-format entries when keeping a sender", () => {
    const next = keepAlwaysSender(PERSONAL_FORMAT, "no-reply@nextdoor.com");
    expect(next).toContain("## Keep-always senders");
    // verify the Review-queue line for that sender was removed
    const reviewSectionStart = next.indexOf("## Review queue");
    expect(next.slice(reviewSectionStart)).not.toContain("no-reply@nextdoor.com");
  });

  it("does not duplicate a sender already present with a bullet prefix", () => {
    const base = graduateSender(BULLETED_RICH_FORMAT, "no-reply@rs.email.nextdoor.com");
    const again = graduateSender(base, "no-reply@rs.email.nextdoor.com");
    const autoSection = again.slice(
      again.indexOf("## Auto-triage senders"),
      again.indexOf("## Keep-always senders"),
    );
    const count = (autoSection.match(/no-reply@rs\.email\.nextdoor\.com/g) ?? []).length;
    expect(count).toBe(1);
  });

  it("dismisses without adding the sender to any other section", () => {
    const next = dismissReviewSender(BULLETED_RICH_FORMAT, "info@coversandall.com");
    const auto = next.slice(next.indexOf("## Auto-triage senders"), next.indexOf("## Keep-always"));
    expect(auto).not.toContain("info@coversandall.com");
    const review = next.slice(next.indexOf("## Review queue"));
    expect(review).not.toContain("info@coversandall.com");
  });
});
