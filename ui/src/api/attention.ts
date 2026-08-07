import type { AttentionQueueResponse, Company } from "@paperclipai/shared";
import { api } from "./client";

export type PortfolioAttentionResponse = AttentionQueueResponse & {
  companies: Company[];
};

/**
 * The attention queue. Every surface that asks the operator to act reads
 * these endpoints; nothing computes its own "needs you" list.
 */
export const attentionApi = {
  /**
   * `includeSetAside` also returns the rows that have gone quiet - failures
   * that have not happened again in a fortnight. They are held back by default
   * so months-old sediment does not sit next to a live outage, and the response
   * always reports how many there are.
   */
  list: (companyId: string, includeSetAside = false) =>
    api.get<AttentionQueueResponse>(
      `/companies/${companyId}/attention${includeSetAside ? "?setAside=1" : ""}`,
    ),
  listPortfolio: (hqCompanyId: string, includeSetAside = false) =>
    api.get<PortfolioAttentionResponse>(
      `/companies/${hqCompanyId}/portfolio-attention${includeSetAside ? "?setAside=1" : ""}`,
    ),
};
