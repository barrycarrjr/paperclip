import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  documents,
  pipelineCaseDocuments,
} from "@paperclipai/db";
import { PIPELINE_CASE_BODY_DOCUMENT_KEY, type SourceTrustMetadata } from "@paperclipai/shared";

export const PIPELINE_CASE_BODY_CASE_DOCUMENT_KEY = "body";

export interface PipelineConversationBodyDocumentContext {
  caseId: string;
  bodyDocument: {
    id: string;
    caseDocumentKey: typeof PIPELINE_CASE_BODY_CASE_DOCUMENT_KEY;
    conversationIssueDocumentKey: typeof PIPELINE_CASE_BODY_DOCUMENT_KEY;
    title: string | null;
    format: string;
    latestRevisionId: string | null;
    latestRevisionNumber: number;
    latestBody: string;
    latestBodyTruncated: boolean;
    sourceTrust: SourceTrustMetadata | null;
    updatedAt: Date;
  } | null;
  openAnnotationThreads: any[];
}

export function pipelineConversationContextService(db: Db) {
  return {
    async getCaseBodyDocumentContext(caseId: string, companyId: string): Promise<PipelineConversationBodyDocumentContext> {
      const [link] = await db
        .select()
        .from(pipelineCaseDocuments)
        .where(
          and(
            eq(pipelineCaseDocuments.caseId, caseId),
            eq(pipelineCaseDocuments.companyId, companyId),
            eq(pipelineCaseDocuments.key, PIPELINE_CASE_BODY_CASE_DOCUMENT_KEY),
          ),
        )
        .limit(1);

      if (!link) {
        return { caseId, bodyDocument: null, openAnnotationThreads: [] };
      }

      const [doc] = await db.select().from(documents).where(eq(documents.id, link.documentId)).limit(1);
      if (!doc) {
        return { caseId, bodyDocument: null, openAnnotationThreads: [] };
      }

      return {
        caseId,
        bodyDocument: {
          id: doc.id,
          caseDocumentKey: PIPELINE_CASE_BODY_CASE_DOCUMENT_KEY,
          conversationIssueDocumentKey: PIPELINE_CASE_BODY_DOCUMENT_KEY,
          title: doc.title,
          format: doc.format,
          latestRevisionId: doc.latestRevisionId,
          latestRevisionNumber: doc.latestRevisionNumber,
          latestBody: doc.latestBody,
          latestBodyTruncated: false,
          sourceTrust: null,
          updatedAt: doc.updatedAt,
        },
        openAnnotationThreads: [],
      };
    },
  };
}

export async function loadPipelineConversationBodyDocumentContext(db: Db, input: { caseId: string; companyId: string }) {
  const { caseId, companyId } = input;
  return pipelineConversationContextService(db).getCaseBodyDocumentContext(caseId, companyId);
}

export function formatPipelineConversationBodyDocumentContextMarkdown(ctx: any): string {
  if (!ctx || !ctx.bodyDocument || !ctx.bodyDocument.latestBody) return "";
  return ctx.bodyDocument.latestBody;
}
