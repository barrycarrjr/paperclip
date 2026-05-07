import { createHash } from "node:crypto";
import { and, eq, gte, isNull, lte, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, routines } from "@paperclipai/db";

export const STRUCTURAL_FINDING_KINDS = [
  "orphan_no_manager",
  "idle_agent",
  "company_no_routines",
] as const;

export type StructuralFindingKind = (typeof STRUCTURAL_FINDING_KINDS)[number];

export interface StructuralFinding {
  kind: StructuralFindingKind;
  fingerprint: string;
  severity: "low" | "medium" | "high";
  subjectType: "agent" | "company";
  subjectId: string;
  summary: string;
  details: Record<string, unknown>;
}

const NEW_AGENT_GRACE_DAYS = 7;
const IDLE_AGENT_DAYS = 30;
const ROOT_ROLES = new Set(["ceo"]);
const NON_ARCHIVED_AGENT_STATUSES_GUARD = "archived";

function fingerprint(parts: Array<string | number | undefined | null>): string {
  const text = parts.filter((p) => p !== undefined && p !== null).join("|");
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export function structuralFindingService(db: Db) {
  async function detectOrphanNoManager(companyId: string): Promise<StructuralFinding[]> {
    const cutoff = daysAgo(NEW_AGENT_GRACE_DAYS);
    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
        createdAt: agents.createdAt,
      })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          isNull(agents.reportsTo),
          ne(agents.status, NON_ARCHIVED_AGENT_STATUSES_GUARD),
          lte(agents.createdAt, cutoff),
        ),
      );

    return rows
      .filter((row) => !ROOT_ROLES.has(row.role))
      .map<StructuralFinding>((row) => ({
        kind: "orphan_no_manager",
        fingerprint: fingerprint(["orphan_no_manager", row.id]),
        severity: "low",
        subjectType: "agent",
        subjectId: row.id,
        summary: `Agent ${row.name} (${row.role}) has no manager`,
        details: {
          agentId: row.id,
          agentName: row.name,
          role: row.role,
          createdAt: row.createdAt,
          recommendation: "Set reportsTo to the appropriate parent agent or archive the agent",
        },
      }));
  }

  async function detectIdleAgents(companyId: string): Promise<StructuralFinding[]> {
    const cutoff = daysAgo(IDLE_AGENT_DAYS);

    const candidates = await db
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
        status: agents.status,
        createdAt: agents.createdAt,
        lastHeartbeatAt: agents.lastHeartbeatAt,
      })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          ne(agents.status, NON_ARCHIVED_AGENT_STATUSES_GUARD),
          lte(agents.createdAt, cutoff),
        ),
      );

    if (candidates.length === 0) return [];

    const findings: StructuralFinding[] = [];
    for (const agent of candidates) {
      if (agent.lastHeartbeatAt && agent.lastHeartbeatAt > cutoff) continue;
      const recent = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agent.id), gte(heartbeatRuns.startedAt, cutoff)))
        .limit(1);
      if (recent.length > 0) continue;

      findings.push({
        kind: "idle_agent",
        fingerprint: fingerprint(["idle_agent", agent.id]),
        severity: "low",
        subjectType: "agent",
        subjectId: agent.id,
        summary: `Agent ${agent.name} has had no activity in ${IDLE_AGENT_DAYS} days`,
        details: {
          agentId: agent.id,
          agentName: agent.name,
          role: agent.role,
          status: agent.status,
          lastHeartbeatAt: agent.lastHeartbeatAt,
          recommendation: "Archive the agent or assign new work — extended inactivity may indicate orphaned scope",
        },
      });
    }
    return findings;
  }

  async function detectCompanyNoRoutines(companyId: string): Promise<StructuralFinding[]> {
    const activeAgents = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), ne(agents.status, "archived")))
      .limit(1);
    if (activeAgents.length === 0) return [];

    const activeRoutines = await db
      .select({ id: routines.id })
      .from(routines)
      .where(and(eq(routines.companyId, companyId), eq(routines.status, "active")))
      .limit(1);
    if (activeRoutines.length > 0) return [];

    return [
      {
        kind: "company_no_routines",
        fingerprint: fingerprint(["company_no_routines", companyId]),
        severity: "medium",
        subjectType: "company",
        subjectId: companyId,
        summary: "Company has active agents but no scheduled routines",
        details: {
          companyId,
          recommendation:
            "Add at least one recurring routine — without one, agents only act when manually triggered",
        },
      },
    ];
  }

  return {
    detectOrphanNoManager,
    detectIdleAgents,
    detectCompanyNoRoutines,
    scan: async (companyId: string, kinds?: StructuralFindingKind[]): Promise<StructuralFinding[]> => {
      const requested = new Set<StructuralFindingKind>(kinds ?? STRUCTURAL_FINDING_KINDS);
      const out: StructuralFinding[] = [];
      if (requested.has("orphan_no_manager")) {
        out.push(...(await detectOrphanNoManager(companyId)));
      }
      if (requested.has("idle_agent")) {
        out.push(...(await detectIdleAgents(companyId)));
      }
      if (requested.has("company_no_routines")) {
        out.push(...(await detectCompanyNoRoutines(companyId)));
      }
      return out;
    },
  };
}

export type StructuralFindingService = ReturnType<typeof structuralFindingService>;
