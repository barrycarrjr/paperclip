import { AlertCircle, Bot, Loader2 } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FILLS_OR_KEEPS_HEIGHT_CLASS } from "@/lib/narrow-layout";
import { cn } from "@/lib/utils";
import { EmailAgentHoldPanel } from "./EmailAgentHoldPanel";
import type { EmailHandoffSummary, TakeOverHandoffResult } from "@/api/emailHandoffs";

/**
 * Every message an agent is holding, in one place.
 *
 * This is a list of handovers rather than a list of mail, and that is on
 * purpose: a message that has been handed over is usually already read and
 * usually not in the newest fifty, so reading the mailbox again would miss
 * most of them. The records know what was handed over, when, to whom, and
 * what work it became, so the list is built from those.
 */
export function EmailAgentHoldList({
  companyId,
  holds,
  loading,
  error,
  onTakenOver,
}: {
  companyId: string;
  holds: EmailHandoffSummary[];
  loading: boolean;
  error: Error | null;
  onTakenOver: (result: TakeOverHandoffResult, agentName: string) => void;
}) {
  if (loading) {
    return (
      <div className={cn(FILLS_OR_KEEPS_HEIGHT_CLASS, "flex items-center justify-center")}>
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn(FILLS_OR_KEEPS_HEIGHT_CLASS, "flex items-center justify-center px-4")}>
        <div className="text-center space-y-1">
          <AlertCircle className="h-5 w-5 text-destructive mx-auto" />
          {/* An empty list and a list that could not be read are different
              answers, and only one of them means no agent has anything. */}
          <p className="text-xs text-muted-foreground">
            Could not check what agents are holding. {error.message}
          </p>
        </div>
      </div>
    );
  }

  if (holds.length === 0) {
    return (
      <div className={cn(FILLS_OR_KEEPS_HEIGHT_CLASS, "flex flex-col items-center justify-center gap-2 px-4 text-center")}>
        <Bot className="h-5 w-5 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">No agent is holding any mail right now.</p>
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1">
      <div className="space-y-2 p-2">
        {holds.map((hold) => (
          <EmailAgentHoldPanel
            key={hold.id}
            companyId={companyId}
            hold={hold}
            showSource
            onTakenOver={onTakenOver}
          />
        ))}
      </div>
    </ScrollArea>
  );
}
