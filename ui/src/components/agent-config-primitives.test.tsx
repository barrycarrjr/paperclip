// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Field } from "./agent-config-primitives";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Field", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps the help icon beside its label on a touch screen", () => {
    // A touch screen makes every button at least 44px tall (index.css). The
    // icon sat at the top of that, so on a phone each "?" on the agent
    // Configuration tab was drawn above its label instead of beside it.
    act(() => {
      root.render(
        <TooltipProvider>
          <Field label="Name" hint="Display name for this agent.">
            <input />
          </Field>
        </TooltipProvider>,
      );
    });
    const help = container.querySelector("button");
    expect(help).not.toBeNull();
    expect(help!.classList.contains("items-center")).toBe(true);
  });
});
