import { useEffect, useRef, useState } from "react";
import { ArrowDown, Download, FileText, Info, Loader2, MessageSquare } from "lucide-react";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { MarkdownBody } from "./MarkdownBody";
import { ClippyToolCallCard } from "./ClippyToolCallCard";
import { ClippyPermissionCard } from "./ClippyPermissionCard";
import type { ClippyTranscriptEntry } from "../hooks/useChatSession";
import type { LiveToolCall, PendingPermission } from "../lib/clippy-stream-manager";
import { resolveStreamActivity } from "../lib/clippy-stream-reducer";
import type { ChatContentBlock } from "../api/chat";
import { useNowTick } from "../hooks/useNowTick";
import { formatElapsed } from "../lib/clippy-tool-labels";

interface Props {
  transcript: ClippyTranscriptEntry[];
  pendingPermissions: PendingPermission[];
  onPermissionDecision: (toolUseId: string, decision: "approve" | "deny") => void;
  streaming: boolean;
  /** Live per-tool-call state from the stream (badges, results, timing). */
  liveToolCalls?: Record<string, LiveToolCall>;
  /** Epoch ms of the last stream event; drives the quiet-stream indicator. */
  lastEventAt?: number | null;
}

export function ClippyMessageList({
  transcript,
  pendingPermissions,
  onPermissionDecision,
  streaming,
  liveToolCalls = {},
  lastEventAt = null,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (stickToBottomRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [transcript, pendingPermissions]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const node = e.currentTarget;
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    const atBottom = distanceFromBottom < 24;
    stickToBottomRef.current = atBottom;
    setShowJump(!atBottom);
  };

  const jumpToLatest = () => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    stickToBottomRef.current = true;
    setShowJump(false);
  };

  const toolResultsByUseId = new Map<string, ChatContentBlock & { type: "tool_result" }>();
  for (const entry of transcript) {
    if (entry.role !== "tool") continue;
    for (const block of entry.blocks) {
      if (block.type === "tool_result") {
        toolResultsByUseId.set(block.tool_use_id, block);
      }
    }
  }

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="absolute inset-0 overflow-y-auto px-4 py-4 scrollbar-auto-hide"
      >
        {transcript.length === 0 && !streaming && (
          <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
            <MessageSquare className="mb-2 h-8 w-8 opacity-40" />
            <div className="font-medium">Ask Clippy anything</div>
            <div className="mt-1 max-w-sm text-xs">
              Clippy can look things up and take actions for you; each action
              shows up as a card as it runs. With{" "}
              <span className="font-medium">Ask permission</span> selected below,
              anything that makes a real change waits for your OK.
            </div>
          </div>
        )}
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {transcript.map((entry) => {
            if (entry.role === "tool") {
              // Tool-role rows are mostly tool_result blocks (mined into
              // toolResultsByUseId above), but the draft-approval loop also
              // appends plain-text tool messages ("The user approved your
              // earlier draft… the tool ran and returned…"). Those close the
              // loop for the reader, so render them as system notes instead
              // of dropping them.
              return <SystemNote key={entry.id} blocks={entry.blocks} />;
            }
            return (
              <MessageBubble
                key={entry.id}
                role={entry.role}
                blocks={entry.blocks}
                pending={entry.pending}
                toolResults={toolResultsByUseId}
                liveToolCalls={liveToolCalls}
                pendingPermissions={pendingPermissions}
                onPermissionDecision={onPermissionDecision}
              />
            );
          })}
          <StreamActivityLine
            streaming={streaming}
            lastEventAt={lastEventAt}
            hasAssistantContent={
              transcript.length > 0 &&
              transcript[transcript.length - 1].role === "assistant" &&
              transcript[transcript.length - 1].blocks.length > 0
            }
            hasPendingPermission={pendingPermissions.length > 0}
            hasRunningTool={Object.values(liveToolCalls).some((c) => c.completedAt == null)}
          />
        </div>
      </div>
      {showJump && (
        <Button
          size="sm"
          variant="secondary"
          className="absolute bottom-3 left-1/2 -translate-x-1/2"
          onClick={jumpToLatest}
        >
          <ArrowDown className="mr-1 h-3 w-3" /> Jump to latest
        </Button>
      )}
    </div>
  );
}

function MessageBubble({
  role,
  blocks,
  pending,
  toolResults,
  liveToolCalls,
  pendingPermissions,
  onPermissionDecision,
}: {
  role: "user" | "assistant";
  blocks: ChatContentBlock[];
  pending?: boolean;
  toolResults: Map<string, ChatContentBlock & { type: "tool_result" }>;
  liveToolCalls: Record<string, LiveToolCall>;
  pendingPermissions: PendingPermission[];
  onPermissionDecision: (toolUseId: string, decision: "approve" | "deny") => void;
}) {
  const isUser = role === "user";
  const text = blocks
    .filter((b): b is ChatContentBlock & { type: "text" } => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");
  const toolUses = blocks.filter(
    (b): b is ChatContentBlock & { type: "tool_use" } => b.type === "tool_use",
  );
  const images = blocks.filter(
    (b): b is ChatContentBlock & { type: "image" } => b.type === "image",
  );
  const files = blocks.filter(
    (b): b is ChatContentBlock & { type: "file" } => b.type === "file",
  );

  return (
    <div className={cn("flex flex-col", isUser ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-3 py-2 text-sm",
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted/50 text-foreground",
        )}
      >
        {(images.length > 0 || files.length > 0) && (
          <div className="mb-2 flex flex-wrap gap-2">
            {images.map((img) => (
              <ImageAttachment key={img.attachmentId} block={img} />
            ))}
            {files.map((f) => (
              <FileAttachment key={f.attachmentId} block={f} onUserBubble={isUser} />
            ))}
          </div>
        )}
        {text && (
          isUser ? (
            // User messages render as plain text. MarkdownBody injects its own
            // typography colors that override our `text-primary-foreground`,
            // which made the bubble look like dark-on-dark in some themes.
            <p className="whitespace-pre-wrap break-words text-primary-foreground">
              {text}
            </p>
          ) : (
            <MarkdownBody className="[&_p]:my-1 [&_pre]:my-2">{text}</MarkdownBody>
          )
        )}
        {!text && pending && images.length === 0 && files.length === 0 && (
          <span className="text-xs text-muted-foreground">…</span>
        )}
        {!isUser && toolUses.length > 0 && (
          <div className="mt-1">
            {toolUses.map((block) => {
              const pendingPerm = pendingPermissions.find(
                (p) => p.toolUseId === block.id,
              );
              if (pendingPerm) {
                return (
                  <ClippyPermissionCard
                    key={block.id}
                    toolName={block.name}
                    input={block.input}
                    expiresAt={pendingPerm.expiresAt}
                    onApprove={() => onPermissionDecision(block.id, "approve")}
                    onDeny={() => onPermissionDecision(block.id, "deny")}
                  />
                );
              }
              // Persisted tool_result blocks are canonical; the live stream
              // state fills the gap between "result streamed in" and the
              // next react-query refetch, and carries badges and timing the
              // persisted transcript doesn't have. Only consult live state
              // when no persisted result exists: providers with synthetic
              // toolUseIds (call_0 style) can reuse ids across turns, and a
              // historical card must not inherit the current turn's timing.
              const persisted = toolResults.get(block.id);
              const live = persisted ? undefined : liveToolCalls[block.id];
              const result = persisted
                ? { ok: !persisted.is_error, data: tryParse(persisted.content) }
                : live?.result
                  ? { ok: live.result.ok, data: live.result.result }
                  : undefined;
              // No result and no live stream state (e.g. after a reload)
              // means the call's outcome is unknown — say so instead of
              // claiming it is still running.
              const status = result
                ? isDeniedResult(result)
                  ? "denied"
                  : "completed"
                : live
                  ? "pending"
                  : "interrupted";
              return (
                <ClippyToolCallCard
                  key={block.id}
                  name={block.name}
                  input={block.input}
                  status={status}
                  result={result}
                  mutating={live?.mutating}
                  startedAt={live?.startedAt}
                  completedAt={live?.completedAt}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Matches the server's synthesized denial result for both the persisted
 * (`"User denied this action."` string) and live (`{ error: … }`) shapes. */
function isDeniedResult(result: { ok: boolean; data: unknown }): boolean {
  if (result.ok) return false;
  const text =
    typeof result.data === "string"
      ? result.data
      : typeof (result.data as { error?: unknown } | null)?.error === "string"
        ? ((result.data as { error: string }).error)
        : "";
  return text.includes("denied this action");
}

/**
 * The draft-approval loop appends tool-role messages with plain text
 * ("[Paperclip] The user approved your earlier draft…"). Render them as
 * subdued system notes so the reader sees the loop close in the thread.
 */
function SystemNote({ blocks }: { blocks: ChatContentBlock[] }) {
  const text = blocks
    .filter((b): b is ChatContentBlock & { type: "text" } => b.type === "text")
    .map((b) => b.text.replace(/^\[Paperclip\]\s*/, ""))
    .join("\n\n");
  if (!text) return null;
  return (
    <div className="flex items-start gap-2 border-l-2 border-border pl-2.5 text-xs text-muted-foreground">
      <Info className="mt-0.5 h-3 w-3 shrink-0" />
      <MarkdownBody className="min-w-0 text-xs [&_p]:my-0.5">{text}</MarkdownBody>
    </div>
  );
}

/**
 * Live status line under the transcript. Covers the two silent stretches of
 * a turn: before the first token ("thinking"), and the quiet gap after text
 * stops while the model assembles its next tool call — previously the UI
 * just froze there with no indicator. Suppressed while a permission prompt
 * or a running tool card is already telling the story.
 */
function StreamActivityLine({
  streaming,
  lastEventAt,
  hasAssistantContent,
  hasPendingPermission,
  hasRunningTool,
}: {
  streaming: boolean;
  lastEventAt: number | null;
  hasAssistantContent: boolean;
  hasPendingPermission: boolean;
  hasRunningTool: boolean;
}) {
  const now = useNowTick(streaming);
  const activity = resolveStreamActivity({
    streaming,
    lastEventAt,
    hasAssistantContent,
    hasPendingPermission,
    hasRunningTool,
    now,
  });
  if (!activity) return null;
  if (activity.kind === "thinking") {
    return <div className="text-xs text-muted-foreground">Clippy is thinking…</div>;
  }
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
      <span>
        Preparing the next action ·{" "}
        <span className="tabular-nums">{formatElapsed(activity.quietMs)}</span>
      </span>
    </div>
  );
}

function ImageAttachment({
  block,
}: {
  block: ChatContentBlock & { type: "image" };
}) {
  return (
    <a
      href={block.url}
      target="_blank"
      rel="noreferrer"
      className="block overflow-hidden rounded-md border border-border bg-background"
      title={block.name}
    >
      <img
        src={block.url}
        alt={block.name}
        className="block max-h-72 max-w-[280px] object-contain"
        loading="lazy"
      />
    </a>
  );
}

function FileAttachment({
  block,
  onUserBubble,
}: {
  block: ChatContentBlock & { type: "file" };
  onUserBubble: boolean;
}) {
  return (
    <a
      href={block.url}
      target="_blank"
      rel="noreferrer"
      download={block.name}
      className={cn(
        "flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs",
        onUserBubble
          ? "border-primary-foreground/30 bg-primary/30 text-primary-foreground hover:bg-primary/40"
          : "border-border bg-background hover:bg-accent",
      )}
      title={`${block.name} · ${formatBytesShort(block.sizeBytes)}`}
    >
      <FileText className="h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 max-w-[200px]">
        <div className="truncate font-medium">{block.name}</div>
        <div className="truncate text-[10px] opacity-70">
          {block.mediaType} · {formatBytesShort(block.sizeBytes)}
        </div>
      </div>
      <Download className="h-3 w-3 shrink-0 opacity-60" />
    </a>
  );
}

function formatBytesShort(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

