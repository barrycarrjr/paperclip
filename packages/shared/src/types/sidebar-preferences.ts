export interface SidebarOrderPreference {
  orderedIds: string[];
  updatedAt: Date | null;
}

export interface PageSectionOrderPreference {
  pageKey: string;
  orderedIds: string[];
  updatedAt: Date | null;
}
