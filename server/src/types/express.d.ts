export {};

declare global {
  namespace Express {
    interface Request {
      actor: {
        type: "board" | "agent" | "none";
        userId?: string;
        userName?: string | null;
        userEmail?: string | null;
        agentId?: string;
        companyId?: string;
        companyIds?: string[];
        memberships?: Array<{
          companyId: string;
          membershipRole?: string | null;
          status?: string;
        }>;
        isInstanceAdmin?: boolean;
        /** True if this agent's company is the portfolio root (HQ). Confers cross-company READ via `assertCompanyAccess(..., "read")`. */
        isPortfolioRootAgent?: boolean;
        /** True if this board user has an active owner|admin membership in the portfolio root (HQ). Confers cross-company READ via `assertCompanyAccess(..., "read")`. */
        isPortfolioRootUserAdmin?: boolean;
        keyId?: string;
        runId?: string;
        source?: "local_implicit" | "session" | "board_key" | "agent_key" | "agent_jwt" | "none";
      };
    }
  }
}
