import { useCallback, useId, useMemo, useRef } from "react";
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

/**
 * The title of a failed save's message: a fixed line such as "Could not save
 * settings", or a function that words it from what was sent, so it can name
 * the item that failed.
 */
export type SaveFailureMessage<TError, TVariables> =
  | string
  | ((error: TError, variables: TVariables) => string);

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
   * Where one hook saves several items, word it from what was sent to name
   * the item ("Could not save the budget for Ada").
   */
  errorMessage?: SaveFailureMessage<TError, TVariables>;
  /**
   * A fixed name for this save, such as "costs-budget": the same on every
   * visit to its page, and different from every other save's. Its failure
   * messages are filed under it, so they outlast the visit: back on the page,
   * a save of the same item that works takes the old failure back, and the
   * same failure again replaces it rather than adding a second. Without a
   * name, failures are filed under the one visit.
   */
  saveName?: string;
  /**
   * For a hook that saves several items (a card each, or whichever user is
   * picked): which item a save is for. Each item keeps its own failure
   * message, and a save that works takes back only its own item's. Without
   * it, a second card saving fine took back the first card's failure, and the
   * first card looked saved while it still showed an amount that never went
   * through.
   */
  saveKey?: (variables: TVariables) => string;
};

/** Said when a save worked but its own message could not be worded. */
const FALLBACK_SAVED_MESSAGE = "Saved";

/** Said when a save failed but its own message could not be worded. */
const FALLBACK_FAILED_MESSAGE = "Could not save";

/** The item a save is for when the hook saves only one thing. */
const SINGLE_ITEM_KEY = "";

/**
 * Tells the person whether a save they asked for worked, and takes each
 * message back once the next try of that same save turns out the other way.
 *
 * For a page that saves several items through one of these (one per agent,
 * say), pass each call the item's key, so each item's failure stays until a
 * save of that item works. Give it a fixed saveName too, so that holds across
 * visits to the page.
 *
 * The message goes to the toast viewport, the app's usual place for "it
 * worked" and "it failed". It is fixed to the screen, so it is seen however
 * far down the page the Save button was, and it is a polite live region, so a
 * screen reader reads it out. Not inside a modal dialog or sheet, though: the
 * dialog hides everything behind it from a screen reader, and a click on the
 * message counts as a click outside the dialog and closes it. Say it inside
 * the dialog there instead.
 *
 * Each message has a fixed id. Saying the same thing again replaces the
 * message on screen rather than adding a second one, and it arrives as a new
 * message, so a second save straight after the first gets a message of its
 * own. "Saved" also starts its timer again. A failure has no timer, since it
 * stays until it is closed, but a repeat still replaces it: without the id,
 * the same failure again within a few seconds was taken for a duplicate and
 * showed nothing at all.
 *
 * A "saved" message's id is made from its title. A failure's is made from
 * the save's fixed name and the item it is about (key, for a hook that saves
 * several items), not from its title: the same words come from more than one
 * place ("Could not save the budget" from the costs page, an agent and a
 * project), and with the title as the id, one place's failure replaced
 * another's, and a later save that worked anywhere took it back. The name
 * makes a failure said on an earlier visit to the page the same message as
 * one said now, so it is taken back and replaced by id. With an id made for
 * each visit, a save that worked after coming back left the old failure up
 * beside "Budget saved", and the same failure again added a second message.
 * A save given no name falls back to an id made for the one visit.
 *
 * Each outcome takes back the other one's message, so the two are never on
 * screen together. A failed second try a moment after a good one used to show
 * "Budget saved" next to "Could not save the budget", and a good try after a
 * failed one left the failure up beside the "saved" message. A save that
 * works takes back only the failure of its own item.
 *
 * confirmSaved and reportFailed say how it went. withdrawSaved and
 * withdrawFailed take a message back without saying anything new, for a save
 * that shows its own failures on the page, or one that worked but has nothing
 * to say.
 */
export function useSaveConfirmation({ saveName }: { saveName?: string } = {}) {
  const toastActions = useOptionalToastActions();
  // Stands in for saveName when there is none: stable for as long as the
  // component using this is on the page, and different for every other one.
  const visitId = useId();
  const shownIdRef = useRef<string | null>(null);

  const failureId = useCallback(
    (key: string) => `failed:${saveName ?? visitId}:${key}`,
    [saveName, visitId],
  );

  const withdrawSaved = useCallback(() => {
    if (shownIdRef.current) toastActions?.dismissToast(shownIdRef.current);
    shownIdRef.current = null;
  }, [toastActions]);

  /**
   * Takes back the failure message of the item saved under key. By its id,
   * so one said on an earlier visit to the page goes too.
   */
  const withdrawFailed = useCallback(
    (key: string = SINGLE_ITEM_KEY) => {
      toastActions?.dismissToast(failureId(key));
    },
    [failureId, toastActions],
  );

  /** Says the save of the item under key worked. */
  const confirmSaved = useCallback(
    (title: string, key: string = SINGLE_ITEM_KEY) => {
      withdrawFailed(key);
      const id = `saved:${title}`;
      shownIdRef.current = id;
      toastActions?.pushToast({ id, title, tone: "success" });
    },
    [toastActions, withdrawFailed],
  );

  /**
   * Says the save of the item under key failed, with the reason the server
   * gave underneath.
   */
  const reportFailed = useCallback(
    (title: string, error: unknown, key: string = SINGLE_ITEM_KEY) => {
      withdrawSaved();
      toastActions?.pushToast({
        id: failureId(key),
        title,
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    },
    [failureId, toastActions, withdrawSaved],
  );

  return useMemo(
    () => ({ confirmSaved, withdrawSaved, reportFailed, withdrawFailed }),
    [confirmSaved, withdrawSaved, reportFailed, withdrawFailed],
  );
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
 * confirmation, and a save that works takes back the earlier failure message
 * of the same item (see saveKey), even when it has nothing to say itself.
 */
export function useSaveMutation<
  TData = unknown,
  TError = DefaultError,
  TVariables = void,
  TOnMutateResult = unknown,
>({
  successMessage,
  errorMessage,
  saveName,
  saveKey,
  onSuccess,
  onError,
  ...options
}: UseSaveMutationOptions<TData, TError, TVariables, TOnMutateResult>): UseMutationResult<
  TData,
  TError,
  TVariables,
  TOnMutateResult
> {
  const { confirmSaved, withdrawSaved, reportFailed, withdrawFailed } = useSaveConfirmation({ saveName });

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
      const key = saveKey?.(variables);
      if (message) confirmSaved(message, key);
      else withdrawFailed(key);
    },
    onError: async (error, variables, onMutateResult, context) => {
      if (errorMessage) {
        // As with successMessage, a wording function that trips must not
        // lose the failure, or the page's own onError after it.
        let title: string;
        try {
          title = typeof errorMessage === "function" ? errorMessage(error, variables) : errorMessage;
        } catch {
          title = FALLBACK_FAILED_MESSAGE;
        }
        reportFailed(title, error, saveKey?.(variables));
      } else {
        withdrawSaved();
      }
      await onError?.(error, variables, onMutateResult, context);
    },
  });
}
