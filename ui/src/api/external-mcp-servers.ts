/**
 * Frontend API client for external MCP server CRUD + diagnostics.
 *
 * Maps 1:1 to `server/src/routes/external-mcp-servers.ts`. All routes are
 * board-scoped — UI consumers gate on `board` actor before calling.
 */

import type {
  CreateExternalMcpServer,
  ExternalMcpServerRecord,
  ExternalMcpTestConnectResult,
  UpdateExternalMcpServer,
} from "@paperclipai/shared";
import { api } from "./client";

const BASE = "/external-mcp-servers";

export const externalMcpServersApi = {
  list: () => api.get<ExternalMcpServerRecord[]>(BASE),
  get: (id: string) => api.get<ExternalMcpServerRecord>(`${BASE}/${id}`),
  create: (body: CreateExternalMcpServer) =>
    api.post<ExternalMcpServerRecord>(BASE, body),
  update: (id: string, body: UpdateExternalMcpServer) =>
    api.patch<ExternalMcpServerRecord>(`${BASE}/${id}`, body),
  remove: (id: string) => api.delete<{ ok: true }>(`${BASE}/${id}`),
  testConnect: (id: string, companyId: string) =>
    api.post<ExternalMcpTestConnectResult>(`${BASE}/${id}/test-connect`, {
      companyId,
    }),
};
