import {
  createReplyPrefixContext,
  type ClawdbotConfig,
  type RuntimeEnv,
  type ReplyPayload,
} from "openclaw/plugin-sdk";
import { resolveWeComAccount } from "./accounts.js";
import { getWeComRuntime } from "./runtime.js";
import { sendWeComImage, sendWeComText } from "./send.js";

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
            await sendWeComText({ cfg, to: toUser, text: chunk, accountId });
          }
        }
        // Send media attachments (images)
        const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
        for (const url of mediaUrls) {
          if (url && /\.(jpe?g|png|gif|bmp)(\?.*)?$/i.test(url)) {
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
