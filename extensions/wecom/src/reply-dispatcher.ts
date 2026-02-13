import {
  createReplyPrefixContext,
  type ClawdbotConfig,
  type RuntimeEnv,
  type ReplyPayload,
} from "openclaw/plugin-sdk";
import { resolveWeComAccount } from "./accounts.js";
import { getWeComRuntime } from "./runtime.js";
import { sendWeComGroupText, sendWeComImage, sendWeComText } from "./send.js";

export type AiBotStreamState = {
  streamId: string;
  content: string;
  finished: boolean;
};

export type CreateWeComAiBotReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  accountId?: string;
  stream: AiBotStreamState;
};

export type CreateWeComReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  toUser: string;
  accountId?: string;
};

/**
 * Strip `formatReasoningMessage()` formatting to recover plain reasoning text.
 * Input format: `"Reasoning:\n_line1_\n_line2_"` → `"line1\nline2"`
 */
function stripReasoningFormat(text: string): string {
  let body = text;
  // Remove leading "Reasoning:\n" prefix
  const prefixRe = /^Reasoning:\s*\n?/i;
  body = body.replace(prefixRe, "");
  // Remove italic underscore wrapping per line
  body = body
    .split("\n")
    .map((line) => {
      const m = line.match(/^_(.*)_$/);
      return m ? m[1] : line;
    })
    .join("\n");
  return body.trim();
}

const REASONING_DEBOUNCE_MS = 3000;

export function createWeComReplyDispatcher(params: CreateWeComReplyDispatcherParams) {
  const core = getWeComRuntime();
  const { cfg, agentId, toUser, accountId } = params;
  const account = resolveWeComAccount({ cfg, accountId });
  const textChunkLimit = account.config?.textChunkLimit ?? 2048;

  const groupChatId = toUser.startsWith("chat:") ? toUser.slice(5) : null;

  const prefixContext = createReplyPrefixContext({ cfg, agentId });

  // --- Reasoning stream state (defined before dispatcher so deliver can flush) ---
  let reasoningBuffer = "";
  let reasoningSentPos = 0;
  let reasoningTimer: ReturnType<typeof setTimeout> | undefined;

  const sendReasoningChunk = async () => {
    const unsent = reasoningBuffer.slice(reasoningSentPos).trim();
    if (!unsent) return;
    reasoningSentPos = reasoningBuffer.length;
    const message = `💭 ${unsent}`;
    const chunks = core.channel.text.chunkTextWithMode(message, textChunkLimit, "text");
    for (const chunk of chunks) {
      if (groupChatId) {
        await sendWeComGroupText({ cfg, chatId: groupChatId, text: chunk, accountId });
      } else {
        await sendWeComText({ cfg, to: toUser, text: chunk, accountId });
      }
    }
  };

  const flushReasoningInternal = async () => {
    if (reasoningTimer) {
      clearTimeout(reasoningTimer);
      reasoningTimer = undefined;
    }
    await sendReasoningChunk();
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      deliver: async (payload: ReplyPayload) => {
        // Flush pending reasoning before delivering any reply to preserve order.
        await flushReasoningInternal();

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

  const onReasoningStream = async (payload: ReplyPayload) => {
    const raw = payload.text ?? "";
    if (!raw) return;
    const plain = stripReasoningFormat(raw);
    if (!plain) return;
    reasoningBuffer = plain;
    // Debounce: reset timer on each delta, send after idle
    if (reasoningTimer) clearTimeout(reasoningTimer);
    reasoningTimer = setTimeout(() => {
      sendReasoningChunk().catch((err) => {
        params.runtime.error?.(
          `wecom[${account.accountId}] reasoning stream failed: ${String(err)}`,
        );
      });
    }, REASONING_DEBOUNCE_MS);
  };

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
      onReasoningStream,
    },
    markDispatchIdle,
    flushReasoning: flushReasoningInternal,
  };
}

/**
 * AI Bot reply dispatcher: writes text and reasoning to a shared stream state
 * object that the HTTP handler reads from to serve streaming responses.
 */
export function createWeComAiBotReplyDispatcher(params: CreateWeComAiBotReplyDispatcherParams) {
  const core = getWeComRuntime();
  const { cfg, agentId, accountId, stream } = params;
  const account = resolveWeComAccount({ cfg, accountId });
  const prefixContext = createReplyPrefixContext({ cfg, agentId });

  let thinkingContent = "";
  let replyContent = "";

  function updateStreamContent() {
    const parts: string[] = [];
    if (thinkingContent) parts.push(`<think>${thinkingContent}</think>`);
    if (replyContent) parts.push(replyContent);
    stream.content = parts.join("\n\n") || "";
  }

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      deliver: async (payload: ReplyPayload) => {
        const text = payload.text ?? "";
        if (text.trim()) {
          replyContent = replyContent ? `${replyContent}\n\n${text}` : text;
          updateStreamContent();
        }
      },
      onError: (err: unknown, info: { kind: string }) => {
        params.runtime.error?.(
          `wecom[${account.accountId}] AI bot ${info.kind} reply failed: ${String(err)}`,
        );
      },
    });

  const onReasoningStream = async (payload: ReplyPayload) => {
    const raw = payload.text ?? "";
    if (!raw) return;
    const plain = stripReasoningFormat(raw);
    if (!plain) return;
    thinkingContent = plain;
    updateStreamContent();
  };

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
      onReasoningStream,
    },
    markDispatchIdle,
    flushReasoning: async () => {
      // Reasoning is already in the stream content via updateStreamContent
    },
  };
}
