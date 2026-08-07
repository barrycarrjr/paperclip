/**
 * What the queue is not showing you.
 *
 * Failures that have not happened again in a fortnight stop counting as
 * something waiting on you: nothing is retrying that work, so it is history
 * rather than a decision. Two such rows had been sitting in "Awaiting your tap"
 * since May on the instance this was built for, next to a live row about the
 * same agent failing forty-three times that week.
 *
 * Holding them back is only honest if the holding back is visible. A list that
 * quietly shows fewer rows than it has is the same trap as a control that only
 * appears on hover - you cannot act on what you cannot see is there. So the
 * count is always stated, and one tap brings them back.
 */
export function SetAsideNotice({
  count,
  showing,
  onToggle,
}: {
  /** How many rows have gone quiet. Nothing renders when this is zero. */
  count: number;
  /** Whether those rows are currently in the list. */
  showing: boolean;
  onToggle: () => void;
}) {
  if (count <= 0) return null;

  return (
    <button
      type="button"
      onClick={onToggle}
      className="block w-full px-4 py-2.5 text-center text-[12px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
    >
      {showing
        ? "Hide the older ones"
        : `${count} older ${count === 1 ? "failure has" : "failures have"} gone quiet — show ${count === 1 ? "it" : "them"}`}
    </button>
  );
}
