import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { assertCompanyAccess } from "../routes/authz.js";

const COMPANY_HQ = "00000000-0000-4000-8000-00000000aaaa";
const COMPANY_OTHER = "00000000-0000-4000-8000-00000000bbbb";
const AGENT_ID = "00000000-0000-4000-8000-cccccccccccc";

type AgentActor = Required<Pick<Express.Request["actor"], "type">> & {
  type: "agent";
  agentId: string;
  companyId: string;
  isPortfolioRootAgent?: boolean;
  source: "agent_jwt" | "agent_key";
};

type BoardActor = {
  type: "board";
  userId: string;
  companyIds: string[];
  memberships?: Array<{ companyId: string; membershipRole?: string | null; status?: string }>;
  isInstanceAdmin?: boolean;
  isPortfolioRootUserAdmin?: boolean;
  source: "session" | "board_key" | "local_implicit";
};

function makeReq(actor: AgentActor | BoardActor, method: "GET" | "POST" = "GET"): Request {
  return { actor, method } as unknown as Request;
}

describe("assertCompanyAccess — HQ portfolio-root bypass", () => {
  describe("existing behavior (regression guard)", () => {
    it("allows agent to write to its own company", () => {
      const req = makeReq(
        {
          type: "agent",
          agentId: AGENT_ID,
          companyId: COMPANY_HQ,
          source: "agent_jwt",
        },
        "POST",
      );
      expect(() => assertCompanyAccess(req, COMPANY_HQ, "write")).not.toThrow();
    });

    it("blocks non-HQ agent from cross-company write", () => {
      const req = makeReq(
        {
          type: "agent",
          agentId: AGENT_ID,
          companyId: COMPANY_OTHER,
          source: "agent_jwt",
        },
        "POST",
      );
      expect(() => assertCompanyAccess(req, COMPANY_HQ, "write")).toThrow(
        /Agent key cannot access another company/,
      );
    });

    it("blocks non-HQ agent from cross-company read", () => {
      const req = makeReq({
        type: "agent",
        agentId: AGENT_ID,
        companyId: COMPANY_OTHER,
        source: "agent_jwt",
      });
      expect(() => assertCompanyAccess(req, COMPANY_HQ, "read")).toThrow(
        /Agent key cannot access another company/,
      );
    });

    it("allows local_implicit board across all companies (loopback bypass intact)", () => {
      const req = makeReq(
        {
          type: "board",
          userId: "local-board",
          companyIds: [],
          isInstanceAdmin: true,
          source: "local_implicit",
        },
        "POST",
      );
      expect(() => assertCompanyAccess(req, COMPANY_OTHER, "write")).not.toThrow();
    });

    it("blocks non-HQ board user from cross-company read (no membership, no admin)", () => {
      const req = makeReq({
        type: "board",
        userId: "outsider",
        companyIds: [COMPANY_OTHER],
        source: "session",
        isInstanceAdmin: false,
      });
      expect(() => assertCompanyAccess(req, COMPANY_HQ, "read")).toThrow(
        /User does not have access to this company/,
      );
    });
  });

  describe("HQ agent bypass", () => {
    it("allows HQ agent to read another company (read bypass)", () => {
      const req = makeReq({
        type: "agent",
        agentId: AGENT_ID,
        companyId: COMPANY_HQ,
        isPortfolioRootAgent: true,
        source: "agent_jwt",
      });
      expect(() => assertCompanyAccess(req, COMPANY_OTHER, "read")).not.toThrow();
    });

    it("blocks HQ agent from writing to another company (writes never bypassed)", () => {
      const req = makeReq(
        {
          type: "agent",
          agentId: AGENT_ID,
          companyId: COMPANY_HQ,
          isPortfolioRootAgent: true,
          source: "agent_jwt",
        },
        "POST",
      );
      expect(() => assertCompanyAccess(req, COMPANY_OTHER, "write")).toThrow(
        /Agent key cannot access another company/,
      );
    });

    it("does not retroactively bypass when mode defaults to write", () => {
      const req = makeReq(
        {
          type: "agent",
          agentId: AGENT_ID,
          companyId: COMPANY_HQ,
          isPortfolioRootAgent: true,
          source: "agent_jwt",
        },
        "POST",
      );
      // Default mode = "write" → bypass not engaged
      expect(() => assertCompanyAccess(req, COMPANY_OTHER)).toThrow(
        /Agent key cannot access another company/,
      );
    });
  });

  describe("HQ user-admin bypass", () => {
    it("allows HQ owner/admin user to read another company (read bypass)", () => {
      const req = makeReq({
        type: "board",
        userId: "barry",
        companyIds: [COMPANY_HQ],
        isPortfolioRootUserAdmin: true,
        source: "session",
        isInstanceAdmin: false,
        memberships: [{ companyId: COMPANY_HQ, membershipRole: "owner", status: "active" }],
      });
      expect(() => assertCompanyAccess(req, COMPANY_OTHER, "read")).not.toThrow();
    });

    it("blocks HQ owner/admin user from writing to another company", () => {
      const req = makeReq(
        {
          type: "board",
          userId: "barry",
          companyIds: [COMPANY_HQ],
          isPortfolioRootUserAdmin: true,
          source: "session",
          isInstanceAdmin: false,
          memberships: [{ companyId: COMPANY_HQ, membershipRole: "owner", status: "active" }],
        },
        "POST",
      );
      expect(() => assertCompanyAccess(req, COMPANY_OTHER, "write")).toThrow(
        /User does not have access to this company/,
      );
    });

    it("blocks board user without HQ admin (operator/member tier) from cross-company read", () => {
      const req = makeReq({
        type: "board",
        userId: "junior-hq",
        companyIds: [COMPANY_HQ],
        // Crucially: isPortfolioRootUserAdmin is NOT set — operator/member in HQ doesn't get the bypass.
        source: "session",
        isInstanceAdmin: false,
        memberships: [{ companyId: COMPANY_HQ, membershipRole: "operator", status: "active" }],
      });
      expect(() => assertCompanyAccess(req, COMPANY_OTHER, "read")).toThrow(
        /User does not have access to this company/,
      );
    });
  });
});
