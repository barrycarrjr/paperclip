import { useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { GOAL_STATUSES, GOAL_LEVELS } from "@paperclipai/shared";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useOptionalToastActions } from "../context/ToastContext";
import { useDialogCompanyId } from "../hooks/useDialogCompany";
import { useDialogOpening, type DialogOpening } from "../hooks/useDialogOpening";
import { goalsApi } from "../api/goals";
import { assetsApi } from "../api/assets";
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
  Layers,
} from "lucide-react";
import { cn } from "../lib/utils";
import { MarkdownEditor, type MarkdownEditorRef } from "./MarkdownEditor";
import { StatusBadge } from "./StatusBadge";

const levelLabels: Record<string, string> = {
  company: "Company",
  team: "Team",
  agent: "Agent",
  task: "Task",
};

export function NewGoalDialog() {
  const { newGoalOpen, newGoalDefaults, closeNewGoal } = useDialog();
  const { companies, selectedCompanyId } = useCompany();
  // The company this goal is being written in, held still while the dialog is
  // open so changing company does not file it somewhere else. See
  // hooks/useDialogCompany.ts.
  const companyId = useDialogCompanyId(newGoalOpen);
  const dialogCompany = companies.find((c) => c.id === companyId) ?? null;
  const movedCompanyWhileOpen =
    newGoalOpen && !!companyId && !!selectedCompanyId && companyId !== selectedCompanyId;
  const queryClient = useQueryClient();
  const toast = useOptionalToastActions();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("planned");
  const [level, setLevel] = useState("task");
  const [parentId, setParentId] = useState("");
  const [expanded, setExpanded] = useState(false);

  const [statusOpen, setStatusOpen] = useState(false);
  const [levelOpen, setLevelOpen] = useState(false);
  const [parentOpen, setParentOpen] = useState(false);
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);

  // Apply defaults when dialog opens
  const appliedParentId = parentId || newGoalDefaults.parentId || "";

  const { data: goals } = useQuery({
    queryKey: queryKeys.goals.list(companyId!),
    queryFn: () => goalsApi.list(companyId!),
    enabled: !!companyId && newGoalOpen,
  });

  // Which opening of the dialog a create was sent from (see
  // hooks/useDialogOpening.ts). The dialog stays open while a create runs,
  // but the layout holding it can go first (browser Back to a page outside
  // it), and the dialog can be opened again in the next one.
  const createOpening = useDialogOpening(newGoalOpen);

  const createGoal = useMutation({
    mutationFn: ({ goal }: { goal: Record<string, unknown>; opening: DialogOpening | null }) =>
      goalsApi.create(companyId!, goal),
    onSuccess: (_created, sent) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(companyId!) });
      // Made after the dialog it came from had gone: a later opening is the
      // next goal, and is not reset or closed by this one.
      if (!createOpening.isShowing(sent.opening)) return;
      reset();
      closeNewGoal();
    },
    // The dialog says a failure itself (createFailure below). Once the dialog
    // it came from has gone, a toast is the only place left to say it.
    onError: (error, sent) => {
      if (createOpening.isShowing(sent.opening)) return;
      toast?.pushToast({
        tone: "error",
        title: "Could not create the goal",
        body: error instanceof Error && error.message ? error.message : "Please try again.",
      });
    },
  });

  const uploadDescriptionImage = useMutation({
    mutationFn: async (file: File) => {
      if (!companyId) throw new Error("No company selected");
      return assetsApi.uploadImage(companyId, file, "goals/drafts");
    },
  });

  function reset() {
    setTitle("");
    setDescription("");
    setStatus("planned");
    setLevel("task");
    setParentId("");
    setExpanded(false);
    createGoal.reset();
  }

  function handleSubmit() {
    // Ctrl+Enter reaches here even while Create is disabled, and used to make
    // the goal a second time.
    if (!companyId || !title.trim() || createGoal.isPending) return;
    createGoal.mutate({
      goal: {
        title: title.trim(),
        description: description.trim() || undefined,
        status,
        level,
        ...(appliedParentId ? { parentId: appliedParentId } : {}),
      },
      opening: createOpening.current(),
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  const currentParent = (goals ?? []).find((g) => g.id === appliedParentId);
  // A failed create used to show nothing: the dialog stayed open as if the
  // click had not happened.
  const createFailure = createGoal.isError
    ? `Could not create the goal. ${
        createGoal.error instanceof Error && createGoal.error.message
          ? createGoal.error.message
          : "Please try again."
      }`
    : null;
  // While the create holds the dialog open, Escape and the × do nothing, so
  // the dialog says what it is doing.
  const progress = createGoal.isPending
    ? (newGoalDefaults.parentId ? "Creating the sub-goal…" : "Creating the goal…")
    : null;

  return (
    <Dialog
      open={newGoalOpen}
      // Not modal: this dialog is built to stay open and keep the company you
      // started it in (see hooks/useDialogCompany.ts and
      // movedCompanyWhileOpen above) while you switch company on the rail
      // behind it, so the rail has to stay clickable.
      modal={false}
      // Held open until the goal is made or fails, however long that takes,
      // as NewProjectDialog is. Closed mid-create, reset() cleared the
      // create, so a failure was shown nowhere, and a create that worked
      // could close the dialog after it had been opened again for the next
      // goal.
      onOpenChange={(open) => {
        if (!open && !createGoal.isPending) {
          reset();
          closeNewGoal();
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
            below already shows it. Without a title the dialog had no name,
            and the dialog library warned about it. */}
        <DialogTitle className="sr-only">{newGoalDefaults.parentId ? "New sub-goal" : "New goal"}</DialogTitle>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {dialogCompany && (
              <span className="bg-muted px-1.5 py-0.5 rounded text-xs font-medium">
                {dialogCompany.name.slice(0, 3).toUpperCase()}
              </span>
            )}
            <span className="text-muted-foreground/60">&rsaquo;</span>
            <span>{newGoalDefaults.parentId ? "New sub-goal" : "New goal"}</span>
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
              onClick={() => { reset(); closeNewGoal(); }}
              disabled={createGoal.isPending}
            >
              <span className="text-lg leading-none">&times;</span>
            </Button>
          </div>
        </div>

        {/* You changed company with this form open. It keeps the company you
            started it in rather than quietly moving to the new one. */}
        {movedCompanyWhileOpen && dialogCompany && (
          <div className="px-4 pt-3 text-xs text-muted-foreground">
            This goal will be saved in {dialogCompany.name}, where you started it.
          </div>
        )}

        {/* Title */}
        <div className="px-4 pt-4 pb-2 shrink-0">
          <input
            className="w-full text-lg font-semibold bg-transparent outline-none placeholder:text-muted-foreground/50"
            placeholder="Goal title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
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
        <div className="px-4 pb-2 overflow-y-auto max-h-[50vh]">
          <MarkdownEditor
            ref={descriptionEditorRef}
            value={description}
            onChange={setDescription}
            placeholder="Add description..."
            bordered={false}
            contentClassName={cn("text-sm text-muted-foreground", expanded ? "min-h-[220px]" : "min-h-[120px]")}
            imageUploadHandler={async (file) => {
              const asset = await uploadDescriptionImage.mutateAsync(file);
              return asset.contentPath;
            }}
          />
        </div>

        {/* Property chips */}
        <div className="flex items-center gap-1.5 px-4 py-2 border-t border-border flex-wrap">
          {/* Status */}
          <Popover open={statusOpen} onOpenChange={setStatusOpen}>
            <PopoverTrigger asChild>
              <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors">
                <StatusBadge status={status} />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-40 p-1" align="start">
              {GOAL_STATUSES.map((s) => (
                <button
                  key={s}
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 capitalize",
                    s === status && "bg-accent"
                  )}
                  onClick={() => { setStatus(s); setStatusOpen(false); }}
                >
                  {s}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          {/* Level */}
          <Popover open={levelOpen} onOpenChange={setLevelOpen}>
            <PopoverTrigger asChild>
              <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors">
                <Layers className="h-3 w-3 text-muted-foreground" />
                {levelLabels[level] ?? level}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-40 p-1" align="start">
              {GOAL_LEVELS.map((l) => (
                <button
                  key={l}
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                    l === level && "bg-accent"
                  )}
                  onClick={() => { setLevel(l); setLevelOpen(false); }}
                >
                  {levelLabels[l] ?? l}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          {/* Parent goal */}
          <Popover open={parentOpen} onOpenChange={setParentOpen}>
            <PopoverTrigger asChild>
              <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors">
                <Target className="h-3 w-3 text-muted-foreground" />
                {currentParent ? currentParent.title : "Parent goal"}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-48 p-1" align="start">
              <button
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                  !appliedParentId && "bg-accent"
                )}
                onClick={() => { setParentId(""); setParentOpen(false); }}
              >
                No parent
              </button>
              {(goals ?? []).map((g) => (
                <button
                  key={g.id}
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 truncate",
                    g.id === appliedParentId && "bg-accent"
                  )}
                  onClick={() => { setParentId(g.id); setParentOpen(false); }}
                >
                  {g.title}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-border">
          {/* On the page even while empty, so a screen reader hears a failure
              when it appears, and how a create is getting on. */}
          <p role="status" className={cn("text-xs", progress ? "text-muted-foreground" : "text-destructive")}>
            {progress ?? createFailure}
          </p>
          <Button
            size="sm"
            disabled={!title.trim() || createGoal.isPending}
            onClick={handleSubmit}
          >
            {createGoal.isPending ? "Creating…" : newGoalDefaults.parentId ? "Create sub-goal" : "Create goal"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
