import { useEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ChatSession } from "../api/chat";
import { cn, relativeTime } from "../lib/utils";
import { ROW_WITH_HOVER_TOOLBAR, RowHoverToolbar } from "./email/RowHoverToolbar";

export interface ClippyChatRowCompany {
  name: string;
  brandColor?: string | null;
}

/**
 * The line under a chat's title: where it belongs and when it was last
 * used, e.g. "HQ · 2h ago". It used to be the raw model id
 * (`adapter:claude_local:claude-sonnet-5-5`), which told nobody anything.
 */
export function clippyChatSubtitle(session: Pick<ChatSession, "updatedAt" | "archivedAt">, companyName: string | null): string {
  return [session.archivedAt ? "Archived" : null, companyName, relativeTime(session.updatedAt)]
    .filter(Boolean)
    .join(" · ");
}

interface ClippyChatRowProps {
  session: ChatSession;
  /** The chat's company. Null for a chat that belongs to no company. */
  company: ClippyChatRowCompany | null;
  active: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  /** Offers Archive (or Unarchive). Leave out where archived chats are not listed. */
  onArchiveToggle?: () => void;
}

/**
 * One chat in a Clippy chat list: its title, then its company and how long
 * ago it was used. Rename, archive and delete float over the row's end while
 * it is pointed at or tabbed into. Rename edits the title in place; delete
 * asks in the row itself rather than in a pop-up.
 */
export function ClippyChatRow({ session, company, active, onSelect, onRename, onDelete, onArchiveToggle }: ClippyChatRowProps) {
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement | null>(null);
  const archived = Boolean(session.archivedAt);

  useEffect(() => {
    if (!renaming) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [renaming]);

  useEffect(() => {
    if (confirmingDelete) cancelDeleteRef.current?.focus();
  }, [confirmingDelete]);

  const beginRename = () => {
    setDraft(session.title);
    setRenaming(true);
  };

  const commitRename = () => {
    const trimmed = draft.trim();
    if (trimmed.length > 0 && trimmed !== session.title) onRename(trimmed);
    setRenaming(false);
  };

  if (renaming) {
    return (
      <li className="px-1.5 py-1">
        <Input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitRename();
            } else if (e.key === "Escape") {
              // Cancels the rename only, not whatever holds the list.
              e.preventDefault();
              e.stopPropagation();
              setRenaming(false);
            }
          }}
          className="h-8 text-sm"
          aria-label="Chat name"
        />
      </li>
    );
  }

  if (confirmingDelete) {
    return (
      <li
        className="flex items-center gap-1.5 rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs"
        onKeyDown={(e) => {
          // Escape takes back the question, not whatever holds the list.
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          setConfirmingDelete(false);
        }}
      >
        <span className="min-w-0 flex-1 truncate">Delete "{session.title}"?</span>
        <Button size="xs" variant="destructive" onClick={onDelete}>
          Delete
        </Button>
        <Button ref={cancelDeleteRef} size="xs" variant="ghost" onClick={() => setConfirmingDelete(false)}>
          Cancel
        </Button>
      </li>
    );
  }

  return (
    <li className={cn(ROW_WITH_HOVER_TOOLBAR, "rounded-md", active ? "bg-accent" : "hover:bg-accent/50", archived && "opacity-70")}>
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={(e) => {
          e.preventDefault();
          beginRename();
        }}
        aria-current={active ? "true" : undefined}
        className="block w-full min-w-0 rounded-md px-2.5 py-1.5 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
        title={session.title}
      >
        <span className="block truncate text-sm font-medium">{session.title}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {company?.brandColor ? (
            <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: company.brandColor }} />
          ) : null}
          <span className="truncate">{clippyChatSubtitle(session, company?.name ?? null)}</span>
        </span>
      </button>
      <RowHoverToolbar>
        <Button size="icon-sm" variant="ghost" aria-label={`Rename "${session.title}"`} title="Rename" onClick={beginRename}>
          <Pencil />
        </Button>
        {onArchiveToggle ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={archived ? `Unarchive "${session.title}"` : `Archive "${session.title}"`}
            title={archived ? "Unarchive" : "Archive"}
            onClick={onArchiveToggle}
          >
            {archived ? <ArchiveRestore /> : <Archive />}
          </Button>
        ) : null}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Delete "${session.title}"`}
          title="Delete"
          onClick={() => setConfirmingDelete(true)}
        >
          <Trash2 />
        </Button>
      </RowHoverToolbar>
    </li>
  );
}
