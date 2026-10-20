import { describe, expect, it, vi } from "vitest";
import { redactOperationalJson, redactOperationalText, redactionResidualMatches, prepareCommentRedaction, quotedJsonTokens } from "../services/comment-redaction-text.js";
import { redactLog, logResidualMatches } from "../services/comment-redaction.js";
import { boundHeartbeatRunEventPayloadForStorage, compactRunLogChunk } from "../services/heartbeat.js";

describe("lossless operational comment cleanup", () => {
  it("prepares full Unicode SQL spellings with bounded regex programs and literal case", () => {
    const target = 'Example.[\\"\n' + Array.from({ length: 110 }, (_, i) => String.fromCharCode(0x4e00 + i)).join("") + '\u00e9\ud83d\ude80';
    const prepared = prepareCommentRedaction([target], false);
    const candidate = (value: string) => prepared.unicodeCandidatePatterns.some((parts) => parts.every((pattern) => new RegExp(pattern).test(value)));
    for (let value = target, level = 0; level <= 3; level++, value = JSON.stringify(value).slice(1, -1)) {
      const mixed = value.replace(/[^\x00-\x7f]/g, (unit, index) => index % 3 ? "\\u" + unit.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase() : unit);
      // Never make a raw lone surrogate in a PostgreSQL text parameter.
      const valid = mixed.replace(/\ud83d/g, String.raw`\uD83D`).replace(/\ude80/g, String.raw`\uDE80`);
      expect(candidate(valid)).toBe(true);
      expect(candidate(valid.replace("Example", "example"))).toBe(false);
    }
    expect(candidate(String.raw`\u4E00`)).toBe(false);
    const long = prepareCommentRedaction([Array.from({ length: 2000 }, (_, i) => String.fromCharCode(0x4e00 + i)).join("")], false);
    expect(long.unicodeCandidatePatterns[0]!.length).toBeGreaterThan(1);
    expect(long.unicodeCandidatePatterns.flat().every((pattern) => pattern.length <= 16_000)).toBe(true);
    expect(prepareCommentRedaction(["ordinary selection"], false).unicodeCandidatePatterns).toEqual([]);
  });

  it("selectively prechecks its own UTF-16 escapes and combines multiline encoding forms", () => {
    const target = 'Case.["\\\n' + Array.from({ length: 93 }, (_, i) => String.fromCharCode(0x4e00 + i)).join("") + '\t\u00e9\ud83d\ude80';
    const prepared = prepareCommentRedaction([target], false);
    expect(prepared.candidateForms).toHaveLength(4);
    expect(prepared.unicodeCandidatePatterns).toHaveLength(1);
    expect(prepared.unicodeCandidatePatterns[0]).toHaveLength(1);
    const precheck = (text: string) => prepared.unicodePrechecks.some((pattern) => new RegExp(pattern).test(text));
    for (const ordinary of [String.raw`\u001b[32mPASS\u001b[0m`, String.raw`C:\\ui\\src\\utils`, String.raw`\u042f unrelated`]) expect(precheck(ordinary)).toBe(false);
    for (const unit of target.split("").filter((char) => char.charCodeAt(0) >= 128)) {
      const hex = unit.charCodeAt(0).toString(16).padStart(4, "0");
      for (const spelling of [hex, hex.toUpperCase()]) expect(precheck("\\".repeat(16) + "u" + spelling)).toBe(true);
    }
    const escaped = target.replace(/[^\x00-\x7f]/g, (unit) => "\\".repeat(16) + "u" + unit.charCodeAt(0).toString(16).padStart(4, "0"));
    expect(prepared.unicodeCandidatePatterns.some((parts) => parts.every((pattern) => new RegExp(pattern).test(escaped)))).toBe(true);
    // SQL widening does not change the replacement matcher's decoded bound.
    expect(redactOperationalText("before " + "\\".repeat(16) + "u00e9 after", ["Caf\u00e9 value"], false)).not.toContain("[redacted]");
  });

  it("extracts valid JSON strings exactly and consumes dangling or invalid tokens safely", () => {
    const values = ['plain', 'quoted "value"', 'backslash \\', 'line\nnext', '\t', '🚀', '\\"', ''];
    const json = JSON.stringify({ values, nested: JSON.stringify({ values }) });
    expect([...quotedJsonTokens(json)].map((t) => t.text)).toEqual([...json.matchAll(/"(?:[^"\\]|\\.)*"/g)].map((m) => m[0]));
    for (const value of ['"dangling', '"escape\\', '"' + '\\"'.repeat(1000)]) expect([...quotedJsonTokens(value)]).toEqual([]);
    const invalid = '"bad\\\nnewline" "valid"';
    const tokens = [...quotedJsonTokens(invalid)];
    expect(() => JSON.parse(tokens[0]!.text)).toThrow();
    expect(JSON.parse(tokens[1]!.text)).toBe("valid");
  });

  it("executes bounded JS programs at all 20 maximum-sized mixed-encoding selections", () => {
    const targets = Array.from({ length: 20 }, (_, i) => {
      let target = `T${i} `;
      for (let j = 0; target.length < 2000; j++) {
        const value = [String.fromCodePoint(0x1f600 + ((i * 31 + j) % 64)), String.fromCharCode(0x4e00 + ((i * 97 + j * 13) % 20000)), '"', "\\", j % 50 === 4 ? "\n" : "\u00e9", String.fromCharCode(0x0430 + (j % 32))][(i + j) % 6]!;
        if (target.length + value.length > 2000) break;
        target += value;
      }
      return target;
    });
    const prepared = prepareCommentRedaction(targets, false);
    const expected = targets.map(() => "[redacted]").join(" | ");
    const variants = [targets, targets.map((target) => target.replace(/[^\x00-\x7f]/g, (unit) => "\\u" + unit.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()))];
    for (const forms of variants) for (let level = 0; level <= 2; level++) {
      let text = forms.join(" | ");
      for (let i = 0; i < level; i++) text = JSON.stringify(text).slice(1, -1);
      expect(redactOperationalText(text, targets, false, prepared)).toBe(expected);
    }
    const json = JSON.stringify({ output: variants[1]!.join(" | "), sessionId: "structural" });
    expect(redactOperationalJson(json, targets, false, undefined, prepared)).toBe(JSON.stringify({ output: expected, sessionId: "structural" }));
    expect(redactionResidualMatches(expected, targets, false, false, prepared)).toBe(0);
    // Reusing the holder must reset every program's cursor.
    expect(redactOperationalText(targets[0]!, targets, false, prepared)).toBe("[redacted]");
  });

  it("checks malformed 250/500 KiB output through logResidualMatches without suffix rescans", () => {
    const targets = ["ACCT 9000001234"];
    const prepared = prepareCommentRedaction(targets, false);
    const times: number[] = [];
    for (const pairs of [64_000, 128_000]) {
      const chunk = 'progress "' + '\\"'.repeat(pairs);
      const log = JSON.stringify({ stream: "stdout", chunk }) + "\n";
      const start = performance.now();
      expect(logResidualMatches(log, targets, false, prepared)).toBe(0);
      times.push(performance.now() - start);
      expect(times.at(-1)).toBeLessThan(1500);
    }
    // Broad allowance for shared-machine load, but the former 10-second pass fails.
    expect(times[1]!).toBeLessThan(times[0]! * 3 + 200);
    console.log(`malformed log residual 250/500 KiB: ${times.map((n) => n.toFixed(1)).join("/")}ms`);
  });

  it("counts actual heartbeat truncation edges without replacing partial selections", () => {
    const secret = "example-pass-Zq7Rt5WmQ2xY";
    const targets = [secret];
    const event = boundHeartbeatRunEventPayloadForStorage({ prompt: "x".repeat(16384 - 12) + secret + " tail".repeat(100) });
    expect(event.prompt).toContain("\n[truncated ");
    const stored = JSON.stringify(event);
    expect(redactOperationalJson(stored, targets, false)).toBe(stored);
    expect(redactionResidualMatches(stored, targets, false, true)).toBeGreaterThan(0);
    const head = Math.floor(65536 * 0.6), tail = Math.floor(65536 * 0.25);
    // Put a cut through both the head's prefix and the tail's suffix of a target.
    const raw = "a".repeat(head - 9) + secret + "b".repeat(70000) + secret + "c".repeat(tail - 11);
    const compacted = compactRunLogChunk(raw);
    expect(compacted).toContain("\n[paperclip truncated run log chunk: omitted ");
    expect(redactionResidualMatches(compacted, targets, false)).toBe(2);
    for (let encoded = compacted, level = 0; level <= 3; level++, encoded = JSON.stringify(encoded).slice(1, -1)) {
      expect(redactionResidualMatches(encoded, targets, false, true)).toBe(2);
    }
    const nested = JSON.stringify({ type: "user", content: JSON.stringify({ output: compacted, event: event.prompt }) });
    const log = [nested.slice(0, 51), nested.slice(51)].map((chunk) => JSON.stringify({ stream: "stdout", chunk })).join("\n");
    expect(redactLog(log, targets, false)).toBe(log);
    expect(logResidualMatches(log, targets, false)).toBeGreaterThanOrEqual(3);
    // An identity is insufficient when truncation broke the original prefix proof.
    const identity = JSON.stringify({ paperclipWakeComment: { id: "synthetic-comment", body: event.prompt } });
    expect(redactOperationalJson(identity, targets, false, { commentId: "synthetic-comment", originalBody: "x".repeat(16384 - 12) + secret, redactedBody: "[redacted]" })).toBe(identity);
    for (const marker of ["\n[truncated 2 chars] trailing", "\n[truncated -2 chars]", "\n[truncated 0 chars]", "[truncated 2 chars]", "\n[paperclip truncated run log chunk: omitted two chars]\n"]) {
      expect(redactionResidualMatches("prefix " + secret.slice(0, 9) + marker + "suffix", targets, false)).toBe(0);
    }
    for (const marker of ["\n[truncated -2 chars]", "\n[truncated 0 chars]", "\n[truncated 02 chars]", "[truncated 2 chars]", "\n[paperclip truncated run log chunk: omitted 2 chars]"]) {
      expect(redactionResidualMatches("prefix " + secret.slice(0, 9) + marker, targets, false)).toBe(0);
    }
    expect(redactionResidualMatches("prefix " + secret.slice(0, 3) + "\n[truncated 20 chars]", targets, false)).toBe(0);
    expect(redactionResidualMatches("prefix " + secret + "\n[truncated 20 chars]", targets, false)).toBe(1);
  });

  it("prepares long selections once across small values, adapter chunks and residual checks", () => {
    const key = ["-----BEGIN EXAMPLE PRIVATE KEY-----", ...Array.from({ length: 26 }, (_, i) => ("EXAMPLEnotARealKey" + i + "abcdefghijklmnopqrstuvwxyz0123456789+/").padEnd(64, "Q")), "-----END EXAMPLE PRIVATE KEY-----"].join("\n");
    const targets = [key];
    const prepared = prepareCommentRedaction(targets, false);
    const ordinary = Array.from({ length: 600 }, (_, i) => `ordinary value ${i}`);
    // A relative comparison tolerates slower machines. The constructor assertion
    // below also detects recompilation without depending on elapsed time.
    const baselineStart = performance.now();
    for (const value of ordinary.slice(0, 100)) redactOperationalText(value, targets, false);
    const baselinePerValue = (performance.now() - baselineStart) / 100;
    const cachedStart = performance.now();
    for (const value of ordinary) redactOperationalText(value, targets, false, prepared);
    const cachedPerValue = (performance.now() - cachedStart) / ordinary.length;
    expect(cachedPerValue).toBeLessThan(baselinePerValue / 3);
    const constructor = vi.spyOn(globalThis, "RegExp");
    try {
      const field = JSON.stringify({ items: ordinary.map((text) => ({ text })), text: key, n: 9007199254740991 });
      const cleaned = redactOperationalJson(field, targets, false, undefined, prepared);
      expect(JSON.parse(cleaned).text).toBe("[redacted]");
      expect(redactionResidualMatches(cleaned, targets, false, true, prepared)).toBe(0);
      const output = ordinary.map((value, i) => JSON.stringify({ type: "user", message: { content: JSON.stringify({ text: i === 0 ? key : value }) } }) + "\n").join("");
      const log = Array.from({ length: Math.ceil(output.length / 71) }, (_, i) => JSON.stringify({ stream: "stdout", chunk: output.slice(i * 71, (i + 1) * 71) })).join("\n");
      const next = redactLog(log, targets, false, prepared);
      expect(next).toContain("[redacted]");
      expect(logResidualMatches(next, targets, false, prepared)).toBe(0);
      // Repeated calls must not inherit a global regex cursor.
      for (let i = 0; i < 3; i++) expect(redactOperationalText(key + key, targets, false, prepared)).toBe("[redacted][redacted]");
      expect(constructor).not.toHaveBeenCalled();
    } finally { constructor.mockRestore(); }
    console.log(`long selection per value: rebuilt=${(baselinePerValue * 1000).toFixed(1)}us prepared=${(cachedPerValue * 1000).toFixed(1)}us`);
  });

  const target = 'Account:\nexample "quoted"\\path\t9000001234';

  it("cleans a real stream-json tool result containing a JSON comments API response", () => {
    const event = JSON.stringify({ type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "synthetic-tool", content: JSON.stringify([{ id: "synthetic-comment", body: target }]) },
    ] } }) + "\n";
    const log = `{"stream":"stdout","sequence":9007199254740993123456,"chunk":${JSON.stringify(event)}}\n`;
    const cleaned = redactLog(log, [target], true);
    const parsed = JSON.parse(JSON.parse(cleaned).chunk);
    expect(JSON.parse(parsed.message.content[0].content)[0].body).toBe("[redacted …1234]");
    expect(cleaned).toContain('"sequence":9007199254740993123456');
    expect(parsed.message.content[0].tool_use_id).toBe("synthetic-tool");
  });

  it("matches raw, once and twice escaped forms in plain excerpts with the original marker", () => {
    let form = target;
    for (let level = 0; level <= 2; level++) {
      expect(redactOperationalText(`prefix ${form} suffix`, [target], true)).toBe("prefix [redacted …1234] suffix");
      form = JSON.stringify(form).slice(1, -1);
    }
  });

  it("cleans unknown content while preserving JSON keys, structural values, timestamps and large integers", () => {
    const raw = '{"body":"2026 status example","2026":"2026","status":"2026","timestamp":"2026-10-18T10:00:00.000Z","sessionParams":{"body":"example"},"cwd":"example","unknown":"example","n":9007199254740993123456}';
    expect(redactOperationalJson(raw, ["2026", "status", "example"], false)).toBe(raw.replace('"body":"2026 status example"', '"body":"[redacted] [redacted] [redacted]"').replace('"2026":"2026"', '"2026":"[redacted]"').replace('"unknown":"example"', '"unknown":"[redacted]"'));
  });

  it("cleans Codex exec JSON and every Claude Bash/thinking output shape", () => {
    const frames = [
      { type: "item.completed", item: { id: "synthetic-item", type: "command_execution", aggregated_output: target } },
      { type: "assistant", message: { content: [{ type: "thinking", thinking: target }, { type: "tool_use", id: "synthetic-tool", input: { command: target } }] } },
      { type: "user", tool_use_result: { stdout: target, stderr: target }, message: { content: [{ type: "tool_result", tool_use_id: "synthetic-tool", content: target }] } },
    ];
    const output = frames.map((frame) => JSON.stringify(frame) + "\n").join("");
    const split = Math.floor(output.length / 2);
    const log = [output.slice(0, split), output.slice(split)].map((chunk) => `{ "sequence":9007199254740993123456,"stream":"stdout","chunk":${JSON.stringify(chunk)}}`).join("\n");
    const cleaned = redactLog(log, [target], false);
    const decoded = cleaned.split("\n").map((line) => JSON.parse(line).chunk).join("");
    expect(decoded).not.toContain(JSON.stringify(target).slice(1, -1));
    const result = decoded.trim().split("\n").map((line) => JSON.parse(line));
    expect(result[0].item.aggregated_output).toBe("[redacted]");
    expect(result[1].message.content.map((block: any) => block.thinking ?? block.input.command)).toEqual(["[redacted]", "[redacted]"]);
    expect(result[2].tool_use_result).toEqual({ stdout: "[redacted]", stderr: "[redacted]" });
    expect(cleaned.match(/9007199254740993123456/g)).toHaveLength(2);
    expect(result[0].item.id).toBe("synthetic-item");
  });

  it("treats nested escaped multiline JSON-shaped comments as content", () => {
    const comment = JSON.stringify({ service: "example", token: 'example-not-a-credential\n"quoted"' }, null, 2);
    const output = JSON.stringify({ type: "user", message: { content: JSON.stringify({ body: comment }) } }) + "\n";
    const log = JSON.stringify({ stream: "stdout", chunk: output }) + "\n";
    const cleaned = JSON.parse(JSON.parse(redactLog(log, [comment], false)).chunk);
    expect(JSON.parse(cleaned.message.content).body).toBe("[redacted]");
    expect(redactOperationalText(comment, [comment], false)).toBe("[redacted]");
    expect(JSON.parse(redactLog(JSON.stringify({ stream: "stdout", chunk: comment }), [comment], false)).chunk).toBe("[redacted]");
  });

  it("checks all twenty targets after replacement, including overlaps and preserved values", () => {
    const targets = Array.from({ length: 19 }, (_, i) => `example-choice-${String(i).padStart(2, "0")}`);
    targets.push("choice-00");
    const content = targets.join(" / ");
    const cleaned = redactOperationalJson(JSON.stringify({ sessionId: content, paperclipTaskMarkdown: content }), targets, false);
    expect(JSON.parse(cleaned).paperclipTaskMarkdown).not.toContain("choice-");
    expect(JSON.parse(cleaned).sessionId).toBe(content);
    expect(redactionResidualMatches(cleaned, targets, false, true)).toBe(20);
  });

  it("preserves untouched log bytes and rejects ambiguous chunk keys", () => {
    const untouched = '{ "stream": "stdout", "chunk": "harmless", "n":9007199254740993123456 }\n';
    expect(redactLog(untouched, [target], false)).toBe(untouched);
    expect(() => redactLog('{"stream":"stdout","chunk":"one","chunk":"two"}', [target], false)).toThrow("Ambiguous");
  });
  it("reports cut-off pieces only at field edges without guessing replacements", () => {
    const secret = "example-pass-Zq7Rt5WmQ2";
    for (const clipped of ["Login: example", "prefix " + secret.slice(0, 10), secret.slice(8) + " suffix"]) {
      expect(redactOperationalText(clipped, [secret], false)).toBe(clipped);
      expect(redactionResidualMatches(clipped, [secret], false)).toBeGreaterThan(0);
      expect(redactionResidualMatches(JSON.stringify({ content: clipped }), [secret], false, true)).toBeGreaterThan(0);
      const log = JSON.stringify({ stream: "stdout", chunk: clipped });
      expect(redactLog(log, [secret], false)).toBe(log);
      expect(logResidualMatches(log, [secret], false)).toBeGreaterThan(0);
      const nested = JSON.stringify({ type: "item.completed", item: { aggregated_output: JSON.stringify({ bodySnippet: clipped }) } });
      expect(redactionResidualMatches(nested, [secret], false)).toBeGreaterThan(0);
      expect(logResidualMatches(JSON.stringify({ stream: "stdout", chunk: nested }), [secret], false)).toBeGreaterThan(0);
    }
    expect(redactionResidualMatches("middle example content", [secret], false)).toBe(0);
    expect(redactionResidualMatches("exa", [secret], false)).toBe(0);
    expect(redactionResidualMatches("Q2", [secret], false)).toBe(0);
  });

  it("cleans mixed Unicode escapes, hex case and surrogate pairs at all supported levels", () => {
    const secret = 'example-caf\u00e9-\u03bb-\ud83d\ude80-"quoted"';
    for (const upper of [false, true]) {
      let encoded = secret.replace(/[^\x00-\x7f]/g, (unit) => {
        const hex = unit.charCodeAt(0).toString(16).padStart(4, "0");
        return "\\u" + (upper ? hex.toUpperCase() : hex);
      });
      for (let level = 0; level <= 2; level++) {
        const raw = `prefix ${encoded} suffix`;
        expect(redactOperationalText(raw, [secret], false)).toBe("prefix [redacted] suffix");
        const json = `{"type":"assistant","content":${JSON.stringify(raw)},"id":${JSON.stringify(encoded)},"n":9007199254740993123456}`;
        const cleaned = redactOperationalJson(json, [secret], false);
        expect(JSON.parse(cleaned).content).toBe("prefix [redacted] suffix");
        expect(JSON.parse(cleaned).id).toBe(encoded);
        expect(cleaned).toContain('"n":9007199254740993123456');
        expect(redactionResidualMatches(cleaned, [secret], false, true)).toBeGreaterThan(0);
        const log = JSON.stringify({ stream: "stdout", chunk: json + "\n" });
        const parsed = JSON.parse(JSON.parse(redactLog(log, [secret], false)).chunk);
        expect(parsed.content).toBe("prefix [redacted] suffix");
        expect(parsed.id).toBe(encoded);
        encoded = JSON.stringify(encoded).slice(1, -1);
      }
    }
  });

  it("rebuilds only identity-proven snippets and wake bodies without expanding clipped fields", () => {
    const secret = "example-pass-Zq7Rt5WmQ2";
    const originalBody = "x".repeat(113) + secret + " tail";
    const source = { commentId: "synthetic-comment", originalBody, redactedBody: "x".repeat(113) + "[redacted] tail", activity: true };
    const json = `{"bodySnippet":${JSON.stringify(originalBody.slice(0, 120))},"commentId":"synthetic-comment","n":9007199254740993123456}`;
    const cleaned = redactOperationalJson(json, [secret], false, source);
    expect(JSON.parse(cleaned).bodySnippet).toBe(source.redactedBody.slice(0, 120));
    expect(cleaned).toContain('"n":9007199254740993123456');
    const wake = { paperclipWake: { comments: [{ id: source.commentId, body: originalBody.slice(0, 118) }, { id: "other-comment", body: originalBody.slice(0, 118) }] }, paperclipWakeComment: { body: originalBody, id: source.commentId } };
    const next = JSON.parse(redactOperationalJson(JSON.stringify(wake), [secret], false, source));
    expect(next.paperclipWake.comments[0].body).toBe(source.redactedBody.slice(0, 118));
    expect(next.paperclipWake.comments[1]).toEqual(wake.paperclipWake.comments[1]);
    expect(next.paperclipWakeComment.body).toBe(source.redactedBody);
  });

});
