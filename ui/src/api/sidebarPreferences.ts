import type {
  PageSectionOrderPreference,
  SidebarOrderPreference,
  UpsertSidebarOrderPreference,
  UpsertSidebarSlugOrderPreference,
} from "@paperclipai/shared";
import { api } from "./client";

export const sidebarPreferencesApi = {
  getCompanyOrder: () => api.get<SidebarOrderPreference>("/sidebar-preferences/me"),
  updateCompanyOrder: (data: UpsertSidebarOrderPreference) =>
    api.put<SidebarOrderPreference>("/sidebar-preferences/me", data),
  getProjectOrder: (companyId: string) =>
    api.get<SidebarOrderPreference>(`/companies/${companyId}/sidebar-preferences/me`),
  updateProjectOrder: (companyId: string, data: UpsertSidebarOrderPreference) =>
    api.put<SidebarOrderPreference>(`/companies/${companyId}/sidebar-preferences/me`, data),
  getPortfolioNavOrder: () =>
    api.get<SidebarOrderPreference>("/sidebar-preferences/me/portfolio-nav"),
  updatePortfolioNavOrder: (data: UpsertSidebarSlugOrderPreference) =>
    api.put<SidebarOrderPreference>("/sidebar-preferences/me/portfolio-nav", data),
  getPageSectionOrder: (pageKey: string) =>
    api.get<PageSectionOrderPreference>(
      `/sidebar-preferences/me/sections/${encodeURIComponent(pageKey)}`,
    ),
  updatePageSectionOrder: (pageKey: string, data: UpsertSidebarSlugOrderPreference) =>
    api.put<PageSectionOrderPreference>(
      `/sidebar-preferences/me/sections/${encodeURIComponent(pageKey)}`,
      data,
    ),
};
