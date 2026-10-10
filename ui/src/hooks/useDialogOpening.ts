import { useLayoutEffect, useMemo, useRef } from "react";

/** One opening of a dialog, told apart from every other by identity alone. */
export type DialogOpening = object;

/**
 * Which opening of a dialog is on screen, so the answer to a request can tell
 * whether the dialog it was sent from is still there.
 *
 * Send current() with the request, and ask isShowing() about it when the
 * answer comes back. A dialog that sends a request stays open until the answer
 * comes (closing it does nothing until then), but the component holding it can
 * still go first: browser Back leaves the page, and Skill Studio rebuilds its
 * panes when it switches between side by side panes and tabs (the window
 * crossing 900 px, or the studio's own width changing as Clippy docks or the
 * navigation opens). TanStack Query still runs the
 * onSuccess and onError given to useMutation after that, with the values from
 * the last render, and state set by them on a component that has gone goes
 * nowhere. So when the opening is no longer showing, a failure goes to a
 * toast, which is safe once no dialog is open, and a success changes nothing
 * the person has moved on to: it does not close or reset a later opening of
 * the dialog, or open what was made.
 */
export function useDialogOpening(open: boolean) {
  const showingRef = useRef<DialogOpening | null>(null);

  // A layout effect, so the opening ends the moment the dialog closes or its
  // component unmounts, before an answer arriving straight after can look.
  useLayoutEffect(() => {
    if (!open) return;
    const opening: DialogOpening = {};
    showingRef.current = opening;
    return () => {
      if (showingRef.current === opening) showingRef.current = null;
    };
  }, [open]);

  return useMemo(
    () => ({
      /** The opening on screen now, or null while the dialog is closed. */
      current: () => showingRef.current,
      /** Whether that opening is still the one on screen. */
      isShowing: (opening: DialogOpening | null | undefined) =>
        opening != null && opening === showingRef.current,
    }),
    [],
  );
}
