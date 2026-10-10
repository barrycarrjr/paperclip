import { useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useOptionalToastActions } from "../context/ToastContext";
import { useDialogCompanyId } from "../hooks/useDialogCompany";
import { useDialogOpening } from "../hooks/useDialogOpening";
import { accessApi } from "../api/access";
import { projectsApi } from "../api/projects";
import { agentsApi } from "../api/agents";
import { goalsApi } from "../api/goals";
import { assetsApi } from "../api/assets";
import { buildMarkdownMentionOptions } from "../lib/company-members";
import { queryKeys } from "../lib/queryKeys";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Maximize2,
  Minimize2,
  Target,
  Calendar,
  Plus,
  X,
  HelpCircle,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PROJECT_COLORS } from "@paperclipai/shared";
import { cn } from "../lib/utils";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";
import { StatusBadge } from "./StatusBadge";
import { ChoosePathButton } from "./PathInstructionsModal";

const projectStatuses = [
  { value: "backlog", label: "Backlog" },
  { value: "planned", label: "Planned" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

/**
 * The project was made, but adding its workspace failed. Told apart from a
 * failure to make the project at all, so that a failure said after the dialog
 * has gone (when the dialog's own note of the project has gone with it) still
 * says the project exists.
 */
class WorkspaceNotAddedError extends Error {}

export function NewProjectDialog() {
  const { newProjectOpen, closeNewProject } = useDialog();
  const { companies, selectedCompanyId } = useCompany();
  // The company this project is being written in, held still while the dialog
  // is open so changing company does not file it somewhere else. See
  // hooks/useDialogCompany.ts.
  const companyId = useDialogCompanyId(newProjectOpen);
  const dialogCompany = companies.find((c) => c.id === companyId) ?? null;
  const movedCompanyWhileOpen =
    newProjectOpen && !!companyId && !!selectedCompanyId && companyId !== selectedCompanyId;
  const queryClient = useQueryClient();
  const toast = useOptionalToastActions();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("planned");
  const [goalIds, setGoalIds] = useState<string[]>([]);
  const [targetDate, setTargetDate] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [workspaceLocalPath, setWorkspaceLocalPath] = useState("");
  const [workspaceRepoUrl, setWorkspaceRepoUrl] = useState("");
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);

  const [statusOpen, setStatusOpen] = useState(false);
  const [goalOpen, setGoalOpen] = useState(false);
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);

  const { data: goals } = useQuery({
    queryKey: queryKeys.goals.list(companyId!),
    queryFn: () => goalsApi.list(companyId!),
    enabled: !!companyId && newProjectOpen,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId!),
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId && newProjectOpen,
  });

  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId!),
    queryFn: () => accessApi.listUserDirectory(companyId!),
    enabled: !!companyId && newProjectOpen,
  });

  const mentionOptions = useMemo<MentionOption[]>(() => {
    return buildMarkdownMentionOptions({
      agents,
      members: companyMembers?.users,
    });
  }, [agents, companyMembers?.users]);

  // The project this dialog has made so far. Adding its workspace can fail
  // after the project itself was made, and trying again then adds the
  // workspace to that project instead of making a second one.
  const [createdProject, setCreatedProject] = useState<{ id: string } | null>(null);

  // Which opening of the dialog a create was sent from (see
  // hooks/useDialogOpening.ts). The dialog stays open while a create runs,
  // but the layout holding it can go first (browser Back to a page outside
  // it), and the dialog can be opened again in the next one.
  const createOpening = useDialogOpening(newProjectOpen);

  // Both steps are one mutation, so Create stays disabled until the workspace
  // is added too. It used to come back on in between, and a second click made
  // a second project.
  const createProject = useMutation({
    mutationFn: async ({
      project,
      workspace,
    }: {
      project: Record<string, unknown>;
      workspace: Record<string, unknown> | null;
    }) => {
      const made = createdProject ?? (await projectsApi.create(companyId!, project));
      setCreatedProject(made);
      if (workspace) {
        await projectsApi.createWorkspace(made.id, workspace).catch((error: unknown) => {
          throw new WorkspaceNotAddedError(error instanceof Error ? error.message : "", { cause: error });
        });
      }
      return made;
    },
  });

  const uploadDescriptionImage = useMutation({
    mutationFn: async (file: File) => {
      if (!companyId) throw new Error("No company selected");
      return assetsApi.uploadImage(companyId, file, "projects/drafts");
    },
  });

  function reset() {
    setName("");
    setDescription("");
    setStatus("planned");
    setGoalIds([]);
    setTargetDate("");
    setExpanded(false);
    setWorkspaceLocalPath("");
    setWorkspaceRepoUrl("");
    setWorkspaceError(null);
    setCreatedProject(null);
    createProject.reset();
  }

  const isAbsolutePath = (value: string) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);

  const looksLikeRepoUrl = (value: string) => {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:") return false;
      const segments = parsed.pathname.split("/").filter(Boolean);
      return segments.length >= 2;
    } catch {
      return false;
    }
  };

  const deriveWorkspaceNameFromPath = (value: string) => {
    const normalized = value.trim().replace(/[\\/]+$/, "");
    const segments = normalized.split(/[\\/]/).filter(Boolean);
    return segments[segments.length - 1] ?? "Local folder";
  };

  const deriveWorkspaceNameFromRepo = (value: string) => {
    try {
      const parsed = new URL(value);
      const segments = parsed.pathname.split("/").filter(Boolean);
      const repo = segments[segments.length - 1]?.replace(/\.git$/i, "") ?? "";
      return repo || "GitHub repo";
    } catch {
      return "GitHub repo";
    }
  };

  async function handleSubmit() {
    // Ctrl+Enter reaches here even while Create is disabled.
    if (!companyId || !name.trim() || createProject.isPending) return;
    const localPath = workspaceLocalPath.trim();
    const repoUrl = workspaceRepoUrl.trim();

    if (localPath && !isAbsolutePath(localPath)) {
      setWorkspaceError("Local folder must be a full absolute path.");
      return;
    }
    if (repoUrl && !looksLikeRepoUrl(repoUrl)) {
      setWorkspaceError("Repo must use a valid GitHub or GitHub Enterprise repo URL.");
      return;
    }

    setWorkspaceError(null);

    const opening = createOpening.current();
    try {
      const created = await createProject.mutateAsync({
        project: {
          name: name.trim(),
          description: description.trim() || undefined,
          status,
          color: PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)],
          ...(goalIds.length > 0 ? { goalIds } : {}),
          ...(targetDate ? { targetDate } : {}),
        },
        workspace: localPath || repoUrl
          ? {
              name: localPath
                ? deriveWorkspaceNameFromPath(localPath)
                : deriveWorkspaceNameFromRepo(repoUrl),
              ...(localPath ? { cwd: localPath } : {}),
              ...(repoUrl ? { repoUrl } : {}),
            }
          : null,
      });

      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(created.id) });
      // Made after the dialog it came from had gone: a later opening is the
      // next project, and is not reset or closed by this one.
      if (!createOpening.isShowing(opening)) return;
      reset();
      closeNewProject();
    } catch (error) {
      // The dialog stays open with what was typed, and says what went wrong
      // (createFailure below). A project that was made before its workspace
      // failed belongs in the list already.
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(companyId) });
      // Once the dialog it came from has gone with the layout holding it, a
      // toast is the only place left to say it.
      if (!createOpening.isShowing(opening)) {
        toast?.pushToast({
          tone: "error",
          title: error instanceof WorkspaceNotAddedError
            ? "The project was created, but its workspace was not added"
            : "Could not create the project",
          body: error instanceof Error && error.message ? error.message : "Please try again.",
        });
      }
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  const selectedGoals = (goals ?? []).filter((g) => goalIds.includes(g.id));
  const availableGoals = (goals ?? []).filter((g) => !goalIds.includes(g.id));
  const createFailureReason =
    createProject.error instanceof Error && createProject.error.message
      ? createProject.error.message
      : "Please try again.";
  const createFailure = !createProject.isError
    ? null
    : createdProject
      ? `The project was created, but its workspace was not added. ${createFailureReason}`
      : `Could not create the project. ${createFailureReason}`;
  // Once the project exists, trying again only adds its workspace, so its own
  // fields are locked and the button says what it will do. Left open, an edit
  // to the name, description, status, goals or date was dropped without a word.
  const projectMade = createdProject !== null;
  const hasWorkspace = Boolean(workspaceLocalPath.trim() || workspaceRepoUrl.trim());
  const submitLabel = createProject.isPending
    ? projectMade ? "Adding workspace…" : "Creating…"
    : !projectMade
      ? "Create project"
      // With the workspace fields emptied, the button just finishes, leaving
      // the project without a workspace.
      : hasWorkspace ? "Add workspace" : "Done";
  // While the create holds the dialog open, Escape and the × do nothing, so
  // the dialog says what it is doing.
  const progress = createProject.isPending
    ? (projectMade ? "Adding the workspace…" : "Creating the project…")
    : null;

  return (
    <Dialog
      open={newProjectOpen}
      // Not modal: this dialog is built to stay open and keep the company you
      // started it in (see hooks/useDialogCompany.ts) while you switch
      // company on the rail behind it, so the rail has to stay clickable.
      modal={false}
      // Held open until the project is made or fails, however long that
      // takes, as NewIssueDialog is, so the dialog is never reset under a
      // create that is still running.
      onOpenChange={(open) => {
        if (!open && !createProject.isPending) {
          reset();
          closeNewProject();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        // Nothing here describes the dialog beyond its title, as in
        // NewIssueDialog. Without this the dialog library warns about it.
        aria-describedby={undefined}
        className={cn("p-0 gap-0", expanded ? "sm:max-w-2xl" : "sm:max-w-lg")}
        onKeyDown={handleKeyDown}
        // Radix still treats a click on the rail as an "outside" interaction
        // and closes the dialog for it by default, `modal={false}` only stops
        // it from being blocked. Without this the fix above lets the click
        // reach the rail and then the dialog closes anyway, losing whatever
        // was typed. Escape and the × button are untouched.
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        {/* The dialog's name for screen readers. Hidden, since the header
            below already shows "New project". Without a title the dialog had
            no name, and the dialog library warned about it. */}
        <DialogTitle className="sr-only">New project</DialogTitle>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {dialogCompany && (
              <span className="bg-muted px-1.5 py-0.5 rounded text-xs font-medium">
                {dialogCompany.name.slice(0, 3).toUpperCase()}
              </span>
            )}
            <span className="text-muted-foreground/60">&rsaquo;</span>
            <span>New project</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              aria-label={expanded ? "Make smaller" : "Make bigger"}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              aria-label="Close"
              onClick={() => { reset(); closeNewProject(); }}
              disabled={createProject.isPending}
            >
              <span className="text-lg leading-none">&times;</span>
            </Button>
          </div>
        </div>

        {/* You changed company with this form open. It keeps the company you
            started it in rather than quietly moving to the new one. */}
        {movedCompanyWhileOpen && dialogCompany && (
          <div className="px-4 pt-3 text-xs text-muted-foreground">
            This project will be saved in {dialogCompany.name}, where you started it.
          </div>
        )}

        {/* Name */}
        <div className="px-4 pt-4 pb-2 shrink-0">
          <input
            className="w-full text-lg font-semibold bg-transparent outline-none placeholder:text-muted-foreground/50"
            placeholder="Project name"
            value={name}
            readOnly={projectMade}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Tab" && !e.shiftKey) {
                e.preventDefault();
                descriptionEditorRef.current?.focus();
              }
            }}
            autoFocus
          />
        </div>

        {/* Description */}
        <div className="px-4 pb-2">
          <MarkdownEditor
            ref={descriptionEditorRef}
            value={description}
            onChange={setDescription}
            readOnly={projectMade}
            placeholder="Add description..."
            bordered={false}
            mentions={mentionOptions}
            contentClassName={cn("text-sm text-muted-foreground", expanded ? "min-h-[220px]" : "min-h-[120px]")}
            imageUploadHandler={async (file) => {
              const asset = await uploadDescriptionImage.mutateAsync(file);
              return asset.contentPath;
            }}
          />
        </div>

        <div className="px-4 pt-3 pb-3 space-y-3 border-t border-border">
          <div>
            <div className="mb-1 flex items-center gap-1.5">
              <label className="block text-xs text-muted-foreground">Repo URL</label>
              <span className="text-xs text-muted-foreground/50">optional</span>
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <HelpCircle className="h-3 w-3 text-muted-foreground/50 cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-[240px] text-xs">
                  Link a GitHub repository so agents can clone, read, and push code for this project.
                </TooltipContent>
              </Tooltip>
            </div>
            <input
              className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs outline-none"
              value={workspaceRepoUrl}
              onChange={(e) => { setWorkspaceRepoUrl(e.target.value); setWorkspaceError(null); }}
              placeholder="https://github.com/org/repo"
            />
          </div>

          <div>
            <div className="mb-1 flex items-center gap-1.5">
              <label className="block text-xs text-muted-foreground">Local folder</label>
              <span className="text-xs text-muted-foreground/50">optional</span>
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <HelpCircle className="h-3 w-3 text-muted-foreground/50 cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-[240px] text-xs">
                  Set an absolute path on this machine where local agents will read and write files for this project.
                </TooltipContent>
              </Tooltip>
            </div>
            <div className="flex items-center gap-2">
              <input
                className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                value={workspaceLocalPath}
                onChange={(e) => { setWorkspaceLocalPath(e.target.value); setWorkspaceError(null); }}
                placeholder="/absolute/path/to/workspace"
              />
              <ChoosePathButton />
            </div>
          </div>

          {workspaceError && (
            <p className="text-xs text-destructive">{workspaceError}</p>
          )}
        </div>

        {/* Property chips */}
        <div className="flex items-center gap-1.5 px-4 py-2 border-t border-border flex-wrap">
          {/* Status */}
          <Popover open={statusOpen} onOpenChange={setStatusOpen}>
            <PopoverTrigger asChild>
              <button
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors disabled:opacity-60"
                disabled={projectMade}
              >
                <StatusBadge status={status} />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-40 p-1" align="start">
              {projectStatuses.map((s) => (
                <button
                  key={s.value}
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                    s.value === status && "bg-accent"
                  )}
                  onClick={() => { setStatus(s.value); setStatusOpen(false); }}
                >
                  {s.label}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          {selectedGoals.map((goal) => (
            <span
              key={goal.id}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs"
            >
              <Target className="h-3 w-3 text-muted-foreground" />
              <span className="max-w-[160px] truncate">{goal.title}</span>
              <button
                className="text-muted-foreground hover:text-foreground disabled:opacity-60"
                onClick={() => setGoalIds((prev) => prev.filter((id) => id !== goal.id))}
                aria-label={`Remove goal ${goal.title}`}
                type="button"
                disabled={projectMade}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}

          <Popover open={goalOpen} onOpenChange={setGoalOpen}>
            <PopoverTrigger asChild>
              <button
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors disabled:opacity-60"
                disabled={projectMade || (selectedGoals.length > 0 && availableGoals.length === 0)}
              >
                {selectedGoals.length > 0 ? <Plus className="h-3 w-3 text-muted-foreground" /> : <Target className="h-3 w-3 text-muted-foreground" />}
                {selectedGoals.length > 0 ? "+ Goal" : "Goal"}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-1" align="start">
              {selectedGoals.length === 0 && (
                <button
                  className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-muted-foreground"
                  onClick={() => setGoalOpen(false)}
                >
                  No goal
                </button>
              )}
              {availableGoals.map((g) => (
                <button
                  key={g.id}
                  className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 truncate"
                  onClick={() => {
                    setGoalIds((prev) => [...prev, g.id]);
                    setGoalOpen(false);
                  }}
                >
                  {g.title}
                </button>
              ))}
              {selectedGoals.length > 0 && availableGoals.length === 0 && (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  All goals already selected.
                </div>
              )}
            </PopoverContent>
          </Popover>

          {/* Target date */}
          <div className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs">
            <Calendar className="h-3 w-3 text-muted-foreground" />
            <input
              type="date"
              className="bg-transparent outline-none text-xs w-24 disabled:opacity-60"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              placeholder="Target date"
              disabled={projectMade}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-border">
          {/* On the page even while empty, so a screen reader hears a failure
              when it appears, and how a create is getting on. It used to say
              only "Failed to create project." and nothing at all when the
              workspace step failed. */}
          <p role="status" className={cn("text-xs", progress ? "text-muted-foreground" : "text-destructive")}>
            {progress ?? createFailure}
          </p>
          <Button
            size="sm"
            disabled={!name.trim() || createProject.isPending}
            onClick={handleSubmit}
          >
            {/* {createProject.isPending ? "Creating…" : "Create project"} */}
            {submitLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
