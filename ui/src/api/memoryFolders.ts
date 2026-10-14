import type {
  DocumentLinkApplyResult,
  DocumentLinkPreview,
  KnowledgeBaseIndexResult,
  KnowledgeBaseValidationResult,
  MemoryFolderRunResult,
  MemoryFolderSettings,
  UpdateMemoryFolder,
} from "@paperclipai/shared";
import { api } from "./client";

export const memoryFoldersApi = {
  get: (companyId: string) =>
    api.get<MemoryFolderSettings>(`/companies/${companyId}/memory-folder`),
  update: (companyId: string, data: UpdateMemoryFolder) =>
    api.put<MemoryFolderSettings>(`/companies/${companyId}/memory-folder`, data),
  export: (companyId: string) =>
    api.post<MemoryFolderRunResult>(`/companies/${companyId}/memory-folder/export`, {}),
  import: (companyId: string) =>
    api.post<MemoryFolderRunResult>(`/companies/${companyId}/memory-folder/import`, {}),
  sync: (companyId: string) =>
    api.post<MemoryFolderRunResult>(`/companies/${companyId}/memory-folder/sync`, {}),
  findings: (companyId: string) =>
    api.get<KnowledgeBaseValidationResult>(`/companies/${companyId}/memory-folder/findings`),
  rebuildIndex: (companyId: string) =>
    api.post<KnowledgeBaseIndexResult>(`/companies/${companyId}/memory-folder/index`, {}),
  previewLinks: (companyId: string) =>
    api.get<DocumentLinkPreview>(`/companies/${companyId}/memory-folder/links/preview`),
  applyLinks: (companyId: string, planHash: string) =>
    api.post<DocumentLinkApplyResult>(`/companies/${companyId}/memory-folder/links/apply`, { planHash }),
};
