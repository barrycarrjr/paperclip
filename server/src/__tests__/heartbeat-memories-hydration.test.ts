import { describe, expect, it } from "vitest";
import {
  buildPaperclipMemoriesMarkdown,
  HEARTBEAT_MEMORIES_MAX_CHARS,
  HEARTBEAT_MEMORIES_MAX_ITEMS,
} from "../services/heartbeat.js";

describe("buildPaperclipMemoriesMarkdown", () => {
  it("returns null when memories list is empty", () => {
    expect(buildPaperclipMemoriesMarkdown([])).toBeNull();
  });

  it("renders single-line memories with and without descriptions", () => {
    const markdown = buildPaperclipMemoriesMarkdown([
      {
        name: "tech_stack",
        content: "React 19 with Tailwind v4",
        description: "frontend guidelines",
        kind: "guideline",
      },
      {
        name: "board_contact",
        content: "Ping Bryon for board approvals",
        description: null,
        kind: "contact",
      },
    ]);

    expect(markdown).toContain("Paperclip company memories:");
    expect(markdown).toContain("- **tech_stack** (frontend guidelines): React 19 with Tailwind v4");
    expect(markdown).toContain("- **board_contact**: Ping Bryon for board approvals");
  });

  it("indents multi-line memory content cleanly", () => {
    const markdown = buildPaperclipMemoriesMarkdown([
      {
        name: "code_style",
        content: "Line 1: use const\nLine 2: avoid any",
        description: "conventions",
        kind: "rule",
      },
    ]);

    expect(markdown).toContain("- **code_style** (conventions):\n  Line 1: use const\n  Line 2: avoid any");
  });

  it("truncates and appends guidance when memories exceed max items count", () => {
    const items = Array.from({ length: HEARTBEAT_MEMORIES_MAX_ITEMS + 5 }, (_, i) => ({
      name: `rule_${i}`,
      content: `value for rule ${i}`,
      description: null,
      kind: "rule",
    }));

    const markdown = buildPaperclipMemoriesMarkdown(items);
    expect(markdown).not.toBeNull();
    expect(markdown).toContain("- **rule_0**: value for rule 0");
    expect(markdown).toContain(`- **rule_${HEARTBEAT_MEMORIES_MAX_ITEMS - 1}**:`);
    expect(markdown).not.toContain(`- **rule_${HEARTBEAT_MEMORIES_MAX_ITEMS}**:`);
    expect(markdown).toContain("recall_memories");
  });

  it("truncates and appends guidance when total character count exceeds limit", () => {
    const longString = "A".repeat(3000);
    const items = [
      { name: "mem1", content: longString, description: null, kind: "note" },
      { name: "mem2", content: longString, description: null, kind: "note" },
      { name: "mem3", content: longString, description: null, kind: "note" },
    ];

    const markdown = buildPaperclipMemoriesMarkdown(items);
    expect(markdown).not.toBeNull();
    expect(markdown!.length).toBeLessThanOrEqual(HEARTBEAT_MEMORIES_MAX_CHARS + 200);
    expect(markdown).toContain("recall_memories");
  });
});
