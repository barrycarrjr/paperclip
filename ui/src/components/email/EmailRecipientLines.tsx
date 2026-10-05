import { Fragment } from "react";
import { cn } from "../../lib/utils";
import { recipientDisplayName, splitAddressList } from "./emailRecipients";

interface EmailRecipientLinesProps {
  from: string;
  to?: readonly string[];
  cc?: readonly string[];
  className?: string;
}

/**
 * The sender, To and Cc lines above an open email, laid out as Outlook lays
 * them out: the sender on its own line, then a "To" row and a "Cc" row, each
 * recipient by name and separated by semicolons, with the full address on
 * hover. A row with nobody on it is left off.
 *
 * The Email page's reading pane and the full-size pop-out both draw it, so the
 * two cannot drift apart. Before this, both showed To only, and a message
 * copied to the operator looked as though it had been sent to someone else.
 */
export function EmailRecipientLines({ from, to, cc, className }: EmailRecipientLinesProps) {
  return (
    <div className={cn("space-y-0.5 text-xs text-muted-foreground", className)}>
      <div className="break-words font-medium text-foreground">{from}</div>
      <RecipientRow label="To" recipients={splitAddressList(to)} />
      <RecipientRow label="Cc" recipients={splitAddressList(cc)} />
    </div>
  );
}

function RecipientRow({ label, recipients }: { label: string; recipients: string[] }) {
  if (recipients.length === 0) return null;
  return (
    <div className="flex gap-2">
      <span className="w-5 shrink-0">{label}</span>
      <span className="min-w-0 break-words text-foreground">
        {recipients.map((recipient, i) => (
          <Fragment key={`${i}-${recipient}`}>
            {i > 0 && "; "}
            {/* A native title, as EmailStateIcons uses, keeps the full
                address one hover away. */}
            <span title={recipient}>{recipientDisplayName(recipient)}</span>
          </Fragment>
        ))}
      </span>
    </div>
  );
}
