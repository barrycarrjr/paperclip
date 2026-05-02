import { InfoPopoverButton } from "./InfoPopoverButton";
import { cn } from "@/lib/utils";

interface SidebarInfoButtonProps {
  title: string;
  info: string;
  className?: string;
  alwaysVisible?: boolean;
}

export function SidebarInfoButton({
  title,
  info,
  className,
  alwaysVisible = false,
}: SidebarInfoButtonProps) {
  return (
    <InfoPopoverButton
      title={title}
      info={info}
      className={cn(
        !alwaysVisible &&
          "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100",
        className,
      )}
    />
  );
}
