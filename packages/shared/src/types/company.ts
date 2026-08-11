import type { CompanyKind, CompanyStatus, PauseReason } from "../constants.js";

export interface Company {
  id: string;
  name: string;
  description: string | null;
  status: CompanyStatus;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  issuePrefix: string;
  issueCounter: number;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  requireBoardApprovalForNewAgents: boolean;
  brandColor: string | null;
  /** True if this is HQ — the portfolio-root holding-company entity. Singleton per instance. */
  isPortfolioRoot: boolean;
  /**
   * `standard` — an ordinary company people share.
   * `personal`  — belongs to one user and cannot be shared, joined, or deleted.
   */
  kind: CompanyKind;
  /** Set only on personal companies: the one person it belongs to. */
  ownerUserId: string | null;
  logoAssetId: string | null;
  logoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}
