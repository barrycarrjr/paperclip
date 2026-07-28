import { api } from "./client";

export interface DraftReplyInput {
  subject?: string;
  from?: string;
  /** Recipient — only meaningful when composing a new message. */
  to?: string;
  bodyText: string;
  instructions?: string;
  /** Reply text already in the composer — the model revises it rather than
   *  starting over, so instructions can be applied one nudge at a time. */
  currentDraft?: string;
  /** "reply" answers an email; "new" writes a first message, where the
   *  instructions are the only thing the model has to go on. */
  mode?: "reply" | "new";
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
