import { useRef, useState } from "react";
import { AlarmClock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatSnoozeChoiceTime, snoozeOptions } from "@/lib/email-snooze";
import { EmailSnoozeDialog } from "../EmailSnoozeDialog";

const SNOOZE_HINT = "Snooze (hide it until later, then bring it back unread)";

interface EmailSnoozeMenuProps {
  /** Called with the moment the email should come back. */
  onSnooze: (until: Date) => void;
  pending?: boolean;
  /**
   * "toolbar" is the outlined button above an open email, with a tooltip.
   * "row" is the plain icon in a list row's hover buttons, matching its
   * neighbours there. "group" is the plain icon in a sender group's header,
   * with a tooltip like its neighbours.
   */
  placement?: "toolbar" | "row" | "group";
  /**
   * Told when the menu or the date dialog opens or closes. A row's hover
   * buttons hide once the pointer leaves the row, so the row uses this to
   * keep them showing while either is open.
   */
  onActiveChange?: (active: boolean) => void;
  /** Hover text; a sender group says it snoozes all of them. */
  hint?: string;
}

/**
 * The snooze button and its "Snooze until..." menu (Later today, Tomorrow,
 * ... each with its real time, then "Pick date & time"). One component so
 * the open email, the company Email list and the HQ all-mail list offer the
 * same choices.
 */
export function EmailSnoozeMenu({
  onSnooze,
  pending = false,
  placement = "toolbar",
  onActiveChange,
  hint = SNOOZE_HINT,
}: EmailSnoozeMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  // Worked out when the menu opens, so the times shown match the moment
  // the operator is looking at them.
  const [menuNow, setMenuNow] = useState(() => new Date());
  // Choosing "Pick date & time" opens the dialog and closes the menu in the
  // same event, before state updates land, so the latest values live here.
  const openRef = useRef({ menu: false, dialog: false });

  function report() {
    onActiveChange?.(openRef.current.menu || openRef.current.dialog);
  }

  function changeMenu(open: boolean) {
    if (open) setMenuNow(new Date());
    openRef.current.menu = open;
    setMenuOpen(open);
    report();
  }

  function changeDialog(open: boolean) {
    openRef.current.dialog = open;
    setDialogOpen(open);
    report();
  }

  // Rows and group headers use the plain icon style of their neighbours; only
  // plain rows use a browser title, as their neighbours do, the others a tooltip.
  const isPlain = placement !== "toolbar";
  const trigger = (
    <DropdownMenuTrigger asChild>
      <Button
        size="icon-sm"
        variant={isPlain ? "ghost" : "outline"}
        disabled={pending}
        aria-label="Snooze"
        title={placement === "row" ? hint : undefined}
        className={cn(isPlain && "text-muted-foreground hover:text-foreground")}
      >
        {pending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <AlarmClock className="h-3.5 w-3.5" />
        )}
      </Button>
    </DropdownMenuTrigger>
  );

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={changeMenu}>
        {placement === "row" ? (
          trigger
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>{trigger}</TooltipTrigger>
            <TooltipContent>{hint}</TooltipContent>
          </Tooltip>
        )}
        <DropdownMenuContent align={isPlain ? "end" : "start"} className="min-w-64">
          <DropdownMenuLabel>Snooze until...</DropdownMenuLabel>
          {snoozeOptions(menuNow).map((opt) => (
            <DropdownMenuItem
              key={opt.key}
              className="justify-between gap-6"
              onSelect={() => onSnooze(opt.until)}
            >
              <span>{opt.label}</span>
              <span className="text-xs text-muted-foreground">
                {formatSnoozeChoiceTime(opt.until, menuNow)}
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => changeDialog(true)}>Pick date &amp; time</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <EmailSnoozeDialog open={dialogOpen} onOpenChange={changeDialog} onSave={onSnooze} />
    </>
  );
}
