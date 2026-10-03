import React from "react";
import { cn } from "@/lib/utils";

export type AvatarAgent = { id?: string; name?: string; appearance?: any; avatarUrl?: string | null };
export type AgentAvatarSize = 16 | 20 | 24 | 32 | 40 | 48 | 64 | 96 | 128 | 256 | 512;

export interface AgentAvatarProps {
  agent?: AvatarAgent | null;
  appearance?: any;
  size?: AgentAvatarSize;
  name?: string;
  label?: string;
  pose?: string;
  muted?: boolean;
  className?: string;
}

export function AgentAvatar({ agent, size = 24, name, label, className }: AgentAvatarProps) {
  const displayName = name ?? agent?.name ?? "Agent";
  const initials = displayName.slice(0, 2).toUpperCase();
  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground", className)}
      style={{ width: size, height: size }}
      aria-label={label ?? displayName}
    >
      {initials}
    </span>
  );
}
