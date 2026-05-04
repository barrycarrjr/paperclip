import type { Company, DashboardSummary } from "@paperclipai/shared";
import { api } from "./client";

export const dashboardApi = {
  summary: (companyId: string) => api.get<DashboardSummary>(`/companies/${companyId}/dashboard`),
  listPortfolio: (hqCompanyId: string) =>
    api.get<{ summaries: DashboardSummary[]; companies: Company[] }>(
      `/companies/${hqCompanyId}/portfolio-dashboard`,
    ),
};
