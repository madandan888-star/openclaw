import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { sendMediaFeishu } from "./media.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendFeishuVoice, sendMessageFeishu } from "./send.js";

export const feishuOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getFeishuRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId }) => {
    const result = await sendMessageFeishu({ cfg, to, text, accountId: accountId ?? undefined });
    return { channel: "feishu", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
    // Send text first if provided
    if (text?.trim()) {
      await sendMessageFeishu({ cfg, to, text, accountId: accountId ?? undefined });
    }

    // Upload and send media if URL provided
    if (mediaUrl) {
      const url = mediaUrl.trim();
      const isAudio = /\.(mp3|wav|amr|ogg|m4a|opus)(\?.*)?$/i.test(url);

      if (url && isAudio) {
        try {
          const result = await sendFeishuVoice({
            cfg,
            chatId: to,
            audioPath: url,
            accountId: accountId ?? undefined,
          });
          return {
            channel: "feishu",
            messageId: result.messageId ?? "unknown",
            chatId: result.chatId ?? to,
          };
        } catch (err) {
          console.error(`[feishu] sendFeishuVoice failed:`, err);
          // Fallback to sending as a regular file
          try {
            const result = await sendMediaFeishu({
              cfg,
              to,
              mediaUrl: url,
              accountId: accountId ?? undefined,
            });
            return { channel: "feishu", ...result };
          } catch (fallbackErr) {
            console.error(`[feishu] sendMediaFeishu fallback failed:`, fallbackErr);
            const fallbackText = `📎 ${url}`;
            const result = await sendMessageFeishu({
              cfg,
              to,
              text: fallbackText,
              accountId: accountId ?? undefined,
            });
            return { channel: "feishu", ...result };
          }
        }
      }

      try {
        const result = await sendMediaFeishu({
          cfg,
          to,
          mediaUrl: url,
          accountId: accountId ?? undefined,
        });
        return { channel: "feishu", ...result };
      } catch (err) {
        // Log the error for debugging
        console.error(`[feishu] sendMediaFeishu failed:`, err);
        // Fallback to URL link if upload fails
        const fallbackText = `📎 ${url}`;
        const result = await sendMessageFeishu({
          cfg,
          to,
          text: fallbackText,
          accountId: accountId ?? undefined,
        });
        return { channel: "feishu", ...result };
      }
    }

    // No media URL, just return text result
    const result = await sendMessageFeishu({
      cfg,
      to,
      text: text ?? "",
      accountId: accountId ?? undefined,
    });
    return { channel: "feishu", ...result };
  },
};
