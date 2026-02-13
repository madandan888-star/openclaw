import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { sendWeComGroupText, sendWeComImage, sendWeComText } from "./send.js";

function resolveWeComDeliveryTarget(to: string): { kind: "user" | "chat"; id: string } {
  // DeliveryContext.to uses "user:LongYu" format; WeCom API expects bare userid.
  if (to.startsWith("user:")) return { kind: "user", id: to.slice(5) };
  if (to.startsWith("chat:")) return { kind: "chat", id: to.slice(5) };
  // Backwards compatible: bare userId
  return { kind: "user", id: to };
}

export const wecomOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  textChunkLimit: 2048,
  sendText: async ({ cfg, to, text, accountId }) => {
    const target = resolveWeComDeliveryTarget(to);
    const ok =
      target.kind === "chat"
        ? await sendWeComGroupText({
            cfg,
            chatId: target.id,
            text,
            accountId: accountId ?? undefined,
          })
        : await sendWeComText({
            cfg,
            to: target.id,
            text,
            accountId: accountId ?? undefined,
          });

    return { channel: "wecom", ok };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
    const target = resolveWeComDeliveryTarget(to);
    const url = mediaUrl?.trim();

    // NOTE: WeCom appchat/send can support richer message types, but this plugin
    // only implements group text for now.
    if (target.kind === "chat") {
      const content = url ? `${text || ""}\n${url}`.trim() : (text ?? "");
      const ok = await sendWeComGroupText({
        cfg,
        chatId: target.id,
        text: content,
        accountId: accountId ?? undefined,
      });
      return { channel: "wecom", ok };
    }

    const resolvedTo = target.id;
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
