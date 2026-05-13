import { api } from "./client";

export interface DraftReplyInput {
  subject?: string;
  from?: string;
  bodyText: string;
  instructions?: string;
  model?: string;
}

export interface DraftReplyResult {
  draft: string;
  model: string;
}

export const emailDraftsApi = {
  draftReply: (input: DraftReplyInput) =>
    api.post<DraftReplyResult>("/email-drafts/reply", input),
};
