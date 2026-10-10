// @vitest-environment jsdom

import { act, type AnchorHTMLAttributes, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseDetail as CaseDetailData, CaseDocument } from "@/api/cases";
import type { IssueDocumentsSection } from "@/components/IssueDocumentsSection";
import { queryKeys } from "@/lib/queryKeys";
import { CaseDetail } from "./CaseDetail";

type DocumentsSectionProps = ComponentProps<typeof IssueDocumentsSection>;

const mockCasesApi = vi.hoisted(() => ({
  get: vi.fn(),
  listEvents: vi.fn(),
  listChildren: vi.fn(),
  patch: vi.fn(),
  getDocument: vi.fn(),
  listRevisions: vi.fn(),
  upsertDocument: vi.fn(),
  lockDocument: vi.fn(),
  unlockDocument: vi.fn(),
  restoreDocumentRevision: vi.fn(),
  deleteDocument: vi.fn(),
}));
const mockIssuesApi = vi.hoisted(() => ({ listLabels: vi.fn(), createLabel: vi.fn() }));
const panelState = vi.hoisted(() => ({ openPanel: vi.fn(), closePanel: vi.fn() }));
const breadcrumbState = vi.hoisted(() => ({ setBreadcrumbs: vi.fn() }));
const documentsSection = vi.hoisted(() => ({ props: null as DocumentsSectionProps | null }));

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => breadcrumbState }));
vi.mock("@/context/PanelContext", () => ({ usePanel: () => panelState }));
vi.mock("@/api/cases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/cases")>()),
  casesApi: mockCasesApi,
}));
vi.mock("@/api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("@/components/IssueDocumentsSection", () => ({
  IssueDocumentsSection: (props: DocumentsSectionProps) => {
    documentsSection.props = props;
    return <div data-testid="case-documents-section" />;
  },
}));
vi.mock("@/lib/router", () => ({
  useParams: () => ({ caseIdentifier: "PAP-C7" }),
  useLocation: () => ({ hash: "" }),
  Navigate: () => null,
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useCaseHref: () => (...segments: string[]) =>
    `/PAP/${["cases", ...segments].filter(Boolean).join("/")}`,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function caseDocument(overrides: Partial<CaseDocument> = {}): CaseDocument {
  return {
    id: "doc-1",
    companyId: "company-1",
    title: "body",
    format: "markdown",
    latestBody: "# Draft body",
    latestRevisionId: "rev-8",
    latestRevisionNumber: 8,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: "agent-1",
    updatedByUserId: null,
    lockedAt: null,
    lockedByAgentId: null,
    lockedByUserId: null,
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    ...overrides,
  };
}

function caseRevision(id: string, revisionNumber: number) {
  return {
    id,
    revisionNumber,
    title: "body",
    format: "markdown",
    body: "# Draft body",
    changeSummary: null,
    createdAt: "2026-07-07T00:00:00.000Z",
    createdByAgentId: null,
    createdByUserId: null,
    createdByRunId: null,
    actorAgentName: null,
    issue: null,
  };
}

function detail(): CaseDetailData {
  return {
    id: "case-1",
    companyId: "company-1",
    projectId: null,
    caseNumber: 7,
    identifier: "PAP-C7",
    caseType: "blog_post",
    key: null,
    title: "Launch post",
    summary: null,
    status: "in_review",
    fields: {},
    parent: null,
    parentCaseId: null,
    createdByAgentId: null,
    createdByUserId: null,
    completedAt: null,
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    labels: [],
    issueLinks: [],
    documents: [{ key: "body", document: caseDocument() }],
    attachments: [],
  };
}

describe("CaseDetail", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.clearAllMocks();
    documentsSection.props = null;
    mockCasesApi.get.mockResolvedValue(detail());
    mockCasesApi.listEvents.mockResolvedValue([]);
    mockCasesApi.listChildren.mockResolvedValue([]);
  });

  afterEach(() => {
    container.remove();
  });

  it("gives the documents section the case's own document addresses, not task ones", async () => {
    const root = createRoot(container);
    // Fresh for 30 seconds, as in the app (main.tsx), so the list reads the cached case.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CaseDetail />
        </QueryClientProvider>,
      );
    });

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="case-documents-section"]')).not.toBeNull();
    });
    const props = documentsSection.props!;
    expect(props.issue).toBeUndefined();
    const subject = props.subject!;
    expect(subject.id).toBe("case-1");

    expect(await subject.listDocuments()).toEqual([
      expect.objectContaining({ issueId: "case-1", key: "body", body: "# Draft body", latestRevisionNumber: 8 }),
    ]);

    // The server answers a save with the document row alone, which has no key.
    mockCasesApi.upsertDocument.mockResolvedValue({
      document: caseDocument({ latestBody: "# New body", latestRevisionId: "rev-9", latestRevisionNumber: 9 }),
      revision: caseRevision("rev-9", 9),
    });
    const draft = { title: null, format: "markdown" as const, body: "# New body", baseRevisionId: "rev-8" };
    const saved = await subject.upsertDocument("body", draft);
    expect(mockCasesApi.upsertDocument).toHaveBeenCalledWith("PAP-C7", "body", draft);
    expect(saved).toMatchObject({ issueId: "case-1", key: "body", body: "# New body", latestRevisionNumber: 9 });

    mockCasesApi.getDocument.mockResolvedValue({ ...caseDocument(), key: "body", body: "# Draft body" });
    expect(await subject.getDocument("body")).toMatchObject({ key: "body", body: "# Draft body" });
    expect(mockCasesApi.getDocument).toHaveBeenCalledWith("PAP-C7", "body");

    mockCasesApi.listRevisions.mockResolvedValue({
      key: "body",
      document: { id: "doc-1", title: "body", format: "markdown", latestRevisionId: "rev-8", latestRevisionNumber: 8 },
      revisions: [caseRevision("rev-8", 8), caseRevision("rev-7", 7)],
    });
    const revisions = await subject.listDocumentRevisions("body");
    expect(mockCasesApi.listRevisions).toHaveBeenCalledWith("PAP-C7", "body");
    expect(revisions.map((revision) => [revision.issueId, revision.key, revision.revisionNumber])).toEqual([
      ["case-1", "body", 8],
      ["case-1", "body", 7],
    ]);

    mockCasesApi.restoreDocumentRevision.mockResolvedValue({
      document: { ...caseDocument({ latestRevisionNumber: 9 }), key: "body", body: "# Draft body" },
      revision: caseRevision("rev-9", 9),
      restoredFromRevisionId: "rev-7",
      restoredFromRevisionNumber: 7,
    });
    expect(await subject.restoreDocumentRevision("body", "rev-7")).toMatchObject({ key: "body", latestRevisionNumber: 9 });
    expect(mockCasesApi.restoreDocumentRevision).toHaveBeenCalledWith("PAP-C7", "body", "rev-7");

    mockCasesApi.deleteDocument.mockResolvedValue({ ok: true });
    await act(async () => {
      await subject.deleteDocument("body");
    });
    expect(mockCasesApi.deleteDocument).toHaveBeenCalledWith("PAP-C7", "body");
    // The list is read from the cached case, which must no longer hold the deleted document.
    expect(await subject.listDocuments()).toEqual([]);

    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("lists the documents of the case reload under way, not of the copy it replaces", async () => {
    const root = createRoot(container);
    // No fresh period, so a window focus reloads the case at once, as the app
    // does once the case is 30 seconds old.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <CaseDetail />
          </QueryClientProvider>,
        );
      });
      await waitForAssertion(() => {
        expect(documentsSection.props?.subject).toBeTruthy();
      });
      const subject = documentsSection.props!.subject!;

      const reload = deferred<CaseDetailData>();
      mockCasesApi.get.mockReturnValueOnce(reload.promise);
      await act(async () => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
      });
      expect(queryClient.isFetching({ queryKey: queryKeys.cases.detail("PAP-C7") })).toBe(1);

      // The document list reloads on the same focus.
      const listed = subject.listDocuments();
      await act(async () => {
        reload.resolve({
          ...detail(),
          documents: [{
            key: "body",
            document: caseDocument({ latestBody: "# Newer body", latestRevisionId: "rev-9", latestRevisionNumber: 9 }),
          }],
        });
      });

      expect(await listed).toEqual([
        expect.objectContaining({ key: "body", body: "# Newer body", latestRevisionNumber: 9 }),
      ]);
      // It waited for that reload rather than asking for the case again.
      expect(mockCasesApi.get).toHaveBeenCalledTimes(2);
    } finally {
      focusManager.setFocused(undefined);
      await act(async () => {
        root.unmount();
      });
      queryClient.clear();
    }
  });
});
