import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  STRUCTURAL_FINDING_KINDS,
  type StructuralFindingKind,
  structuralFindingService,
} from "../services/structural-findings.js";
import { assertCompanyAccess } from "./authz.js";

const queryParamsSchema = z.object({
  kinds: z.string().optional(),
});

function parseKinds(raw: string | undefined): StructuralFindingKind[] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  const allowed = new Set<StructuralFindingKind>(STRUCTURAL_FINDING_KINDS);
  return parts.filter((p): p is StructuralFindingKind => allowed.has(p as StructuralFindingKind));
}

export function structuralFindingRoutes(db: Db) {
  const router = Router();
  const svc = structuralFindingService(db);

  router.get("/companies/:companyId/structural-findings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId, "read");
    const query = queryParamsSchema.parse(req.query);
    const kinds = parseKinds(query.kinds);
    const findings = await svc.scan(companyId, kinds);
    res.json({ findings });
  });

  return router;
}
