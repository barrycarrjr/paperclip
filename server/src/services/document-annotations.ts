import type { Db } from "@paperclipai/db";

export function documentAnnotationService(db: Db) {
  return {
    async listThreadsForCaseDocument(...args: any[]): Promise<any[]> {
      return [];
    },
    async getThreadForCaseDocument(...args: any[]): Promise<any> {
      return null;
    },
    async createCaseThread(...args: any[]): Promise<any> {
      return {
        id: "noop",
        comments: [],
        documentKey: "",
        documentId: "",
        currentRevisionNumber: 1,
        selectedText: "",
      };
    },
    async addCaseComment(...args: any[]): Promise<any> {
      return { id: "noop", threadId: "", body: "" };
    },
    async updateCaseThread(...args: any[]): Promise<any> {
      return { id: "noop", status: "open", documentKey: "", documentId: "" };
    },
    async remapOpenThreadsForCaseDocument(...args: any[]): Promise<Array<{ thread: any; snapshot: any }>> {
      return [];
    },
    async remapOpenThreadsForDocument(...args: any[]): Promise<any[]> {
      return [];
    },
  };
}
