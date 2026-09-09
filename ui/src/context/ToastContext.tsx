import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastTone = "info" | "success" | "warn" | "error";

export interface ToastAction {
  label: string;
  href: string;
}

export interface ToastInput {
  /**
   * Stable identity for a replaceable message. Pushing the same id again
   * updates that toast in place and restarts its dismissal timer.
   */
  id?: string;
  dedupeKey?: string;
  title: string;
  body?: string;
  tone?: ToastTone;
  /**
   * How long the message shows for, in milliseconds. Leave it out to get the
   * default for the tone, which for a failure means it stays until dismissed.
   */
  ttlMs?: number;
  action?: ToastAction;
}

export interface ToastItem {
  id: string;
  title: string;
  body?: string;
  tone: ToastTone;
  /** null means this one stays on screen until the person closes it. */
  ttlMs: number | null;
  action?: ToastAction;
  createdAt: number;
}

interface ToastActionsContextValue {
  pushToast: (input: ToastInput) => string | null;
  dismissToast: (id: string) => void;
  clearToasts: () => void;
}

interface ToastContextValue extends ToastActionsContextValue {
  toasts: ToastItem[];
}

/**
 * How long each kind of message shows for, with null meaning it stays until
 * the person closes it.
 *
 * Only failures stay. A failure means the thing you asked for did not happen,
 * so there is something left for you to do, and the reason the server gave is
 * usually written nowhere else in the app: these messages carry the error text
 * straight from the failed request, and no page shows it afterwards. Ten
 * seconds was enough to see it only if you happened to be looking at the
 * corner of the screen at the moment it appeared.
 *
 * Everything else still fades. "Saved", "Now in Acme" and the like are reports
 * that something already worked, so missing one costs nothing, and a pile of
 * them would bury the failures.
 *
 * A caller can still ask for a time limit on a failure by passing ttlMs, and
 * one does: LiveUpdatesProvider announces agent runs that failed on their own,
 * without you asking, and that run and its error are kept on the run's own
 * page, so that message has somewhere to go back to and is allowed to fade.
 */
const DEFAULT_TTL_BY_TONE: Record<ToastTone, number | null> = {
  info: 4000,
  success: 3500,
  warn: 8000,
  error: null,
};
const MIN_TTL_MS = 1500;
const MAX_TTL_MS = 15000;
const MAX_TOASTS = 5;
const DEDUPE_WINDOW_MS = 3500;
const DEDUPE_MAX_AGE_MS = 20000;

const ToastStateContext = createContext<ToastItem[] | null>(null);
const ToastActionsContext = createContext<ToastActionsContextValue | null>(null);

function normalizeTtl(value: number | undefined, tone: ToastTone): number | null {
  const fallback = DEFAULT_TTL_BY_TONE[tone];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, Math.floor(value)));
}

/**
 * Keep the list to MAX_TOASTS, dropping the oldest one that was going to fade
 * anyway before dropping one that stays. Without this the five-message cap
 * would quietly delete the failure you still have to deal with as soon as five
 * "Saved" messages arrived after it, which is the exact thing this file is
 * trying to stop happening.
 *
 * If every message on screen is one that stays, the oldest still goes, because
 * the list has to stay a fixed size.
 */
function trimToLimit(toasts: ToastItem[]): ToastItem[] {
  if (toasts.length <= MAX_TOASTS) return toasts;
  const kept = [...toasts];
  while (kept.length > MAX_TOASTS) {
    let index = kept.length - 1;
    for (let i = kept.length - 1; i >= 0; i -= 1) {
      if (kept[i]!.ttlMs !== null) {
        index = i;
        break;
      }
    }
    kept.splice(index, 1);
  }
  return kept;
}

function generateToastId() {
  return `toast_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef(new Map<string, number>());
  const dedupeRef = useRef(new Map<string, number>());

  const clearTimer = useCallback((id: string) => {
    const handle = timersRef.current.get(id);
    if (handle !== undefined) {
      window.clearTimeout(handle);
      timersRef.current.delete(id);
    }
  }, []);

  const dismissToast = useCallback(
    (id: string) => {
      clearTimer(id);
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    },
    [clearTimer],
  );

  const clearToasts = useCallback(() => {
    for (const handle of timersRef.current.values()) {
      window.clearTimeout(handle);
    }
    timersRef.current.clear();
    setToasts([]);
  }, []);

  const pushToast = useCallback(
    (input: ToastInput) => {
      const now = Date.now();
      const tone = input.tone ?? "info";
      const ttlMs = normalizeTtl(input.ttlMs, tone);
      const id = input.id ?? generateToastId();

      // An explicit id is a caller's request to keep one live message and
      // update it in place. Do not dedupe those updates: rapid company
      // switches, for example, must replace the previous company's message
      // even when the person returns to a company they just viewed.
      if (!input.id) {
        const dedupeKey =
          input.dedupeKey ?? `${tone}|${input.title}|${input.body ?? ""}|${input.action?.href ?? ""}`;

        for (const [key, ts] of dedupeRef.current.entries()) {
          if (now - ts > DEDUPE_MAX_AGE_MS) {
            dedupeRef.current.delete(key);
          }
        }

        const lastSeen = dedupeRef.current.get(dedupeKey);
        if (lastSeen && now - lastSeen < DEDUPE_WINDOW_MS) {
          return null;
        }
        dedupeRef.current.set(dedupeKey, now);
      }

      clearTimer(id);

      setToasts((prev) => {
        const nextToast: ToastItem = {
          id,
          title: input.title,
          body: input.body,
          tone,
          ttlMs,
          action: input.action,
          createdAt: now,
        };

        const withoutCurrent = prev.filter((toast) => toast.id !== id);
        return trimToLimit([nextToast, ...withoutCurrent]);
      });

      if (ttlMs !== null) {
        const timeout = window.setTimeout(() => {
          dismissToast(id);
        }, ttlMs);
        timersRef.current.set(id, timeout);
      }
      return id;
    },
    [clearTimer, dismissToast],
  );

  useEffect(() => () => {
    for (const handle of timersRef.current.values()) {
      window.clearTimeout(handle);
    }
    timersRef.current.clear();
  }, []);

  const actions = useMemo<ToastActionsContextValue>(
    () => ({
      pushToast,
      dismissToast,
      clearToasts,
    }),
    [pushToast, dismissToast, clearToasts],
  );

  return (
    <ToastActionsContext.Provider value={actions}>
      <ToastStateContext.Provider value={toasts}>{children}</ToastStateContext.Provider>
    </ToastActionsContext.Provider>
  );
}

export function useToastState() {
  const context = useContext(ToastStateContext);
  if (!context) {
    throw new Error("useToastState must be used within a ToastProvider");
  }
  return context;
}

export function useToastActions() {
  const context = useContext(ToastActionsContext);
  if (!context) {
    throw new Error("useToastActions must be used within a ToastProvider");
  }
  return context;
}

export function useToast() {
  const toasts = useToastState();
  const actions = useToastActions();
  return useMemo<ToastContextValue>(() => ({ toasts, ...actions }), [toasts, actions]);
}
