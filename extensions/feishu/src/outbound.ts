import fs from "fs";
import path from "path";
import type { ChannelOutboundAdapter, ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import {
  broadcastFeishuBotMessageToOtherAccounts,
  dispatchCrossBotMentions,
} from "./cross-bot-broadcast.js";
import { sendMediaFeishu } from "./media.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMarkdownCardFeishu, sendMessageFeishu, sendFeishuVoice } from "./send.js";

/** Get a logger for outbound operations, with fallback to console. */
function getOutboundLogger() {
  try {
    return getFeishuRuntime().logging.getChildLogger({ component: "feishu-outbound" });
  } catch {
    // Fallback to console if runtime not ready
    return {
      debug: (msg: string) => console.debug(`[feishu-outbound] ${msg}`),
      info: (msg: string) => console.log(`[feishu-outbound] ${msg}`),
      warn: (msg: string) => console.warn(`[feishu-outbound] ${msg}`),
      error: (msg: string) => console.error(`[feishu-outbound] ${msg}`),
    };
  }
}

function normalizePossibleLocalImagePath(text: string | undefined): string | null {
  const raw = text?.trim();
  if (!raw) return null;

  // Only auto-convert when the message is a pure path-like payload.
  // Avoid converting regular sentences that merely contain a path.
  const hasWhitespace = /\s/.test(raw);
  if (hasWhitespace) return null;

  // Ignore links/data URLs; those should stay in normal mediaUrl/text paths.
  if (/^(https?:\/\/|data:|file:\/\/)/i.test(raw)) return null;

  const ext = path.extname(raw).toLowerCase();
  const isImageExt = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".tiff"].includes(
    ext,
  );
  if (!isImageExt) return null;

  if (!path.isAbsolute(raw)) return null;
  if (!fs.existsSync(raw)) return null;

  // Fix race condition: wrap statSync in try-catch to handle file deletion
  // between existsSync and statSync
  try {
    if (!fs.statSync(raw).isFile()) return null;
  } catch {
    // File may have been deleted or became inaccessible between checks
    return null;
  }

  return raw;
}

function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

function resolveReplyToMessageId(params: {
  replyToId?: string | null;
  threadId?: string | number | null;
}): string | undefined {
  const replyToId = params.replyToId?.trim();
  if (replyToId) {
    return replyToId;
  }
  if (params.threadId == null) {
    return undefined;
  }
  const trimmed = String(params.threadId).trim();
  return trimmed || undefined;
}

async function sendOutboundText(params: {
  cfg: Parameters<typeof sendMessageFeishu>[0]["cfg"];
  to: string;
  text: string;
  replyToMessageId?: string;
  accountId?: string;
}) {
  const { cfg, to, text, accountId, replyToMessageId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  const renderMode = account.config?.renderMode ?? "auto";

  if (renderMode === "card" || (renderMode === "auto" && shouldUseCard(text))) {
    return sendMarkdownCardFeishu({ cfg, to, text, accountId, replyToMessageId });
  }

  return sendMessageFeishu({ cfg, to, text, accountId, replyToMessageId });
}

/**
 * After a messaging tool sends text to a group chat:
 * 1. Broadcast to other bot accounts' history (Feishu won't deliver bot->bot).
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
  sendText: async ({ cfg, to, text, accountId, replyToId, threadId, mediaLocalRoots }) => {
    const replyToMessageId = resolveReplyToMessageId({ replyToId, threadId });
    // Scheme A compatibility shim:
    // when upstream accidentally returns a local image path as plain text,
    // auto-upload and send as Feishu image message instead of leaking path text.
    const localImagePath = normalizePossibleLocalImagePath(text);
    if (localImagePath) {
      try {
        const result = await sendMediaFeishu({
          cfg,
          to,
          mediaUrl: localImagePath,
          accountId: accountId ?? undefined,
          replyToMessageId,
          mediaLocalRoots,
        });
        return { channel: "feishu", ...result };
      } catch (err) {
        console.error(`[feishu] local image path auto-send failed:`, err);
        // fall through to plain text as last resort
      }
    }

    const result = await sendOutboundText({
      cfg,
      to,
      text,
      accountId: accountId ?? undefined,
      replyToMessageId,
    });
    handleGroupChatBroadcast({ cfg, to, text, messageId: result.messageId, accountId });
    return { channel: "feishu", ...result };
  },
  sendMedia: async ({
    cfg,
    to,
    text,
    mediaUrl,
    accountId,
    mediaLocalRoots,
    replyToId,
    threadId,
  }) => {
    const logger = getOutboundLogger();
    const replyToMessageId = resolveReplyToMessageId({ replyToId, threadId });
    // Send text first if provided
    if (text?.trim()) {
      await sendOutboundText({
        cfg,
        to,
        text,
        accountId: accountId ?? undefined,
        replyToMessageId,
      });
    }

    // Upload and send media if URL or local path provided
    if (mediaUrl) {
      const url = mediaUrl.trim();
      const isAudio = /\.(mp3|wav|amr|ogg|m4a|opus)(\?.*)?$/i.test(url);

      logger.info(`sendMedia: processing mediaUrl=${url} isAudio=${isAudio}`);

      if (url && isAudio) {
        try {
          const result = await sendFeishuVoice({
            cfg,
            chatId: to,
            audioPath: url,
            accountId: accountId ?? undefined,
          });
          logger.info(`sendMedia: sendFeishuVoice success messageId=${result.messageId}`);
          return {
            channel: "feishu",
            messageId: result.messageId ?? "unknown",
            chatId: result.chatId ?? to,
          };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const errStack = err instanceof Error ? err.stack : undefined;
          logger.error(`sendMedia: sendFeishuVoice failed: ${errMsg}`);
          if (errStack) {
            logger.error(`sendMedia: sendFeishuVoice stack: ${errStack}`);
          }
          // Fallback to sending as a regular file
          try {
            logger.info(`sendMedia: attempting fallback to sendMediaFeishu`);
            const result = await sendMediaFeishu({
              cfg,
              to,
              mediaUrl: url,
              accountId: accountId ?? undefined,
            });
            logger.info(
              `sendMedia: sendMediaFeishu fallback success messageId=${result.messageId}`,
            );
            return { channel: "feishu", ...result };
          } catch (fallbackErr) {
            const fallbackErrMsg =
              fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
            const fallbackErrStack = fallbackErr instanceof Error ? fallbackErr.stack : undefined;
            logger.error(`sendMedia: sendMediaFeishu fallback failed: ${fallbackErrMsg}`);
            if (fallbackErrStack) {
              logger.error(`sendMedia: fallback stack: ${fallbackErrStack}`);
            }
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
        logger.info(`sendMedia: calling sendMediaFeishu for url=${url}`);
        const result = await sendMediaFeishu({
          cfg,
          to,
          mediaUrl: url,
          accountId: accountId ?? undefined,
          mediaLocalRoots,
          replyToMessageId,
        });
        logger.info(`sendMedia: sendMediaFeishu success messageId=${result.messageId}`);
        return { channel: "feishu", ...result };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const errStack = err instanceof Error ? err.stack : undefined;
        logger.error(`sendMedia: sendMediaFeishu failed: ${errMsg}`);
        if (errStack) {
          logger.error(`sendMedia: stack: ${errStack}`);
        }
        // Fallback to URL link if upload fails
        const fallbackText = `📎 ${url}`;
        const result = await sendOutboundText({
          cfg,
          to,
          text: fallbackText,
          accountId: accountId ?? undefined,
          replyToMessageId,
        });
        return { channel: "feishu", ...result };
      }
    }

    // No media URL, just return text result
    const result = await sendOutboundText({
      cfg,
      to,
      text: text ?? "",
      accountId: accountId ?? undefined,
      replyToMessageId,
    });
    return { channel: "feishu", ...result };
  },
};
