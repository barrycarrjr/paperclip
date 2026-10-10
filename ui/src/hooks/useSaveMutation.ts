import { useCallback, useMemo, useRef } from "react";
import {
  useMutation,
  type DefaultError,
  type UseMutationOptions,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useOptionalToastActions } from "../context/ToastContext";

/**
 * What a save says when it works: a fixed line such as "Profile saved", or a
 * function that words it from the result and from what was sent. Returning
 * null from the function says nothing for that one call.
 */
export type SaveSuccessMessage<TData, TVariables> =
  | string
  | ((data: TData, variables: TVariables) => string | null);

export type UseSaveMutationOptions<
  TData = unknown,
  TError = DefaultError,
  TVariables = void,
  TOnMutateResult = unknown,
> = UseMutationOptions<TData, TError, TVariables, TOnMutateResult> & {
  successMessage: SaveSuccessMessage<TData, TVariables>;
  /**
   * Title of a message for a failed save, with the reason the server gave
   * underneath. Only for a save whose page shows its failures nowhere else:
   * leave it out where the page already shows the error, or it says it twice.
   */
  errorMessage?: string;
};

/** Said when a save worked but its own message could not be worded. */
const FALLBACK_SAVED_MESSAGE = "Saved";

/**
 * Tells the person that a save they asked for worked, and takes it back if
 * the next try of that same save fails.
 *
 * The message goes to the toast viewport, the app's usual place for "it
 * worked" and "it failed". It is fixed to the screen, so it is seen however
 * far down the page the Save button was, and it is a polite live region, so a
 * screen reader reads it out. Not inside a modal dialog or sheet, though: the
 * dialog hides everything behind it from a screen reader, and a click on the
 * message counts as a click outside the dialog and closes it. Say it inside
 * the dialog there instead.
 *
 * Saying the same thing again replaces the message on screen and restarts its
 * timer, and it arrives as a new message, so a second save straight after the
 * first gets a confirmation of its own.
 *
 * withdrawSaved removes the message this save put up. Without it, a failed
 * second try a moment after a good one showed "Budget saved" next to "Could
 * not save the budget".
 */
export function useSaveConfirmation() {
  const toastActions = useOptionalToastActions();
  const shownIdRef = useRef<string | null>(null);

  const confirmSaved = useCallback(
    (title: string) => {
      const id = `saved:${title}`;
      shownIdRef.current = id;
      toastActions?.pushToast({ id, title, tone: "success" });
    },
    [toastActions],
  );

  const withdrawSaved = useCallback(() => {
    if (shownIdRef.current) toastActions?.dismissToast(shownIdRef.current);
    shownIdRef.current = null;
  }, [toastActions]);

  return useMemo(() => ({ confirmSaved, withdrawSaved }), [confirmSaved, withdrawSaved]);
}

/**
 * useMutation for a save, update or create the person asked for. It says so
 * when the request succeeds.
 *
 * A form that keeps showing what was typed looks the same after a save that
 * worked as it did before the click, so without a message there is no way to
 * tell the save happened. Taking the message as a required option means a
 * form built on this cannot leave it out.
 *
 * The confirmation waits for the page's own onSuccess to finish, so a page
 * that reloads its data there confirms once the new data is in, and nothing
 * is confirmed for a save that failed. Failures are left to the page unless
 * errorMessage is set; either way a failure takes back this save's earlier
 * confirmation.
 */
export function useSaveMutation<
  TData = unknown,
  TError = DefaultError,
  TVariables = void,
  TOnMutateResult = unknown,
>({
  successMessage,
  errorMessage,
  onSuccess,
  onError,
  ...options
}: UseSaveMutationOptions<TData, TError, TVariables, TOnMutateResult>): UseMutationResult<
  TData,
  TError,
  TVariables,
  TOnMutateResult
> {
  const { confirmSaved, withdrawSaved } = useSaveConfirmation();
  const pushToast = useOptionalToastActions()?.pushToast;

  return useMutation<TData, TError, TVariables, TOnMutateResult>({
    ...options,
    onSuccess: async (data, variables, onMutateResult, context) => {
      await onSuccess?.(data, variables, onMutateResult, context);
      // The save has already reached the server by now. A wording function
      // that trips over the reply (an empty one, say) must not turn that into
      // a reported failure, so it falls back to a plain "Saved".
      let message: string | null;
      try {
        message = typeof successMessage === "function" ? successMessage(data, variables) : successMessage;
      } catch {
        message = FALLBACK_SAVED_MESSAGE;
      }
      if (message) confirmSaved(message);
    },
    onError: async (error, variables, onMutateResult, context) => {
      withdrawSaved();
      if (errorMessage) {
        pushToast?.({
          title: errorMessage,
          body: error instanceof Error ? error.message : String(error),
          tone: "error",
        });
      }
      await onError?.(error, variables, onMutateResult, context);
    },
  });
}
