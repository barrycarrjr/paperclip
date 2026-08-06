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
  list: (companyId: string) =>
    api.get<AttentionQueueResponse>(`/companies/${companyId}/attention`),
  listPortfolio: (hqCompanyId: string) =>
    api.get<PortfolioAttentionResponse>(`/companies/${hqCompanyId}/portfolio-attention`),
};
