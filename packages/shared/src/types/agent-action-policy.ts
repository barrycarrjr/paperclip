import type { AgentActionMode, AgentActionType } from "../constants.js";

/** One company default for an action type. */
export interface CompanyActionPolicy {
  companyId: string;
  actionType: AgentActionType;
  mode: AgentActionMode;
}

/** One agent-specific setting that replaces the company default. */
export interface AgentActionPolicyOverride {
  companyId: string;
  agentId: string;
  actionType: AgentActionType;
  mode: AgentActionMode;
}

export type AgentActionPolicySource = "company" | "agent";

/** The resolved setting returned when an operator views one agent's policy. */
export interface EffectiveAgentActionPolicy {
  companyId: string;
  agentId: string;
  actionType: AgentActionType;
  companyMode: AgentActionMode;
  overrideMode: AgentActionMode | null;
  effectiveMode: AgentActionMode;
  source: AgentActionPolicySource;
}

export type CompanyActionPolicyResponse = CompanyActionPolicy[];

export interface AgentActionPolicyResponse {
  overrides: AgentActionPolicyOverride[];
  effective: EffectiveAgentActionPolicy[];
}

export interface PatchCompanyActionPolicy {
  actionType: AgentActionType;
  mode: AgentActionMode;
}

export interface PatchAgentActionPolicyOverride {
  actionType: AgentActionType;
  /** Null removes the agent override and restores the company default. */
  mode: AgentActionMode | null;
}
