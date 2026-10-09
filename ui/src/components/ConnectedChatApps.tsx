import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, MessageSquare, Trash2 } from "lucide-react";
import type { ChannelPairingPreview, ChannelUserLink } from "@paperclipai/shared";
import { channelLinksApi } from "@/api/channelLinks";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function describeAccount(account: Pick<ChannelUserLink, "externalLabel" | "externalUserId" | "externalWorkspace">) {
  const who = account.externalLabel ? `${account.externalLabel} (${account.externalUserId})` : account.externalUserId;
  return account.externalWorkspace ? `${who} in workspace ${account.externalWorkspace}` : who;
}

function formatWhen(iso: string | null) {
  if (!iso) return "never";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/**
 * Chat app accounts (Slack, for example) connected to the signed-in user.
 * Connecting one lets that account talk to Clippy and approve actions as
 * this user; the code proves the same person holds both accounts.
 */
export function ConnectedChatApps() {
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<ChannelPairingPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Says what a connect or disconnect did, where the user is looking: the
  // account list it changes can be off screen, on a phone especially.
  const [notice, setNotice] = useState<string | null>(null);

  const linksQuery = useQuery({
    queryKey: queryKeys.auth.channelLinks,
    queryFn: () => channelLinksApi.list(),
    retry: false,
  });

  const previewMutation = useMutation({
    mutationFn: (value: string) => channelLinksApi.preview(value),
    onSuccess: (pairing) => {
      setError(null);
      setNotice(null);
      setPreview(pairing);
    },
    onError: (err) => {
      setPreview(null);
      setNotice(null);
      setError(err instanceof Error ? err.message : "Could not check that code.");
    },
  });

  const claimMutation = useMutation({
    mutationFn: (value: string) => channelLinksApi.claim(value),
    onSuccess: (link) => {
      setError(null);
      setPreview(null);
      setCode("");
      setNotice(`Connected ${describeAccount(link)}. Message the bot again and Clippy will answer as you.`);
      void queryClient.invalidateQueries({ queryKey: queryKeys.auth.channelLinks });
    },
    onError: (err) => {
      setNotice(null);
      setError(err instanceof Error ? err.message : "Could not connect that account.");
    },
  });

  const removeMutation = useMutation({
    mutationFn: (link: ChannelUserLink) => channelLinksApi.remove(link.id),
    onSuccess: (_result, link) => {
      setError(null);
      setNotice(`Disconnected ${describeAccount(link)}.`);
      void queryClient.invalidateQueries({ queryKey: queryKeys.auth.channelLinks });
    },
    onError: (err) => {
      setNotice(null);
      setError(err instanceof Error ? err.message : "Could not disconnect that account.");
    },
  });

  const links = linksQuery.data ?? [];
  const busy = previewMutation.isPending || claimMutation.isPending;

  return (
    <section className="space-y-4 rounded-lg border border-border p-5" aria-labelledby="chat-apps-heading">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-muted-foreground" />
          <h2 id="chat-apps-heading" className="text-base font-semibold">Chat apps</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Connect a chat app account, such as Slack, to talk to Clippy and approve actions from there. Send the
          app's bot a message; it replies with a code. Enter that code here.
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {notice ? (
        <div
          role="status"
          className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300"
        >
          {notice}
        </div>
      ) : null}

      {preview ? (
        <div className="space-y-3 rounded-md border border-border bg-muted/40 p-4">
          <p className="text-sm">
            This connects <span className="font-medium">{describeAccount(preview)}</span> through{" "}
            <span className="font-medium">{preview.pluginName}</span>. Messages from that account will act as you,
            with your access.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => claimMutation.mutate(code)} disabled={busy}>
              {claimMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
              Connect
            </Button>
            <Button type="button" variant="outline" onClick={() => setPreview(null)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (code.trim()) previewMutation.mutate(code.trim());
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="chat-app-code">Code from the chat app</Label>
            <Input
              id="chat-app-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="ABCD-2345"
              maxLength={32}
              autoComplete="off"
              className="w-48 font-mono uppercase"
            />
          </div>
          <Button type="submit" variant="secondary" disabled={busy || !code.trim()}>
            {previewMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
            Check code
          </Button>
        </form>
      )}

      <div className="space-y-2">
        {linksQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading connected accounts...</p>
        ) : linksQuery.error ? (
          <p className="text-sm text-destructive">
            {linksQuery.error instanceof Error ? linksQuery.error.message : "Could not load connected accounts."}
          </p>
        ) : links.length === 0 ? (
          <p className="text-sm text-muted-foreground">No chat app accounts connected.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {links.map((link) => (
              <li key={link.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate text-sm font-medium">
                    {link.pluginName}: {describeAccount(link)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Connected {formatWhen(link.createdAt)}. Last used {formatWhen(link.lastUsedAt)}.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => removeMutation.mutate(link)}
                  disabled={removeMutation.isPending}
                  aria-label={`Disconnect ${describeAccount(link)}`}
                >
                  <Trash2 className="size-4" />
                  Disconnect
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
