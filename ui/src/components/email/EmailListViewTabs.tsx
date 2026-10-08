import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  EMAIL_LIST_VIEWS,
  EMAIL_LIST_VIEW_LABEL,
  type EmailListView,
} from "@/lib/email-list-view";

/**
 * The three views of the list: All mail, Unread and With agents.
 *
 * Switching only on a click or a key press, never on focus alone. The tab
 * bar's default is to switch the moment a tab receives focus, and the choice
 * is saved as the person's preference, so anything that moved focus onto
 * "All mail" (a closing dialog, a browser restoring focus) silently changed
 * the remembered view to the one that downloads every message. With manual
 * activation the arrow keys still move between tabs, and Enter or Space picks.
 */
export function EmailListViewTabs({
  value,
  onChange,
  agentHoldCount,
}: {
  value: EmailListView;
  onChange: (view: EmailListView) => void;
  agentHoldCount: number;
}) {
  return (
    <div className="px-2 py-1.5 border-b border-border shrink-0 overflow-hidden">
      <Tabs
        value={value}
        activationMode="manual"
        onValueChange={(v) => onChange(v as EmailListView)}
      >
        {/* Each tab keeps its own text on one line, which makes it as wide as
            its longest word by default and lets the three of them paint out
            over the mailbox column beside them when the column is narrow.
            `min-w-0` lets a tab give way instead, and the label then cuts
            short with three dots inside its own tab. */}
        <TabsList className="w-full min-w-0">
          {EMAIL_LIST_VIEWS.map((view) => (
            <TabsTrigger key={view} value={view} className="min-w-0 text-xs">
              <span className="truncate">{EMAIL_LIST_VIEW_LABEL[view]}</span>
              {view === "agents" && agentHoldCount > 0 && (
                <span className="ml-1 shrink-0 text-[10px] text-muted-foreground">
                  {agentHoldCount}
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );
}
