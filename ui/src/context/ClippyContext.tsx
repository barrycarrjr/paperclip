import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { chatApi, type ChatSession } from "../api/chat";
import { useActiveCompanyId } from "../hooks/useRouteCompany";
import {
  INITIAL_CLIPPY_DRAWER_RECONCILE_GATE,
  reconcileClippyDrawerSession,
  shouldReconcileClippyDrawerSession,
  type ClippyDrawerReconcileGate,
} from "../lib/clippy-company-scope";
import {
  DEFAULT_FLOATING_RECT,
  DEFAULT_SIDEBAR_WIDTH,
  SIDEBAR_MIN_WIDTH,
  isClippyMode,
  type ClippyFloatingRect,
  type ClippyMode,
} from "../lib/clippy-window-geometry";

const ACTIVE_SESSION_KEY = "paperclip.clippy.activeSessionId";
const MODE_KEY = "paperclip.clippy.mode";
const FLOATING_RECT_KEY = "paperclip.clippy.floatingRect";
const SIDEBAR_WIDTH_KEY = "paperclip.clippy.sidebarWidth";
/** The old drawer's width. Read once, as where the docked panel starts. */
const LEGACY_DRAWER_WIDTH_KEY = "paperclip.clippy.drawerWidth";
const SIDEBAR_OPEN_KEY = "paperclip.clippy.sidebarOpen";

/**
 * Every chat, archived ones included, newest first: what the window checks
 * the open chat against. Archived chats are in it so that one picked from the
 * full screen list (which can show them) stays open; the chat menu leaves them
 * out.
 */
export const CLIPPY_RECENT_SESSIONS_KEY = ["clippy", "sessions", { status: "all", sort: "recency" }] as const;

/**
 * One remembered chat per company, the same way NewIssueDialog stores its
 * draft under a key that carries the company (see its draftStorageKey).
 *
 * A chat belongs to one company. Clippy is mounted once for the whole app,
 * and it only tidies up the open chat while it is on screen, so a single
 * shared key left the chat you had open in one company remembered under every
 * other one: reopen Clippy, or reload the page, in a different company and
 * the other company's conversation is what you are looking at and typing into
 * until the chat list finishes loading. Keyed by company, each company reads
 * back only its own.
 */
export function activeSessionStorageKey(companyId: string | null): string {
  return `${ACTIVE_SESSION_KEY}:${companyId ?? "none"}`;
}

function readStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function readMode(): ClippyMode {
  const stored = readStorage(MODE_KEY);
  return isClippyMode(stored) ? stored : "floating";
}

function readFloatingRect(): ClippyFloatingRect {
  try {
    const parsed = JSON.parse(readStorage(FLOATING_RECT_KEY) ?? "null") as Partial<ClippyFloatingRect> | null;
    if (!parsed) return DEFAULT_FLOATING_RECT;
    const rect = { ...DEFAULT_FLOATING_RECT, ...parsed };
    const valid = Object.values(rect).every((n) => typeof n === "number" && Number.isFinite(n));
    return valid ? rect : DEFAULT_FLOATING_RECT;
  } catch {
    return DEFAULT_FLOATING_RECT;
  }
}

function readSidebarWidth(): number {
  for (const key of [SIDEBAR_WIDTH_KEY, LEGACY_DRAWER_WIDTH_KEY]) {
    const parsed = Number.parseInt(readStorage(key) ?? "", 10);
    if (Number.isFinite(parsed) && parsed >= SIDEBAR_MIN_WIDTH) return parsed;
  }
  return DEFAULT_SIDEBAR_WIDTH;
}

export interface ClippyContextValue {
  open: boolean;
  /**
   * True when Clippy came back open after a reload (the docked panel
   * remembers it was open) rather than being opened by a click, so it must
   * not take focus away from the page.
   */
  openedOnLoad: boolean;
  openClippy: () => void;
  /** `returnFocus` puts focus back on the launcher. Pass it whenever focus was inside Clippy. */
  closeClippy: (options?: { returnFocus?: boolean }) => void;
  /** The layout the person chose. */
  mode: ClippyMode;
  /** The layout actually drawn: a phone has room only for full screen. */
  effectiveMode: ClippyMode;
  setMode: (mode: ClippyMode) => void;
  isPhone: boolean;
  /** The company of the page, which a new chat is created for. */
  activeCompanyId: string | null;
  /** The open chat. Null is a new chat that has not been sent yet. */
  activeSessionId: string | null;
  /** A chat the person picked, from any company. Reconciliation never undoes it. */
  selectSession: (id: string) => void;
  /**
   * Open a chat that a new chat's first send just made, unless the person has
   * moved to another company since: it belongs to the company it was made
   * for, and must not become the remembered chat of the one open now.
   */
  openCreatedSession: (session: ChatSession) => void;
  /** Show a new, unsent chat. Nothing is created until its first message. */
  startNewChat: () => void;
  /** Every chat across every company, archived ones included, loaded while Clippy is open. */
  sessions: ChatSession[];
  sessionsLoading: boolean;
  /**
   * The page is the full Clippy page. The window and the launcher stay out
   * of the way there (the page is Clippy already), and the window comes back
   * as it was on the next page.
   */
  onClippyPage: boolean;
  /** Width the app's own columns take beside the page (navigation, properties panel). */
  reservedPageWidth: number;
  floatingRect: ClippyFloatingRect;
  /** `persist: false` while a drag is still going, so only where it ends is stored. */
  setFloatingRect: (rect: ClippyFloatingRect, options?: { persist?: boolean }) => void;
  sidebarWidth: number;
  setSidebarWidth: (width: number, options?: { persist?: boolean }) => void;
  launcherRef: RefObject<HTMLButtonElement | null>;
}

const ClippyContext = createContext<ClippyContextValue | null>(null);

/** True while Clippy covers the whole page, so the page behind it is taken out of reach. */
const ClippyCoversPageContext = createContext(false);

interface ClippyProviderProps {
  children: ReactNode;
  isPhone?: boolean;
  /** See ClippyContextValue.onClippyPage. */
  onClippyPage?: boolean;
  /** See ClippyContextValue.reservedPageWidth. */
  reservedPageWidth?: number;
}

export function ClippyProvider({
  children,
  isPhone = false,
  onClippyPage = false,
  reservedPageWidth = 0,
}: ClippyProviderProps) {
  // Read from the address rather than the context selection: the selection is
  // synced from the route by an effect, so it is one render behind on the
  // first render after a company change (see hooks/useRouteCompany.ts).
  const activeCompanyId = useActiveCompanyId();
  const activeCompanyIdRef = useRef<string | null>(activeCompanyId);
  activeCompanyIdRef.current = activeCompanyId;

  const [mode, setModeState] = useState<ClippyMode>(readMode);
  // Only the docked panel reopens after a reload, the way the properties
  // panel stays where you left it. A floating window or a full screen chat
  // reappearing over a page you just loaded would be in the way.
  const [open, setOpen] = useState<boolean>(
    () => !isPhone && readMode() === "sidebar" && readStorage(SIDEBAR_OPEN_KEY) === "true",
  );
  const [openedOnLoad, setOpenedOnLoad] = useState(open);
  const effectiveMode: ClippyMode = isPhone ? "fullscreen" : mode;

  useEffect(() => {
    writeStorage(SIDEBAR_OPEN_KEY, open && mode === "sidebar" ? "true" : null);
  }, [open, mode]);

  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const focusLauncherAfterCloseRef = useRef(false);

  const openClippy = useCallback(() => {
    setOpenedOnLoad(false);
    setOpen(true);
  }, []);

  const closeClippy = useCallback((options?: { returnFocus?: boolean }) => {
    focusLauncherAfterCloseRef.current = options?.returnFocus ?? true;
    setOpen(false);
  }, []);

  // Put focus back on the launcher once Clippy has gone. Without this,
  // closing left focus on the page body, so the next Tab press started again
  // from the very top of the document.
  useEffect(() => {
    if (open || !focusLauncherAfterCloseRef.current) return;
    focusLauncherAfterCloseRef.current = false;
    const launcher = launcherRef.current;
    // Not when the launcher is itself hidden (on the Clippy page): focus on a
    // hidden button is lost focus.
    if (launcher && launcher.isConnected && !launcher.hidden) launcher.focus();
  }, [open]);

  const setMode = useCallback((next: ClippyMode) => {
    setModeState(next);
    writeStorage(MODE_KEY, next);
  }, []);

  const [floatingRect, setFloatingRectState] = useState<ClippyFloatingRect>(readFloatingRect);
  const setFloatingRect = useCallback((rect: ClippyFloatingRect, options?: { persist?: boolean }) => {
    setFloatingRectState(rect);
    if (options?.persist ?? true) writeStorage(FLOATING_RECT_KEY, JSON.stringify(rect));
  }, []);

  const [sidebarWidth, setSidebarWidthState] = useState<number>(readSidebarWidth);
  const setSidebarWidth = useCallback((width: number, options?: { persist?: boolean }) => {
    setSidebarWidthState(width);
    if (options?.persist ?? true) writeStorage(SIDEBAR_WIDTH_KEY, String(Math.round(width)));
  }, []);

  const [activeSessionId, setActiveSessionIdState] = useState<string | null>(() =>
    readStorage(activeSessionStorageKey(activeCompanyId)),
  );
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  const setActiveSessionId = useCallback((id: string | null) => {
    setActiveSessionIdState(id);
    writeStorage(activeSessionStorageKey(activeCompanyIdRef.current), id);
  }, []);

  // Change company and Clippy picks up that company's own remembered chat,
  // whether it is open at the time or not. Without this, the chat from the
  // company you left stays selected while Clippy is closed, and is what you
  // see for a moment when you open it again.
  const loadedForCompanyIdRef = useRef<string | null | undefined>(activeCompanyId);
  useEffect(() => {
    if (loadedForCompanyIdRef.current === activeCompanyId) return;
    loadedForCompanyIdRef.current = activeCompanyId;
    setActiveSessionIdState(readStorage(activeSessionStorageKey(activeCompanyId)));
  }, [activeCompanyId]);

  // Fetched while open, archived chats included (see CLIPPY_RECENT_SESSIONS_KEY).
  const sessionsQuery = useQuery({
    queryKey: CLIPPY_RECENT_SESSIONS_KEY,
    queryFn: () => chatApi.listSessions({ status: "all", sort: "recency" }).then((r) => r.sessions),
    enabled: open,
  });
  const sessions = useMemo<ChatSession[]>(() => sessionsQuery.data ?? [], [sessionsQuery.data]);
  // What a company check may open in place of a chat: never an archived one.
  const unarchivedSessions = useMemo(() => sessions.filter((s) => !s.archivedAt), [sessions]);

  // See clippy-company-scope.ts's shouldReconcileClippyDrawerSession for why
  // this needs a gate at all, not just a plain "run on every change" effect:
  // the chat menu deliberately allows picking a different company's chat,
  // and that pick must not be immediately undone.
  const reconcileGateRef = useRef<ClippyDrawerReconcileGate>(INITIAL_CLIPPY_DRAWER_RECONCILE_GATE);

  const selectSession = useCallback(
    (id: string) => {
      // Picking the chat already open changes nothing, so no effect run
      // would use up the skip, and it would then wrongly skip the run after
      // a later company change.
      if (id !== activeSessionIdRef.current) {
        reconcileGateRef.current = { ...reconcileGateRef.current, skip: true };
      }
      // The person is using Clippy now, so the message box may take focus.
      setOpenedOnLoad(false);
      setActiveSessionId(id);
    },
    [setActiveSessionId],
  );

  const openCreatedSession = useCallback(
    (session: ChatSession) => {
      if (session.companyId !== null && session.companyId !== activeCompanyIdRef.current) return;
      selectSession(session.id);
    },
    [selectSession],
  );

  const startNewChat = useCallback(() => {
    // Settled for this company: the first reconciliation for it must not
    // replace the new chat with the latest old one.
    reconcileGateRef.current = { skip: false, reconciledForCompanyId: activeCompanyIdRef.current };
    setOpenedOnLoad(false);
    setActiveSessionId(null);
  }, [setActiveSessionId]);

  // When open, make sure the open chat belongs to the current company, but
  // only when the company actually just changed (or the open chat is gone),
  // not on every incidental re-render. "Gone" is checked against every chat,
  // archived ones included, so an archived chat the person opened stays open.
  useEffect(() => {
    if (!open) return;
    if (!sessionsQuery.data) return;

    const { run, nextGate } = shouldReconcileClippyDrawerSession({
      gate: reconcileGateRef.current,
      selectedCompanyId: activeCompanyId,
      activeSessionId,
      sessions,
    });
    reconcileGateRef.current = nextGate;
    if (!run) return;

    const result = reconcileClippyDrawerSession({
      activeSessionId,
      sessions: unarchivedSessions,
      selectedCompanyId: activeCompanyId,
    });
    if (result.action === "select") setActiveSessionId(result.id);
    else if (result.action === "draft" && activeSessionId !== null) setActiveSessionId(null);
  }, [open, activeSessionId, sessionsQuery.data, sessions, unarchivedSessions, setActiveSessionId, activeCompanyId]);

  const value = useMemo<ClippyContextValue>(
    () => ({
      open,
      openedOnLoad,
      openClippy,
      closeClippy,
      mode,
      effectiveMode,
      setMode,
      isPhone,
      activeCompanyId,
      activeSessionId,
      selectSession,
      openCreatedSession,
      startNewChat,
      sessions,
      sessionsLoading: sessionsQuery.isLoading,
      onClippyPage,
      reservedPageWidth,
      floatingRect,
      setFloatingRect,
      sidebarWidth,
      setSidebarWidth,
      launcherRef,
    }),
    [
      open,
      openedOnLoad,
      openClippy,
      closeClippy,
      mode,
      effectiveMode,
      setMode,
      isPhone,
      activeCompanyId,
      activeSessionId,
      selectSession,
      openCreatedSession,
      startNewChat,
      sessions,
      sessionsQuery.isLoading,
      onClippyPage,
      reservedPageWidth,
      floatingRect,
      setFloatingRect,
      sidebarWidth,
      setSidebarWidth,
    ],
  );

  return (
    <ClippyContext.Provider value={value}>
      <ClippyCoversPageContext.Provider value={open && effectiveMode === "fullscreen" && !onClippyPage}>
        {children}
      </ClippyCoversPageContext.Provider>
    </ClippyContext.Provider>
  );
}

export function useClippy(): ClippyContextValue {
  const ctx = useContext(ClippyContext);
  if (!ctx) throw new Error("useClippy must be used within ClippyProvider");
  return ctx;
}

/**
 * Whether Clippy covers the whole page right now. A separate context from
 * the rest so the layout around every page re-renders only when this flips,
 * not on every chat list fetch.
 */
export function useClippyCoversPage(): boolean {
  return useContext(ClippyCoversPageContext);
}
