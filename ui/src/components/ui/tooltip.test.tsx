// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./hover-card";
import { Z_TOOLTIP, zLayerValue } from "@/lib/z-layers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("TooltipContent stacking", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function layerOf(selector: string): number {
    const el = document.querySelector(selector);
    expect(el, `expected ${selector} to be rendered`).not.toBeNull();
    const cls = el!.getAttribute("class") ?? "";
    const hit = cls
      .split(/\s+/)
      .map(zLayerValue)
      .find((n) => !Number.isNaN(n));
    expect(hit, `expected ${selector} to carry a layer class, got: ${cls}`).toBeDefined();
    return hit!;
  }

  it("renders above a popover it is nested inside", () => {
    // Mirrors the real arrangement in SidebarAccountMenu: tooltips living
    // inside an open popover. Before the shared scale, the tooltip lost and its
    // label was hidden behind the menu it belonged to.
    act(() => {
      root.render(
        <TooltipProvider>
          <Popover open>
            <PopoverTrigger>menu</PopoverTrigger>
            <PopoverContent>
              <Tooltip open>
                <TooltipTrigger>icon</TooltipTrigger>
                <TooltipContent>Back up now</TooltipContent>
              </Tooltip>
            </PopoverContent>
          </Popover>
        </TooltipProvider>,
      );
    });

    expect(layerOf('[data-slot="tooltip-content"]')).toBeGreaterThan(
      layerOf('[data-slot="popover-content"]'),
    );
  });

  it("renders above a hover card", () => {
    act(() => {
      root.render(
        <TooltipProvider>
          <HoverCard open>
            <HoverCardTrigger>card</HoverCardTrigger>
            <HoverCardContent>details</HoverCardContent>
          </HoverCard>
          <Tooltip open>
            <TooltipTrigger>icon</TooltipTrigger>
            <TooltipContent>label</TooltipContent>
          </Tooltip>
        </TooltipProvider>,
      );
    });

    expect(layerOf('[data-slot="tooltip-content"]')).toBeGreaterThan(
      layerOf('[data-slot="hover-card-content"]'),
    );
  });

  it("keeps its layer when the caller passes an unrelated className", () => {
    // cn() merges Tailwind conflicts, so a caller passing their own z-* wins on
    // purpose. Passing anything else must not strip the layer. SidebarAccountMenu
    // passes max-w-[220px] on every tooltip in that menu.
    act(() => {
      root.render(
        <TooltipProvider>
          <Tooltip open>
            <TooltipTrigger>icon</TooltipTrigger>
            <TooltipContent className="max-w-[220px]">label</TooltipContent>
          </Tooltip>
        </TooltipProvider>,
      );
    });

    expect(layerOf('[data-slot="tooltip-content"]')).toBe(zLayerValue(Z_TOOLTIP));
  });
});
