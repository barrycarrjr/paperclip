// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionPolicyControls } from "./ActionPolicyControls";

describe("ActionPolicyControls", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("renders all five company actions and saves the selected mode", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(<ActionPolicyControls scope="company" policies={[]} onChange={onChange} />);
    });

    expect(container.querySelectorAll("select")).toHaveLength(5);
    expect(container.textContent).toContain("Send messages");
    expect(container.textContent).toContain("Change the knowledge base");
    expect(container.textContent).not.toContain("Use company setting");

    const select = container.querySelector('[data-testid="action-policy-move_money"]') as HTMLSelectElement;
    act(() => {
      select.value = "go_ahead";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("move_money", "go_ahead");
  });

  it("shows agent inheritance and effective source, and clears an override", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <ActionPolicyControls
          scope="agent"
          overrides={[{ companyId: "company-1", agentId: "agent-1", actionType: "send_message", mode: "go_ahead" }]}
          effective={[{
            companyId: "company-1",
            agentId: "agent-1",
            actionType: "send_message",
            companyMode: "ask_first",
            overrideMode: "go_ahead",
            effectiveMode: "go_ahead",
            source: "agent",
          }]}
          onChange={onChange}
        />,
      );
    });

    expect(container.textContent).toContain("Use company setting");
    expect(container.textContent).toContain("Effective: Go ahead, agent override.");

    const select = container.querySelector('[data-testid="action-policy-send_message"]') as HTMLSelectElement;
    act(() => {
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("send_message", null);
  });
});
