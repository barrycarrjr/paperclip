import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";

type AgentAssignmentKind = "work" | "routine";

export async function assertAssignableAgent(
  db: Db,
  companyId: string,
  agentId: string | null | undefined,
  options: { kind?: AgentAssignmentKind } = {},
) {
  if (!agentId) return;
  const [assignee] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!assignee) throw notFound("Assignee agent not found");
  if (assignee.companyId !== companyId) {
    throw unprocessable("Assignee must belong to same company");
  }
  if (assignee.status === "terminated") {
    throw conflict("Cannot assign to terminated agent");
  }
  if (assignee.status === "pending_approval") {
    throw conflict("Cannot assign to pending approval agent");
  }
}
