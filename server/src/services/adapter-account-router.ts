/**
 * Choosing which account signs a run in, and moving off one that has run out.
 *
 * Each adapter signs in as one account at a time, so every agent using that
 * adapter shares one subscription's limits. When that subscription's window is
 * spent, every one of those agents stops, and the bounded retry ladder (2
 * minutes, 10, 30, then 2 hours) burns all four rungs against a window that
 * does not reopen for days.
 *
 * The fix is a list of accounts per adapter and one active choice. A run that
 * fails because its plan is spent marks that account as out until its reset
 * time, moves the active choice to the next account with room, and is retried
 * there. The move is sticky and instance-wide, so only the first failure pays
 * for it rather than every agent discovering the wall separately.
 *
 * Everything here is pure: no database, no filesystem, no process environment.
 * State comes in as a plain object and a decision comes out, which is what
 * makes the interesting cases (a concurrent run that already moved, every
 * account out, a flap between two) testable without a running instance.
 */

/**
 * How long a just-abandoned account stays off the table.
 *
 * Guards the case where the reset times are unknown: without it, two spent
 * accounts hand runs back and forth as fast as the scheduler can dispatch them.
 * When a real reset time is known, `exhaustedUntil` does the work and this is
 * only the backstop.
 */
export const ACCOUNT_SWITCH_COOLDOWN_MS = 10 * 60 * 1000;

export interface AdapterAccountSlot {
  /** Stable id, used as the active-account key and in run context. */
  slot: string;
  /** The long-lived `sk-ant-oat01-...` token this account signs in with. */
  token: string;
  /** What a person calls this account. A token carries no account name. */
  label: string;
  /** A disabled account stays configured but is never selected. */
  enabled?: boolean;
}

export interface AdapterAccountState {
  /** Configured accounts, in preference order. */
  slots: AdapterAccountSlot[];
  /** The account new runs sign in with. Empty when nothing is configured. */
  activeSlot: string;
  /** The most recent move, for the cooldown. */
  lastSwitch: { at: number; from: string; to: string } | null;
  /** Per account, the epoch ms before which it is known to have nothing left. */
  exhaustedUntil: Record<string, number>;
}

export type AdapterAccountSwitch =
  /** Move the active account and retry there. */
  | { kind: "switch"; to: string; from: string }
  /** Another run already moved us; retry on the new account without moving again. */
  | { kind: "adopt"; to: string }
  /** Nothing has room. `resetsAt` is the earliest known return, if any. */
  | { kind: "exhausted"; resetsAt: number | null }
  /** Not a failure this router acts on. */
  | null;

export const EMPTY_ADAPTER_ACCOUNT_STATE: AdapterAccountState = {
  slots: [],
  activeSlot: "",
  lastSwitch: null,
  exhaustedUntil: {},
};

function usableSlots(state: AdapterAccountState): AdapterAccountSlot[] {
  return state.slots.filter((slot) => slot.enabled !== false && slot.token.trim().length > 0);
}

function findSlot(state: AdapterAccountState, slot: string): AdapterAccountSlot | null {
  if (!slot) return null;
  return usableSlots(state).find((candidate) => candidate.slot === slot) ?? null;
}

/**
 * The account a new run should sign in with.
 *
 * Falls back to the first usable account when the recorded active one has been
 * removed or disabled, so editing the list cannot strand the instance on an
 * account that no longer exists. Returns null when nothing is configured, which
 * is what keeps an install with no accounts on its existing single sign-in.
 */
export function activeAccount(state: AdapterAccountState): AdapterAccountSlot | null {
  const usable = usableSlots(state);
  if (usable.length === 0) return null;
  return findSlot(state, state.activeSlot) ?? usable[0] ?? null;
}

/** The active account and the standbys, for a status line. Never a token. */
export function describeAccounts(state: AdapterAccountState, now = Date.now()): string {
  const usable = usableSlots(state);
  if (usable.length === 0) return "No accounts configured";
  const active = activeAccount(state);
  return usable
    .map((slot) => {
      const until = state.exhaustedUntil[slot.slot] ?? 0;
      if (slot.slot === active?.slot) return `${slot.label} (active)`;
      if (until > now) return `${slot.label} (out until ${new Date(until).toISOString()})`;
      return `${slot.label} (standby)`;
    })
    .join(" · ");
}

/**
 * Whether an account is known to have nothing left right now.
 *
 * Two clocks matter and the later one wins. `exhaustedUntil` is the account's
 * own reset time, which can be days out. The cooldown is a much shorter guard
 * that only applies to the account we have just moved away from.
 */
function accountUnavailableUntil(
  state: AdapterAccountState,
  slot: string,
  justLeft: string | null,
): number {
  const resets = state.exhaustedUntil[slot] ?? 0;
  const cooled =
    state.lastSwitch && state.lastSwitch.from === slot && slot !== justLeft
      ? state.lastSwitch.at + ACCOUNT_SWITCH_COOLDOWN_MS
      : 0;
  return Math.max(resets, cooled);
}

/**
 * What to do about a run that has just failed.
 *
 * Only `plan_exhausted` is acted on. A `transient_upstream` failure is the
 * provider being busy, and the same account will very likely work in two
 * minutes, so moving accounts for one would spread load onto a second
 * subscription for no reason and hide a real outage behind a rotation.
 */
export function accountSwitchDecision(input: {
  state: AdapterAccountState;
  /** The account the failed run signed in with, or null if it used its own token. */
  ranOn: string | null;
  family: "plan_exhausted" | "transient_upstream" | null;
  /** When the failed account comes back, from the CLI's rate-limit event. */
  resetsAt: number | null;
  now: number;
}): AdapterAccountSwitch {
  const { state, ranOn, family, resetsAt, now } = input;
  if (family !== "plan_exhausted") return null;
  if (!ranOn) return null;

  const usable = usableSlots(state);
  if (usable.length === 0) return null;

  // A sibling run hit the same wall while ours was in flight and has already
  // moved. Retrying on the account it chose is right; moving again would skip
  // a perfectly good account for every run that was in flight at the time.
  if (state.activeSlot && state.activeSlot !== ranOn) {
    const adopted = findSlot(state, state.activeSlot);
    if (adopted && accountUnavailableUntil(state, adopted.slot, ranOn) <= now) {
      return { kind: "adopt", to: adopted.slot };
    }
  }

  // The account that just failed is out until its window resets. Fold that in
  // before choosing, so it cannot be picked again on this pass.
  const exhaustedUntil: Record<string, number> = {
    ...state.exhaustedUntil,
    [ranOn]: Math.max(state.exhaustedUntil[ranOn] ?? 0, resetsAt ?? now + ACCOUNT_SWITCH_COOLDOWN_MS),
  };
  const withFailure: AdapterAccountState = { ...state, exhaustedUntil };

  for (const candidate of usable) {
    if (candidate.slot === ranOn) continue;
    if (accountUnavailableUntil(withFailure, candidate.slot, ranOn) > now) continue;
    return { kind: "switch", to: candidate.slot, from: ranOn };
  }

  // Nothing left. Report the earliest known return so the caller can schedule a
  // retry for then rather than backing off into a wall.
  const known = usable
    .map((slot) => exhaustedUntil[slot.slot] ?? 0)
    .filter((value) => value > now);
  const earliest = known.length === usable.length && known.length > 0 ? Math.min(...known) : null;
  return { kind: "exhausted", resetsAt: earliest ?? resetsAt ?? null };
}

/**
 * The state after a decision is acted on.
 *
 * Kept beside the decision so persistence has nothing to work out for itself,
 * and so the transition is covered by the same tests as the decision.
 */
export function applyAccountSwitch(input: {
  state: AdapterAccountState;
  decision: AdapterAccountSwitch;
  ranOn: string | null;
  resetsAt: number | null;
  now: number;
}): AdapterAccountState {
  const { state, decision, ranOn, resetsAt, now } = input;
  if (!decision || !ranOn) return state;

  const exhaustedUntil = { ...state.exhaustedUntil };
  if (decision.kind !== "adopt") {
    exhaustedUntil[ranOn] = Math.max(
      exhaustedUntil[ranOn] ?? 0,
      resetsAt ?? now + ACCOUNT_SWITCH_COOLDOWN_MS,
    );
  }

  if (decision.kind !== "switch") {
    return { ...state, exhaustedUntil };
  }

  return {
    ...state,
    activeSlot: decision.to,
    lastSwitch: { at: now, from: decision.from, to: decision.to },
    exhaustedUntil,
  };
}

/**
 * Drop reset times that have passed.
 *
 * Called before a decision so an account whose window reopened while nothing
 * was running becomes selectable again without needing a failure to clear it.
 */
export function forgetExpiredAccountLimits(
  state: AdapterAccountState,
  now: number,
): AdapterAccountState {
  const exhaustedUntil: Record<string, number> = {};
  for (const [slot, until] of Object.entries(state.exhaustedUntil)) {
    if (until > now) exhaustedUntil[slot] = until;
  }
  return Object.keys(exhaustedUntil).length === Object.keys(state.exhaustedUntil).length
    ? state
    : { ...state, exhaustedUntil };
}
