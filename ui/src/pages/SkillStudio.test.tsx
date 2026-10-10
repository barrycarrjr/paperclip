// @vitest-environment jsdom

import { useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import type {
  CompanySkillDetail,
  CompanySkillLastEditor,
  CompanySkillListItem,
  CompanySkillTestRunDetail,
} from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastProvider } from "../context/ToastContext";
import { ToastViewport } from "../components/ToastViewport";
import { NO_TEST_RUN_TEMPLATE_STORAGE_VALUE } from "@/lib/skill-studio";
import { InteractionSection, SkillStudio } from "./SkillStudio";

const routeState = vi.hoisted(() => ({
  pathname: "/skills/studio/new",
  search: "",
  skillId: "new" as string | undefined,
}));

const mockNavigate = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

const mockCompanySkillsApi = vi.hoisted(() => ({
  list: vi.fn(),
  detail: vi.fn(),
  create: vi.fn(),
  file: vi.fn(),
  updateFile: vi.fn(),
  deleteFile: vi.fn(),
  testInputs: vi.fn(),
  updateTestInput: vi.fn(),
  deleteTestInput: vi.fn(),
  createTestInput: vi.fn(),
  testRunTemplates: vi.fn(),
  testRuns: vi.fn(),
  createTestRunTemplate: vi.fn(),
  updateTestRunTemplate: vi.fn(),
  deleteTestRunTemplate: vi.fn(),
  createTestRun: vi.fn(),
  testRunDetail: vi.fn(),
  cancelTestRun: vi.fn(),
  deleteTestRun: vi.fn(),
  versions: vi.fn(),
  createVersion: vi.fn(),
}));
const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));
const mockIssuesApi = vi.hoisted(() => ({
  listInteractions: vi.fn(),
  acceptInteraction: vi.fn(),
  respondToInteraction: vi.fn(),
  rejectInteraction: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname: routeState.pathname, search: routeState.search, hash: "" }),
  useNavigate: () => mockNavigate,
  useParams: () => ({ skillId: routeState.skillId }),
  useSearchParams: () => [new URLSearchParams(routeState.search), vi.fn()],
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("@/api/companySkills", () => ({
  companySkillsApi: mockCompanySkillsApi,
}));

vi.mock("@/api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("@/api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("@/components/SearchableSelect", () => ({
  SearchableSelect: ({
    placeholder,
    renderValue,
  }: {
    placeholder: string;
    renderValue?: (option: null) => ReactNode;
  }) => <button type="button">{renderValue ? renderValue(null) : placeholder}</button>,
}));

vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
    readOnly,
  }: {
    value: string;
    onChange: (value: string) => void;
    readOnly?: boolean;
  }) => (
    <textarea
      data-testid="markdown-editor"
      readOnly={readOnly}
      value={value}
      onChange={(event) => {
        if (!readOnly) onChange(event.target.value);
      }}
      onKeyDown={(event) => {
        if (!readOnly && event.key === "E") {
          onChange(`${value}\n\nEdited body\n`);
        }
      }}
    />
  ),
}));

vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/resizable-panels", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div />,
}));

vi.mock("./CompanySkills", () => ({
  SkillCardIcon: ({ card }: { card: { name: string } }) => (
    <div data-testid="skill-card-icon">{card.name}</div>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

/**
 * Waits on the condition, not on a fixed number of turns. A hand-rolled retry
 * loop is ample on an idle machine and not when the suite runs many workers in
 * parallel: it gives up after N turns and reports a failure on behaviour that
 * works. `vi.waitFor` retries against a time budget, so a loaded worker gets
 * more turns instead.
 *
 * Same replacement as #11499 and #11521, which fixed the shorter-budget
 * instances of this in the routing tests.
 *
 * This was a reimplementation of `vi.waitFor` down to rethrowing the last
 * error, differing only in bounding on turns rather than on time.
 */
async function waitFor(assertion: () => void) {
  // vi.waitFor's default budget is one second. A full parallel run once took
  // longer than that to settle a failed save in a dialog, so allow five.
  // await vi.waitFor(assertion);
  await vi.waitFor(assertion, { timeout: 5_000 });
}

/** Takes the studio off the page, as browser Back does, and leaves the rest. */
let leaveStudio: () => Promise<void> = async () => {};
/**
 * Draws the studio again from nothing, as coming back to the page does. What
 * the app keeps between pages, its requests and what they loaded, is kept.
 */
let returnToStudio: () => Promise<void> = async () => {};

/**
 * Draws the studio. With toasts, it sits inside the message viewport the app
 * has around every page, for what is said once a dialog has gone.
 */
async function renderStudio({ toasts = false }: { toasts?: boolean } = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const draw = (page: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      {toasts ? (
        <ToastProvider>
          {page}
          <ToastViewport />
        </ToastProvider>
      ) : page}
    </QueryClientProvider>
  );

  await act(async () => {
    root?.render(draw(<SkillStudio />));
  });
  leaveStudio = async () => {
    await act(async () => {
      root?.render(draw(null));
    });
  };
  returnToStudio = async () => {
    await act(async () => {
      root?.render(draw(<SkillStudio />));
    });
  };

  return container;
}

/** The message viewport's live region. */
function messageRegion(node: ParentNode) {
  const region = node.querySelector('aside[aria-live="polite"]');
  expect(region, "the studio was drawn with its message viewport").not.toBeNull();
  return region as HTMLElement;
}

const windowWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");

/** Resizes the window, as far as the studio can tell. */
async function setWindowWidth(width: number) {
  await act(async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    window.dispatchEvent(new Event("resize"));
  });
}

async function inputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function keyDown(element: HTMLElement, key: string) {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
  });
}

/** A request that waits until the test settles it. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeSkill(overrides: Partial<CompanySkillDetail> = {}): CompanySkillDetail {
  return {
    id: "source-skill",
    companyId: "company-1",
    key: "paperclip/demo-skill",
    slug: "demo-skill",
    name: "Demo Skill",
    description: "A demo skill.",
    markdown: "---\nname: Demo Skill\ndescription: Existing\n---\n\n# Demo Skill\n",
    sourceType: "local_path",
    sourceLocator: null,
    sourceRef: null,
    trustLevel: "markdown_only",
    compatibility: "compatible",
    fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    iconUrl: null,
    color: null,
    tagline: "Existing tagline",
    authorName: null,
    homepageUrl: null,
    categories: ["engineering"],
    sharingScope: "company",
    publicShareToken: null,
    forkedFromSkillId: null,
    forkedFromCompanyId: null,
    starCount: 0,
    installCount: 0,
    forkCount: 0,
    currentVersionId: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    attachedAgentCount: 0,
    usedByAgents: [],
    editable: true,
    editableReason: null,
    sourceLabel: "Local",
    sourceBadge: "local",
    sourcePath: null,
    currentVersion: null,
    starredByCurrentActor: false,
    existingForks: [],
    ...overrides,
  };
}

function buttonsNamed(node: ParentNode, name: string) {
  return Array.from(node.querySelectorAll("button")).filter((button) =>
    button.textContent?.trim() === name,
  );
}

beforeEach(() => {
  routeState.pathname = "/skills/studio/new";
  routeState.search = "";
  routeState.skillId = "new";
  mockNavigate.mockReset();
  mockSetBreadcrumbs.mockReset();
  // Answers a test lined up but never used (one it stopped short of, by
  // failing) would otherwise go to the next test's first call, and fail that
  // test too. vi.clearAllMocks after each test leaves them queued.
  for (const api of [mockCompanySkillsApi, mockAgentsApi, mockIssuesApi]) {
    for (const mock of Object.values(api)) mock.mockReset();
  }
  mockCompanySkillsApi.list.mockResolvedValue([]);
  mockCompanySkillsApi.detail.mockResolvedValue(makeSkill());
  mockCompanySkillsApi.create.mockResolvedValue({
    id: "created-skill",
    name: "Code Review",
    forkedFromSkillId: null,
  });
  mockCompanySkillsApi.file.mockResolvedValue({
    path: "SKILL.md",
    content: "---\nname: Demo Skill\ndescription: Existing\n---\n\n# Demo Skill\n",
    markdown: true,
    editable: true,
    editableReason: null,
  });
  mockCompanySkillsApi.updateFile.mockResolvedValue({
    path: "SKILL.md",
    content: "---\nname: Demo Skill\ndescription: Existing\n---\n\n# Demo Skill\n",
    markdown: true,
    editable: true,
    editableReason: null,
  });
  mockCompanySkillsApi.deleteFile.mockResolvedValue({ deletedPaths: [] });
  mockCompanySkillsApi.testInputs.mockResolvedValue([]);
  mockCompanySkillsApi.updateTestInput.mockResolvedValue({ id: "input-1", name: "input.md", content: "" });
  mockCompanySkillsApi.deleteTestInput.mockResolvedValue({ id: "input-1" });
  mockCompanySkillsApi.createTestInput.mockResolvedValue({ id: "input-1", name: "input.md", content: "" });
  mockCompanySkillsApi.testRunTemplates.mockResolvedValue([]);
  mockCompanySkillsApi.testRuns.mockResolvedValue([]);
  mockCompanySkillsApi.createTestRunTemplate.mockResolvedValue({ id: "template-1", name: "Template" });
  mockCompanySkillsApi.updateTestRunTemplate.mockResolvedValue({ id: "template-1", name: "Template" });
  mockCompanySkillsApi.deleteTestRunTemplate.mockResolvedValue({ id: "template-1", name: "Template" });
  mockCompanySkillsApi.createTestRun.mockResolvedValue({ id: "run-1", status: "queued" });
  mockCompanySkillsApi.testRunDetail.mockResolvedValue(null);
  mockCompanySkillsApi.cancelTestRun.mockResolvedValue({ id: "run-1", status: "cancelled" });
  mockCompanySkillsApi.deleteTestRun.mockResolvedValue({ id: "run-1" });
  mockCompanySkillsApi.versions.mockResolvedValue([]);
  mockCompanySkillsApi.createVersion.mockResolvedValue({ id: "version-1" });
  mockAgentsApi.list.mockResolvedValue([]);
  mockIssuesApi.listInteractions.mockResolvedValue([]);
  mockIssuesApi.acceptInteraction.mockResolvedValue({});
  mockIssuesApi.respondToInteraction.mockResolvedValue({});
  mockIssuesApi.rejectInteraction.mockResolvedValue({});
});

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
  onlineManager.setOnline(true);
  if (windowWidth) Object.defineProperty(window, "innerWidth", windowWidth);
  else delete (window as { innerWidth?: number }).innerWidth;
});

describe("SkillStudio create mode", () => {
  it("renders /skills/studio/new as create mode instead of loading skill id new", async () => {
    const node = await renderStudio();

    await waitFor(() => expect(node.textContent).toContain("Create a new skill"));

    expect(node.textContent).not.toContain("Skill not found.");
    expect(mockCompanySkillsApi.detail).not.toHaveBeenCalledWith("company-1", "new");
    expect(mockSetBreadcrumbs).toHaveBeenCalledWith([
      { label: "Skills", href: "/skills" },
      { label: "Studio", href: "/skills/studio" },
      { label: "New skill" },
    ]);
  });

  it("prefills fork drafts from the forkFrom query param", async () => {
    routeState.search = "?forkFrom=source-skill";

    const node = await renderStudio();

    await waitFor(() => expect(node.textContent).toContain("Forking Demo Skill"));

    expect(mockCompanySkillsApi.detail).toHaveBeenCalledWith("company-1", "source-skill");
    expect((node.querySelector("#skill-name") as HTMLInputElement).value).toBe("Demo Skill Fork");
    expect((node.querySelector("#skill-slug") as HTMLInputElement).value).toBe("demo-skill-fork");
  });

  it("creates a skill and navigates to the Studio editor for the new id", async () => {
    const node = await renderStudio();

    await waitFor(() => expect(node.querySelector("#skill-name")).toBeTruthy());
    await inputValue(node.querySelector("#skill-name") as HTMLInputElement, "Code Review");
    await click(buttonsNamed(node, "Create skill")[0] as HTMLButtonElement);

    await waitFor(() => expect(mockCompanySkillsApi.create).toHaveBeenCalled());

    expect(mockCompanySkillsApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        name: "Code Review",
        slug: "code-review",
        sharingScope: "company",
        forkedFromSkillId: null,
      }),
    );
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/skills/studio/created-skill"));
  });

  it("forwards the folderId query param so the new skill is filed there (PAP-14086)", async () => {
    routeState.search = "?folderId=folder-my-skills";

    const node = await renderStudio();

    await waitFor(() => expect(node.querySelector("#skill-name")).toBeTruthy());
    await inputValue(node.querySelector("#skill-name") as HTMLInputElement, "Code Review");
    await click(buttonsNamed(node, "Create skill")[0] as HTMLButtonElement);

    await waitFor(() => expect(mockCompanySkillsApi.create).toHaveBeenCalled());

    expect(mockCompanySkillsApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        name: "Code Review",
        folderId: "folder-my-skills",
      }),
    );
  });

  it("keeps category commas and spaces editable while creating a skill", async () => {
    const node = await renderStudio();

    await waitFor(() => expect(node.querySelector("#skill-categories")).toBeTruthy());
    await inputValue(node.querySelector("#skill-name") as HTMLInputElement, "Code Review");
    await inputValue(node.querySelector("#skill-categories") as HTMLInputElement, "AI Tools, Developer Experience, ");

    expect((node.querySelector("#skill-categories") as HTMLInputElement).value).toBe("AI Tools, Developer Experience, ");

    await click(buttonsNamed(node, "Create skill")[0] as HTMLButtonElement);
    await waitFor(() => expect(mockCompanySkillsApi.create).toHaveBeenCalled());

    expect(mockCompanySkillsApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        categories: ["AI Tools", "Developer Experience"],
      }),
    );
  });
});

function makeListItem(
  overrides: Partial<CompanySkillListItem> & { id: string },
): CompanySkillListItem {
  return {
    companyId: "company-1",
    key: overrides.id,
    slug: overrides.id,
    name: overrides.id,
    description: null,
    sourceType: "local_path",
    sourceLocator: null,
    sourceRef: null,
    trustLevel: "markdown_only",
    compatibility: "compatible",
    fileInventory: [],
    iconUrl: null,
    color: null,
    tagline: null,
    authorName: null,
    homepageUrl: null,
    categories: [],
    sharingScope: "private",
    publicShareToken: null,
    forkedFromSkillId: null,
    forkedFromCompanyId: null,
    starCount: 0,
    installCount: 0,
    forkCount: 0,
    currentVersionId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    attachedAgentCount: 0,
    editable: true,
    editableReason: null,
    sourceLabel: null,
    sourceBadge: "local",
    sourcePath: null,
    catalogKind: null,
    originHash: null,
    packageName: null,
    packageVersion: null,
    ...overrides,
  };
}

const userEditor = (name: string): CompanySkillLastEditor => ({
  kind: "user",
  id: `user-${name}`,
  name,
  imageUrl: null,
});
const agentEditor: CompanySkillLastEditor = {
  kind: "agent",
  id: "agent-1",
  name: "Bot",
  imageUrl: null,
};

function findRowButton(node: ParentNode, name: string): HTMLButtonElement | undefined {
  return Array.from(node.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(name),
  ) as HTMLButtonElement | undefined;
}

describe("SkillStudio landing", () => {
  beforeEach(() => {
    routeState.pathname = "/skills/studio";
    routeState.search = "";
    routeState.skillId = undefined;
    localStorage.clear();
  });

  it("renders recently-visited and recently-updated sections, gating avatars to humans", async () => {
    localStorage.setItem("paperclip:recent-studio-skills", JSON.stringify(["visited-1"]));
    mockCompanySkillsApi.list.mockResolvedValue([
      makeListItem({
        id: "visited-1",
        name: "Visited One",
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        lastEditor: userEditor("Ada Lovelace"),
      }),
      makeListItem({
        id: "agent-updated",
        name: "Agent Updated",
        updatedAt: new Date("2026-03-01T00:00:00Z"),
        lastEditor: agentEditor,
      }),
      makeListItem({
        id: "user-updated",
        name: "User Updated",
        updatedAt: new Date("2026-02-01T00:00:00Z"),
        lastEditor: userEditor("Grace Hopper"),
      }),
    ]);

    const node = await renderStudio();

    await waitFor(() => expect(node.textContent).toContain("Recently visited"));
    expect(node.textContent).toContain("Recently updated");

    // Visited section surfaces the visited skill; updated section excludes it.
    const visitedSection = Array.from(node.querySelectorAll("section")).find((s) =>
      s.querySelector("h2")?.textContent === "Recently visited",
    )!;
    const updatedSection = Array.from(node.querySelectorAll("section")).find((s) =>
      s.querySelector("h2")?.textContent === "Recently updated",
    )!;
    expect(visitedSection.textContent).toContain("Visited One");
    expect(updatedSection.textContent).not.toContain("Visited One");
    expect(updatedSection.textContent).toContain("Agent Updated");
    expect(updatedSection.textContent).toContain("User Updated");

    // Only the two human-edited rows render an avatar (initials fallback); the
    // agent-edited row renders none.
    const initials = Array.from(node.querySelectorAll('[data-slot="avatar-fallback"]')).map(
      (el) => el.textContent,
    );
    expect(initials).toEqual(["AL", "GH"]);
  });

  it("opens the clicked skill in Studio", async () => {
    mockCompanySkillsApi.list.mockResolvedValue([
      makeListItem({ id: "user-updated", name: "User Updated", lastEditor: userEditor("Grace Hopper") }),
    ]);

    const node = await renderStudio();

    await waitFor(() => expect(node.textContent).toContain("User Updated"));
    const row = findRowButton(node, "User Updated")!;
    await click(row);

    expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining("user-updated"));
  });

  it("falls back to the empty state when there are no skills", async () => {
    mockCompanySkillsApi.list.mockResolvedValue([]);

    const node = await renderStudio();

    await waitFor(() => expect(node.textContent).toContain("Select a skill to open Studio."));
    expect(node.textContent).toContain("Create a new skill");
    expect(node.textContent).not.toContain("Recently updated");
  });

  it("shows the loading fallback while skills load", async () => {
    mockCompanySkillsApi.list.mockReturnValue(new Promise(() => {}));

    const node = await renderStudio();

    await waitFor(() => expect(node.textContent).toContain("Loading skills..."));
  });
});

describe("SkillStudio editor frontmatter", () => {
  beforeEach(() => {
    routeState.pathname = "/skills/studio/source-skill";
    routeState.search = "";
    routeState.skillId = "source-skill";
  });

  it("does not show the frontmatter section when the selected markdown file has no frontmatter", async () => {
    mockCompanySkillsApi.file.mockResolvedValueOnce({
      path: "SKILL.md",
      content: "# Demo Skill\n\nNo YAML block here.\n",
      markdown: true,
      editable: true,
      editableReason: null,
    });

    const node = await renderStudio();

    await waitFor(() => {
      expect(mockCompanySkillsApi.file).toHaveBeenCalledWith("company-1", "source-skill", "SKILL.md");
    });
    await waitFor(() => {
      const textareas = Array.from(node.querySelectorAll("textarea"));
      expect(textareas.some((textarea) => textarea.value.includes("No YAML block here."))).toBe(true);
    });

    expect(node.querySelector('[data-testid="frontmatter-panel"]')).toBeNull();
    expect(node.textContent).not.toContain("Add frontmatter");
  });

  it("shows existing frontmatter collapsed by default", async () => {
    const node = await renderStudio();

    await waitFor(() => {
      expect(node.querySelector('[data-testid="frontmatter-panel"]')).toBeTruthy();
    });

    const toggle = node.querySelector<HTMLButtonElement>('button[aria-controls="frontmatter-panel-body"]');
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(node.querySelector("#fm-name")).toBeNull();
  });

  it("marks rich markdown body edits dirty and saves the edited markdown", async () => {
    mockCompanySkillsApi.updateFile.mockImplementationOnce((
      _companyId: string,
      _skillId: string,
      path: string,
      content: string,
    ) => Promise.resolve({
      path,
      content,
      markdown: true,
      editable: true,
      editableReason: null,
    }));

    const node = await renderStudio();

    let bodyEditor: HTMLTextAreaElement | undefined;
    await waitFor(() => {
      bodyEditor = Array.from(node.querySelectorAll<HTMLTextAreaElement>('[data-testid="markdown-editor"]')).find(
        (editor) => editor.value.includes("# Demo Skill"),
      );
      expect(bodyEditor).toBeTruthy();
    });

    await keyDown(bodyEditor as HTMLElement, "E");

    await waitFor(() => expect(node.textContent).toContain("Unsaved"));

    const saveButton = buttonsNamed(node, "Save").find((button) => !button.disabled);
    expect(saveButton).toBeTruthy();
    await click(saveButton as HTMLButtonElement);

    await waitFor(() => {
      expect(mockCompanySkillsApi.updateFile).toHaveBeenCalledWith(
        "company-1",
        "source-skill",
        "SKILL.md",
        expect.stringContaining("Edited body"),
      );
    });
    expect(mockCompanySkillsApi.updateFile).toHaveBeenCalledWith(
      "company-1",
      "source-skill",
      "SKILL.md",
      expect.stringContaining("---\nname: Demo Skill"),
    );
  });

  it("offers a 'Make a copy' CTA on the read-only banner (PAP-13112)", async () => {
    mockCompanySkillsApi.detail.mockResolvedValueOnce(makeSkill({
      editable: false,
      editableReason: "Bundled skill.",
    }));

    const node = await renderStudio();

    await waitFor(() => expect(node.textContent).toContain("Bundled skill."));

    // The dead-end "Fork" text link is replaced by a primary "Make a copy"
    // button that opens the fork-confirm dialog (agent-switch flow).
    const editCopy = Array.from(node.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Make a copy",
    );
    expect(editCopy).toBeTruthy();
    const staleForkLink = Array.from(node.querySelectorAll("a")).find((link) =>
      link.getAttribute("href")?.includes("/skills/studio/new?forkFrom"),
    );
    expect(staleForkLink).toBeUndefined();
  });
});

/**
 * The version sheet is modal, so it hides toasts from screen readers and a
 * click on one closes it. A restore says what happened inside the sheet.
 */
describe("SkillStudio version history", () => {
  const OLD_VERSION = {
    id: "version-2",
    revisionNumber: 2,
    label: null,
    createdAt: new Date("2026-01-03T00:00:00Z"),
    fileInventory: [{ path: "SKILL.md", content: "# Old Demo Skill\n", encoding: "utf8", executable: false }],
  };

  beforeEach(() => {
    routeState.pathname = "/skills/studio/source-skill";
    routeState.search = "";
    routeState.skillId = "source-skill";
    mockCompanySkillsApi.versions.mockResolvedValue([OLD_VERSION]);
  });

  /** Opens the sheet and returns its Restore button and its status line. */
  async function openSheet(node: HTMLElement) {
    let historyButton: HTMLButtonElement | undefined;
    await waitFor(() => {
      historyButton = buttonsNamed(node, "Version history")[0];
      expect(historyButton).toBeTruthy();
    });
    await click(historyButton as HTMLButtonElement);

    let restoreButton: HTMLButtonElement | undefined;
    await waitFor(() => {
      restoreButton = buttonsNamed(document.body, "Restore as v3")[0];
      expect(restoreButton).toBeTruthy();
    });
    const status = document.querySelector('[role="dialog"] [role="status"]') as HTMLElement | null;
    expect(status, "the status line is in the sheet").not.toBeNull();
    return { restoreButton: restoreButton as HTMLButtonElement, status: status as HTMLElement };
  }

  /** Opens the sheet and returns its status line, taken before any restore. */
  async function openVersionHistory(node: HTMLElement) {
    const opened = await openSheet(node);
    expect(opened.status.textContent, "the status line is empty before any restore").toBe("");
    return opened;
  }

  it("says inside the sheet which version a restore made", async () => {
    mockCompanySkillsApi.createVersion.mockResolvedValueOnce({ id: "version-3", revisionNumber: 3 });
    const node = await renderStudio();
    const { restoreButton, status } = await openVersionHistory(node);

    await click(restoreButton);

    await waitFor(() => expect(status.textContent).toBe("Restored as v3."));
    expect(mockCompanySkillsApi.updateFile).toHaveBeenCalledWith(
      "company-1",
      "source-skill",
      "SKILL.md",
      "# Old Demo Skill\n",
      { encoding: "utf8", executable: false },
    );
  });

  it("says inside the sheet why a restore failed, where it used to say nothing", async () => {
    mockCompanySkillsApi.updateFile.mockRejectedValueOnce(new Error("The skill folder is read only."));
    const node = await renderStudio();
    const { restoreButton, status } = await openVersionHistory(node);

    await click(restoreButton);

    await waitFor(() =>
      expect(status.textContent).toBe("Couldn't restore version. The skill folder is read only."),
    );
    expect(mockCompanySkillsApi.createVersion).not.toHaveBeenCalled();
  });

  function sheetCloseButton(sheet: HTMLElement) {
    return buttonsNamed(sheet, "Close")[0] ?? null;
  }

  it("keeps the sheet open while a restore runs, and says what it is doing", async () => {
    const written = deferred<never>();
    mockCompanySkillsApi.updateFile.mockReturnValueOnce(written.promise);
    const node = await renderStudio();
    const { restoreButton, status } = await openVersionHistory(node);
    const sheet = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(sheetCloseButton(sheet), "the sheet has its close button before the restore").not.toBeNull();

    await click(restoreButton);

    // Closed mid-restore, the result landed while the sheet was closed, and a
    // failure turned up stale the next time it opened.
    await waitFor(() => expect(status.textContent).toBe("Restoring v2…"));
    expect(sheetCloseButton(sheet)).toBeNull();
    await keyDown(sheet, "Escape");
    expect(document.querySelector('[role="dialog"]')).toBe(sheet);

    await act(async () => {
      written.reject(new Error("The skill folder is read only."));
    });
    await waitFor(() =>
      expect(status.textContent).toBe("Couldn't restore version. The skill folder is read only."),
    );
  });

  it("keeps the sheet open while a restore waits for a connection", async () => {
    // A restore sent while the browser says it is offline waits for a
    // connection. The sheet used to let go of it then, and closed and opened
    // again, it could start a second restore alongside the first.
    mockCompanySkillsApi.createVersion.mockResolvedValueOnce({ id: "version-3", revisionNumber: 3 });
    const node = await renderStudio();
    const { restoreButton, status } = await openVersionHistory(node);
    const sheet = document.querySelector('[role="dialog"]') as HTMLElement;
    onlineManager.setOnline(false);

    await click(restoreButton);

    await waitFor(() => expect(status.textContent).toBe("Restoring v2…"));
    expect(sheetCloseButton(sheet)).toBeNull();
    await keyDown(sheet, "Escape");
    expect(document.querySelector('[role="dialog"]')).toBe(sheet);
    expect(mockCompanySkillsApi.updateFile).not.toHaveBeenCalled();

    // Back online, the restore goes out, and the sheet says how it went.
    await act(async () => {
      onlineManager.setOnline(true);
    });
    await waitFor(() => expect(status.textContent).toBe("Restored as v3."));
  });

  /*
   * The sheet stays open while its restore runs, but the page can still be
   * left (browser Back), and the restore carries on without it.
   */

  it("says in a message why a restore failed once the page was left while it ran", async () => {
    const written = deferred<never>();
    mockCompanySkillsApi.updateFile.mockReturnValueOnce(written.promise);
    const node = await renderStudio({ toasts: true });
    const { restoreButton } = await openVersionHistory(node);
    await click(restoreButton);
    await waitFor(() => expect(mockCompanySkillsApi.updateFile).toHaveBeenCalledTimes(1));

    await leaveStudio();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => {
      written.reject(new Error("The skill folder is read only."));
    });

    const region = messageRegion(node);
    await waitFor(() => expect(region.textContent).toContain("Couldn't restore version"));
    expect(region.textContent).toContain("The skill folder is read only.");
    expect(mockCompanySkillsApi.createVersion).not.toHaveBeenCalled();
  });

  it("keeps Restore off, and says why, on coming back to the page while an earlier restore still runs", async () => {
    // The first file of the version is still being written back.
    const written = deferred<unknown>();
    mockCompanySkillsApi.updateFile.mockReturnValueOnce(written.promise);
    const node = await renderStudio();
    const { restoreButton } = await openVersionHistory(node);
    await click(restoreButton);
    await waitFor(() => expect(mockCompanySkillsApi.updateFile).toHaveBeenCalledTimes(1));

    // Browser Back, then Forward: the studio is drawn again from nothing.
    await leaveStudio();
    await returnToStudio();
    const { restoreButton: again, status } = await openSheet(node);

    // A second restore alongside the first wrote files from two versions
    // into the one skill.
    expect(again.disabled).toBe(true);
    expect(status.textContent).toBe("An earlier restore is still running. Restore is off until it finishes.");
    await click(again);
    expect(mockCompanySkillsApi.updateFile).toHaveBeenCalledTimes(1);

    // Once the first is done, Restore is back on.
    await act(async () => {
      written.resolve({});
    });
    await waitFor(() => expect(buttonsNamed(document.body, "Restore as v3")[0]?.disabled).toBe(false));
    expect(status.textContent).toBe("");
    expect(mockCompanySkillsApi.createVersion).toHaveBeenCalledTimes(1);
  });
});

/**
 * Each of these dialogs is modal and stays open when its save fails. A toast
 * behind a modal dialog is hidden from screen readers, and clicking it closes
 * the dialog, so the reason is said inside the dialog, in a status line that
 * is there before anything goes wrong.
 */
describe("SkillStudio dialogs, a failed save", () => {
  beforeEach(() => {
    routeState.pathname = "/skills/studio/source-skill";
    routeState.search = "";
    routeState.skillId = "source-skill";
  });

  function openDialog() {
    return document.querySelector('[role="dialog"]') as HTMLElement | null;
  }

  async function clickLabelled(node: ParentNode, label: string) {
    let button: HTMLButtonElement | null = null;
    await waitFor(() => {
      button = node.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
      expect(button).toBeTruthy();
      expect(button!.disabled).toBe(false);
    });
    await click(button!);
  }

  /** The dialog's status line, taken before the save, then the dialog's text after it fails. */
  async function saveAndFail(saveLabel: string) {
    const dialog = openDialog()!;
    const statusBefore = dialog.querySelector('[role="status"]');
    await click(buttonsNamed(dialog, saveLabel)[0] as HTMLButtonElement);
    return { dialog, statusBefore };
  }

  function expectSaidInStatusLine(dialog: HTMLElement, statusBefore: Element | null, text: string) {
    expect(statusBefore, "the status line is in the dialog before the save").not.toBeNull();
    expect(statusBefore!.textContent).toBe(text);
    expect(openDialog()).toBe(dialog);
  }

  /**
   * The empty status line takes no room. It used to be the last item of a
   * space-y group, which gave the field above it a bottom margin, so every
   * one of these dialogs had a band of empty space above its buttons.
   */
  function expectNoRoomTakenWhileEmpty() {
    const status = openDialog()?.querySelector('[role="status"]') ?? null;
    expect(status, "the status line is in the dialog").not.toBeNull();
    expect(status!.textContent).toBe("");
    expect(status!.parentElement?.className ?? "").not.toMatch(/\bspace-y-/);
    expect(status!.className).not.toMatch(/\bm[ty]?-/);
  }

  async function openSaveInputDialog(node: HTMLElement) {
    await click(buttonsNamed(node, "Save as input")[0] as HTMLButtonElement);
    await waitFor(() => expect(document.querySelector("#input-name")).toBeTruthy());
  }

  /** Types a test input into the paste box and opens Save test input for it. */
  async function startSavingInput(node: HTMLElement) {
    // The paste box is there before the saved inputs have loaded, and what is
    // typed before the pane switches to a new input is dropped, which left
    // Save as input off. Whether that happened depended on how quickly the
    // inputs loaded, so wait for the pane to say it is on a new input.
    await waitFor(() => expect(node.textContent).toContain("New input"));
    let pasteBox: HTMLTextAreaElement | null = null;
    await waitFor(() => {
      pasteBox = node.querySelector<HTMLTextAreaElement>('textarea[aria-label="Skill test input"]');
      expect(pasteBox).toBeTruthy();
    });
    await inputValue(pasteBox!, "The printer is jammed again.");
    await openSaveInputDialog(node);
    await inputValue(document.querySelector("#input-name") as HTMLInputElement, "printer/jammed");
  }

  /** Opens Advanced, then a new run template, and fills it in. */
  async function startNewRunTemplate(node: HTMLElement) {
    let advanced: HTMLButtonElement | undefined;
    await waitFor(() => {
      advanced = Array.from(node.querySelectorAll("button")).find((button) =>
        button.textContent?.trim().startsWith("Advanced"),
      );
      expect(advanced).toBeTruthy();
    });
    await click(advanced!);
    await clickLabelled(node, "Create run template");
    await waitFor(() => expect(document.querySelector("#run-template-name")).toBeTruthy());
    await inputValue(document.querySelector("#run-template-name") as HTMLInputElement, "Smoke check");
    await inputValue(document.querySelector("#run-template-body") as HTMLTextAreaElement, "Run {{skillName}} once.");
  }

  const SKILL_WITH_FOLDER = {
    fileInventory: [
      { path: "SKILL.md", kind: "skill" },
      { path: "references/examples.md", kind: "reference" },
    ],
  } as Partial<CompanySkillDetail>;

  it("says why a test input could not be saved", async () => {
    mockCompanySkillsApi.createTestInput.mockRejectedValueOnce(new Error("An input with that name already exists."));
    const node = await renderStudio();
    await startSavingInput(node);
    expectNoRoomTakenWhileEmpty();

    const { dialog, statusBefore } = await saveAndFail("Save");

    await waitFor(() => expect(dialog.textContent).toContain("An input with that name already exists."));
    expectSaidInStatusLine(dialog, statusBefore, "Couldn't save input. An input with that name already exists.");
    expect((document.querySelector("#input-name") as HTMLInputElement).value).toBe("printer/jammed");
  });

  it("says why a file could not be added", async () => {
    mockCompanySkillsApi.updateFile.mockRejectedValueOnce(new Error("The skill folder is read only."));
    const node = await renderStudio();
    await clickLabelled(node, "Add file");
    await waitFor(() => expect(document.querySelector("#skill-path-input")).toBeTruthy());
    expectNoRoomTakenWhileEmpty();

    const { dialog, statusBefore } = await saveAndFail("Create");

    await waitFor(() => expect(dialog.textContent).toContain("The skill folder is read only."));
    expectSaidInStatusLine(dialog, statusBefore, "Couldn't create file. The skill folder is read only.");
  });

  it("says why a folder could not be deleted", async () => {
    mockCompanySkillsApi.detail.mockResolvedValue(makeSkill(SKILL_WITH_FOLDER));
    mockCompanySkillsApi.deleteFile.mockRejectedValueOnce(new Error("A run is still using these files."));
    const node = await renderStudio();
    await clickLabelled(node, "Delete folder");
    await waitFor(() => expect(document.querySelector("#skill-folder-delete")).toBeTruthy());
    await inputValue(document.querySelector("#skill-folder-delete") as HTMLInputElement, "references");
    expectNoRoomTakenWhileEmpty();

    const { dialog, statusBefore } = await saveAndFail("Delete");

    await waitFor(() => expect(dialog.textContent).toContain("A run is still using these files."));
    expect(mockCompanySkillsApi.deleteFile).toHaveBeenCalledWith("company-1", "source-skill", {
      path: "references",
      target: "folder",
    });
    expectSaidInStatusLine(dialog, statusBefore, "Couldn't delete folder. A run is still using these files.");
  });

  it("says why a run template could not be saved", async () => {
    mockCompanySkillsApi.createTestRunTemplate.mockRejectedValueOnce(
      new Error("A template with that name already exists."),
    );
    const node = await renderStudio();
    await startNewRunTemplate(node);
    expectNoRoomTakenWhileEmpty();

    const { dialog, statusBefore } = await saveAndFail("Save template");

    await waitFor(() => expect(dialog.textContent).toContain("A template with that name already exists."));
    expectSaidInStatusLine(dialog, statusBefore, "Couldn't save template. A template with that name already exists.");
  });

  /**
   * While its request runs, none of the dialog's ways out closes it: Cancel is
   * off, the corner close button is gone, and Escape does nothing. A dialog
   * closed mid-request kept the failure for a dialog nobody could see.
   *
   * It says what it is doing meanwhile, on its button and in its status line.
   * The button used to keep its label and the line stayed empty, so a keyboard
   * or screen reader user whose Escape and Cancel did nothing was told nothing.
   */
  async function expectHeldOpen(
    dialog: HTMLElement,
    { progress, busyLabel }: { progress: string; busyLabel: string },
  ) {
    // The request is under way once Cancel goes off.
    await waitFor(() => expect(buttonsNamed(dialog, "Cancel")[0]?.disabled).toBe(true));
    expect(dialog.querySelector('[data-slot="dialog-close"]')).toBeNull();
    expect(statusText(dialog)).toBe(progress);
    expect(buttonsNamed(dialog, busyLabel)).toHaveLength(1);
    await keyDown(dialog, "Escape");
    expect(openDialog()).toBe(dialog);
  }

  function statusText(dialog: Element) {
    return dialog.querySelector('[role="status"]')?.textContent;
  }

  /** Cancels the dialog, opens it again with openAgain, and returns the status line's text. */
  async function closeAndReopen(dialog: HTMLElement, openAgain: () => Promise<void>) {
    await click(buttonsNamed(dialog, "Cancel")[0] as HTMLButtonElement);
    await waitFor(() => expect(openDialog()).toBeNull());
    await openAgain();
    await waitFor(() => expect(openDialog()).toBeTruthy());
    return statusText(openDialog()!);
  }

  it("keeps Add folder open while the folder is made, and says it was a folder that failed", async () => {
    const made = deferred<never>();
    mockCompanySkillsApi.updateFile.mockReturnValueOnce(made.promise);
    const node = await renderStudio();
    await clickLabelled(node, "Add folder");
    await waitFor(() => expect(document.querySelector("#skill-path-input")).toBeTruthy());
    const dialog = openDialog()!;

    await click(buttonsNamed(dialog, "Create")[0] as HTMLButtonElement);
    await expectHeldOpen(dialog, { progress: "Creating the folder…", busyLabel: "Creating…" });
    await act(async () => {
      made.reject(new Error("The skill folder is read only."));
    });

    await waitFor(() => expect(statusText(dialog)).toBe("Couldn't create folder. The skill folder is read only."));
    // That reason was about that try, so the dialog opens again without it.
    expect(await closeAndReopen(dialog, () => clickLabelled(node, "Add folder"))).toBe("");
  });

  it("keeps Delete folder open while the folder is deleted, and says why it could not be", async () => {
    mockCompanySkillsApi.detail.mockResolvedValue(makeSkill(SKILL_WITH_FOLDER));
    const deleted = deferred<never>();
    mockCompanySkillsApi.deleteFile.mockReturnValueOnce(deleted.promise);
    const node = await renderStudio();
    await clickLabelled(node, "Delete folder");
    await waitFor(() => expect(document.querySelector("#skill-folder-delete")).toBeTruthy());
    await inputValue(document.querySelector("#skill-folder-delete") as HTMLInputElement, "references");
    const dialog = openDialog()!;

    await click(buttonsNamed(dialog, "Delete")[0] as HTMLButtonElement);
    await expectHeldOpen(dialog, { progress: "Deleting the folder…", busyLabel: "Deleting…" });
    await act(async () => {
      deleted.reject(new Error("A run is still using these files."));
    });

    await waitFor(() => expect(statusText(dialog)).toBe("Couldn't delete folder. A run is still using these files."));
    expect(await closeAndReopen(dialog, () => clickLabelled(node, "Delete folder"))).toBe("");
  });

  it("keeps Save test input open while the input is saved, and says why it could not be", async () => {
    const saved = deferred<never>();
    mockCompanySkillsApi.createTestInput.mockReturnValueOnce(saved.promise);
    const node = await renderStudio();
    await startSavingInput(node);
    const dialog = openDialog()!;

    await click(buttonsNamed(dialog, "Save")[0] as HTMLButtonElement);
    await expectHeldOpen(dialog, { progress: "Saving the input…", busyLabel: "Saving…" });
    await act(async () => {
      saved.reject(new Error("An input with that name already exists."));
    });

    await waitFor(() => expect(statusText(dialog)).toBe("Couldn't save input. An input with that name already exists."));
    expect(await closeAndReopen(dialog, () => openSaveInputDialog(node))).toBe("");
  });

  it("keeps the run template dialog open while the template is saved, and says why it could not be", async () => {
    const saved = deferred<never>();
    mockCompanySkillsApi.createTestRunTemplate.mockReturnValueOnce(saved.promise);
    const node = await renderStudio();
    await startNewRunTemplate(node);
    const dialog = openDialog()!;

    await click(buttonsNamed(dialog, "Save template")[0] as HTMLButtonElement);
    await expectHeldOpen(dialog, { progress: "Saving the template…", busyLabel: "Saving..." });
    await act(async () => {
      saved.reject(new Error("A template with that name already exists."));
    });

    await waitFor(() =>
      expect(statusText(dialog)).toBe("Couldn't save template. A template with that name already exists."),
    );
    expect(await closeAndReopen(dialog, () => clickLabelled(node, "Create run template"))).toBe("");
  });

  /*
   * A dialog stays open until its request is done, but the pane or page
   * holding it can still go first: the panes are built again when the window
   * crosses the width where they turn into tabs, and browser Back leaves the
   * page. The request carries on, and a failure is said in a message, which
   * nothing hides once no dialog is open. A save that works changes nothing
   * the person has moved on to.
   */

  it("says in a message why a file could not be made when the panes are rebuilt while it is made", async () => {
    const made = deferred<never>();
    mockCompanySkillsApi.updateFile.mockReturnValueOnce(made.promise);
    const node = await renderStudio({ toasts: true });
    await clickLabelled(node, "Add file");
    await waitFor(() => expect(document.querySelector("#skill-path-input")).toBeTruthy());
    await click(buttonsNamed(openDialog()!, "Create")[0] as HTMLButtonElement);
    await waitFor(() => expect(mockCompanySkillsApi.updateFile).toHaveBeenCalled());

    // The window narrows past the width where the panes turn into tabs. That
    // builds the panes again, and the dialog goes with the old ones.
    await setWindowWidth(800);
    await waitFor(() => expect(openDialog()).toBeNull());

    await act(async () => {
      made.reject(new Error("The skill folder is read only."));
    });

    // It used to be kept for the dialog that had gone, and never seen.
    const region = messageRegion(node);
    await waitFor(() => expect(region.textContent).toContain("Couldn't create file"));
    expect(region.textContent).toContain("The skill folder is read only.");
  });

  it("says in a message why a run template could not be saved when the page is left while it is saved", async () => {
    const saved = deferred<never>();
    mockCompanySkillsApi.createTestRunTemplate.mockReturnValueOnce(saved.promise);
    const node = await renderStudio({ toasts: true });
    await startNewRunTemplate(node);
    await click(buttonsNamed(openDialog()!, "Save template")[0] as HTMLButtonElement);
    await waitFor(() => expect(mockCompanySkillsApi.createTestRunTemplate).toHaveBeenCalled());

    // Browser Back: the studio goes, and the dialog with it.
    await leaveStudio();
    expect(openDialog()).toBeNull();

    await act(async () => {
      saved.reject(new Error("A template with that name already exists."));
    });

    const region = messageRegion(node);
    await waitFor(() => expect(region.textContent).toContain("Couldn't save template"));
    expect(region.textContent).toContain("A template with that name already exists.");
  });

  it("leaves the picked run template and the company's default alone when a template is saved after the page was left", async () => {
    // The company's default run template is kept in the browser between
    // visits. Here the person runs with no template.
    const defaultKey = "skillStudio.runTemplate.company-1";
    localStorage.setItem(defaultKey, NO_TEST_RUN_TEMPLATE_STORAGE_VALUE);
    try {
      const SAVED = {
        id: "template-2",
        companyId: "company-1",
        name: "Smoke check",
        description: null,
        body: "Run {{skillName}} once.",
        builtIn: false,
      };
      const saved = deferred<typeof SAVED>();
      mockCompanySkillsApi.createTestRunTemplate.mockReturnValueOnce(saved.promise);
      const node = await renderStudio({ toasts: true });
      await startNewRunTemplate(node);
      await click(buttonsNamed(openDialog()!, "Save template")[0] as HTMLButtonElement);
      await waitFor(() => expect(mockCompanySkillsApi.createTestRunTemplate).toHaveBeenCalled());

      // Browser Back, and the template is saved after that.
      await leaveStudio();
      mockCompanySkillsApi.testRunTemplates.mockResolvedValue([SAVED]);
      await act(async () => {
        saved.resolve(SAVED);
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      // It used to pick the new template and make it the company's default,
      // over what the person had moved on to.
      expect(localStorage.getItem(defaultKey)).toBe(NO_TEST_RUN_TEMPLATE_STORAGE_VALUE);
      expect(messageRegion(node).textContent).not.toContain("Template saved");

      // Back on the page, the template is there to pick, and not picked.
      await returnToStudio();
      await waitFor(() => {
        const advanced = Array.from(node.querySelectorAll("button")).find((button) =>
          button.textContent?.trim().startsWith("Advanced"),
        );
        expect(advanced?.textContent).toContain("No template");
      });
    } finally {
      localStorage.removeItem(defaultKey);
    }
  });
});

/**
 * A run's interaction cards are drawn from the full interactions, which stop
 * refreshing once nothing is left to answer. An answered card has to show the
 * answer straight away, and a failed answer has to say why.
 */
describe("SkillStudio run interactions", () => {
  const CREATED = new Date("2026-10-01T00:00:00Z");
  const PENDING = {
    id: "interaction-1",
    companyId: "company-1",
    issueId: "issue-1",
    kind: "request_confirmation",
    status: "pending",
    continuationPolicy: "none",
    title: "Publish the summary?",
    summary: null,
    createdByAgentId: "agent-1",
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    payload: { version: 1, prompt: "Publish the weekly summary now?" },
    result: null,
    resolvedAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
  };
  const ACCEPTED = {
    ...PENDING,
    status: "accepted",
    result: { version: 1, outcome: "accepted" },
    resolvedByUserId: "user-1",
    resolvedAt: CREATED,
  };
  const QUESTIONS = {
    ...PENDING,
    id: "interaction-2",
    kind: "ask_user_questions",
    title: "Which summary goes out?",
    payload: {
      version: 1,
      questions: [
        {
          id: "question-1",
          prompt: "Which summary should go out?",
          selectionMode: "single",
          required: true,
          options: [
            { id: "weekly", label: "Weekly" },
            { id: "monthly", label: "Monthly" },
          ],
        },
      ],
    },
  };
  const INTERACTIONS_KEY = ["skill-studio", "interactions", "issue-1"];

  type PendingInteraction = { id: string; kind: string; title: string };

  /**
   * Stands in for the run view: answering reloads the run, and the reloaded
   * run lists the interaction as no longer pending.
   */
  function Harness({ interaction, onAnswered }: { interaction: PendingInteraction; onAnswered: () => void }) {
    const [status, setStatus] = useState("pending");
    const detail = {
      harnessIssue: { id: "issue-1", identifier: null, title: "Skill test", status: "in_progress", hiddenAt: null },
      interactions: [
        { id: interaction.id, kind: interaction.kind, status, title: interaction.title, createdAt: CREATED, updatedAt: CREATED },
      ],
    } as unknown as CompanySkillTestRunDetail;
    return (
      <InteractionSection
        companyId="company-1"
        detail={detail}
        agents={[]}
        onAnswered={() => {
          onAnswered();
          setStatus("accepted");
        }}
      />
    );
  }

  /** Renders the run's interactions with this one unanswered, and waits for its card's button. */
  async function renderInteractions(interaction: PendingInteraction = PENDING, cardButton = "Confirm") {
    mockIssuesApi.listInteractions.mockResolvedValue([interaction]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const onAnswered = vi.fn();
    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <TooltipProvider>
              <Harness interaction={interaction} onAnswered={onAnswered} />
            </TooltipProvider>
            <ToastViewport />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await waitFor(() => expect(buttonsNamed(container!, cardButton)).toHaveLength(1));
    const region = container!.querySelector('aside[aria-live="polite"]') as HTMLElement;
    expect(region, "the live region is on the page before the answer").not.toBeNull();
    return { node: container!, region, onAnswered, queryClient };
  }

  it("shows the answer on the card as soon as the server takes it", async () => {
    mockIssuesApi.acceptInteraction.mockResolvedValueOnce(ACCEPTED);
    const { node, onAnswered } = await renderInteractions();
    // Every load after the first never finishes, so the answer can only show
    // by going straight onto the card. Counting loads instead failed whenever
    // the two second refresh, timed from when the card appeared, fell between
    // the count and the answer. A refresh that lands after the answer is the
    // next test's.
    mockIssuesApi.listInteractions.mockReturnValue(new Promise(() => {}));

    await click(buttonsNamed(node, "Confirm")[0] as HTMLButtonElement);

    await waitFor(() => expect(onAnswered).toHaveBeenCalled());
    await waitFor(() => expect(node.textContent).toContain("Confirmed"));
    expect(buttonsNamed(node, "Confirm")).toHaveLength(0);
  });

  it("keeps the answer when a refresh that left before it comes back after it", async () => {
    mockIssuesApi.acceptInteraction.mockResolvedValueOnce(ACCEPTED);
    const { node, queryClient } = await renderInteractions();
    // A refresh is on its way when the answer goes, as one is every two
    // seconds while the card is unanswered. It left before the answer, so it
    // comes back with the card still unanswered.
    const refresh = deferred<unknown[]>();
    mockIssuesApi.listInteractions.mockReturnValueOnce(refresh.promise);
    void queryClient.refetchQueries({ queryKey: INTERACTIONS_KEY });
    await waitFor(() => expect(queryClient.isFetching({ queryKey: INTERACTIONS_KEY })).toBe(1));

    await click(buttonsNamed(node, "Confirm")[0] as HTMLButtonElement);
    await waitFor(() => expect(node.textContent).toContain("Confirmed"));

    await act(async () => {
      refresh.resolve([PENDING]);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Answered for good: refreshing has stopped, so a card put back to
    // unanswered here would stay that way.
    expect(node.textContent).toContain("Confirmed");
    expect(buttonsNamed(node, "Confirm")).toHaveLength(0);
  });

  it("says why an answer could not be sent", async () => {
    mockIssuesApi.acceptInteraction.mockRejectedValueOnce(new Error("The test task has already finished."));
    const { node, region, onAnswered } = await renderInteractions();

    await click(buttonsNamed(node, "Confirm")[0] as HTMLButtonElement);

    await waitFor(() => expect(region.textContent).toContain("Couldn't confirm"));
    expect(region.textContent).toContain("The test task has already finished.");
    expect(onAnswered).not.toHaveBeenCalled();
    // Still unanswered, so it can be tried again.
    expect(buttonsNamed(node, "Confirm")).toHaveLength(1);
  });

  it("says why answers could not be sent, without an uncaught error", async () => {
    mockIssuesApi.respondToInteraction.mockRejectedValueOnce(new Error("The test task has already finished."));
    const uncaught = vi.fn();
    process.on("unhandledRejection", uncaught);
    try {
      const { node, region, onAnswered } = await renderInteractions(QUESTIONS, "Submit answers");

      await click(buttonsNamed(node, "Weekly")[0] as HTMLButtonElement);
      await click(buttonsNamed(node, "Submit answers")[0] as HTMLButtonElement);

      await waitFor(() => expect(region.textContent).toContain("Couldn't send answers"));
      expect(region.textContent).toContain("The test task has already finished.");
      // An uncaught failure is reported once the current turn ends, so give
      // it that turn before checking there was none.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(uncaught).not.toHaveBeenCalled();
      expect(onAnswered).not.toHaveBeenCalled();
      // Still unanswered, so the answers can be sent again.
      await waitFor(() => expect(buttonsNamed(node, "Submit answers")[0]?.disabled).toBe(false));
    } finally {
      process.off("unhandledRejection", uncaught);
    }
  });
});
