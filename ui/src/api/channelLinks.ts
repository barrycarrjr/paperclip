import type { ChannelPairingPreview, ChannelUserLink } from "@paperclipai/shared";
import { api } from "./client";

/** The signed-in user's connected chat app accounts (Slack, for example). */
export const channelLinksApi = {
  list: () => api.get<{ links: ChannelUserLink[] }>("/me/channel-links").then((res) => res.links),
  preview: (code: string) =>
    api.post<{ pairing: ChannelPairingPreview }>("/me/channel-links/preview", { code }).then((res) => res.pairing),
  claim: (code: string) =>
    api.post<{ link: ChannelUserLink }>("/me/channel-links", { code }).then((res) => res.link),
  remove: (id: string) => api.delete<void>(`/me/channel-links/${encodeURIComponent(id)}`),
};
