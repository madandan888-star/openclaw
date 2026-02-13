import type { ClawdbotConfig, RuntimeEnv, HistoryEntry } from "openclaw/plugin-sdk";
import { resolveWeComAccount } from "./accounts.js";
import {
  createWeComReplyDispatcher,
  createWeComAiBotReplyDispatcher,
  type AiBotStreamState,
} from "./reply-dispatcher.js";
import { getWeComRuntime } from "./runtime.js";
import { getAccessToken, sendWeComGroupText, sendWeComText } from "./send.js";

// --- Deduplication ---
const DEDUP_TTL_MS = 30 * 60 * 1000;
const DEDUP_MAX_SIZE = 1000;
const processedMsgIds = new Map<string, number>();

function tryRecordMessage(msgId: string): boolean {
  const now = Date.now();
  // Cleanup
  if (processedMsgIds.size > DEDUP_MAX_SIZE) {
    for (const [id, ts] of processedMsgIds) {
      if (now - ts > DEDUP_TTL_MS) processedMsgIds.delete(id);
    }
  }
  if (processedMsgIds.has(msgId)) return false;
  processedMsgIds.set(msgId, now);
  return true;
}

// --- XML parsing helpers ---
function extractXmlField(xml: string, field: string): string {
  const re = new RegExp(`<${field}><!\\[CDATA\\[(.+?)\\]\\]><\\/${field}>`, "s");
  const match = xml.match(re);
  if (match) return match[1]!;
  // Try without CDATA
  const re2 = new RegExp(`<${field}>(.+?)<\\/${field}>`, "s");
  const match2 = xml.match(re2);
  return match2?.[1] ?? "";
}

export type HandleWeComMessageParams = {
  cfg: ClawdbotConfig;
  xml: string;
  runtime?: RuntimeEnv;
  chatHistories: Map<string, HistoryEntry[]>;
  accountId?: string;
};

export async function handleWeComMessage(params: HandleWeComMessageParams) {
  const { cfg, xml, runtime, accountId } = params;
  const core = getWeComRuntime();
  const account = resolveWeComAccount({ cfg, accountId });
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  // Parse XML fields
  const fromUser = extractXmlField(xml, "FromUserName");
  const msgType = extractXmlField(xml, "MsgType");
  const content = extractXmlField(xml, "Content");
  const picUrl = extractXmlField(xml, "PicUrl");
  const msgId = extractXmlField(xml, "MsgId");
  const createTime = extractXmlField(xml, "CreateTime");
  const chatId = extractXmlField(xml, "ChatId");

  log(
    `wecom[${account.accountId}]: recv type=${msgType} from=${fromUser} chatId=${chatId || "-"} msgId=${msgId}`,
  );

  // Dedup
  if (msgId && !tryRecordMessage(msgId)) {
    log(`wecom[${account.accountId}]: duplicate message ${msgId}, skipping`);
    return;
  }

  // Determine effective content and media attachments
  let effectiveContent = content.trim();
  let mediaUrls: string[] = [];

  if (msgType === "image") {
    log(
      `wecom[${account.accountId}]: image xml picUrl=[${picUrl.slice(0, 100)}] content=[${content.slice(0, 50)}]`,
    );
    if (picUrl) {
      mediaUrls = [picUrl];
    }
    effectiveContent = effectiveContent || "[用户发送了一张图片]";
    if (picUrl) effectiveContent += `\n${picUrl}`;
  } else if (msgType === "voice") {
    // Download voice media and transcribe via Qwen3-ASR
    const mediaId = extractXmlField(xml, "MediaId");
    log(`wecom[${account.accountId}]: voice mediaId=${mediaId}`);
    if (mediaId) {
      try {
        const token = await getAccessToken({ cfg, accountId });
        const mediaUrl = `https://bot.youfuli.cn/wecom-api/cgi-bin/media/get?access_token=${token}&media_id=${mediaId}`;
        const mediaResp = await fetch(mediaUrl);
        if (!mediaResp.ok) throw new Error(`media download failed: ${mediaResp.status}`);
        const amrBuf = Buffer.from(await mediaResp.arrayBuffer());
        log(`wecom[${account.accountId}]: voice downloaded ${amrBuf.length} bytes`);

        // Convert AMR to WAV using ffmpeg
        const { execSync } = await import("child_process");
        const tmpAmr = `/tmp/wecom_voice_${msgId}.amr`;
        const tmpWav = `/tmp/wecom_voice_${msgId}.wav`;
        const fs = await import("fs");
        fs.writeFileSync(tmpAmr, amrBuf);
        try {
          execSync(`ffmpeg -y -i "${tmpAmr}" -ar 16000 -ac 1 "${tmpWav}" 2>&1`);
        } catch (ffErr: any) {
          log(
            `wecom[${account.accountId}]: ffmpeg error: ${ffErr.stderr?.toString() || ffErr.message}`,
          );
          throw ffErr;
        }
        const wavStat = fs.statSync(tmpWav);
        log(`wecom[${account.accountId}]: wav converted ${wavStat.size} bytes`);

        // Send to Qwen3-ASR API
        const wavBuf = fs.readFileSync(tmpWav);
        const formData = new FormData();
        formData.append("file", new Blob([wavBuf], { type: "audio/wav" }), "audio.wav");
        const asrResp = await fetch("http://127.0.0.1:9882/transcribe", {
          method: "POST",
          body: formData,
        });
        const asrRaw = await asrResp.text();
        log(`wecom[${account.accountId}]: ASR raw response: ${asrRaw}`);
        const asrResult = JSON.parse(asrRaw) as { text?: string };
        effectiveContent = (asrResult.text || "").trim();
        log(`wecom[${account.accountId}]: ASR result: ${effectiveContent}`);

        // Cleanup
        try {
          fs.unlinkSync(tmpAmr);
          fs.unlinkSync(tmpWav);
        } catch {}

        if (!effectiveContent) {
          await sendWeComText({ cfg, to: fromUser, text: "语音识别结果为空，请重试。", accountId });
          return;
        }
      } catch (e: any) {
        log(`wecom[${account.accountId}]: voice ASR error: ${e.message}`);
        await sendWeComText({
          cfg,
          to: fromUser,
          text: "语音识别失败，请发送文字消息。",
          accountId,
        });
        return;
      }
    }
  } else if (msgType !== "text" || !effectiveContent) {
    if (fromUser) {
      await sendWeComText({
        cfg,
        to: fromUser,
        text: `收到 ${msgType} 消息，目前支持文本对话和图片。`,
        accountId,
      });
    }
    return;
  }

  const isGroup = msgType === "text" && !!chatId.trim();
  const chatType = (isGroup ? "group" : "direct") as const;
  const peerId = isGroup ? chatId.trim() : fromUser;

  const wecomFrom = isGroup ? `wecom:chat:${peerId}` : `wecom:${fromUser}`;
  // NOTE: `To` is used as the outbound target. We keep it provider-specific:
  // - direct: user:<userid>
  // - group:  chat:<chatid>
  const wecomTo = isGroup ? `chat:${peerId}` : `user:${fromUser}`;

  // Resolve agent route (group messages are routed by chatId)
  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "wecom",
    accountId: account.accountId,
    peer: {
      kind: chatType,
      id: peerId,
    },
  });

  // Group mention gate: only respond when @-mentioned
  let wasMentioned = true;
  if (isGroup) {
    const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg as any, route.agentId);
    const byPattern = core.channel.mentions.matchesMentionPatterns(
      effectiveContent,
      mentionRegexes,
    );
    const fallback = mentionRegexes.length === 0 ? /^\s*@/.test(effectiveContent) : false;
    wasMentioned = byPattern || fallback;

    if (!wasMentioned) {
      log(`wecom[${account.accountId}]: drop group chat ${peerId} (not mentioned)`);
      return;
    }
  }

  // Format envelope
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
  // For image messages, include the PicUrl so the agent can see/analyze it
  const agentText =
    mediaUrls.length > 0 ? `${effectiveContent}\n${mediaUrls.join("\n")}` : effectiveContent;

  // System event for logging
  const inboundLabel = isGroup ? `[WeCom] chat:${peerId} ${fromUser}` : `[WeCom] ${fromUser}`;
  const preview = agentText.length > 100 ? agentText.slice(0, 100) + "…" : agentText;
  core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
    channel: "wecom",
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    text: agentText,
    senderLabel: fromUser,
    senderTag: fromUser,
    chatType,
    options: envelopeOptions,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: agentText,
    RawBody: agentText,
    CommandBody: agentText,
    From: wecomFrom,
    To: wecomTo,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: chatType,
    SenderName: fromUser,
    SenderId: fromUser,
    Provider: "wecom" as const,
    Surface: "wecom" as const,
    MessageSid: msgId || `wecom-${Date.now()}`,
    Timestamp: Number(createTime) * 1000 || Date.now(),
    WasMentioned: isGroup ? wasMentioned : true,
    CommandAuthorized: true,
    OriginatingChannel: "wecom" as const,
    OriginatingTo: wecomTo,
  });

  // Create reply dispatcher
  const { dispatcher, replyOptions, markDispatchIdle, flushReasoning } = createWeComReplyDispatcher(
    {
      cfg,
      agentId: route.agentId,
      runtime: runtime as RuntimeEnv,
      toUser: isGroup ? `chat:${peerId}` : fromUser,
      accountId: account.accountId,
    },
  );

  log(`wecom[${account.accountId}]: dispatching to agent (session=${route.sessionKey})`);

  try {
    const { queuedFinal, counts } = await core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions,
    });

    await flushReasoning();
    markDispatchIdle();

    log(
      `wecom[${account.accountId}]: dispatch complete (queuedFinal=${queuedFinal}, replies=${counts.final})`,
    );
  } catch (err) {
    error(`wecom[${account.accountId}]: failed to dispatch: ${String(err)}`);
    // Fallback error reply
    if (isGroup) {
      await sendWeComGroupText({
        cfg,
        chatId: peerId,
        text: "抱歉，AI 处理出现异常，请稍后再试。",
        accountId,
      });
    } else {
      await sendWeComText({
        cfg,
        to: fromUser,
        text: "抱歉，AI 处理出现异常，请稍后再试。",
        accountId,
      });
    }
  }
}

// --- AI Bot (智能机器人) message handler ---

export type HandleWeComAiBotMessageParams = {
  cfg: ClawdbotConfig;
  msg: {
    msgid?: string;
    aibotid?: string;
    chatid?: string;
    chattype?: string;
    from?: { userid?: string };
    response_url?: string;
    msgtype?: string;
    text?: { content?: string };
  };
  runtime?: RuntimeEnv;
  chatHistories: Map<string, HistoryEntry[]>;
  accountId?: string;
  stream: AiBotStreamState;
};

export async function handleWeComAiBotMessage(params: HandleWeComAiBotMessageParams) {
  const { cfg, msg, runtime, accountId, stream } = params;
  const core = getWeComRuntime();
  const account = resolveWeComAccount({ cfg, accountId });
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const fromUser = msg.from?.userid ?? "";
  const msgId = msg.msgid ?? "";
  const chatId = msg.chatid ?? "";
  const chatType = (msg.chattype === "group" ? "group" : "direct") as const;
  const content = msg.text?.content?.trim() ?? "";

  log(
    `wecom[${account.accountId}]: AI bot recv from=${fromUser} chatId=${chatId || "-"} msgId=${msgId}`,
  );

  // Dedup
  if (msgId && !tryRecordMessage(msgId)) {
    log(`wecom[${account.accountId}]: AI bot duplicate ${msgId}, skipping`);
    stream.finished = true;
    return;
  }

  if (!content) {
    log(`wecom[${account.accountId}]: AI bot empty content, skipping`);
    stream.content = "请发送文本消息。";
    stream.finished = true;
    return;
  }

  const isGroup = chatType === "group";
  const peerId = isGroup ? chatId : fromUser;
  const wecomFrom = isGroup ? `wecom:chat:${peerId}` : `wecom:${fromUser}`;
  const wecomTo = isGroup ? `chat:${peerId}` : `user:${fromUser}`;

  // Resolve agent route
  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "wecom",
    accountId: account.accountId,
    peer: { kind: chatType, id: peerId },
  });

  // Format envelope
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const inboundLabel = isGroup
    ? `[WeCom AI Bot] chat:${peerId} ${fromUser}`
    : `[WeCom AI Bot] ${fromUser}`;
  const preview = content.length > 100 ? content.slice(0, 100) + "…" : content;
  core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
    channel: "wecom",
    sessionKey: route.sessionKey,
  });

  const body = core.channel.reply.formatAgentEnvelope({
    text: content,
    senderLabel: fromUser,
    senderTag: fromUser,
    chatType,
    options: envelopeOptions,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: content,
    RawBody: content,
    CommandBody: content,
    From: wecomFrom,
    To: wecomTo,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: chatType,
    SenderName: fromUser,
    SenderId: fromUser,
    Provider: "wecom" as const,
    Surface: "wecom" as const,
    MessageSid: msgId || `wecom-aibot-${Date.now()}`,
    Timestamp: Date.now(),
    WasMentioned: true,
    CommandAuthorized: true,
    OriginatingChannel: "wecom" as const,
    OriginatingTo: wecomTo,
  });

  // Create AI bot reply dispatcher (stream-based)
  const { dispatcher, replyOptions, flushReasoning } = createWeComAiBotReplyDispatcher({
    cfg,
    agentId: route.agentId,
    runtime: runtime as RuntimeEnv,
    accountId: account.accountId,
    stream,
  });

  log(`wecom[${account.accountId}]: AI bot dispatching (session=${route.sessionKey})`);

  try {
    const { counts } = await core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions,
    });

    await flushReasoning();
    if (!stream.content) {
      stream.content = "（AI 未生成回复）";
    }
    stream.finished = true;

    log(`wecom[${account.accountId}]: AI bot dispatch complete (replies=${counts.final})`);
  } catch (err) {
    error(`wecom[${account.accountId}]: AI bot dispatch failed: ${String(err)}`);
    stream.content = stream.content || "抱歉，AI 处理出现异常，请稍后再试。";
    stream.finished = true;
  }
}
