import {
  createReplyPrefixContext,
  type ClawdbotConfig,
  type RuntimeEnv,
  type ReplyPayload,
} from "openclaw/plugin-sdk";
import { resolveWeComAccount } from "./accounts.js";
import { getWeComRuntime } from "./runtime.js";
import { sendWeComGroupText, sendWeComImage, sendWeComText } from "./send.js";

export type CreateWeComReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  toUser: string;
  accountId?: string;
};

export function createWeComReplyDispatcher(params: CreateWeComReplyDispatcherParams) {
  const core = getWeComRuntime();
  const { cfg, agentId, toUser, accountId } = params;
  const account = resolveWeComAccount({ cfg, accountId });
  const textChunkLimit = account.config?.textChunkLimit ?? 2048;

  const groupChatId = toUser.startsWith("chat:") ? toUser.slice(5) : null;

  const prefixContext = createReplyPrefixContext({ cfg, agentId });

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      deliver: async (payload: ReplyPayload) => {
        const text = payload.text ?? "";
        if (text.trim()) {
          const chunks = core.channel.text.chunkTextWithMode(text, textChunkLimit, "text");
          for (const chunk of chunks) {
            if (groupChatId) {
              await sendWeComGroupText({ cfg, chatId: groupChatId, text: chunk, accountId });
            } else {
              await sendWeComText({ cfg, to: toUser, text: chunk, accountId });
            }
          }
        }

        // Send media attachments (images)
        const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
        for (const url of mediaUrls) {
          if (!url) continue;
          const isImage = /\.(jpe?g|png|gif|bmp)(\?.*)?$/i.test(url);
          if (groupChatId) {
            // Group chat: fall back to sending the URL as text.
            const label = isImage ? "[图片]" : "[附件]";
            await sendWeComGroupText({
              cfg,
              chatId: groupChatId,
              text: `${label} ${url}`,
              accountId,
            });
            continue;
          }
          if (isImage) {
            await sendWeComImage({ cfg, to: toUser, mediaUrl: url, accountId });
          }
        }
      },
      onError: (err: unknown, info: { kind: string }) => {
        params.runtime.error?.(
          `wecom[${account.accountId}] ${info.kind} reply failed: ${String(err)}`,
        );
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
    },
    markDispatchIdle,
  };
}
