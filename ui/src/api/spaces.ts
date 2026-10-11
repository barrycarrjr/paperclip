import type {
  CreateSpace,
  CreateSpacePage,
  MoveSpacePage,
  RestoreSpacePageRevision,
  Space,
  SpaceListItem,
  SpacePage,
  SpacePageLocation,
  SpacePageRevision,
  SpacePageRevisionDetail,
  SpacePageSummary,
  SpacePageTreeNode,
  SpaceTrashChange,
  SpaceTrashItem,
  UpdateSpace,
  UpdateSpacePage,
} from "@paperclipai/shared";
import { api } from "./client";

export const spacesApi = {
  /** The company's Spaces, or with archived set, only its archived ones. */
  list: (companyId: string, options: { archived?: boolean } = {}) =>
    api.get<SpaceListItem[]>(`/companies/${companyId}/spaces${options.archived ? "?archived=true" : ""}`),
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
  /** A page's versions, newest first, without their text. */
  revisions: (spaceId: string, pageId: string) =>
    api.get<SpacePageRevision[]>(`/spaces/${spaceId}/pages/${pageId}/revisions`),
  revision: (spaceId: string, pageId: string, revisionId: string) =>
    api.get<SpacePageRevisionDetail>(`/spaces/${spaceId}/pages/${pageId}/revisions/${revisionId}`),
  /** Like a save, answers 409 when the page has moved on from baseRevisionId. */
  restoreRevision: (spaceId: string, pageId: string, revisionId: string, data: RestoreSpacePageRevision) =>
    api.post<SpacePage>(`/spaces/${spaceId}/pages/${pageId}/revisions/${revisionId}/restore`, data),
  movePage: (spaceId: string, pageId: string, data: MoveSpacePage) =>
    api.post<SpacePageSummary>(`/spaces/${spaceId}/pages/${pageId}/move`, data),
  /** Sends the page and its subpages to the Space's trash. */
  deletePage: (spaceId: string, pageId: string) => api.delete<SpaceTrashChange>(`/spaces/${spaceId}/pages/${pageId}`),
  trash: (spaceId: string) => api.get<SpaceTrashItem[]>(`/spaces/${spaceId}/trash`),
  restoreFromTrash: (spaceId: string, pageId: string) =>
    api.post<SpaceTrashChange>(`/spaces/${spaceId}/trash/${pageId}/restore`, {}),
  /** The Space a page of the company is in now. */
  locatePage: (companyId: string, pageId: string) =>
    api.get<SpacePageLocation>(`/companies/${companyId}/space-pages/${encodeURIComponent(pageId)}`),
};
