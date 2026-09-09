import type { StartWorkPlanResponse } from "@paperclipai/shared";
import { api } from "./client";

export interface StartWorkPlanInput {
  /** What the person typed, in their own words. */
  text: string;
  /**
   * One key per typed request, minted in the browser. The server uses it to
   * land a repeat submit (double Enter, retry after a timeout) on the same
   * plan instead of drafting a second one.
   */
  requestKey: string;
}

export const startWorkApi = {
  /**
   * Draft a reviewable plan. The company is the route parameter and nothing
   * in the body can point the plan elsewhere. 201 for a fresh plan, 200 when
   * the requestKey already had one; both carry the same body.
   */
  plan: (companyId: string, input: StartWorkPlanInput) =>
    api.post<StartWorkPlanResponse>(`/companies/${companyId}/start-work/plan`, input),
};
