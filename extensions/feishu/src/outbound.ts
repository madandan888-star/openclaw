import type { ChannelOutboundAdapter, ClawdbotConfig } from "openclaw/plugin-sdk";
import {
  broadcastFeishuBotMessageToOtherAccounts,
  dispatchCrossBotMentions,
} from "./cross-bot-broadcast.js";
import { sendMediaFeishu } from "./media.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendFeishuVoice, sendMessageFeishu } from "./send.js";

/**
 * After a messaging tool sends text to a group chat:
 * 1. Broadcast to other bot accounts' history (Feishu won't deliver bot→bot).
 * 2. Trigger cross-bot dispatch so @mentioned bots process the message.
 *
 * Without this, messages sent via messaging tools (as opposed to the normal
 * block-reply path through reply-dispatcher) would never reach other bots.
 */
function handleGroupChatBroadcast(params: {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  messageId: string;
  accountId: string | null | undefined;
}) {
  const { cfg, to, text, messageId, accountId } = params;

  const log = (msg: string) => {
    try {
      getFeishuRuntime().logging.getChildLogger().info(msg);
    } catch {
      /* runtime not ready */
    }
  };

  log(
    `outbound-broadcast: to=${to} accountId=${accountId ?? "NULL"} messageId=${messageId} textLen=${text.length}`,
  );

  if (!to.startsWith("oc_")) {
    log(`outbound-broadcast: skip — to does not start with oc_`);
    return;
  }
  if (!accountId) {
    log(`outbound-broadcast: skip — accountId is falsy`);
    return;
  }
  if (messageId === "unknown") {
    log(`outbound-broadcast: skip — messageId is unknown`);
    return;
  }

  // Inject into other accounts' group history so they have context
  broadcastFeishuBotMessageToOtherAccounts({
    cfg,
    chatId: to,
    senderAccountId: accountId,
    senderBotName: accountId,
    text,
    messageId,
    log,
  });

  // Dispatch to @mentioned bots
  void dispatchCrossBotMentions({
    cfg,
    chatId: to,
    senderAccountId: accountId,
    senderBotName: accountId,
    text,
    messageId,
    crossBotDepth: 1,
    log,
  })
    .then(() => {
      log(`outbound-broadcast: dispatchCrossBotMentions completed for msgId=${messageId}`);
    })
    .catch((err) => {
      log(`outbound-broadcast: dispatchCrossBotMentions error: ${String(err)}`);
    });
}

export const feishuOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getFeishuRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId }) => {
    const result = await sendMessageFeishu({ cfg, to, text, accountId: accountId ?? undefined });
    handleGroupChatBroadcast({ cfg, to, text, messageId: result.messageId, accountId });
    return { channel: "feishu", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
    // Send text first if provided
    if (text?.trim()) {
      const textResult = await sendMessageFeishu({
        cfg,
        to,
        text,
        accountId: accountId ?? undefined,
      });
      handleGroupChatBroadcast({
        cfg,
        to,
        text,
        messageId: textResult.messageId,
        accountId,
      });
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
