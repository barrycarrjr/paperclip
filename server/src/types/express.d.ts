export {};

declare global {
  namespace Express {
    interface Request {
      actor: {
        type: "board" | "agent" | "tool_session" | "none";
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
        /** Synthetic identity carried in tool_session JWTs, e.g. `clippy-<sessionId>`. Never a foreign key into `agents`. */
        toolSessionId?: string;
        source?:
          | "local_implicit"
          | "session"
          | "board_key"
          | "agent_key"
          | "agent_jwt"
          | "tool_session_jwt"
          | "none";
      };
    }
  }
}
