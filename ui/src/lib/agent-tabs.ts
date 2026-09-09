/**
 * The tabs on one agent's own page.
 *
 * Pulled out of AgentDetail.tsx so the names can be checked by a test without
 * mounting that whole page, which needs a great deal of stubbing. The same
 * reasoning as work-tabs.ts and team-tabs.ts.
 *
 * The first tab is called "Current work", per difference 11 of
 * docs/plans/2026-09-07-mockup-vs-app.md. Its value stays "dashboard" on
 * purpose: that value is in the web address, so changing it would break every
 * saved link to this tab. The Team page uses the same words for the same idea,
 * so the two agree with each other.
 *
 * Channels is not here. The mockup lists it as a fixed tab; in this app it is
 * contributed by an add-on, so it appears only when that add-on is installed,
 * and inventing an empty fixed tab for it would promise something the app
 * cannot deliver on its own.
 */
export interface AgentTab {
  value: string;
  label: string;
}

export const AGENT_TABS: AgentTab[] = [
  { value: "dashboard", label: "Current work" },
  { value: "instructions", label: "Instructions" },
  { value: "skills", label: "Skills" },
  { value: "configuration", label: "Configuration" },
  { value: "runs", label: "Runs" },
  { value: "budget", label: "Budget" },
];

/** The label to show in the breadcrumb trail for a tab, by its value. */
export function agentTabLabel(value: string): string | null {
  return AGENT_TABS.find((tab) => tab.value === value)?.label ?? null;
}
