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
        /**
         * Tool sessions only: the person the key acts for, as the board actor a
         * signed-in request from them would get, loaded again on every request.
         * The company check gives the key no more than this person has now. Kept
         * apart from the board fields above, which many routes read without
         * checking the actor type.
         */
        person?: Request["actor"];
        source?:
          | "local_implicit"
          | "session"
          | "board_key"
          | "agent_key"
          | "agent_jwt"
          | "tool_session_jwt"
          /** A chat app account (Slack, for example) the user paired to themselves from their profile. */
          | "channel_link"
          | "none";
      };
    }
  }
}
