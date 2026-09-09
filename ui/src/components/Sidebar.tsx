import { SquarePen } from "lucide-react";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useGeneralSettings } from "../context/GeneralSettingsContext";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";
import { SidebarMenu } from "./SidebarMenu";

/**
 * The sidebar no longer carries its own search button or its own "What do you
 * want done?" button (removed 2026-09-07). The top bar now has both, and two
 * copies of the same control on one screen is worse than one.
 *
 * Known consequence, flagged rather than hidden: the top bar deliberately
 * hides "Start work" in portfolio scope, because work is always created inside
 * one company and a button there would quietly file it under HQ. With this
 * entry gone there is now no way to start work while you are on a portfolio
 * page; pick a company first. Instance settings and company settings are
 * unaffected, because they render InstanceSidebar / CompanySettingsSidebar
 * rather than this component, so they never had this button.
 */
export function Sidebar() {
  const { openNewIssue } = useDialog();
  const { selectedCompany } = useCompany();
  const { keyboardShortcutsEnabled } = useGeneralSettings();

  return (
    <aside className="w-60 h-full min-h-0 border-r border-border bg-sidebar flex flex-col">
      {/* Top bar: Company name (bold). Search moved to the app's top bar. */}
      <div className="flex items-center gap-1 px-3 h-12 shrink-0">
        <SidebarCompanyMenu />
      </div>

      <div className="px-3 pt-1 pb-2 shrink-0">
        <button
          onClick={() => openNewIssue()}
          className="group flex w-full items-center gap-2.5 border border-border bg-background px-3 py-1.5 text-[13px] font-medium text-foreground hover:border-foreground/30 hover:bg-accent transition-all"
        >
          <SquarePen className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-foreground transition-colors" />
          <span className="truncate">New issue</span>
          {keyboardShortcutsEnabled && (
            <kbd className="ml-auto text-[10px] text-muted-foreground/70 font-mono group-hover:text-muted-foreground transition-colors">C</kbd>
          )}
        </button>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col gap-4 px-3 py-1">
        {selectedCompany && <SidebarMenu company={selectedCompany} />}
      </nav>
    </aside>
  );
}
