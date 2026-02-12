import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { sendWeComImage, sendWeComText } from "./send.js";

function resolveToUser(to: string): string {
  // DeliveryContext.to uses "user:LongYu" format; WeCom API expects bare userid.
  return to.startsWith("user:") ? to.slice(5) : to;
}

export const wecomOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  textChunkLimit: 2048,
  sendText: async ({ cfg, to, text, accountId }) => {
    const ok = await sendWeComText({
      cfg,
      to: resolveToUser(to),
      text,
      accountId: accountId ?? undefined,
    });
    return { channel: "wecom", ok };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
    const resolvedTo = resolveToUser(to);
    const url = mediaUrl?.trim();

    const isImage = !!url && /\.(jpe?g|png|gif|bmp)(\?.*)?$/i.test(url);
    console.log("[wecom] sendMedia: url=", url, "isImage=", isImage);
    if (url && isImage) {
      if (text?.trim()) {
        const okText = await sendWeComText({
          cfg,
          to: resolvedTo,
          text,
          accountId: accountId ?? undefined,
        });
        if (!okText) return { channel: "wecom", ok: false };
      }

      const okImage = await sendWeComImage({
        cfg,
        to: resolvedTo,
        mediaUrl: url,
        accountId: accountId ?? undefined,
      });
      return { channel: "wecom", ok: okImage };
    }

    const content = url ? `${text || ""}\n${url}`.trim() : (text ?? "");
    const ok = await sendWeComText({
      cfg,
      to: resolvedTo,
      text: content,
      accountId: accountId ?? undefined,
    });
    return { channel: "wecom", ok };
  },
};
