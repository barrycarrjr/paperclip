import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";

export interface AgentIdentityProps {
  agent: { id?: string; name?: string | null; iconUrl?: string | null };
  size?: "xs" | "sm" | "default" | "lg";
  className?: string;
}

export function AgentIdentity({ agent, size = "default", className }: AgentIdentityProps) {
  const iconSizes = { xs: "h-3.5 w-3.5", sm: "h-4 w-4", default: "h-5 w-5", lg: "h-6 w-6" };
  const textSizes = { xs: "text-xs", sm: "text-xs", default: "text-sm", lg: "text-base" };

  return (
    <span title={agent?.name ?? "Agent"} className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <Bot className={cn("shrink-0 text-muted-foreground", iconSizes[size])} />
      <span className={cn("truncate font-medium", textSizes[size])}>{agent?.name ?? "Agent"}</span>
    </span>
  );
}
