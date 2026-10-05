import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";

export interface DocumentAnnotationComment {
  id: string;
  threadId: string;
  caseId: string | null;
  issueId: string | null;
  routineId: string | null;
  body: string;
  author: any;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentAnnotationThread {
  id: string;
  caseId: string | null;
  issueId: string | null;
  routineId: string | null;
  documentKey: string;
  documentId: string;
  status: "open" | "resolved";
  currentRevisionNumber: number;
  selectedText: string;
  anchor: any;
  anchorState: string;
  anchorConfidence: number;
  comments: DocumentAnnotationComment[];
  createdAt: string;
  updatedAt: string;
}

const memoryThreads = new Map<string, DocumentAnnotationThread>();

export function clearDocumentAnnotationsStore(): void {
  memoryThreads.clear();
}

export function documentAnnotationService(_db: Db) {
  return {
    async listThreadsForCaseDocument(
      caseId: string,
      key: string,
      options?: { status?: string; includeComments?: boolean },
    ): Promise<DocumentAnnotationThread[]> {
      const all = Array.from(memoryThreads.values()).filter(
        (t) => t.caseId === caseId && t.documentKey === key,
      );
      const filtered = all.filter((t) => {
        if (options?.status === "resolved") return t.status === "resolved";
        if (options?.status === "all") return true;
        return t.status === "open";
      });
      return filtered.map((t) => ({
        ...t,
        comments: options?.includeComments === false ? [] : [...t.comments],
      }));
    },

    async getThreadForCaseDocument(
      caseId: string,
      key: string,
      threadId: string,
    ): Promise<DocumentAnnotationThread | null> {
      const thread = memoryThreads.get(threadId);
      if (!thread || thread.caseId !== caseId || thread.documentKey !== key) {
        return null;
      }
      return { ...thread, comments: [...thread.comments] };
    },

    async createCaseThread(
      caseId: string,
      key: string,
      body: any,
      annotationActor: any,
    ): Promise<DocumentAnnotationThread> {
      const threadId = randomUUID();
      const now = new Date().toISOString();
      const commentId = randomUUID();
      const commentBody = body.body ?? body.comment?.body ?? "";
      const comment: DocumentAnnotationComment = {
        id: commentId,
        threadId,
        caseId,
        issueId: null,
        routineId: null,
        body: commentBody,
        author: annotationActor,
        createdAt: now,
        updatedAt: now,
      };
      const selectedText = body.selector?.quote?.exact ?? body.selectedText ?? "";
      const thread: DocumentAnnotationThread = {
        id: threadId,
        caseId,
        issueId: null,
        routineId: null,
        documentKey: key,
        documentId: body.documentId ?? "",
        status: "open",
        currentRevisionNumber: body.baseRevisionNumber ?? 1,
        selectedText,
        anchor: body.selector ?? body.anchor ?? null,
        anchorState: "attached",
        anchorConfidence: 1,
        comments: [comment],
        createdAt: now,
        updatedAt: now,
      };
      memoryThreads.set(threadId, thread);
      return { ...thread, comments: [...thread.comments] };
    },

    async addCaseComment(
      caseId: string,
      key: string,
      threadId: string,
      body: any,
      annotationActor: any,
    ): Promise<DocumentAnnotationComment> {
      const thread = memoryThreads.get(threadId);
      const now = new Date().toISOString();
      const comment: DocumentAnnotationComment = {
        id: randomUUID(),
        threadId,
        caseId,
        issueId: null,
        routineId: null,
        body: body.body ?? "",
        author: annotationActor,
        createdAt: now,
        updatedAt: now,
      };
      if (thread) {
        thread.comments.push(comment);
        thread.updatedAt = now;
      }
      return comment;
    },

    async updateCaseThread(
      caseId: string,
      key: string,
      threadId: string,
      body: any,
      _annotationActor: any,
    ): Promise<DocumentAnnotationThread> {
      const thread = memoryThreads.get(threadId);
      if (thread) {
        if (body.status !== undefined) {
          thread.status = body.status;
        }
        thread.updatedAt = new Date().toISOString();
        return { ...thread, comments: [...thread.comments] };
      }
      return {
        id: threadId,
        caseId,
        issueId: null,
        routineId: null,
        documentKey: key,
        documentId: "",
        status: body.status ?? "open",
        currentRevisionNumber: 1,
        selectedText: "",
        anchor: null,
        anchorState: "attached",
        anchorConfidence: 1,
        comments: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    },

    async remapOpenThreadsForCaseDocument(input: {
      caseId: string;
      key: string;
      documentId: string;
      nextRevisionId?: string | null;
      nextRevisionNumber?: number | null;
      nextBody?: string | null;
    }): Promise<Array<{ thread: DocumentAnnotationThread; snapshot: { id: string } }>> {
      const openThreads = Array.from(memoryThreads.values()).filter(
        (t) => t.caseId === input.caseId && t.documentKey === input.key && t.status === "open",
      );
      const remapped: Array<{ thread: DocumentAnnotationThread; snapshot: { id: string } }> = [];
      for (const thread of openThreads) {
        if (input.nextRevisionNumber !== null && input.nextRevisionNumber !== undefined) {
          thread.currentRevisionNumber = input.nextRevisionNumber;
        }
        thread.updatedAt = new Date().toISOString();
        remapped.push({
          thread: { ...thread, comments: [...thread.comments] },
          snapshot: { id: randomUUID() },
        });
      }
      return remapped;
    },

    async remapOpenThreadsForDocument(_input: any): Promise<any[]> {
      return [];
    },
  };
}
