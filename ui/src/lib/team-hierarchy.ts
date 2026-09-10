import type { Agent } from "@paperclipai/shared";
import {
  TEAM_STATE_GROUP_STATES,
  teamStateGroupOf,
  type TeamAgentWork,
  type TeamStateGroup,
  type TeamWorkState,
} from "./team-current-work";

/**
 * Who works for whom, worked out from the reporting lines the app already
 * stores.
 *
 * Every Team view reads this one function: the card grid, the table, the
 * timeline, the attention list and a member's own page. That is the point of
 * it. Each of those could work out a manager's name for itself from
 * `agent.reportsTo`, and then they could each be subtly wrong in a different
 * way about a terminated manager or a company with two people at the top.
 *
 * Nothing here is a new organizational concept. `agents.reportsTo` remains
 * the only source of truth, exactly as the org chart and the server's own
 * `orgForCompany` read it. This file adds no field, stores nothing, and
 * invents no relationship: everything below is either read straight off an
 * agent or derived by walking those same links.
 *
 * The human board is deliberately absent. The operator is not an agent and
 * has no node here; the top of this tree is the CEO, and saying that the CEO
 * answers to the board is a sentence for the UI to write, not a parent for
 * the tree to carry.
 */

/** How far up a reporting line to walk before assuming something is wrong. */
const MAX_CHAIN_DEPTH = 50;

/**
 * The role that marks the top of the AI organization when a company has more
 * than one agent with no manager. This is the enum value from
 * `packages/shared/src/constants.ts`, not a name typed here twice.
 */
const CEO_ROLE = "ceo";

export interface TeamHierarchyNode {
  agent: Agent;
  /**
   * The manager actually shown, which is not always `agent.reportsTo`: an
   * agent whose manager has been terminated, or is missing from the list, or
   * sits in a loop, is treated as having no manager rather than pointing at
   * somebody who is not on screen.
   */
  managerId: string | null;
  /** 0 for anyone with no manager, 1 for their reports, and so on. */
  depth: number;
  /** Their direct reports, by name. */
  directReportIds: string[];
  /** Everybody underneath them at any depth, not counting themselves. */
  descendantIds: string[];
  /**
   * The executive whose organization this member sits in: the ancestor who
   * reports to the top, or the member themselves if they are that ancestor.
   *
   * Null for the top of the company, and null for anyone outside the
   * reporting line altogether. Null therefore means "no branch to name", and
   * the views say so in words rather than filing those members under the CEO.
   */
  branchId: string | null;
}

export interface TeamBranch {
  /** The executive who leads it, and the id the filter uses. */
  id: string;
  leader: Agent;
  /** The leader and everybody beneath them, in reading order. */
  memberIds: string[];
}

export interface TeamHierarchy {
  byId: Map<string, TeamHierarchyNode>;
  /** Everybody with no manager, in reading order. */
  rootIds: string[];
  /**
   * The top of the AI organization, when the company has one. Null when no
   * single agent can be said to be at the top, in which case the views fall
   * back to treating every root as its own branch rather than picking one.
   */
  topId: string | null;
  /** The executive organizations under the top, in reading order. */
  branches: TeamBranch[];
  /**
   * Agents with no manager who are not the top: they are in the company but
   * not in its reporting line. Kept separate on purpose, because putting
   * them under the CEO would state a reporting relationship that nobody
   * configured.
   */
  unattachedIds: string[];
  /**
   * Whether anybody in this company has a manager at all.
   *
   * A company where nobody has been given one is not a flat organization, it
   * is an organization nobody has described yet, and the views say nothing
   * about reporting lines rather than printing "no manager set" on every
   * card and offering a filter that cannot narrow anything.
   */
  hasReportingLines: boolean;
}

/** Alphabetical, the same order the org chart and the sidebar use. */
function byName(a: Agent, b: Agent): number {
  return a.name.localeCompare(b.name);
}

/**
 * Which agent is at the top of the AI organization.
 *
 * One root is the answer on its own. With several roots, the one whose role
 * is CEO is the top, because that is the role the rest of the app already
 * treats as the top (`bootstrap_ceo` invites, the `ceo_role` task-assign
 * source). Several CEOs, or none, and there is no honest answer, so this
 * returns null and the caller shows every root as its own branch instead of
 * choosing one.
 */
function findTop(roots: Agent[]): string | null {
  if (roots.length === 0) return null;
  if (roots.length === 1) return roots[0]!.id;
  const ceos = roots.filter((agent) => agent.role === CEO_ROLE);
  return ceos.length === 1 ? ceos[0]!.id : null;
}

/**
 * Build the reporting tree for one company from the agents already loaded.
 *
 * Terminated agents are dropped, matching every other Team view and the
 * server's own org tree. Their reports become roots rather than vanishing,
 * which is the honest reading: nobody is managing them at the moment.
 */
export function buildTeamHierarchy(agents: Agent[]): TeamHierarchy {
  const living = agents.filter((agent) => agent.status !== "terminated").sort(byName);
  const byAgentId = new Map(living.map((agent) => [agent.id, agent]));

  // Resolve each manager once. A manager who is not in the list (terminated,
  // or filtered out by permissions) means no manager, not a broken link.
  const managerOf = new Map<string, string | null>();
  for (const agent of living) {
    const raw = agent.reportsTo;
    managerOf.set(agent.id, raw && raw !== agent.id && byAgentId.has(raw) ? raw : null);
  }

  // A loop in the reporting lines would make the walk below run forever, so
  // it is broken here: whoever is first alphabetically in the loop is treated
  // as having no manager. The server's getChainOfCommand guards the same way.
  for (const agent of living) {
    const seen = new Set<string>([agent.id]);
    let cursor = managerOf.get(agent.id) ?? null;
    let steps = 0;
    while (cursor && steps < MAX_CHAIN_DEPTH) {
      if (seen.has(cursor)) {
        managerOf.set(agent.id, null);
        break;
      }
      seen.add(cursor);
      cursor = managerOf.get(cursor) ?? null;
      steps += 1;
    }
    if (steps >= MAX_CHAIN_DEPTH) managerOf.set(agent.id, null);
  }

  const childrenOf = new Map<string | null, Agent[]>();
  for (const agent of living) {
    const key = managerOf.get(agent.id) ?? null;
    const siblings = childrenOf.get(key) ?? [];
    siblings.push(agent);
    childrenOf.set(key, siblings);
  }
  for (const siblings of childrenOf.values()) siblings.sort(byName);

  const roots = childrenOf.get(null) ?? [];
  const topId = findTop(roots);

  const byId = new Map<string, TeamHierarchyNode>();
  for (const agent of living) {
    byId.set(agent.id, {
      agent,
      managerId: managerOf.get(agent.id) ?? null,
      depth: 0,
      directReportIds: (childrenOf.get(agent.id) ?? []).map((child) => child.id),
      descendantIds: [],
      branchId: null,
    });
  }

  // One walk down from each root fills in depth, everybody beneath, and the
  // branch. Recursion is bounded by the tree, which the loop-breaking above
  // has already made acyclic.
  const walk = (agent: Agent, depth: number, branchId: string | null): string[] => {
    const node = byId.get(agent.id)!;
    node.depth = depth;
    node.branchId = branchId;
    const beneath: string[] = [];
    for (const child of childrenOf.get(agent.id) ?? []) {
      // Directly under the top is where a branch starts; deeper down the
      // branch is inherited.
      const childBranch = agent.id === topId ? child.id : branchId;
      beneath.push(child.id, ...walk(child, depth + 1, childBranch));
    }
    node.descendantIds = beneath;
    return beneath;
  };

  for (const root of roots) {
    // A root that is not the top leads its own branch: it is outside the
    // reporting line, and the views label it that way rather than pretending
    // it sits under the CEO.
    const rootBranch = root.id === topId ? null : root.id;
    walk(root, 0, rootBranch);
  }

  const branches: TeamBranch[] = [];
  const topNode = topId ? byId.get(topId) : null;
  if (topNode) {
    for (const executiveId of topNode.directReportIds) {
      const node = byId.get(executiveId)!;
      branches.push({
        id: executiveId,
        leader: node.agent,
        memberIds: [executiveId, ...node.descendantIds],
      });
    }
  } else {
    for (const root of roots) {
      const node = byId.get(root.id)!;
      branches.push({ id: root.id, leader: root, memberIds: [root.id, ...node.descendantIds] });
    }
  }

  const unattachedIds = roots.filter((root) => root.id !== topId).map((root) => root.id);

  return {
    byId,
    rootIds: roots.map((root) => root.id),
    topId,
    branches,
    unattachedIds: topId ? unattachedIds : [],
    hasReportingLines: [...byId.values()].some((node) => node.managerId !== null),
  };
}

/** The manager to name on a card, or null when there is nobody to name. */
export function managerOf(hierarchy: TeamHierarchy, agentId: string): Agent | null {
  const node = hierarchy.byId.get(agentId);
  if (!node?.managerId) return null;
  return hierarchy.byId.get(node.managerId)?.agent ?? null;
}

/** True for anyone with at least one direct report. */
export function isManager(hierarchy: TeamHierarchy, agentId: string): boolean {
  return (hierarchy.byId.get(agentId)?.directReportIds.length ?? 0) > 0;
}

/**
 * How one manager's organization is getting on: everybody beneath them at
 * any depth, counted by state group.
 *
 * Deliberately excludes the manager themselves, so a card can say "Working"
 * about the manager and "4 working, 1 needs attention" about their people
 * without the two sentences counting the same agent twice.
 */
export interface TeamOrgRollup {
  /** How many people are beneath this manager at any depth. */
  total: number;
  /** How many report to them directly. */
  directCount: number;
  counts: Record<TeamStateGroup, number>;
  /** The rows beneath them that need a person, worst first. */
  attention: TeamAgentWork[];
}

export function rollupForManager(
  hierarchy: TeamHierarchy,
  agentId: string,
  rowsById: Map<string, TeamAgentWork>,
): TeamOrgRollup {
  const node = hierarchy.byId.get(agentId);
  const counts: Record<TeamStateGroup, number> = {
    attention: 0,
    working: 0,
    paused: 0,
    idle: 0,
  };
  if (!node) return { total: 0, directCount: 0, counts, attention: [] };

  const attention: TeamAgentWork[] = [];
  for (const id of node.descendantIds) {
    const row = rowsById.get(id);
    if (!row) continue;
    counts[teamStateGroupOf(row.state)] += 1;
    if (row.needsAttention) attention.push(row);
  }

  return {
    total: node.descendantIds.length,
    directCount: node.directReportIds.length,
    counts,
    attention,
  };
}

/**
 * The roll-up written out, in the order a person reads it: how many people,
 * then how they are doing. Groups with nobody in them are left out, because
 * "0 paused" is noise on a card that has to stay short.
 */
export function describeRollup(rollup: TeamOrgRollup): string {
  const parts: string[] = [rollup.total === 1 ? "1 person" : `${rollup.total} people`];
  if (rollup.counts.working > 0) parts.push(`${rollup.counts.working} working`);
  if (rollup.counts.idle > 0) parts.push(`${rollup.counts.idle} idle`);
  if (rollup.counts.paused > 0) parts.push(`${rollup.counts.paused} paused`);
  if (rollup.counts.attention > 0) {
    parts.push(
      rollup.counts.attention === 1 ? "1 needs you" : `${rollup.counts.attention} need you`,
    );
  }
  return parts.join(" · ");
}

/**
 * Everything one row needs to say about where its member sits: who they
 * report to, whose organization they are in, and, if they manage anybody,
 * how that organization is getting on.
 *
 * Worked out once per row by the page and handed to the card and the table,
 * so those two stay drawings of the same facts rather than each doing their
 * own walk of the tree.
 */
export interface TeamOrgContext {
  manager: Agent | null;
  /** The executive whose organization this member is in, if any. */
  branch: Agent | null;
  /** True when this member IS the executive leading their branch. */
  leadsBranch: boolean;
  /**
   * True when this member sits outside the company's reporting line: they
   * have no manager and they are not the top, or they are beneath somebody
   * like that.
   *
   * They are still given a branch of their own internally, because the
   * grouped view has to put them somewhere, but a view must not describe
   * that as an organization. "Leads the Mike branch" would be a claim
   * nobody made; "not in the reporting line" is what is actually true.
   */
  outsideReportingLine: boolean;
  /** True for the top of the company, whose manager is the human board. */
  isTop: boolean;
  depth: number;
  /** Present only for somebody who manages at least one person. */
  rollup: TeamOrgRollup | null;
  /** Whether this company has any reporting lines at all. */
  reportingLinesConfigured: boolean;
}

export function orgContextFor(
  hierarchy: TeamHierarchy,
  agentId: string,
  rowsById: Map<string, TeamAgentWork>,
): TeamOrgContext {
  const node = hierarchy.byId.get(agentId);
  const branchId = node?.branchId ?? null;
  const manages = (node?.directReportIds.length ?? 0) > 0;
  // Only meaningful once the company HAS a reporting line to be outside of.
  // With no top at all, every root stands on its own and none of them is
  // outside anything.
  const outsideReportingLine =
    hierarchy.topId !== null && branchId !== null && hierarchy.unattachedIds.includes(branchId);
  return {
    manager: managerOf(hierarchy, agentId),
    branch: branchId ? hierarchy.byId.get(branchId)?.agent ?? null : null,
    leadsBranch: branchId === agentId,
    outsideReportingLine,
    isTop: hierarchy.topId === agentId,
    depth: node?.depth ?? 0,
    rollup: manages ? rollupForManager(hierarchy, agentId, rowsById) : null,
    reportingLinesConfigured: hierarchy.hasReportingLines,
  };
}

/**
 * What to write where a manager's name goes for the top of the company.
 *
 * The board is the human operator, not an agent, so it has no node in the
 * tree and no page to link to. Saying it in words is the whole of how the
 * board appears in these views, which is deliberate: it keeps the governance
 * relationship visible without turning the operator into another employee.
 */
export const BOARD_MANAGER_LABEL = "the board (you)";

/** Everybody in one executive's organization, including the executive. */
export function branchMemberIds(hierarchy: TeamHierarchy, branchId: string): string[] {
  const branch = hierarchy.branches.find((candidate) => candidate.id === branchId);
  if (branch) return branch.memberIds;
  // Not an executive branch: fall back to "this person and everybody beneath
  // them", which is what "reports under X" means for any other manager.
  const node = hierarchy.byId.get(branchId);
  return node ? [branchId, ...node.descendantIds] : [];
}

/** Whether one agent sits anywhere beneath another. */
export function isUnder(hierarchy: TeamHierarchy, agentId: string, managerId: string): boolean {
  if (agentId === managerId) return true;
  return hierarchy.byId.get(managerId)?.descendantIds.includes(agentId) ?? false;
}

/**
 * The reporting line above an agent, nearest manager first, as the server's
 * chain of command reports it. Rebuilt here from the list the page already
 * has rather than asking for it, so a list view can show it without a
 * request per row.
 */
export function chainOfCommand(hierarchy: TeamHierarchy, agentId: string): Agent[] {
  const chain: Agent[] = [];
  let cursor = hierarchy.byId.get(agentId)?.managerId ?? null;
  while (cursor && chain.length < MAX_CHAIN_DEPTH) {
    const node = hierarchy.byId.get(cursor);
    if (!node) break;
    chain.push(node.agent);
    cursor = node.managerId;
  }
  return chain;
}

/**
 * Everybody in reading order: each root, then its people, depth first, so a
 * list drawn in this order reads down the organization rather than
 * alphabetically across it.
 */
export function hierarchyReadingOrder(hierarchy: TeamHierarchy): string[] {
  const ordered: string[] = [];
  const visit = (id: string) => {
    ordered.push(id);
    for (const child of hierarchy.byId.get(id)?.directReportIds ?? []) visit(child);
  };
  // The top first when there is one, so the CEO leads the list rather than
  // landing wherever the alphabet puts them.
  const roots = hierarchy.topId
    ? [hierarchy.topId, ...hierarchy.rootIds.filter((id) => id !== hierarchy.topId)]
    : hierarchy.rootIds;
  for (const root of roots) visit(root);
  return ordered;
}

/**
 * One group of rows for the grouped Right Now view.
 *
 * A group is an executive's organization, with the executive's own row kept
 * separate from their people's so the heading can show both what the
 * executive is doing and how their organization is getting on.
 */
export interface TeamGroupedSection {
  /** The branch id, or null for the group holding agents with no branch. */
  id: string | null;
  title: string;
  /** The executive's own row, when the group has a leader. */
  leaderRow: TeamAgentWork | null;
  /** Everybody beneath the leader, in reading order. */
  memberRows: TeamAgentWork[];
  rollup: TeamOrgRollup | null;
}

/** The heading for the group holding everyone outside the reporting line. */
export const UNATTACHED_GROUP_TITLE = "Not in the reporting line";

/**
 * Split the rows into the sections the grouped view draws: the top of the
 * company first, then one section per executive organization, then anyone
 * the reporting lines cannot place.
 *
 * Rows that a filter or a search has already removed simply do not appear;
 * an executive whose whole organization was filtered out keeps their section
 * only if they are themselves still visible, so the counts on screen always
 * match the cards on screen.
 */
export function groupRowsByBranch(
  hierarchy: TeamHierarchy,
  visibleRows: TeamAgentWork[],
  allRowsById: Map<string, TeamAgentWork>,
): TeamGroupedSection[] {
  const visibleById = new Map(visibleRows.map((row) => [row.agent.id, row]));
  const order = hierarchyReadingOrder(hierarchy);
  const rank = new Map(order.map((id, index) => [id, index]));
  const inReadingOrder = (ids: string[]): TeamAgentWork[] =>
    ids
      .map((id) => visibleById.get(id))
      .filter((row): row is TeamAgentWork => row !== undefined)
      .sort((a, b) => (rank.get(a.agent.id) ?? 0) - (rank.get(b.agent.id) ?? 0));

  const sections: TeamGroupedSection[] = [];
  const placed = new Set<string>();

  if (hierarchy.topId) {
    const topRow = visibleById.get(hierarchy.topId) ?? null;
    if (topRow) {
      sections.push({
        id: hierarchy.topId,
        title: "Executive leadership",
        leaderRow: topRow,
        memberRows: [],
        rollup: rollupForManager(hierarchy, hierarchy.topId, allRowsById),
      });
      placed.add(hierarchy.topId);
    }
  }

  for (const branch of hierarchy.branches) {
    const leaderRow = visibleById.get(branch.id) ?? null;
    const memberRows = inReadingOrder(branch.memberIds.filter((id) => id !== branch.id));
    for (const id of branch.memberIds) placed.add(id);
    if (!leaderRow && memberRows.length === 0) continue;
    sections.push({
      id: branch.id,
      title: branch.leader.name,
      leaderRow,
      memberRows,
      rollup: rollupForManager(hierarchy, branch.id, allRowsById),
    });
  }

  const leftover = inReadingOrder(visibleRows.map((row) => row.agent.id).filter((id) => !placed.has(id)));
  if (leftover.length > 0) {
    sections.push({
      id: null,
      title: UNATTACHED_GROUP_TITLE,
      leaderRow: null,
      memberRows: leftover,
      rollup: null,
    });
  }

  return sections;
}

/** Count the states in one group of rows, for a section heading. */
export function countGroups(rows: TeamAgentWork[]): Record<TeamStateGroup, number> {
  const counts: Record<TeamStateGroup, number> = {
    attention: 0,
    working: 0,
    paused: 0,
    idle: 0,
  };
  for (const row of rows) counts[teamStateGroupOf(row.state)] += 1;
  return counts;
}

/**
 * Everybody needing a person, worst first, with the branch each one sits in
 * so the list can be read from the top of the company without opening
 * anything.
 */
export interface TeamAttentionItem {
  row: TeamAgentWork;
  /** The executive whose organization this sits in, when there is one. */
  branch: Agent | null;
  /** Their own manager, when there is one. */
  manager: Agent | null;
  /**
   * True for the top of the company, who has no branch because every branch
   * is beneath them. Without this an unwell CEO would be grouped with the
   * agents nobody has placed, which reads as the CEO being outside their own
   * company's reporting line.
   */
  isTop: boolean;
}

export function buildAttentionList(
  hierarchy: TeamHierarchy,
  rows: TeamAgentWork[],
): TeamAttentionItem[] {
  const attentionStates = new Set<TeamWorkState>(TEAM_STATE_GROUP_STATES.attention);
  return rows
    .filter((row) => attentionStates.has(row.state))
    .map((row) => {
      const node = hierarchy.byId.get(row.agent.id);
      const branchId = node?.branchId ?? null;
      return {
        row,
        branch: branchId ? hierarchy.byId.get(branchId)?.agent ?? null : null,
        manager: managerOf(hierarchy, row.agent.id),
        isTop: hierarchy.topId === row.agent.id,
      };
    });
}
