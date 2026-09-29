import { Link } from "@/lib/router";
import { explainAgentError } from "../lib/agent-error-explanation";
import { cn } from "../lib/utils";

/**
 * What else to say about an agent that stopped with an error, under the
 * one-line reason the row already gives.
 *
 * For a failure we recognise (lib/agent-error-explanation.ts) that is what to
 * do about it and where, plus the error in its own words behind a Details
 * toggle. The toggle is the only place the raw text appears, so a page with
 * the agent listed twice (the Needs you list and the card) no longer prints
 * it twice. An error we do not recognise is already shown in its own words
 * on the row, so it gets no toggle.
 *
 * The run link is shown whenever the caller has one, recognised or not,
 * because "which run was it" is worth one click either way.
 */
export function AgentErrorNote({
  lastError,
  adapterType,
  runLink,
  className,
}: {
  lastError: string | null | undefined;
  adapterType: string | null | undefined;
  /** Where to see the failed run, when the caller knows. */
  runLink?: { to: string; label: string } | null;
  className?: string;
}) {
  const explained = explainAgentError(lastError, adapterType);
  if (!explained && !runLink) return null;

  return (
    <div className={cn("space-y-1 text-xs text-muted-foreground", className)}>
      {explained && (
        <p>
          {explained.hint}{" "}
          <Link
            to={explained.fixLink.to}
            className="underline underline-offset-2 hover:text-foreground"
          >
            {explained.fixLink.label}
          </Link>
          .
        </p>
      )}
      {runLink && (
        <p>
          <Link
            to={runLink.to}
            className="underline underline-offset-2 hover:text-foreground"
          >
            {runLink.label}
          </Link>
        </p>
      )}
      {explained && (
        <details>
          <summary className="cursor-pointer select-none hover:text-foreground">Details</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-border/60 bg-muted/30 p-2 font-mono text-[11px]">
            {explained.raw}
          </pre>
        </details>
      )}
    </div>
  );
}
