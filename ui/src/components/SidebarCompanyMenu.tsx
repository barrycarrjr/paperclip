import { useState } from "react";
import { Boxes, ChevronDown, DollarSign, Settings, UserPlus } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCompany } from "@/context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";

interface SidebarCompanyMenuProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function SidebarCompanyMenu({ open: controlledOpen, onOpenChange }: SidebarCompanyMenuProps = {}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const { selectedCompany } = useCompany();
  const { isMobile, setSidebarOpen } = useSidebar();
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;

  function closeNavigationChrome() {
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-auto min-w-0 flex-1 justify-start gap-1 px-2 py-1.5 text-left"
            aria-label={selectedCompany ? `Open ${selectedCompany.name} menu` : "Open company menu"}
            disabled={!selectedCompany}
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              {selectedCompany?.brandColor ? (
                <span
                  className="size-4 shrink-0 rounded-sm"
                  style={{ backgroundColor: selectedCompany.brandColor }}
                />
              ) : null}
              <span className="truncate text-sm font-bold text-foreground">
                {selectedCompany?.name ?? "Select company"}
              </span>
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel className="truncate">
            {selectedCompany?.name ?? "Company"}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link to="/company/settings/invites" onClick={closeNavigationChrome}>
              <UserPlus className="size-4" />
              <span className="truncate">
                {selectedCompany ? `Invite people to ${selectedCompany.name}` : "Invite people"}
              </span>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/skills" onClick={closeNavigationChrome}>
              <Boxes className="size-4" />
              <span>Skills</span>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/costs" onClick={closeNavigationChrome}>
              <DollarSign className="size-4" />
              <span>Costs</span>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/company/settings" onClick={closeNavigationChrome}>
              <Settings className="size-4" />
              <span>Company settings</span>
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        asChild
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground shrink-0 hover:text-foreground"
        aria-label="Company settings"
      >
        <Link to="/company/settings" onClick={closeNavigationChrome}>
          <Settings className="size-4" />
        </Link>
      </Button>
    </div>
  );
}
