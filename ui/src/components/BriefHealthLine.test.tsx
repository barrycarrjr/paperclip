// @vitest-environment node

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { briefHealth, type BriefHealthCounts } from "../lib/brief-health";
import { BriefHealthLine, type BriefErroredAgent } from "./BriefHealthLine";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={typeof to === "string" ? to : ""} {...props}>
      {children}
    </a>
  ),
}));

function health(overrides: Partial<BriefHealthCounts> = {}) {
  return briefHealth({
    agentErrors: 0,
    budgetIncidents: 0,
    blockedTasks: 0,
    waitingOnYou: 0,
    pendingApprovals: 0,
    ...overrides,
  });
}

function agent(name: string): BriefErroredAgent {
  return { id: `id-${name}`, name, href: `/agents/${name.toLowerCase()}` };
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

describe("BriefHealthLine", () => {
  it("shows a green dot when all is clear", () => {
    const html = renderToStaticMarkup(<BriefHealthLine health={health()} />);
    expect(text(html)).toBe("All systems green.");
    expect(html).toContain('data-tone="green"');
    expect(html).toContain("bg-emerald-500");
  });

  // Seen live: "1 agent error." beside a green dot, with no word of which agent.
  it("names the agent in error, links to it, and colours the dot red", () => {
    const html = renderToStaticMarkup(
      <BriefHealthLine health={health({ agentErrors: 1 })} erroredAgents={[agent("Scout")]} />,
    );
    expect(text(html)).toBe("1 agent in error (Scout).");
    expect(html).toContain('href="/agents/scout"');
    expect(html).toContain('data-tone="red"');
    expect(html).not.toContain("bg-emerald-500");
  });

  it("colours the dot amber for blocked work", () => {
    const html = renderToStaticMarkup(<BriefHealthLine health={health({ blockedTasks: 9 })} />);
    expect(text(html)).toBe("9 tasks blocked.");
    expect(html).toContain('data-tone="amber"');
  });

  it("keeps the count when the agents have not loaded yet", () => {
    const html = renderToStaticMarkup(<BriefHealthLine health={health({ agentErrors: 2 })} />);
    expect(text(html)).toBe("2 agents in error.");
  });

  it("names three agents and links the rest", () => {
    const html = renderToStaticMarkup(
      <BriefHealthLine
        health={health({ agentErrors: 5, blockedTasks: 1 })}
        erroredAgents={["A", "B", "C", "D", "E"].map(agent)}
        moreAgentsHref="/agents/error"
      />,
    );
    expect(text(html)).toBe("5 agents in error (A, B, C, 2 more), 1 task blocked.");
    expect(html).toContain('href="/agents/error"');
    expect(html).not.toContain('href="/agents/d"');
  });

  it("says how many more in plain text when there is nowhere to send them", () => {
    const html = renderToStaticMarkup(
      <BriefHealthLine
        health={health({ agentErrors: 4 })}
        erroredAgents={["A", "B", "C", "D"].map(agent)}
      />,
    );
    expect(text(html)).toBe("4 agents in error (A, B, C, 1 more).");
    expect(html).not.toContain('href="/agents/error"');
  });
});
