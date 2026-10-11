import type { DocumentFormat } from "./issue.js";

export interface Space {
  id: string;
  companyId: string;
  name: string;
  /** The Space's part of its web address. It stays the same when the Space is renamed. */
  urlKey: string;
  description: string | null;
  sortOrder: number;
  archivedAt: Date | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SpaceListItem extends Space {
  pageCount: number;
}

export interface SpacePageSummary {
  id: string;
  companyId: string;
  spaceId: string;
  parentPageId: string | null;
  documentId: string;
  sortOrder: number;
  title: string;
  /** Send this back as baseRevisionId when saving a change to the page. */
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SpacePageTreeNode extends SpacePageSummary {
  children: SpacePageTreeNode[];
}

export interface SpacePage extends SpacePageSummary {
  format: DocumentFormat;
  body: string;
  createdByAgentId: string | null;
  createdByUserId: string | null;
}
