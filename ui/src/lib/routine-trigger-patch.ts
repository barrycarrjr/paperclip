import type { RoutineTrigger } from "@paperclipai/shared";

export type RoutineTriggerEditorDraft = {
  label: string;
  cronExpression: string;
  timezone: string;
  signingMode: string;
  replayWindowSec: string;
};

/**
 * The starting values for the trigger editor.
 *
 * The time zone comes from what was saved on the trigger, never from the
 * browser looking at it. That is what stops an automation set up in New York
 * from quietly moving when somebody in Tokyo opens it and saves an unrelated
 * change. `browserTimeZone` is only used for a schedule that has no zone saved
 * at all, which is the same value the page used to send silently in that case.
 */
export function buildRoutineTriggerDraft(
  trigger: RoutineTrigger,
  browserTimeZone: string,
): RoutineTriggerEditorDraft {
  return {
    label: trigger.label ?? "",
    cronExpression: trigger.cronExpression ?? "",
    timezone: trigger.timezone ?? browserTimeZone,
    signingMode: trigger.signingMode ?? "bearer",
    replayWindowSec: String(trigger.replayWindowSec ?? 300),
  };
}

export function buildRoutineTriggerPatch(
  trigger: RoutineTrigger,
  draft: RoutineTriggerEditorDraft,
  fallbackTimezone: string,
) {
  const patch: Record<string, unknown> = {
    label: draft.label.trim() || null,
  };

  if (trigger.kind === "schedule") {
    patch.cronExpression = draft.cronExpression.trim();
    // An untouched editor sends back exactly the zone that was already saved,
    // because the draft started from it. Only a person choosing a different
    // zone can change it.
    patch.timezone = draft.timezone.trim() || trigger.timezone || fallbackTimezone;
  }

  if (trigger.kind === "webhook") {
    patch.signingMode = draft.signingMode;
    patch.replayWindowSec = Number(draft.replayWindowSec || "300");
  }

  return patch;
}
