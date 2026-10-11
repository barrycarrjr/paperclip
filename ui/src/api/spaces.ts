import type {
  CreateSpace,
  CreateSpacePage,
  Space,
  SpaceListItem,
  SpacePage,
  SpacePageTreeNode,
  UpdateSpace,
  UpdateSpacePage,
} from "@paperclipai/shared";
import { api } from "./client";

export const spacesApi = {
  list: (companyId: string) => api.get<SpaceListItem[]>(`/companies/${companyId}/spaces`),
  /** A Space by the key in its web address, or by its id. */
  get: (companyId: string, spaceRef: string) =>
    api.get<Space>(`/companies/${companyId}/spaces/${encodeURIComponent(spaceRef)}`),
  create: (companyId: string, data: CreateSpace) => api.post<Space>(`/companies/${companyId}/spaces`, data),
  update: (spaceId: string, data: UpdateSpace) => api.patch<Space>(`/spaces/${spaceId}`, data),
  pageTree: (spaceId: string) => api.get<SpacePageTreeNode[]>(`/spaces/${spaceId}/pages`),
  createPage: (spaceId: string, data: CreateSpacePage) => api.post<SpacePage>(`/spaces/${spaceId}/pages`, data),
  getPage: (spaceId: string, pageId: string) => api.get<SpacePage>(`/spaces/${spaceId}/pages/${pageId}`),
  /** Answers 409 when the page has moved on from baseRevisionId. */
  updatePage: (spaceId: string, pageId: string, data: UpdateSpacePage) =>
    api.patch<SpacePage>(`/spaces/${spaceId}/pages/${pageId}`, data),
};
