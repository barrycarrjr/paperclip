export type SecretProvider =
  | "local_encrypted"
  | "aws_secrets_manager"
  | "gcp_secret_manager"
  | "vault";

export type SecretVersionSelector = number | "latest";

export interface EnvPlainBinding {
  type: "plain";
  value: string;
}

export interface EnvSecretRefBinding {
  type: "secret_ref";
  /**
   * Reference a company secret by UUID. Exactly one of `secretId` or `secretName`
   * must be provided on input; the persistence layer canonicalizes inputs to `secretId`.
   */
  secretId?: string;
  /**
   * Reference a company secret by its human-readable name. Resolved to `secretId`
   * at persistence time; fails if no matching secret exists in the agent's company.
   * Lets agents (e.g. CEOs handling delegated config tasks) bind secrets without
   * needing the secret listing endpoint, which is board-only.
   */
  secretName?: string;
  version?: SecretVersionSelector;
}

// Backward-compatible: legacy plaintext string values are still accepted.
export type EnvBinding = string | EnvPlainBinding | EnvSecretRefBinding;

export type AgentEnvConfig = Record<string, EnvBinding>;

export interface CompanySecret {
  id: string;
  companyId: string;
  name: string;
  provider: SecretProvider;
  externalRef: string | null;
  latestVersion: number;
  description: string | null;
  agentReferences?: CompanySecretAgentReference[];
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompanySecretAgentReference {
  agentId: string;
  agentName: string;
  envKeys: string[];
}

export interface SecretProviderDescriptor {
  id: SecretProvider;
  label: string;
  requiresExternalRef: boolean;
}
