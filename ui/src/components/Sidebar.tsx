import { Search, SquarePen } from "lucide-react";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useGeneralSettings } from "../context/GeneralSettingsContext";
import { Button } from "@/components/ui/button";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";
import { SidebarMenu } from "./SidebarMenu";

export function Sidebar() {
  const { openNewIssue } = useDialog();
  const { selectedCompany } = useCompany();
  const { keyboardShortcutsEnabled } = useGeneralSettings();

  function openSearch() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
  }

  return (
    <aside className="w-60 h-full min-h-0 border-r border-border bg-sidebar flex flex-col">
      {/* Top bar: Company name (bold) + Search — aligned with top sections (no visible border) */}
      <div className="flex items-center gap-1 px-3 h-12 shrink-0">
        <SidebarCompanyMenu />
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground shrink-0 hover:text-foreground"
          onClick={openSearch}
          aria-label="Search (⌘K)"
        >
          <Search className="h-4 w-4" />
        </Button>
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
