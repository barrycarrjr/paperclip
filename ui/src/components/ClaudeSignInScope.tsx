import { Link } from "@/lib/router";

/**
 * Whose sign-in is broken: this agent's, or the whole computer's.
 *
 * Paperclip has two Claude credentials and the failure page only ever talked
 * about one of them. An agent normally signs in with the computer's own Claude
 * login, shared by every agent in every company on that machine. An agent can
 * instead be given its own saved token, which overrides that.
 *
 * The page used to say "paste a token here" for both cases, and the token it
 * offered only ever reached the one agent, in the one company. When the
 * computer's login ran out, that read as one broken agent at a time: ten agents
 * across several companies failed for three days, and pasting on any one of
 * their pages would have fixed exactly that one - while the operator had no way
 * of knowing the other nine were sitting there.
 *
 * So the first thing on the panel is which of the two is actually wrong, and
 * where the fix for it lives.
 */
export function ClaudeSignInScope({
  usesOwnToken,
  otherAgentsAffected,
}: {
  /** True when this agent has its own saved token rather than sharing the computer's. */
  usesOwnToken: boolean;
  /** How many OTHER agents are currently failing to sign in. */
  otherAgentsAffected: number;
}) {
  if (usesOwnToken) {
    return (
      <p className="text-xs text-muted-foreground">
        This agent has its own saved Claude token, so the computer's sign-in is not what is wrong
        here. Its own token has stopped working, and pasting a new one below replaces it.
      </p>
    );
  }

  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        This agent signs in with the computer's Claude login, which every agent on this computer
        shares. Fixing it once there fixes all of them.
      </p>
      {otherAgentsAffected > 0 && (
        <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
          {otherAgentsAffected === 1
            ? "1 other agent cannot sign in either."
            : `${otherAgentsAffected} other agents cannot sign in either.`}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        <Link to="/instance/settings/adapters" className="underline">
          Fix the computer's Claude sign-in
        </Link>{" "}
        (Instance settings, Adapters). Needs instance admin. Pasting a token below instead fixes
        only this one agent, and stops it following any later fix made there.
      </p>
    </div>
  );
}
