// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelListEntry } from "@paperclipai/shared";
import { DEFAULT_CODEX_LOCAL_MODEL } from "@paperclipai/adapter-codex-local";
import { defaultModelForAdapter } from "../lib/model-defaults";
import { queryKeys } from "../lib/queryKeys";
import { useAdapterModelDefault } from "./useAdapterModelDefault";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const CODEX_LIST: ModelListEntry[] = [
  { id: "gpt-6-astra", label: "GPT-6-Astra", status: "current", isDefault: true, isNew: true },
  { id: "gpt-6-sol", label: "GPT-6-Sol", status: "current" },
];

describe("defaultModelForAdapter", () => {
  it("prefers the provider's own default once its list has loaded", () => {
    expect(defaultModelForAdapter("codex_local", CODEX_LIST)).toBe("gpt-6-astra");
  });

  it("falls back to the built-in model while the list is missing or names no default", () => {
    expect(defaultModelForAdapter("codex_local")).toBe(DEFAULT_CODEX_LOCAL_MODEL);
    expect(defaultModelForAdapter("codex_local", [{ id: "gpt-6-sol", label: "GPT-6-Sol" }])).toBe(
      DEFAULT_CODEX_LOCAL_MODEL,
    );
  });

  it("never fills in a retiring or older default", () => {
    const list: ModelListEntry[] = [{ id: "old", label: "Old", isDefault: true, status: "deprecated" }];
    expect(defaultModelForAdapter("codex_local", list)).toBe(DEFAULT_CODEX_LOCAL_MODEL);
  });

  it("leaves adapters that pick their own model empty", () => {
    expect(defaultModelForAdapter("claude_local", CODEX_LIST)).toBe("");
    expect(defaultModelForAdapter("opencode_local")).toBe("");
  });
});

describe("useAdapterModelDefault", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let form: {
    adapterType: string;
    model: string;
    setModel: (model: string) => void;
    switchTo: (adapterType: string) => void;
  };

  /** A form holding an adapter and a model, with the adapter's list passed in. */
  function Form({ models }: { models: ModelListEntry[] | undefined }) {
    const [adapterType, setAdapterType] = useState("claude_local");
    const [model, setModel] = useState("");
    const fill = useAdapterModelDefault({ companyId: "c1", adapterType, model, models, setModel });
    form = {
      adapterType,
      model,
      setModel,
      switchTo: (next) => {
        setAdapterType(next);
        setModel(fill(next));
      },
    };
    return null;
  }

  function renderForm(models: ModelListEntry[] | undefined) {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Form models={models} />
        </QueryClientProvider>,
      );
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("fills the provider's default at once when the list is already loaded", () => {
    queryClient.setQueryData(queryKeys.agents.adapterModels("c1", "codex_local"), CODEX_LIST);
    renderForm(undefined);

    act(() => form.switchTo("codex_local"));
    expect(form.model).toBe("gpt-6-astra");
  });

  // The bug: new Codex agents kept the built-in id, which Codex had retired.
  it("swaps the built-in model for the provider's default when the list arrives", () => {
    renderForm(undefined);
    act(() => form.switchTo("codex_local"));
    expect(form.model).toBe(DEFAULT_CODEX_LOCAL_MODEL);

    renderForm(CODEX_LIST);
    expect(form.model).toBe("gpt-6-astra");
  });

  it("keeps a model a person picked before the list arrived", () => {
    renderForm(undefined);
    act(() => form.switchTo("codex_local"));
    act(() => form.setModel("gpt-6-sol"));

    renderForm(CODEX_LIST);
    expect(form.model).toBe("gpt-6-sol");
  });

  it("changes nothing for an adapter that picks its own model", () => {
    renderForm(undefined);
    act(() => form.switchTo("claude_local"));

    renderForm(CODEX_LIST);
    expect(form.model).toBe("");
  });
});
