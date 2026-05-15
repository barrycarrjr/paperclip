import { createContext, useContext, type ReactNode } from "react";

interface SidebarPeekContextValue {
  /** Company whose menu is being peeked. Clicks switch to this company before navigating. */
  peekCompanyId: string;
  /** Called after a peek menu item is clicked — flyout consumer uses this to close the popover. */
  onItemClick?: () => void;
}

const SidebarPeekContext = createContext<SidebarPeekContextValue | null>(null);

export function SidebarPeekProvider({
  peekCompanyId,
  onItemClick,
  children,
}: SidebarPeekContextValue & { children: ReactNode }) {
  return (
    <SidebarPeekContext.Provider value={{ peekCompanyId, onItemClick }}>
      {children}
    </SidebarPeekContext.Provider>
  );
}

export function useSidebarPeek() {
  return useContext(SidebarPeekContext);
}
