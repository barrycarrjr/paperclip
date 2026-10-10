import { useSyncExternalStore, type Ref } from "react";
import { MessageCircle } from "lucide-react";
import { useClippy } from "../context/ClippyContext";
import { clippyStreamManager } from "../lib/clippy-stream-manager";
import { ABOVE_MOBILE_BOTTOM_NAV_CLASS, CLIPPY_LAUNCHER_SIZE_CLASS } from "../lib/narrow-layout";
import { cn } from "../lib/utils";
import { Z_PAGE_FLOATING } from "../lib/z-layers";

/** The launcher's words, with the number of actions waiting on the person when there are any. */
export function clippyLauncherLabel(pendingActionCount: number): string {
  if (pendingActionCount <= 0) return "Ask Clippy anything";
  return `Ask Clippy anything (${pendingActionCount} action${pendingActionCount === 1 ? "" : "s"} waiting on you)`;
}

interface ClippyLauncherButtonProps {
  /** Actions waiting on the person across every chat, shown as a badge. */
  pendingActionCount: number;
  onClick?: () => void;
  hidden?: boolean;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
}

/**
 * How the launcher looks: a round button on a phone, where there is no room
 * for words, and from `md` up an "Ask Clippy anything" pill. Placement is
 * ClippyLauncher's job.
 */
export function ClippyLauncherButton({ pendingActionCount, onClick, hidden, className, ref }: ClippyLauncherButtonProps) {
  const label = clippyLauncherLabel(pendingActionCount);
  return (
    <button
      ref={ref}
      type="button"
      hidden={hidden}
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "relative flex items-center justify-center gap-2 rounded-full outline-none transition-colors",
        "focus-visible:ring-[3px] focus-visible:ring-ring",
        CLIPPY_LAUNCHER_SIZE_CLASS,
        "bg-primary text-primary-foreground shadow-sm",
        "md:border md:border-border md:bg-card md:pl-1.5 md:pr-4 md:text-card-foreground md:hover:bg-accent",
        className,
      )}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full md:bg-primary md:text-primary-foreground">
        <MessageCircle className="size-5 md:size-4" />
      </span>
      <span className="hidden text-sm text-muted-foreground md:inline">Ask Clippy anything</span>
      {pendingActionCount > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-amber-950 md:static md:ml-0.5">
          {pendingActionCount}
        </span>
      )}
    </button>
  );
}

interface ClippyLauncherProps {
  /**
   * The properties panel is showing on the right. The launcher moves to its
   * left rather than sitting over the bottom of it.
   */
  besidePropertiesPanel?: boolean;
}

/**
 * The launcher in the bottom right corner that opens Clippy. Hidden while
 * Clippy is open: the window takes its place (and shows the same count of
 * actions waiting), and focus comes back here when it closes. Hidden on the
 * full Clippy page too, where it would only open a second Clippy over the
 * page and sat against the corner of the page's own message box.
 */
export function ClippyLauncher({ besidePropertiesPanel = false }: ClippyLauncherProps) {
  const { open, openClippy, launcherRef, onClippyPage } = useClippy();

  // Actions waiting on the person (pending permission prompts) across ALL
  // chats, so a prompt behind a closed Clippy is never invisible.
  const pendingActionCount = useSyncExternalStore(
    clippyStreamManager.subscribeGlobal,
    clippyStreamManager.getPendingActionCount,
    clippyStreamManager.getPendingActionCount,
  );

  return (
    // The launcher sits above the phone bottom bar, not on it. At `bottom-4`
    // it covered the last button in that bar exactly, on a higher layer, so
    // on a phone that button could not be tapped at all: every tap opened
    // Clippy instead. The offset comes from lib/narrow-layout so it stays
    // tied to the bar's own height, and the page's scroll buttons stack
    // above the launcher from the same file.
    <ClippyLauncherButton
      ref={launcherRef}
      pendingActionCount={pendingActionCount}
      hidden={open || onClippyPage}
      onClick={openClippy}
      className={cn(
        "fixed right-4",
        Z_PAGE_FLOATING,
        besidePropertiesPanel && "md:right-[calc(320px+1rem)]",
        ABOVE_MOBILE_BOTTOM_NAV_CLASS,
      )}
    />
  );
}
