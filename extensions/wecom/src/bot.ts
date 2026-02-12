import type { ClawdbotConfig, RuntimeEnv, HistoryEntry } from "openclaw/plugin-sdk";
import { resolveWeComAccount } from "./accounts.js";
import { createWeComReplyDispatcher } from "./reply-dispatcher.js";
import { getWeComRuntime } from "./runtime.js";
import { sendWeComText } from "./send.js";

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

  log(`wecom[${account.accountId}]: recv type=${msgType} from=${fromUser} msgId=${msgId}`);

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

  // Build context (WeCom self-built apps are always DM-like, agentId-scoped)
  const chatType = "direct" as const;
  const wecomFrom = `wecom:${fromUser}`;
  const wecomTo = `user:${fromUser}`;

  // Resolve agent route
  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "wecom",
    peer: {
      kind: chatType,
      id: fromUser,
    },
  });

  // Format envelope
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
  // For image messages, include the PicUrl so the agent can see/analyze it
  const agentText =
    mediaUrls.length > 0 ? `${effectiveContent}\n${mediaUrls.join("\n")}` : effectiveContent;

  // System event for logging
  const inboundLabel = `[WeCom] ${fromUser}`;
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
    WasMentioned: true,
    CommandAuthorized: true,
    OriginatingChannel: "wecom" as const,
    OriginatingTo: wecomTo,
  });

  // Create reply dispatcher
  const { dispatcher, replyOptions, markDispatchIdle } = createWeComReplyDispatcher({
    cfg,
    agentId: route.agentId,
    runtime: runtime as RuntimeEnv,
    toUser: fromUser,
    accountId: account.accountId,
  });

  log(`wecom[${account.accountId}]: dispatching to agent (session=${route.sessionKey})`);

  try {
    const { queuedFinal, counts } = await core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions,
    });

    markDispatchIdle();

    log(
      `wecom[${account.accountId}]: dispatch complete (queuedFinal=${queuedFinal}, replies=${counts.final})`,
    );
  } catch (err) {
    error(`wecom[${account.accountId}]: failed to dispatch: ${String(err)}`);
    // Fallback error reply
    await sendWeComText({
      cfg,
      to: fromUser,
      text: "抱歉，AI 处理出现异常，请稍后再试。",
      accountId,
    });
  }
}
