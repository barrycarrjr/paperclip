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

/** One saved version of a page, for its history. Its text comes one version at a time. */
export interface SpacePageRevision {
  id: string;
  revisionNumber: number;
  title: string;
  /** What the version is, when it says: "Restored version 3". */
  changeSummary: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdByRunId: string | null;
  createdAt: Date;
}

export interface SpacePageRevisionDetail extends SpacePageRevision {
  format: DocumentFormat;
  body: string;
}

/** A page in its Space's trash: the page that was deleted, and how many subpages went with it. */
export interface SpaceTrashItem extends SpacePageSummary {
  deletedAt: Date;
  subpageCount: number;
}

/** A page sent to the trash or brought back, with the subpages that went with it. */
export interface SpaceTrashChange {
  pageId: string;
  parentPageId: string | null;
  subpageCount: number;
}

/** The Space a page is in now, for an address that names another one, and whether it is in that Space's trash. */
export interface SpacePageLocation {
  pageId: string;
  spaceId: string;
  spaceUrlKey: string;
  spaceName: string;
  /** In the trash, on its own or with a page above it. */
  inTrash: boolean;
}
