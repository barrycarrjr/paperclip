import { expect, it } from "vitest";
import { buildCanonicalMessages } from "../services/chat.js";

it("keeps inline consent visible in history without separating provider tool calls from their results", () => {
  const content = buildCanonicalMessages([
    { role: "user", content: [{ type: "text", text: "Fix it" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "repair-1", name: "repair", input: {} }] },
    { role: "user", content: [{ type: "text", text: "Yes, do it" }] },
    { role: "tool", content: [{ type: "tool_result", tool_use_id: "repair-1", content: "Verified" }] },
    { role: "assistant", content: [{ type: "text", text: "Done" }] },
  ] as never);
  expect(content.map(m => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  expect(content[2].content).toEqual([
    { type: "tool_result", tool_use_id: "repair-1", content: "Verified" },
    { type: "text", text: "Yes, do it" },
  ]);
});
