import type { ReactNode } from "react";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSidebar } from "../context/SidebarContext";

export interface PageTabItem {
  value: string;
  label: ReactNode;
}

interface PageTabBarProps {
  items: PageTabItem[];
  /**
   * What this whole set of tabs is choosing between, in plain words, such as
   * "Work section". It names the tab strip on a wide screen and the dropdown
   * that replaces it on a phone.
   *
   * Required rather than optional on purpose. On a phone the strip becomes a
   * plain dropdown, and a dropdown with no name is read out as a combo box
   * with no name at all, with nothing beside it to say what it changes. Making
   * this a required prop is what stops the next tab strip shipping without
   * one.
   */
  label: string;
  value?: string;
  onValueChange?: (value: string) => void;
  align?: "center" | "start";
}

export function PageTabBar({
  items,
  label,
  value,
  onValueChange,
  align = "center",
}: PageTabBarProps) {
  const { isMobile } = useSidebar();

  if (isMobile && value !== undefined && onValueChange) {
    return (
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        className="h-9 rounded-md border border-border bg-background px-2 py-1 text-base focus:outline-none focus:ring-1 focus:ring-ring"
      >
        {items.map((item) => (
          <option key={item.value} value={item.value}>
            {typeof item.label === "string" ? item.label : item.value}
          </option>
        ))}
      </select>
    );
  }

  return (
    <TabsList
      aria-label={label}
      variant="line"
      className={align === "start" ? "justify-start" : undefined}
    >
      {items.map((item) => (
        <TabsTrigger key={item.value} value={item.value}>
          {item.label}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}
