import type {
  AgentTemplate,
  AgentTemplateDetail,
  CreateAgentTemplate,
  CreateRoutineTemplate,
  CreateSkillTemplate,
  DeployTemplate,
  RoutineTemplate,
  RoutineTemplateDetail,
  SkillTemplate,
  SkillTemplateDetail,
  TemplateDeployment,
  TemplateDeploymentResult,
  TemplateType,
  UpdateAgentTemplate,
  UpdateRoutineTemplate,
  UpdateSkillTemplate,
} from "@paperclipai/shared";
import { api } from "./client";

export type LibraryTemplateKind = "agent" | "routine" | "skill" | "bundle";

/** One entry as returned by GET /templates/library. */
export interface LibraryTemplate {
  kind: LibraryTemplateKind;
  name: string;
  displayName: string;
  description: string;
  frontmatter: Record<string, unknown>;
  body: string;
  contentHash: string;
  sourcePath: string;
  installed: boolean;
  updateAvailable: boolean;
  requiresPlugins: string[];
  missingPlugins: string[];
  expandsTo?: Array<{ kind: "agent" | "routine" | "skill"; name: string; found: boolean }>;
}

export interface LibraryListResponse {
  repo: string;
  release: { tag: string; name: string; url: string; publishedAt: string | null };
  templates: LibraryTemplate[];
}

export interface LibraryInstallResult {
  status: "created" | "updated" | "skipped";
  template: AgentTemplateDetail | RoutineTemplateDetail | SkillTemplateDetail;
}

export interface LibraryBundleInstallResult {
  bundle: { name: string; displayName: string };
  items: Array<{
    kind: "agent" | "routine" | "skill";
    name: string;
    status: "created" | "updated" | "skipped" | "error" | "missing";
    templateId?: string;
    error?: string;
  }>;
  missingPlugins: string[];
}

export const templatesApi = {
  listRoutine: () => api.get<{ templates: RoutineTemplate[] }>("/templates/routine"),
  listAgent: () => api.get<{ templates: AgentTemplate[] }>("/templates/agent"),
  listSkill: () => api.get<{ templates: SkillTemplate[] }>("/templates/skill"),

  getRoutine: (id: string) => api.get<RoutineTemplateDetail>(`/templates/routine/${id}`),
  getAgent: (id: string) => api.get<AgentTemplateDetail>(`/templates/agent/${id}`),
  getSkill: (id: string) => api.get<SkillTemplateDetail>(`/templates/skill/${id}`),

  createRoutine: (body: CreateRoutineTemplate) =>
    api.post<RoutineTemplateDetail>("/templates/routine", body),
  createAgent: (body: CreateAgentTemplate) =>
    api.post<AgentTemplateDetail>("/templates/agent", body),
  createSkill: (body: CreateSkillTemplate) =>
    api.post<SkillTemplateDetail>("/templates/skill", body),

  updateRoutine: (id: string, body: UpdateRoutineTemplate) =>
    api.patch<RoutineTemplateDetail>(`/templates/routine/${id}`, body),
  updateAgent: (id: string, body: UpdateAgentTemplate) =>
    api.patch<AgentTemplateDetail>(`/templates/agent/${id}`, body),
  updateSkill: (id: string, body: UpdateSkillTemplate) =>
    api.patch<SkillTemplateDetail>(`/templates/skill/${id}`, body),

  remove: (type: TemplateType, id: string) => api.delete<void>(`/templates/${type}/${id}`),

  deploy: (type: TemplateType, id: string, body: DeployTemplate) =>
    api.post<TemplateDeploymentResult>(`/templates/${type}/${id}/deploy`, body),

  listDeployments: (type: TemplateType, id: string) =>
    api.get<{ deployments: TemplateDeployment[] }>(`/templates/${type}/${id}/deployments`),

  // ---- Library: import from paperclip-extensions GitHub release ----------
  listLibrary: () => api.get<LibraryListResponse>("/templates/library"),
  refreshLibrary: () => api.post<LibraryListResponse>("/templates/library/refresh", {}),
  installFromLibrary: (kind: "agent" | "routine" | "skill", name: string) =>
    api.post<LibraryInstallResult>("/templates/library/install", { kind, name }),
  updateFromLibrary: (kind: "agent" | "routine" | "skill", name: string) =>
    api.post<{ status: "updated"; template: AgentTemplateDetail | RoutineTemplateDetail | SkillTemplateDetail }>(
      "/templates/library/update",
      { kind, name },
    ),
  installBundle: (name: string) =>
    api.post<LibraryBundleInstallResult>("/templates/library/install-bundle", { name }),
};
