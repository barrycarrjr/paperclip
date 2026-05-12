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
};
