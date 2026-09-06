import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderStreamEvent, ProviderTurnInput, ProviderTurnResult } from "../services/chat-providers.js";

const mocks = vi.hoisted(() => ({
  getProviderForModel: vi.fn(),
  decodeAdapterModel: vi.fn(),
  removeClippyWorkspace: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../services/chat-providers.js", () => ({
  getProviderForModel: mocks.getProviderForModel,
  decodeAdapterModel: mocks.decodeAdapterModel,
  removeClippyWorkspace: mocks.removeClippyWorkspace,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: mocks.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { completeOnce, OneShotError, OneShotJsonError, parseJsonObject } from "../services/llm-one-shot.js";

type StreamTurn = (input: ProviderTurnInput) => AsyncGenerator<ProviderStreamEvent, ProviderTurnResult, void>;

function fakeProvider(streamTurn: StreamTurn, configured = true) {
  return {
    name: "anthropic" as const,
    isConfigured: () => configured,
    supportsModel: () => true,
    defaultModel: () => "fake-model",
    listModels: () => ["fake-model"],
    streamTurn: vi.fn(streamTurn),
  };
}

beforeEach(() => {
  mocks.getProviderForModel.mockReset();
  mocks.decodeAdapterModel.mockReset();
  mocks.removeClippyWorkspace.mockReset();
  mocks.warn.mockReset();
  mocks.decodeAdapterModel.mockReturnValue(null);
  mocks.removeClippyWorkspace.mockResolvedValue(undefined);
});

describe("completeOnce", () => {
  it("drains a fake provider generator and returns the joined text and modelUsed", async () => {
    const provider = fakeProvider(async function* () {
      yield { type: "text_delta", delta: "Hel" };
      yield { type: "text_delta", delta: "lo" };
      return {
        content: [
          { type: "text", text: "Hel" },
          { type: "tool_use", id: "t1", name: "noop", input: {} },
          { type: "text", text: "lo " },
        ],
        stopReason: "end_turn",
      };
    });
    mocks.getProviderForModel.mockReturnValue(provider);

    const result = await completeOnce({
      model: "fake-model",
      system: "Be brief.",
      content: "Say hello",
      callerLabel: "test-caller",
    });

    // text_delta events are discarded; only the final content's text blocks
    // are joined, and the joined text is trimmed.
    expect(result).toEqual({ text: "Hello", modelUsed: "fake-model", stopReason: "end_turn" });
    expect(provider.streamTurn).toHaveBeenCalledTimes(1);
    const input = provider.streamTurn.mock.calls[0][0];
    expect(input.model).toBe("fake-model");
    expect(input.system).toBe("Be brief.");
    expect(input.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Say hello" }] }]);
    // Native route: no synthesised adapter context and no workspace to remove.
    expect(input.adapterContext).toBeUndefined();
    expect(mocks.removeClippyWorkspace).not.toHaveBeenCalled();
  });

  it("passes pre-built content blocks and resolved attachments through untouched", async () => {
    const provider = fakeProvider(async function* () {
      return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" };
    });
    mocks.getProviderForModel.mockReturnValue(provider);
    const attachments = new Map([["a1", { data: Buffer.from("x"), mediaType: "image/png", name: "x.png" }]]);
    const blocks = [
      { type: "text" as const, text: "Look" },
      { type: "image" as const, attachmentId: "a1", url: "inline:a1", mediaType: "image/png", name: "x.png" },
    ];

    await completeOnce({
      model: "fake-model",
      system: "s",
      content: blocks,
      resolvedAttachments: attachments,
      callerLabel: "test-caller",
    });

    const input = provider.streamTurn.mock.calls[0][0];
    expect(input.messages[0].content).toBe(blocks);
    expect(input.resolvedAttachments).toBe(attachments);
  });

  it("synthesises adapterContext and removes the clippy workspace in finally for adapter-routed models, even when the stream throws", async () => {
    mocks.decodeAdapterModel.mockReturnValue({ adapterType: "claude_local", model: "opus" });
    const boom = new Error("adapter crashed mid-stream");
    const provider = fakeProvider(async function* () {
      yield { type: "text_delta", delta: "partial" };
      throw boom;
    });
    mocks.getProviderForModel.mockReturnValue(provider);
    // The cleanup itself failing must not mask the stream error; it only warns.
    mocks.removeClippyWorkspace.mockRejectedValue(new Error("rmdir failed"));

    await expect(
      completeOnce({
        model: "adapter:claude_local:opus",
        system: "s",
        content: "plan this",
        callerLabel: "start-work-planner",
        boardUserId: "user-123",
      }),
    ).rejects.toBe(boom);

    const input = provider.streamTurn.mock.calls[0][0];
    const ctx = input.adapterContext;
    expect(ctx).toBeDefined();
    // Session id is `<callerLabel>-<uuid>` so a stray workspace names its caller.
    expect(ctx!.sessionId).toMatch(/^start-work-planner-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(ctx!.boardUserId).toBe("user-123");
    expect(ctx!.companyId).toBeNull();
    expect(ctx!.prevSessionParams).toBeNull();
    await expect(ctx!.saveSessionParams({ x: 1 })).resolves.toBeUndefined();

    // Workspace removed with the same session id even though the stream threw.
    expect(mocks.removeClippyWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.removeClippyWorkspace).toHaveBeenCalledWith(ctx!.sessionId);
    // The rejected cleanup is reported, not thrown.
    await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalledTimes(1));
    expect(mocks.warn.mock.calls[0][0]).toMatchObject({
      caller: "start-work-planner",
      sessionId: ctx!.sessionId,
      err: "rmdir failed",
    });
  });

  it("falls back to the callerLabel as boardUserId when none is given, and still cleans up on success", async () => {
    mocks.decodeAdapterModel.mockReturnValue({ adapterType: "claude_local", model: "opus" });
    const provider = fakeProvider(async function* () {
      return { content: [{ type: "text", text: "done" }], stopReason: "end_turn" };
    });
    mocks.getProviderForModel.mockReturnValue(provider);

    const result = await completeOnce({
      model: "adapter:claude_local:opus",
      system: "s",
      content: "go",
      callerLabel: "plugin-ai-abc",
    });

    expect(result.text).toBe("done");
    const ctx = provider.streamTurn.mock.calls[0][0].adapterContext;
    expect(ctx!.boardUserId).toBe("plugin-ai-abc");
    expect(mocks.removeClippyWorkspace).toHaveBeenCalledWith(ctx!.sessionId);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("throws not_configured when the provider is not configured and never calls streamTurn", async () => {
    const provider = fakeProvider(async function* () {
      return { content: [], stopReason: "end_turn" };
    }, false);
    mocks.getProviderForModel.mockReturnValue(provider);

    const err = await completeOnce({
      model: "fake-model",
      system: "s",
      content: "x",
      callerLabel: "test-caller",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OneShotError);
    expect((err as OneShotError).code).toBe("not_configured");
    expect((err as OneShotError).model).toBe("fake-model");
    expect(provider.streamTurn).not.toHaveBeenCalled();
    expect(mocks.removeClippyWorkspace).not.toHaveBeenCalled();
  });

  it("throws unknown_model when no provider handles the model", async () => {
    mocks.getProviderForModel.mockReturnValue(null);

    const err = await completeOnce({
      model: "nobody-owns-this",
      system: "s",
      content: "x",
      callerLabel: "test-caller",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OneShotError);
    expect((err as OneShotError).code).toBe("unknown_model");
    expect((err as OneShotError).message).toContain("nobody-owns-this");
  });
});

describe("parseJsonObject", () => {
  it("parseJsonObject strips a json fence and rejects non-object output", () => {
    expect(parseJsonObject('```json\n{"tasks": [1, 2]}\n```')).toEqual({ tasks: [1, 2] });
    expect(parseJsonObject('```\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseJsonObject('  {"a": 1}  ')).toEqual({ a: 1 });
    // Only one fence is stripped; nested fences are the model's problem.
    expect(() => parseJsonObject("```json\n```json\n{}\n```\n```")).toThrow(OneShotJsonError);

    const notJson = (() => {
      try {
        parseJsonObject("Sure! Here is the plan: {");
      } catch (e) {
        return e;
      }
    })();
    expect(notJson).toBeInstanceOf(OneShotJsonError);
    expect((notJson as OneShotJsonError).code).toBe("not_json");

    for (const bad of ["[1, 2]", "null", '"text"', "42"]) {
      const err = (() => {
        try {
          parseJsonObject(bad);
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(OneShotJsonError);
      expect((err as OneShotJsonError).code).toBe("not_object");
    }
  });
});
