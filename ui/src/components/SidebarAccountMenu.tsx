import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  BookOpen,
  Download,
  GitBranch,
  Hammer,
  LogOut,
  type LucideIcon,
  Map as MapIcon,
  Moon,
  Power,
  RefreshCw,
  Settings,
  Sun,
  UserRoundPen,
} from "lucide-react";
import type { DeploymentMode } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { authApi } from "@/api/auth";
import { systemApi } from "@/api/system";
import { queryKeys } from "@/lib/queryKeys";
import { useSidebar } from "../context/SidebarContext";
import { useTheme } from "../context/ThemeContext";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "../lib/utils";

const PROFILE_SETTINGS_PATH = "/instance/settings/profile";
const DOCS_URL = "https://docs.paperclip.ing/";

interface SidebarAccountMenuProps {
  deploymentMode?: DeploymentMode;
  instanceSettingsTarget: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  version?: string | null;
  commit?: string | null;
  /**
   * When true, the trigger row shows a clickable pill in place of the commit
   * hash, and the dropdown's matching icon gains a badge dot.
   */
  updateAvailable?: boolean;
  /**
   * Which gap the pill is offering to close.
   *
   * `remote_ahead` means there is something to pull, so the pill runs Update.
   * `build_behind` means what is checked out was never built, so pulling would
   * do nothing and the pill runs Rebuild instead. Defaults to a pull, which is
   * what the pill always did before the two cases were told apart.
   */
  updateReason?: "remote_ahead" | "build_behind" | null;
  /**
   * Which way round this copy and GitHub are.
   *
   * Only `behind` has anything to pull, and that arrives as `updateAvailable`
   * with a `remote_ahead` reason. The other answers are shown, never offered:
   * `ahead` means this copy is newer than GitHub, `diverged` means both sides
   * have changed so pulling would not be a simple move forward, and
   * `no_remote_branch` means GitHub has never seen this branch. `unknown` and
   * `level` say nothing on screen, because there is nothing true to say.
   */
  remoteRelation?:
    | "level"
    | "behind"
    | "ahead"
    | "diverged"
    | "no_remote_branch"
    | "unknown"
    | null;
  /** The branch this install tracks, named only when we actually know it. */
  trackedBranch?: string | null;
  /**
   * Whether this copy runs the working tree's own source rather than a build of
   * it. It is said, never offered: there is no build in the path, so a rebuild
   * has nothing to apply and no pill appears for it.
   */
  runningFromSource?: boolean;
}

interface MenuActionProps {
  label: string;
  description: string;
  icon: LucideIcon;
  onClick?: () => void;
  href?: string;
  external?: boolean;
}

function deriveInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function deriveUserSlug(name: string | null | undefined, email: string | null | undefined, id: string | null | undefined) {
  const candidates = [name, email?.split("@")[0], email, id];
  for (const candidate of candidates) {
    const slug = candidate
      ?.trim()
      .toLowerCase()
      .replace(/['"]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (slug) return slug;
  }
  return "me";
}

function MenuAction({ label, description, icon: Icon, onClick, href, external = false }: MenuActionProps) {
  const className =
    "flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-accent/60";

  const content = (
    <>
      <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </>
  );

  if (href) {
    if (external) {
      return (
        <a href={href} target="_blank" rel="noreferrer" className={className} onClick={onClick}>
          {content}
        </a>
      );
    }

    return (
      <Link to={href} className={className} onClick={onClick}>
        {content}
      </Link>
    );
  }

  return (
    <button type="button" className={className} onClick={onClick}>
      {content}
    </button>
  );
}

interface IconActionProps {
  label: string;
  description: string;
  icon: LucideIcon;
  onClick?: () => void;
  href?: string;
  external?: boolean;
  disabled?: boolean;
  // Tone controls the icon + hover tint. Neutral = muted-foreground / accent
  // hover; info/success/warning/danger pick up colored tints (sky/green/amber/red).
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
  /** Render a small dot on top-right of the icon — used to flag the action. */
  badge?: boolean;
}

function IconAction({
  label,
  description,
  icon: Icon,
  onClick,
  href,
  external = false,
  disabled = false,
  tone = "neutral",
  badge = false,
}: IconActionProps) {
  const toneClass =
    tone === "info"
      ? "text-sky-500 hover:bg-sky-500/10 hover:text-sky-500"
      : tone === "success"
        ? "text-emerald-500 hover:bg-emerald-500/10 hover:text-emerald-500"
        : tone === "warning"
          ? "text-amber-500 hover:bg-amber-500/10 hover:text-amber-500"
          : tone === "danger"
            ? "text-red-500 hover:bg-red-500/10 hover:text-red-500"
            : "text-muted-foreground hover:bg-accent/60 hover:text-foreground";

  const className = cn(
    "flex min-w-0 flex-1 items-center justify-center rounded-lg p-2 transition-colors",
    toneClass,
    disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
  );

  const inner = (
    <span className="relative inline-flex items-center justify-center">
      <Icon className="size-4" />
      {badge ? (
        <span
          aria-hidden="true"
          className="absolute -right-1 -top-1 size-1.5 rounded-full bg-amber-500 ring-2 ring-popover"
        />
      ) : null}
    </span>
  );

  let trigger;
  if (href) {
    trigger = external ? (
      <a href={href} target="_blank" rel="noreferrer" className={className} aria-label={label} onClick={onClick}>
        {inner}
      </a>
    ) : (
      <Link to={href} className={className} aria-label={label} onClick={onClick}>
        {inner}
      </Link>
    );
  } else {
    trigger = (
      <button
        type="button"
        className={className}
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
      >
        {inner}
      </button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="max-w-[220px]">
        <p className="font-medium">{label}</p>
        <p className="text-[10px] opacity-80">{description}</p>
      </TooltipContent>
    </Tooltip>
  );
}

const UPDATE_CONFIRM_MESSAGE =
  "Update Paperclip? A console window will open and pull the latest, rebuild, migrate, and relaunch the server. Everyone connected will be disconnected during the update.";

const REBUILD_CONFIRM_MESSAGE =
  "Rebuild Paperclip? Everything is already downloaded, but it has not been built yet, so the server is still running older code. A console window will open and build, migrate, and relaunch the server. Everyone connected will be disconnected during the rebuild.";

export function SidebarAccountMenu({
  deploymentMode,
  instanceSettingsTarget,
  open: controlledOpen,
  onOpenChange,
  version,
  commit,
  updateAvailable = false,
  updateReason = null,
  remoteRelation = null,
  trackedBranch = null,
  runningFromSource = false,
}: SidebarAccountMenuProps) {
  const shortCommit = commit ? commit.slice(0, 8) : null;
  const [internalOpen, setInternalOpen] = useState(false);
  const queryClient = useQueryClient();
  const { isMobile, setSidebarOpen } = useSidebar();
  const { theme, toggleTheme } = useTheme();
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  const signOutMutation = useMutation({
    mutationFn: () => authApi.signOut(),
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    },
  });

  const restartMutation = useMutation({
    mutationFn: () => systemApi.restart(),
    onSettled: () => {
      setOpen(false);
    },
  });

  const shutdownMutation = useMutation({
    mutationFn: () => systemApi.shutdown(),
    onSettled: () => {
      setOpen(false);
    },
  });

  const updateMutation = useMutation({
    mutationFn: () => systemApi.update(),
    onSettled: () => {
      setOpen(false);
    },
  });

  const rebuildMutation = useMutation({
    mutationFn: () => systemApi.rebuild(),
    onSettled: () => {
      setOpen(false);
    },
  });

  const lifecycleBusy =
    restartMutation.isPending ||
    shutdownMutation.isPending ||
    updateMutation.isPending ||
    rebuildMutation.isPending;

  const displayName = session?.user.name?.trim() || "Board";
  const secondaryLabel =
    session?.user.email?.trim() || (deploymentMode === "authenticated" ? "Signed in" : "Local workspace board");
  const accountBadge = deploymentMode === "authenticated" ? "Account" : "Local";
  const initials = deriveInitials(displayName);
  const profileHref = `/u/${deriveUserSlug(session?.user.name, session?.user.email, session?.user.id)}`;

  function closeNavigationChrome() {
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
  }

  function confirmAndUpdate() {
    if (lifecycleBusy) return;
    if (window.confirm(UPDATE_CONFIRM_MESSAGE)) {
      updateMutation.mutate();
    }
  }

  // Pulling cannot fix a build that was never run, so the pill has to offer the
  // action that actually closes the gap it found.
  const needsRebuildOnly = updateReason === "build_behind";

  // States that are worth saying but are not a job to do. None of them can
  // coexist with an offer to pull, because an offer to pull only comes from
  // being behind, so each is safe to state on its own.
  const localIsNewer = remoteRelation === "ahead";
  const hasDiverged = remoteRelation === "diverged";
  const branchNotOnGitHub = remoteRelation === "no_remote_branch";

  // The trigger row has one slot at its right edge. A pill that does something
  // wins it; otherwise a quiet badge can use it to say how this copy stands.
  // The badge is a plain span, never a button, so it cannot look like a job.
  const quietBadge = updateAvailable
    ? null
    : localIsNewer
      ? {
          label: "Newer",
          icon: ArrowUp,
          title: "This copy is newer than GitHub. There is nothing to update.",
        }
      : hasDiverged
        ? {
            label: "Differs",
            icon: GitBranch,
            title:
              "This copy and GitHub have both changed. Pulling would not be a simple move forward, so no update is offered.",
          }
        : null;
  const pillPending = needsRebuildOnly ? rebuildMutation.isPending : updateMutation.isPending;
  const pillLabel = needsRebuildOnly ? "Rebuild" : "Update";

  function runPillAction() {
    if (lifecycleBusy) return;
    if (needsRebuildOnly) {
      if (window.confirm(REBUILD_CONFIRM_MESSAGE)) rebuildMutation.mutate();
      return;
    }
    confirmAndUpdate();
  }

  return (
    <div className="relative border-t border-r border-border bg-background px-3 py-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] font-medium text-foreground/80 transition-colors hover:bg-accent/50 hover:text-foreground"
            aria-label="Open account menu"
          >
            <Avatar size="sm">
              {session?.user.image ? <AvatarImage src={session.user.image} alt={displayName} /> : null}
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1 truncate">{displayName}</span>
            {shortCommit && !updateAvailable && !quietBadge ? (
              <span
                className="ml-auto shrink-0 font-mono text-[10px] font-normal text-muted-foreground/70"
                title={commit ?? undefined}
              >
                {shortCommit}
              </span>
            ) : null}
            {quietBadge ? (
              <span
                className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                title={quietBadge.title}
              >
                <quietBadge.icon className="size-3" />
                {quietBadge.label}
              </span>
            ) : null}
            {updateAvailable ? <span className="ml-auto h-6 w-[5.25rem]" aria-hidden="true" /> : null}
          </button>
        </PopoverTrigger>
        {updateAvailable ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  event.preventDefault();
                  runPillAction();
                }}
                disabled={lifecycleBusy}
                aria-label={
                  pillPending
                    ? needsRebuildOnly
                      ? "Rebuilding Paperclip"
                      : "Updating Paperclip"
                    : needsRebuildOnly
                      ? "Downloaded but not built. Click to rebuild Paperclip"
                      : "Update available. Click to update Paperclip"
                }
                className="absolute right-5 top-1/2 z-10 inline-flex h-6 -translate-y-1/2 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 text-[10px] font-medium text-amber-500 transition-colors hover:bg-amber-500/15 hover:text-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {needsRebuildOnly ? <Hammer className="size-3" /> : <Download className="size-3" />}
                <span>{pillPending ? (needsRebuildOnly ? "Rebuilding…" : "Updating…") : pillLabel}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6} className="max-w-[220px]">
              <p className="font-medium">
                {needsRebuildOnly ? "Downloaded but not built" : "Update available"}
              </p>
              <p className="text-[10px] opacity-80">
                {needsRebuildOnly
                  ? "The latest code is already here, but the server is still running an older build. Click to build and relaunch."
                  : "A new commit is on origin/master. Click to pull, rebuild, and relaunch."}
              </p>
              {/*
                A rebuild and a newer copy can both be true at once, and the
                pill only has room for the job. Say the other part here so it
                is not a surprise waiting inside the menu.
              */}
              {localIsNewer ? (
                <p className="text-[10px] opacity-80">
                  This copy is also newer than GitHub, so there is nothing to pull.
                </p>
              ) : null}
            </TooltipContent>
          </Tooltip>
        ) : null}
        <PopoverContent
          side="top"
          align="start"
          sideOffset={10}
          onOpenAutoFocus={(event) => event.preventDefault()}
          className="w-80 overflow-hidden rounded-t-2xl rounded-b-none border-border p-0 shadow-2xl"
        >
          <div className="h-24 bg-[linear-gradient(135deg,hsl(var(--primary))_0%,hsl(var(--accent))_55%,hsl(var(--muted))_100%)]" />
          <div className="-mt-8 px-4 pb-4">
            <div className="flex items-start gap-3">
              <Link
                to={profileHref}
                onClick={closeNavigationChrome}
                aria-label="View profile"
                className="group -m-1 flex min-w-0 flex-1 items-start gap-3 rounded-xl p-1 transition-colors hover:bg-accent/40"
              >
                <div className="shrink-0 rounded-2xl border-4 border-popover bg-popover p-0.5 shadow-sm">
                  <Avatar size="lg">
                    {session?.user.image ? <AvatarImage src={session.user.image} alt={displayName} /> : null}
                    <AvatarFallback>{initials}</AvatarFallback>
                  </Avatar>
                </div>
                <div className="min-w-0 flex-1 pt-1">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-base font-semibold text-foreground decoration-muted-foreground/50 underline-offset-2 group-hover:underline">{displayName}</h2>
                    <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {accountBadge}
                    </span>
                  </div>
                  <p className="truncate text-sm text-muted-foreground">{secondaryLabel}</p>
                  {version || shortCommit ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {version ? <>Paperclip v{version}</> : null}
                      {version && shortCommit ? " · " : null}
                      {shortCommit ? (
                        <span className="font-mono" title={commit ?? undefined}>
                          {shortCommit}
                        </span>
                      ) : null}
                    </p>
                  ) : null}
                  {/*
                    Why this copy shows a commit that the install marker does
                    not match and yet offers no rebuild. One quiet line, next to
                    the version it is about, and only ever on a copy that really
                    is running the working tree.
                  */}
                  {runningFromSource ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      This copy runs straight from the working tree, so there is nothing to build.
                    </p>
                  ) : null}
                  {updateAvailable ? (
                    <p className="mt-1 text-xs font-medium text-amber-500">
                      {needsRebuildOnly
                        ? "Downloaded but not built. Rebuild to run it."
                        : "Update available. Pull origin/master to apply."}
                    </p>
                  ) : null}
                  {/*
                    Said, not offered. Each of these is a true statement about
                    where this copy stands, and none of them is a button,
                    because none of them is a job someone should just do.
                  */}
                  {localIsNewer ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      This copy is newer than GitHub, so there is nothing to update.
                    </p>
                  ) : null}
                  {hasDiverged ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      This copy and GitHub have both changed since they last matched. Pulling
                      would not be a simple move forward, so no update is offered here.
                    </p>
                  ) : null}
                  {branchNotOnGitHub ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {trackedBranch
                        ? `GitHub has no branch called ${trackedBranch}, so there is nothing to compare this copy against.`
                        : "GitHub does not have the branch this copy tracks, so there is nothing to compare it against."}
                    </p>
                  ) : null}
                </div>
              </Link>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link
                    to={PROFILE_SETTINGS_PATH}
                    onClick={closeNavigationChrome}
                    aria-label="Edit profile"
                    className="mt-1 shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <UserRoundPen className="size-4" />
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6} className="max-w-[220px]">
                  <p className="font-medium">Edit profile</p>
                  <p className="text-[10px] opacity-80">Update your display name and avatar.</p>
                </TooltipContent>
              </Tooltip>
            </div>

            <div className="my-3 border-t border-border/60" />

            <div className="space-y-1">
              <MenuAction
                label="Instance settings"
                description="Jump back to the last settings page you opened."
                icon={Settings}
                href={instanceSettingsTarget}
                onClick={closeNavigationChrome}
              />
              <div className="my-1 border-t border-border/60" />

              <div className="flex items-center gap-0.5 rounded-xl bg-muted/30 p-1">
                <IconAction
                  label="Documentation"
                  description="Open Paperclip docs in a new tab."
                  icon={BookOpen}
                  href={DOCS_URL}
                  external
                  onClick={() => setOpen(false)}
                />
                <IconAction
                  label="Roadmap"
                  description="See what's planned, in-progress, and shipped across skills, agents, routines, features, and plugins."
                  icon={MapIcon}
                  href="/instance/settings/roadmap"
                  onClick={() => setOpen(false)}
                />
                <IconAction
                  label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                  description="Toggle the app appearance."
                  icon={theme === "dark" ? Sun : Moon}
                  onClick={() => {
                    toggleTheme();
                    setOpen(false);
                  }}
                />
                <IconAction
                  label={rebuildMutation.isPending ? "Rebuilding…" : "Rebuild from local"}
                  description="Build from the local working tree (no git pull), migrate, and relaunch. Use after editing source."
                  icon={Hammer}
                  tone="info"
                  disabled={lifecycleBusy}
                  // Badge whichever action actually closes the gap, so the dot
                  // never points at a pull that would do nothing.
                  badge={updateAvailable && needsRebuildOnly}
                  onClick={() => {
                    if (lifecycleBusy) return;
                    if (
                      window.confirm(
                        "Rebuild Paperclip from your local working tree? A console window will open, rebuild, migrate, and relaunch the server. Everyone connected will be disconnected during the rebuild.",
                      )
                    ) {
                      rebuildMutation.mutate();
                    }
                  }}
                />
                <IconAction
                  label={updateMutation.isPending ? "Updating…" : "Update Paperclip"}
                  description="Pull the latest from origin/master, rebuild, migrate, and relaunch. Opens in a console window."
                  icon={Download}
                  tone="warning"
                  disabled={lifecycleBusy}
                  badge={updateAvailable && !needsRebuildOnly}
                  onClick={confirmAndUpdate}
                />
                <IconAction
                  label={restartMutation.isPending ? "Restarting…" : "Restart Paperclip"}
                  description="Bounce the server. Everyone connected drops briefly while a new instance boots."
                  icon={RefreshCw}
                  tone="success"
                  disabled={lifecycleBusy}
                  onClick={() => {
                    if (lifecycleBusy) return;
                    if (
                      window.confirm(
                        "Restart the Paperclip server? Everyone connected will be disconnected briefly while a new instance boots.",
                      )
                    ) {
                      restartMutation.mutate();
                    }
                  }}
                />
                <IconAction
                  label={shutdownMutation.isPending ? "Shutting down…" : "Shut down Paperclip"}
                  description="Stop the server. Re-launch manually when you're ready."
                  icon={Power}
                  tone="danger"
                  disabled={lifecycleBusy}
                  onClick={() => {
                    if (lifecycleBusy) return;
                    if (
                      window.confirm(
                        "Shut down the Paperclip server? Everyone connected will be disconnected and the server will stay stopped until you re-launch it manually.",
                      )
                    ) {
                      shutdownMutation.mutate();
                    }
                  }}
                />
              </div>

              {deploymentMode === "authenticated" ? (
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-destructive/10",
                    signOutMutation.isPending && "cursor-not-allowed opacity-60",
                  )}
                  onClick={() => signOutMutation.mutate()}
                  disabled={signOutMutation.isPending}
                >
                  <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
                    <LogOut className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">
                      {signOutMutation.isPending ? "Signing out..." : "Sign out"}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      End this browser session.
                    </span>
                  </span>
                </button>
              ) : null}
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
