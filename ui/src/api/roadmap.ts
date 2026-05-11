/**
 * @fileoverview Frontend API client for the cross-portfolio roadmap.
 *
 * The roadmap is a single artifact published as a release asset on the
 * configured extensions repo. Items span skills, agents, routines, features,
 * plugins, and ad-hoc ideas. Built plugins surface as `status: "shipped"`,
 * coming-soon plugins as `status: "planned"`, and curated items pass through
 * verbatim from the repo's `roadmap.json`.
 *
 * @see server/src/routes/plugins.ts — `GET /api/roadmap`
 */

import { api } from "./client";

export type RoadmapItemType =
  | "skill"
  | "agent"
  | "routine"
  | "feature"
  | "plugin"
  | "other";

export type RoadmapItemStatus =
  | "idea"
  | "planned"
  | "in-progress"
  | "shipped"
  | "wont-do";

export interface RoadmapItem {
  id: string;
  type: RoadmapItemType;
  title: string;
  description: string;
  status: RoadmapItemStatus;
  addedAt?: string;
  /** When `type === "plugin"`, the id of the plugin in the Plugin Manager. */
  linkedPluginId?: string;
  notes?: string;
}

export interface RoadmapResponse {
  repo: string;
  release: {
    tag: string;
    name: string;
    url: string;
    publishedAt: string | null;
  };
  items: RoadmapItem[];
}

export const roadmapApi = {
  /** Fetch the merged roadmap from the latest extensions-repo release. */
  list: () => api.get<RoadmapResponse>("/roadmap"),
};
