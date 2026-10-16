import type { AgentActionType } from "./constants.js";

export const AGENT_ACTION_TYPE_LABELS = {
  send_message: "Send messages",
  move_money: "Move money",
  change_files: "Change files",
  post_publicly: "Post publicly",
  change_knowledge_base: "Change the knowledge base",
} as const satisfies Record<AgentActionType, string>;

export const AGENT_ACTION_TYPE_DESCRIPTIONS = {
  send_message: "Send email or messages, or place outbound calls.",
  move_money: "Charge, transfer, refund, pay, or otherwise move money.",
  change_files: "Create, edit, move, or delete files.",
  post_publicly: "Publish or reply on public websites and social channels.",
  change_knowledge_base: "Create, edit, or delete shared knowledge-base facts.",
} as const satisfies Record<AgentActionType, string>;
