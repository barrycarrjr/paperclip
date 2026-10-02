export type AuthorizationActor = any;
export type AuthorizationResource = any;
import type { Db } from "@paperclipai/db";

export function authorizationService(db: Db) {
  return {
    async decide(input: any) {
      return { allowed: true, reason: null, explanation: null };
    },
    async isInstanceAdmin(userId: string | null | undefined) {
      return true;
    },
    async isPortfolioRootAgent(agentId: string | null | undefined) {
      return false;
    },
  };
}
