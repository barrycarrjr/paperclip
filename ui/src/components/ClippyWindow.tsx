import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ExternalLink,
  Maximize2,
  Menu,
  PanelRight,
  PictureInPicture2,
  SquarePen,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { chatApi, type ChatSession } from "../api/chat";
import { CLIPPY_RECENT_SESSIONS_KEY, useClippy } from "../context/ClippyContext";
import { useCompanyOptional } from "../context/CompanyContext";
import { useClippyGreetingName, useClippyPage } from "../hooks/useClippyPage";
import { useClippySessionActions } from "../hooks/useClippySessionActions";
import { clippyStreamManager } from "../lib/clippy-stream-manager";
import {
  FLOATING_MIN_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampFloatingRect,
  clampSidebarWidth,
  growFloatingRect,
  moveFloatingRect,
  resizeFloatingRect,
  type ClippyFloatingRect,
  type ClippyMode,
  type FloatingResizeEdge,
  type ViewportSize,
} from "../lib/clippy-window-geometry";
import { Z_CLIPPY } from "../lib/z-layers";
import { cn } from "../lib/utils";
import { ClippyChatRow } from "./ClippyChatRow";
import { ClippyConversation } from "./ClippyConversation";
import { ClippySessionRail, useClippySessionList } from "./ClippySessionRail";

const LAYOUTS: ReadonlyArray<{ mode: ClippyMode; label: string; icon: LucideIcon }> = [
  { mode: "floating", label: "Floating", icon: PictureInPicture2 },
  { mode: "sidebar", label: "Sidebar", icon: PanelRight },
  { mode: "fullscreen", label: "Full screen", icon: Maximize2 },
];

/** The chat menu lists this many; the full screen list has every chat. */
const MENU_CHAT_LIMIT = 30;

/** How far one arrow key press moves or resizes, and with Shift held. */
const KEYBOARD_STEP = 24;
const KEYBOARD_BIG_STEP = 96;

// The parts below re-render only when their own props change. The window
// itself re-renders on every pointer move while it is dragged or resized, and
// without this every move re-rendered the whole conversation with it.
const MemoConversation = memo(ClippyConversation);

function popOutChat(sessionId: string | null) {
  if (typeof window === "undefined") return null;
  const features = "popup=yes,width=520,height=720,menubar=no,toolbar=no,location=no,status=no";
  // Pass the active session id through so the popup opens the same chat
  // (rather than defaulting to the most-recent session, which may differ).
  // A new chat that has not been sent yet opens as a new chat there too.
  const url = sessionId
    ? `/clippy-popup?session=${encodeURIComponent(sessionId)}`
    : "/clippy-popup?new=1";
  return window.open(url, "paperclip-clippy", features);
}

function currentViewport(): ViewportSize {
  return { width: window.innerWidth, height: window.innerHeight };
}

/** The browser window's size, followed as it changes (one update per frame at most). */
function useViewportSize(): ViewportSize {
  const [size, setSize] = useState<ViewportSize>(currentViewport);
  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setSize(currentViewport()));
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, []);
  return size;
}

/** Arrow key to a step, or null for any other key. */
function arrowStep(event: ReactKeyboardEvent): { x: number; y: number } | null {
  const step = event.shiftKey ? KEYBOARD_BIG_STEP : KEYBOARD_STEP;
  switch (event.key) {
    case "ArrowLeft":
      return { x: -step, y: 0 };
    case "ArrowRight":
      return { x: step, y: 0 };
    case "ArrowUp":
      return { x: 0, y: -step };
    case "ArrowDown":
      return { x: 0, y: step };
    default:
      return null;
  }
}

/**
 * Follow one pointer from a press until it is let go, without selecting the
 * page's text on the way. `onMove` gets the distance moved so far.
 *
 * The pointer is captured, so every move and the release come back to the
 * element pressed even when the pointer crosses an iframe (an email body, a
 * plugin page). Without that, letting go over an iframe never reached this
 * page, and the window stayed stuck to the pointer.
 */
function trackPointerDrag(
  event: ReactPointerEvent<HTMLElement>,
  onMove: (moved: { dx: number; dy: number; x: number; y: number }) => void,
  onEnd: () => void,
) {
  const target = event.currentTarget;
  const pointerId = event.pointerId;
  const startX = event.clientX;
  const startY = event.clientY;
  try {
    target.setPointerCapture(pointerId);
  } catch {
    /* no pointer capture here; the moves still arrive while over the page */
  }
  const previousUserSelect = document.body.style.userSelect;
  document.body.style.userSelect = "none";
  let finished = false;
  const handleMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    onMove({ dx: ev.clientX - startX, dy: ev.clientY - startY, x: ev.clientX, y: ev.clientY });
  };
  const finish = (ev: PointerEvent) => {
    if (finished || ev.pointerId !== pointerId) return;
    finished = true;
    target.removeEventListener("pointermove", handleMove);
    target.removeEventListener("pointerup", finish);
    target.removeEventListener("pointercancel", finish);
    target.removeEventListener("lostpointercapture", finish);
    try {
      if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
    } catch {
      /* already released */
    }
    document.body.style.userSelect = previousUserSelect;
    onEnd();
  };
  target.addEventListener("pointermove", handleMove);
  target.addEventListener("pointerup", finish);
  target.addEventListener("pointercancel", finish);
  target.addEventListener("lostpointercapture", finish);
}

/**
 * Clippy itself, in the layout the person chose:
 *
 * - Floating: a window in the bottom right corner, over the page but not in
 *   front of it. No dimmed backdrop, and the page stays usable. It can be
 *   resized from its left and top edges and top left corner, and moved by
 *   its header, with the pointer or the arrow keys.
 * - Sidebar: docked on the right, beside the page, which is narrowed to make
 *   room (see Layout and `--clippy-dock-width`). Its left edge resizes it.
 * - Full screen: covers the app, with the list of every chat beside the
 *   conversation, as on the Clippy page.
 *
 * Switching between them changes only how this one element is drawn, so the
 * conversation, a reply streaming into it and an unsent message all carry
 * on. A phone has room only for full screen, so that is what it gets. On the
 * full Clippy page it steps out of the way and comes back on the next page.
 */
export function ClippyWindow() {
  const { open, onClippyPage } = useClippy();
  if (!open || onClippyPage) return null;
  return <ClippyWindowFrame />;
}

function ClippyWindowFrame() {
  const {
    effectiveMode,
    mode,
    setMode,
    isPhone,
    closeClippy,
    openedOnLoad,
    activeCompanyId,
    activeSessionId,
    selectSession,
    openCreatedSession,
    startNewChat,
    sessions,
    reservedPageWidth,
    floatingRect,
    setFloatingRect,
    sidebarWidth,
    setSidebarWidth,
  } = useClippy();
  const qc = useQueryClient();
  const titleId = useId();
  const frameRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // Where a drag has got to. Kept here rather than in ClippyContext while the
  // pointer moves, so a drag re-renders only this frame, and stored once when
  // the pointer is let go.
  const [dragRect, setDragRect] = useState<ClippyFloatingRect | null>(null);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const viewport = useViewportSize();
  const { pageContext, suggestions } = useClippyPage();
  const greetingName = useClippyGreetingName();

  // Opened by a click or a key, focus goes into Clippy: the message box
  // takes it as it mounts, and this catches any case where nothing did, so
  // Escape and Tab start from inside the window rather than from the
  // launcher it replaced. Not when it came back open after a reload.
  useEffect(() => {
    if (openedOnLoad) return;
    const frame = frameRef.current;
    if (frame && !frame.contains(document.activeElement)) frame.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const floating = effectiveMode === "floating";
  const sidebar = effectiveMode === "sidebar";
  const fullscreen = effectiveMode === "fullscreen";
  // Full screen on a phone has no room for the list beside the
  // conversation; the chat menu is the list there.
  const showRail = fullscreen && !isPhone;

  const rect = clampFloatingRect(dragRect ?? floatingRect, viewport);
  const dockWidth = clampSidebarWidth(dragWidth ?? sidebarWidth, viewport.width, reservedPageWidth);

  // Docked, the page makes room for the panel instead of being covered by
  // it. Layout pads the app by this width, and the page's floating scroll
  // buttons move left by it (lib/narrow-layout).
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--clippy-dock-width", sidebar ? `${dockWidth}px` : "0px");
    return () => {
      root.style.removeProperty("--clippy-dock-width");
    };
  }, [sidebar, dockWidth]);

  // A different layout starts with the conversation showing, not the menu.
  useEffect(() => {
    setMenuOpen(false);
  }, [effectiveMode]);

  // When the chat menu closes because a chat (even the one already open) or
  // New chat was picked, the button pressed goes away with the menu. Put
  // focus in the message box rather than leave it on the page body.
  const menuWasOpenRef = useRef(menuOpen);
  useEffect(() => {
    const wasOpen = menuWasOpenRef.current;
    menuWasOpenRef.current = menuOpen;
    if (!wasOpen || menuOpen) return;
    const frame = frameRef.current;
    if (!frame || frame.contains(document.activeElement)) return;
    (frame.querySelector<HTMLElement>("textarea") ?? frame).focus();
  }, [menuOpen]);

  // The open chat's record, for the title. Shares its cache with the
  // conversation below, so this is not a second request.
  const sessionQuery = useQuery({
    queryKey: ["clippy", "session", activeSessionId],
    queryFn: () => chatApi.getSession(activeSessionId as string).then((r) => r.session),
    enabled: Boolean(activeSessionId),
  });
  const activeSession = sessionQuery.data ?? sessions.find((s) => s.id === activeSessionId) ?? null;
  const title = activeSessionId ? activeSession?.title ?? "Clippy" : "New chat";

  // Pop-out waits while the open chat has a turn in flight. A new window
  // can't see this window's in-memory stream state, so popping out
  // mid-stream would land the person in a popup that thinks the chat is
  // idle. Wait for the turn to finish (or Stop it).
  const streamingSubscribe = useCallback(
    (listener: () => void) => {
      if (!activeSessionId) return () => {};
      return clippyStreamManager.subscribe(activeSessionId, listener);
    },
    [activeSessionId],
  );
  const streamingSnapshot = useCallback(() => {
    if (!activeSessionId) return false;
    return clippyStreamManager.getSnapshot(activeSessionId).streaming;
  }, [activeSessionId]);
  const activeIsStreaming = useSyncExternalStore(streamingSubscribe, streamingSnapshot, streamingSnapshot);

  // Actions waiting on the person across every chat. The launcher shows this
  // while Clippy is closed and is hidden while it is open, so the window
  // carries the count: a prompt in another chat must never go unseen, and the
  // docked panel can stay open for a whole session.
  const pendingActionCount = useSyncExternalStore(
    clippyStreamManager.subscribeGlobal,
    clippyStreamManager.getPendingActionCount,
    clippyStreamManager.getPendingActionCount,
  );

  const close = useCallback(() => closeClippy({ returnFocus: true }), [closeClippy]);

  const newChat = useCallback(() => {
    startNewChat();
    setMenuOpen(false);
  }, [startNewChat]);

  const pickChat = useCallback(
    (id: string) => {
      selectSession(id);
      setMenuOpen(false);
    },
    [selectSession],
  );

  const showAllChats = useCallback(() => setMode("fullscreen"), [setMode]);

  const showWaitingChat = () => {
    const id = clippyStreamManager.firstSessionWithPendingAction();
    if (id) pickChat(id);
  };

  const onSessionCreated = useCallback(
    (session: ChatSession) => {
      // Into the list straight away, so the chat is listed (and the company
      // check finds it) before the list's own refetch comes back.
      qc.setQueryData<ChatSession[]>(CLIPPY_RECENT_SESSIONS_KEY, (prev) =>
        prev ? [session, ...prev.filter((s) => s.id !== session.id)] : prev,
      );
      openCreatedSession(session);
    },
    [qc, openCreatedSession],
  );

  const closeMenu = () => {
    setMenuOpen(false);
    menuButtonRef.current?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // A menu or picker inside Clippy closes first: Radix marks the Escape it
    // used as handled.
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    if (menuOpen) closeMenu();
    else close();
  };

  const startFloatingResize = (event: ReactPointerEvent<HTMLElement>, edge: FloatingResizeEdge) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const start = rect;
    let latest: ClippyFloatingRect = start;
    trackPointerDrag(
      event,
      ({ x, y }) => {
        latest = resizeFloatingRect(start, edge, { x, y }, currentViewport());
        setDragRect(latest);
      },
      () => {
        setFloatingRect(latest);
        setDragRect(null);
      },
    );
  };

  const startFloatingMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!floating || event.button !== 0) return;
    // The header's buttons stay buttons; only its empty parts move the window.
    if ((event.target as HTMLElement).closest("button, a, input, textarea, [role='menu']")) return;
    event.preventDefault();
    const start = rect;
    let latest: ClippyFloatingRect = start;
    trackPointerDrag(
      event,
      ({ dx, dy }) => {
        latest = moveFloatingRect(start, { dx, dy }, currentViewport());
        setDragRect(latest);
      },
      () => {
        setFloatingRect(latest);
        setDragRect(null);
      },
    );
  };

  const startSidebarResize = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    let latest = dockWidth;
    trackPointerDrag(
      event,
      ({ x }) => {
        // Docked on the right: the width is from the pointer to the edge.
        latest = clampSidebarWidth(window.innerWidth - x, window.innerWidth, reservedPageWidth);
        setDragWidth(latest);
      },
      () => {
        setSidebarWidth(latest);
        setDragWidth(null);
      },
    );
  };

  // The keyboard's way to do the same: arrow keys on the focused header move
  // the floating window, on the corner handle resize it, and on the docked
  // panel's edge make it wider or narrower. Shift takes bigger steps.
  const onHeaderKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Only the header itself: its buttons keep their own keys.
    if (!floating || event.target !== event.currentTarget) return;
    const step = arrowStep(event);
    if (!step) return;
    event.preventDefault();
    setFloatingRect(moveFloatingRect(rect, { dx: step.x, dy: step.y }, currentViewport()));
  };

  const onCornerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = arrowStep(event);
    if (!step) return;
    event.preventDefault();
    // Left and Up grow the window towards the top left, as dragging the
    // corner that way does.
    setFloatingRect(growFloatingRect(rect, { width: -step.x, height: -step.y }, currentViewport()));
  };

  const onSidebarHandleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = arrowStep(event);
    if (!step || step.x === 0) return;
    event.preventDefault();
    setSidebarWidth(clampSidebarWidth(dockWidth - step.x, window.innerWidth, reservedPageWidth));
  };

  const currentLayout = LAYOUTS.find((layout) => layout.mode === mode) ?? LAYOUTS[0]!;

  return (
    <div
      ref={frameRef}
      role={sidebar ? "complementary" : "dialog"}
      aria-modal={fullscreen ? true : undefined}
      aria-labelledby={titleId}
      data-clippy-mode={effectiveMode}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={cn(
        "fixed flex flex-col overflow-hidden bg-background text-foreground outline-none",
        Z_CLIPPY,
        floating && "rounded-xl border border-border shadow-sm",
        sidebar && "inset-y-0 right-0 border-l border-border pt-[env(safe-area-inset-top)]",
        fullscreen && "inset-0 pt-[env(safe-area-inset-top)]",
      )}
      style={
        floating
          ? { width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom }
          : sidebar
            ? { width: dockWidth }
            : undefined
      }
    >
      {floating ? (
        <>
          <div
            aria-hidden
            data-clippy-resize="left"
            onPointerDown={(e) => startFloatingResize(e, "left")}
            className="absolute inset-y-4 left-0 z-20 w-1.5 cursor-ew-resize"
          />
          <div
            aria-hidden
            data-clippy-resize="top"
            onPointerDown={(e) => startFloatingResize(e, "top")}
            className="absolute inset-x-4 top-0 z-20 h-1.5 cursor-ns-resize"
          />
          <div
            role="separator"
            aria-label="Resize Clippy. Arrow keys make it bigger or smaller."
            aria-orientation="vertical"
            aria-valuenow={rect.width}
            aria-valuemin={FLOATING_MIN_WIDTH}
            aria-valuemax={viewport.width}
            tabIndex={0}
            data-clippy-resize="top-left"
            onPointerDown={(e) => startFloatingResize(e, "top-left")}
            onKeyDown={onCornerKeyDown}
            className="absolute left-0 top-0 z-30 size-4 cursor-nwse-resize rounded-tl-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </>
      ) : null}
      {sidebar ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize Clippy"
          aria-valuenow={dockWidth}
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={clampSidebarWidth(Number.MAX_SAFE_INTEGER, viewport.width, reservedPageWidth)}
          tabIndex={0}
          onPointerDown={startSidebarResize}
          onKeyDown={onSidebarHandleKeyDown}
          className="absolute inset-y-0 left-0 z-20 w-1.5 cursor-col-resize outline-none transition-colors hover:bg-primary/40 focus-visible:bg-primary/60"
        />
      ) : null}

      {/* As tall as the page's own top bar, so docked beside it the two
          bottom edges line up. Floating, the header is the handle that moves
          the window, by pointer or (once focused) by arrow keys. */}
      <div
        role={floating ? "group" : undefined}
        aria-label={floating ? "Clippy header. Arrow keys move the window." : undefined}
        tabIndex={floating ? 0 : undefined}
        data-clippy-header=""
        className={cn(
          "flex h-12 shrink-0 select-none items-center gap-0.5 border-b border-border px-1.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          floating && "cursor-grab active:cursor-grabbing",
        )}
        onPointerDown={startFloatingMove}
        onKeyDown={onHeaderKeyDown}
      >
        {!showRail ? (
          <HeaderButton
            ref={menuButtonRef}
            label={menuOpen ? "Hide chats" : "Show chats"}
            aria-expanded={menuOpen}
            onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
          >
            <Menu />
          </HeaderButton>
        ) : null}
        <h2 id={titleId} className="min-w-0 flex-1 truncate px-1.5 text-sm font-semibold">
          <span className="sr-only">Clippy: </span>
          {title}
        </h2>
        {pendingActionCount > 0 ? (
          <button
            type="button"
            onClick={showWaitingChat}
            aria-label={`${pendingActionCount} action${pendingActionCount === 1 ? "" : "s"} waiting on you. Show it.`}
            title="Show the chat that is waiting on you"
            className="mr-0.5 flex h-6 shrink-0 items-center gap-1 rounded-full bg-amber-500 px-2 text-xs font-semibold text-amber-950 outline-none hover:bg-amber-400 focus-visible:ring-2 focus-visible:ring-ring"
          >
            {pendingActionCount} waiting
          </button>
        ) : null}
        <HeaderButton label="New chat" disabled={activeSessionId === null && !menuOpen} onClick={newChat}>
          <SquarePen />
        </HeaderButton>
        {!isPhone ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="size-7 text-muted-foreground hover:text-foreground"
                aria-label={`Layout: ${currentLayout.label}`}
                title="Change layout"
              >
                <currentLayout.icon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Switch to</DropdownMenuLabel>
              {LAYOUTS.map((layout) => (
                <DropdownMenuItem key={layout.mode} onSelect={() => setMode(layout.mode)}>
                  <layout.icon />
                  {layout.label}
                  {layout.mode === mode ? <Check className="ml-auto" aria-label="Current layout" /> : null}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={activeIsStreaming}
                onSelect={() => {
                  const win = popOutChat(activeSessionId);
                  if (win) closeClippy({ returnFocus: true });
                }}
              >
                <ExternalLink />
                {activeIsStreaming ? "Pop out when this reply finishes" : "Pop out into a new window"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <HeaderButton label="Close Clippy" onClick={close}>
          <X />
        </HeaderButton>
      </div>

      <div className="relative flex min-h-0 flex-1">
        {showRail ? (
          <MemoFullScreenChatList activeSessionId={activeSessionId} onSelect={pickChat} onNewChat={newChat} />
        ) : null}
        {/* Hidden from the keyboard while the chat menu covers it, so Tab
            stays in the menu. */}
        <div className="min-w-0 flex-1" inert={menuOpen || undefined}>
          <MemoConversation
            sessionId={activeSessionId}
            showHeader={false}
            newChatCompanyId={activeCompanyId}
            onSessionCreated={onSessionCreated}
            onNewSessionForCurrentCompany={newChat}
            pageContext={pageContext}
            greetingName={greetingName}
            suggestions={suggestions}
            autoFocus={!openedOnLoad}
          />
        </div>
        {menuOpen && !showRail ? (
          <MemoChatMenu
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelect={pickChat}
            onNewChat={newChat}
            onShowAll={isPhone ? undefined : showAllChats}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * A header icon button. Its name shows on hover through a plain `title`, not
 * a Tooltip: a Tooltip also opens when focus is put back on the button (after
 * the chat menu or a layout menu closes) and then sits over the window.
 */
function HeaderButton({
  label,
  children,
  ref,
  ...props
}: {
  label: string;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
  onClick?: () => void;
  disabled?: boolean;
  "aria-expanded"?: boolean;
}) {
  return (
    <Button
      ref={ref}
      type="button"
      size="icon-sm"
      variant="ghost"
      className="size-7 text-muted-foreground hover:text-foreground"
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </Button>
  );
}

/** The list of every chat with its filters, beside the conversation in full screen. */
function FullScreenChatList({
  activeSessionId,
  onSelect,
  onNewChat,
}: {
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
}) {
  const list = useClippySessionList();
  return (
    <ClippySessionRail
      list={list}
      activeId={activeSessionId}
      onSelect={onSelect}
      onNewChat={onNewChat}
      showTitle={false}
    />
  );
}

const MemoFullScreenChatList = memo(FullScreenChatList);

/**
 * The chat menu: New chat, then recent chats from every company with their
 * company and when they were last used, and a way to see them all. It
 * covers the conversation rather than opening as a small dropdown, so rename
 * and delete fit in each row. Archived chats are left out here; full screen
 * lists them.
 */
function ClippyChatMenu({
  sessions,
  activeSessionId,
  onSelect,
  onNewChat,
  onShowAll,
}: {
  sessions: ChatSession[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onShowAll?: () => void;
}) {
  const companies = useCompanyOptional()?.companies ?? [];
  const actions = useClippySessionActions();
  const newChatRef = useRef<HTMLButtonElement | null>(null);
  const recent = sessions.filter((s) => !s.archivedAt).slice(0, MENU_CHAT_LIMIT);

  useEffect(() => {
    newChatRef.current?.focus();
  }, []);

  return (
    <div role="region" aria-label="Chats" className="absolute inset-0 z-10 flex flex-col bg-background">
      <div className="p-1.5">
        <Button
          ref={newChatRef}
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-full justify-start gap-2 px-2.5 font-normal"
          onClick={onNewChat}
        >
          <SquarePen className="size-4" />
          New chat
        </Button>
      </div>
      <div className="px-4 pb-1 text-xs font-medium text-muted-foreground">Recent chats</div>
      {recent.length === 0 ? (
        <p className="flex-1 px-4 py-2 text-xs text-muted-foreground">No chats yet.</p>
      ) : (
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-2">
          {recent.map((s) => {
            const company = s.companyId ? companies.find((c) => c.id === s.companyId) ?? null : null;
            return (
              <ClippyChatRow
                key={s.id}
                session={s}
                company={company ? { name: company.name, brandColor: company.brandColor } : null}
                active={s.id === activeSessionId}
                onSelect={() => onSelect(s.id)}
                onRename={(title) => actions.rename(s.id, title)}
                onDelete={() => actions.remove(s.id)}
              />
            );
          })}
        </ul>
      )}
      {onShowAll ? (
        <div className="border-t border-border p-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-full justify-start gap-2 px-2.5 font-normal"
            onClick={onShowAll}
          >
            <Maximize2 className="size-4" />
            All chats
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const MemoChatMenu = memo(ClippyChatMenu);
