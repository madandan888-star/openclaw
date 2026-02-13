import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { spawnSync } from "child_process";
import fs from "fs";
import { randomUUID } from "node:crypto";
import os from "os";
import path from "path";
import type { MentionTarget } from "./mention.js";
import type { FeishuSendResult, ResolvedFeishuAccount } from "./types.js";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { uploadFileFeishu } from "./media.js";
import { buildMentionedMessage, buildMentionedCardContent } from "./mention.js";
import { getFeishuRuntime } from "./runtime.js";
import { resolveReceiveIdType, normalizeFeishuTarget } from "./targets.js";

export type FeishuMessageInfo = {
  messageId: string;
  chatId: string;
  senderId?: string;
  senderOpenId?: string;
  content: string;
  contentType: string;
  createTime?: number;
};

/**
 * Get a message by its ID.
 * Useful for fetching quoted/replied message content.
 */
export async function getMessageFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  accountId?: string;
}): Promise<FeishuMessageInfo | null> {
  const { cfg, messageId, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  try {
    const response = (await client.im.message.get({
      path: { message_id: messageId },
    })) as {
      code?: number;
      msg?: string;
      data?: {
        items?: Array<{
          message_id?: string;
          chat_id?: string;
          msg_type?: string;
          body?: { content?: string };
          sender?: {
            id?: string;
            id_type?: string;
            sender_type?: string;
          };
          create_time?: string;
        }>;
      };
    };

    if (response.code !== 0) {
      return null;
    }

    const item = response.data?.items?.[0];
    if (!item) {
      return null;
    }

    // Parse content based on message type
    let content = item.body?.content ?? "";
    try {
      const parsed = JSON.parse(content);
      if (item.msg_type === "text" && parsed.text) {
        content = parsed.text;
      }
    } catch {
      // Keep raw content if parsing fails
    }

    return {
      messageId: item.message_id ?? messageId,
      chatId: item.chat_id ?? "",
      senderId: item.sender?.id,
      senderOpenId: item.sender?.id_type === "open_id" ? item.sender?.id : undefined,
      content,
      contentType: item.msg_type ?? "text",
      createTime: item.create_time ? parseInt(item.create_time, 10) : undefined,
    };
  } catch {
    return null;
  }
}

export type SendFeishuMessageParams = {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  replyToMessageId?: string;
  /** Mention target users */
  mentions?: MentionTarget[];
  /** Account ID (optional, uses default if not specified) */
  accountId?: string;
};

function buildFeishuPostMessagePayload(params: { messageText: string }): {
  content: string;
  msgType: string;
} {
  const { messageText } = params;
  return {
    content: JSON.stringify({
      zh_cn: {
        content: [
          [
            {
              tag: "md",
              text: messageText,
            },
          ],
        ],
      },
    }),
    msgType: "post",
  };
}

export async function sendMessageFeishu(
  params: SendFeishuMessageParams,
): Promise<FeishuSendResult> {
  const { cfg, to, text, replyToMessageId, mentions, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);
  const receiveId = normalizeFeishuTarget(to);
  if (!receiveId) {
    throw new Error(`Invalid Feishu target: ${to}`);
  }

  const receiveIdType = resolveReceiveIdType(receiveId);
  const tableMode = getFeishuRuntime().channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "feishu",
  });

  // Build message content (with @mention support)
  let rawText = text ?? "";
  if (mentions && mentions.length > 0) {
    rawText = buildMentionedMessage(mentions, rawText);
  }
  const messageText = getFeishuRuntime().channel.text.convertMarkdownTables(rawText, tableMode);

  const { content, msgType } = buildFeishuPostMessagePayload({ messageText });

  if (replyToMessageId) {
    try {
      const response = await client.im.message.reply({
        path: { message_id: replyToMessageId },
        data: {
          content,
          msg_type: msgType,
        },
      });

      if (response.code !== 0) {
        throw new Error(`Feishu reply failed: ${response.msg || `code ${response.code}`}`);
      }

      return {
        messageId: response.data?.message_id ?? "unknown",
        chatId: receiveId,
      };
    } catch (replyErr) {
      // Fallback: if message.reply fails (e.g. 400 when replying to another bot's
      // message), try message.create instead so the reply still reaches the chat.
      const axiosData = (replyErr as any)?.response?.data;
      console.warn(
        `feishu[${account.accountId}] message.reply failed (replyTo=${replyToMessageId}), ` +
          `falling back to message.create. ` +
          `error=${String(replyErr)}` +
          (axiosData ? ` response=${JSON.stringify(axiosData)}` : ""),
      );
    }
  }

  const response = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      content,
      msg_type: msgType,
    },
  });

  if (response.code !== 0) {
    throw new Error(`Feishu send failed: ${response.msg || `code ${response.code}`}`);
  }

  return {
    messageId: response.data?.message_id ?? "unknown",
    chatId: receiveId,
  };
}

export type SendFeishuCardParams = {
  cfg: ClawdbotConfig;
  to: string;
  card: Record<string, unknown>;
  replyToMessageId?: string;
  accountId?: string;
};

export async function sendCardFeishu(params: SendFeishuCardParams): Promise<FeishuSendResult> {
  const { cfg, to, card, replyToMessageId, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);
  const receiveId = normalizeFeishuTarget(to);
  if (!receiveId) {
    throw new Error(`Invalid Feishu target: ${to}`);
  }

  const receiveIdType = resolveReceiveIdType(receiveId);
  const content = JSON.stringify(card);

  if (replyToMessageId) {
    try {
      const response = await client.im.message.reply({
        path: { message_id: replyToMessageId },
        data: {
          content,
          msg_type: "interactive",
        },
      });

      if (response.code !== 0) {
        throw new Error(`Feishu card reply failed: ${response.msg || `code ${response.code}`}`);
      }

      return {
        messageId: response.data?.message_id ?? "unknown",
        chatId: receiveId,
      };
    } catch (replyErr) {
      const axiosData = (replyErr as any)?.response?.data;
      console.warn(
        `feishu[${account.accountId}] card message.reply failed (replyTo=${replyToMessageId}), ` +
          `falling back to message.create. ` +
          `error=${String(replyErr)}` +
          (axiosData ? ` response=${JSON.stringify(axiosData)}` : ""),
      );
    }
  }

  const response = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      content,
      msg_type: "interactive",
    },
  });

  if (response.code !== 0) {
    throw new Error(`Feishu card send failed: ${response.msg || `code ${response.code}`}`);
  }

  return {
    messageId: response.data?.message_id ?? "unknown",
    chatId: receiveId,
  };
}

export async function updateCardFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  card: Record<string, unknown>;
  accountId?: string;
}): Promise<void> {
  const { cfg, messageId, card, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);
  const content = JSON.stringify(card);

  const response = await client.im.message.patch({
    path: { message_id: messageId },
    data: { content },
  });

  if (response.code !== 0) {
    throw new Error(`Feishu card update failed: ${response.msg || `code ${response.code}`}`);
  }
}

/**
 * Build a Feishu interactive card with markdown content.
 * Cards render markdown properly (code blocks, tables, links, etc.)
 * Uses schema 2.0 format for proper markdown rendering.
 */
export function buildMarkdownCard(text: string): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: text,
        },
      ],
    },
  };
}

/**
 * Send a message as a markdown card (interactive message).
 * This renders markdown properly in Feishu (code blocks, tables, bold/italic, etc.)
 */
export async function sendMarkdownCardFeishu(params: {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  replyToMessageId?: string;
  /** Mention target users */
  mentions?: MentionTarget[];
  accountId?: string;
}): Promise<FeishuSendResult> {
  const { cfg, to, text, replyToMessageId, mentions, accountId } = params;
  // Build message content (with @mention support)
  let cardText = text;
  if (mentions && mentions.length > 0) {
    cardText = buildMentionedCardContent(mentions, text);
  }
  const card = buildMarkdownCard(cardText);
  return sendCardFeishu({ cfg, to, card, replyToMessageId, accountId });
}

/**
 * Edit an existing text message.
 * Note: Feishu only allows editing messages within 24 hours.
 */
export async function editMessageFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  text: string;
  accountId?: string;
}): Promise<void> {
  const { cfg, messageId, text, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);
  const tableMode = getFeishuRuntime().channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "feishu",
  });
  const messageText = getFeishuRuntime().channel.text.convertMarkdownTables(text ?? "", tableMode);

  const { content, msgType } = buildFeishuPostMessagePayload({ messageText });

  const response = await client.im.message.update({
    path: { message_id: messageId },
    data: {
      msg_type: msgType,
      content,
    },
  });

  if (response.code !== 0) {
    throw new Error(`Feishu message edit failed: ${response.msg || `code ${response.code}`}`);
  }
}

export async function sendFeishuVoice(params: {
  cfg: ClawdbotConfig;
  chatId: string;
  // Local file path or URL
  audioPath: string;
  accountId?: string;
}): Promise<{ messageId?: string; chatId?: string }> {
  const { cfg, chatId, audioPath, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);
  const receiveId = normalizeFeishuTarget(chatId);
  if (!receiveId) {
    throw new Error(`Invalid Feishu target: ${chatId}`);
  }
  const receiveIdType = resolveReceiveIdType(receiveId);

  const cleanupPaths: string[] = [];

  const resolveSourcePath = async (): Promise<string> => {
    const trimmed = audioPath.trim();
    if (!trimmed) {
      throw new Error("audioPath is required");
    }

    // Accept "MEDIA: /path" inputs (defensive).
    const mediaPrefix = /^MEDIA:\s*/i;
    const normalized = trimmed.replace(mediaPrefix, "").trim();

    if (/^https?:\/\//i.test(normalized)) {
      const res = await fetch(normalized, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        throw new Error(`Failed to download audio: ${res.status} ${res.statusText}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const url = new URL(normalized);
      const ext = path.extname(url.pathname) || ".wav";
      const tmpPath = path.join(
        os.tmpdir(),
        `feishu_voice_src_${Date.now()}_${randomUUID()}${ext}`,
      );
      fs.writeFileSync(tmpPath, buf);
      cleanupPaths.push(tmpPath);
      return tmpPath;
    }

    // Local path
    const filePath = normalized.startsWith("~")
      ? normalized.replace("~", process.env.HOME ?? "")
      : normalized.replace("file://", "");

    if (!fs.existsSync(filePath)) {
      throw new Error(`Audio file not found: ${filePath}`);
    }
    return filePath;
  };

  const getDurationMs = (filePath: string): number | undefined => {
    try {
      const probe = spawnSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          filePath,
        ],
        { encoding: "utf8" },
      );
      if (probe.status !== 0) {
        return undefined;
      }
      const seconds = Number.parseFloat(String(probe.stdout ?? "").trim());
      if (!Number.isFinite(seconds) || seconds <= 0) {
        return undefined;
      }
      return Math.max(1, Math.round(seconds * 1000));
    } catch {
      return undefined;
    }
  };

  let sourcePath: string | undefined;
  let opusPath: string | undefined;

  try {
    sourcePath = await resolveSourcePath();

    const lower = sourcePath.toLowerCase();
    const alreadyOpus = lower.endsWith(".opus");
    if (alreadyOpus) {
      opusPath = sourcePath;
    } else {
      opusPath = path.join(os.tmpdir(), `feishu_voice_${Date.now()}_${randomUUID()}.opus`);
      cleanupPaths.push(opusPath);
      const ffmpeg = spawnSync(
        "ffmpeg",
        [
          "-y",
          "-i",
          sourcePath,
          "-c:a",
          "libopus",
          "-b:a",
          "32k",
          "-ar",
          "16000",
          "-ac",
          "1",
          opusPath,
        ],
        { encoding: "utf8" },
      );
      if (ffmpeg.status !== 0) {
        throw new Error(
          `ffmpeg opus conversion failed: ${String(ffmpeg.stderr || ffmpeg.stdout || "").trim()}`,
        );
      }
      if (!fs.existsSync(opusPath)) {
        throw new Error(`ffmpeg opus conversion failed: output not found (${opusPath})`);
      }
    }

    if (!opusPath) {
      throw new Error("Feishu voice send failed: opus output missing");
    }

    const duration = getDurationMs(opusPath);
    const { fileKey } = await uploadFileFeishu({
      cfg,
      file: opusPath,
      fileName: "voice.opus",
      fileType: "opus",
      duration,
      accountId,
    });

    const response = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: "audio",
        content: JSON.stringify({ file_key: fileKey }),
      },
    });

    if (response.code !== 0) {
      throw new Error(`Feishu voice send failed: ${response.msg || `code ${response.code}`}`);
    }

    return {
      messageId: response.data?.message_id ?? "unknown",
      chatId: receiveId,
    };
  } finally {
    // Only cleanup temporary files we created.
    for (const p of cleanupPaths) {
      try {
        await fs.promises.unlink(p);
      } catch {
        // ignore
      }
    }
  }
}
