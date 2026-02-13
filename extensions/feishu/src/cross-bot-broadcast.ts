import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import {
  DEFAULT_GROUP_HISTORY_LIMIT,
  recordPendingHistoryEntryIfEnabled,
  type HistoryEntry,
} from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";

export type FeishuAccountHistoryRegistration = {
  accountId: string;
  chatHistories: Map<string, HistoryEntry[]>;
  botOpenId?: string;
  botName?: string;
};

const registrations = new Map<string, FeishuAccountHistoryRegistration>();

export function registerFeishuAccountHistory(reg: FeishuAccountHistoryRegistration): void {
  registrations.set(reg.accountId, reg);
}

export function unregisterFeishuAccountHistory(accountId: string): void {
  registrations.delete(accountId);
}

export function getRegisteredFeishuAccountIds(): string[] {
  return [...registrations.keys()].toSorted((a, b) => a.localeCompare(b));
}

export type BroadcastFeishuBotMessageParams = {
  cfg: ClawdbotConfig;
  chatId: string;
  senderAccountId: string;
  /** Plain, human-readable bot name to show in history bodies. */
  senderBotName: string;
  /** Message text to inject into other accounts' group history. */
  text: string;
  messageId: string;
  timestamp?: number;
  log?: (msg: string) => void;
};

function resolveHistoryLimit(cfg: ClawdbotConfig, accountId: string): number {
  const account = resolveFeishuAccount({ cfg, accountId });
  const feishuCfg = account.config;
  return Math.max(
    0,
    feishuCfg?.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
  );
}

/**
 * Feishu won't deliver bot -> bot messages in the same group.
 * After a bot sends a message successfully, we inject that outbound message
 * into other Feishu accounts' group chat history so their sessions stay in sync.
 */
export function broadcastFeishuBotMessageToOtherAccounts(
  params: BroadcastFeishuBotMessageParams,
): void {
  const { cfg, chatId, senderAccountId, senderBotName, text, messageId } = params;

  // This implementation is intentionally conservative:
  // - only group chat IDs (oc_...) are eligible
  // - only accounts currently registered in this monitor process participate
  if (!chatId?.startsWith("oc_")) {
    return;
  }

  const now = params.timestamp ?? Date.now();

  const senderOpenId = registrations.get(senderAccountId)?.botOpenId;
  // Keep sender id simple (avoid additional ':' which is used in envelope from formatting).
  const entrySender = senderOpenId || `bot_${senderAccountId}`;

  const injectedBody = `${senderBotName}: ${text}`;

  for (const [accountId, reg] of registrations) {
    if (accountId === senderAccountId) continue;

    const historyLimit = resolveHistoryLimit(cfg, accountId);
    if (historyLimit <= 0) continue;

    recordPendingHistoryEntryIfEnabled({
      historyMap: reg.chatHistories,
      historyKey: chatId,
      limit: historyLimit,
      entry: {
        sender: entrySender,
        body: injectedBody,
        timestamp: now,
        messageId,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Cross-bot mention dispatch
// ---------------------------------------------------------------------------

export function getFeishuAccountRegistration(
  accountId: string,
): FeishuAccountHistoryRegistration | undefined {
  return registrations.get(accountId);
}

/**
 * Find registered bot accounts whose botOpenId appears in the outbound text
 * or in the auto-mention targets.
 *
 * Detection covers:
 *  - mentionTargetOpenIds (auto-@mentions added by reply dispatcher)
 *  - `<at user_id="xxx">` format in text (Feishu text message markup)
 *  - `<at id=xxx>` format in text (Feishu card markdown markup)
 *  - `@BotName` in text (plain text, agent-written)
 */
export function findMentionedBotRegistrations(params: {
  text: string;
  mentionTargetOpenIds?: string[];
  excludeAccountId: string;
}): FeishuAccountHistoryRegistration[] {
  const { text, mentionTargetOpenIds, excludeAccountId } = params;
  const matched = new Map<string, FeishuAccountHistoryRegistration>();

  for (const [accountId, reg] of registrations) {
    if (accountId === excludeAccountId) continue;
    if (!reg.botOpenId) continue;

    // Check mentionTargets openIds (auto-mention from reply)
    if (mentionTargetOpenIds?.includes(reg.botOpenId)) {
      matched.set(accountId, reg);
      continue;
    }

    // Check <at user_id="xxx"> format in text
    if (text.includes(`user_id="${reg.botOpenId}"`)) {
      matched.set(accountId, reg);
      continue;
    }

    // Check <at id=xxx> format (card markdown)
    if (text.includes(`id=${reg.botOpenId}`)) {
      matched.set(accountId, reg);
      continue;
    }

    // Check @BotName in text (plain text mention by agent)
    if (reg.botName && text.includes(`@${reg.botName}`)) {
      matched.set(accountId, reg);
      continue;
    }
  }

  return [...matched.values()];
}

export type DispatchCrossBotMentionsParams = {
  cfg: ClawdbotConfig;
  chatId: string;
  senderAccountId: string;
  senderBotName: string;
  /** The full outbound message text (agent output). */
  text: string;
  /** Message ID of the last sent chunk. */
  messageId: string;
  /** OpenIDs from the auto-mention targets in the reply. */
  mentionTargetOpenIds?: string[];
  /** Current cross-bot dispatch depth. */
  crossBotDepth?: number;
  runtime?: RuntimeEnv;
  log?: (msg: string) => void;
};

/**
 * After a bot sends a message, check if it @mentions any other registered
 * bots.  If so, dispatch a synthetic inbound message to the target bot's
 * agent session so it processes and replies as if a human had spoken.
 *
 * Anti-loop: the dispatched handleFeishuMessage call is marked with
 * `_fromCrossBotDispatch = true`.  The resulting reply dispatcher will
 * have `skipCrossBotDispatch = true`, preventing further cascading.
 */
export async function dispatchCrossBotMentions(
  params: DispatchCrossBotMentionsParams,
): Promise<void> {
  const {
    cfg,
    chatId,
    senderAccountId,
    senderBotName,
    text,
    messageId,
    mentionTargetOpenIds,
    crossBotDepth = 0,
    runtime,
    log,
  } = params;

  if (!chatId?.startsWith("oc_")) return;

  const mentionedBots = findMentionedBotRegistrations({
    text,
    mentionTargetOpenIds,
    excludeAccountId: senderAccountId,
  });

  if (mentionedBots.length === 0) return;

  const senderReg = registrations.get(senderAccountId);
  const senderBotOpenId = senderReg?.botOpenId || `bot_${senderAccountId}`;

  // Dynamic import to avoid circular dependency (bot → reply-dispatcher → cross-bot-broadcast → bot)
  const { handleFeishuMessage } = await import("./bot.js");

  for (const targetReg of mentionedBots) {
    log?.(`cross-bot-dispatch: ${senderAccountId} → ${targetReg.accountId} in chat ${chatId}`);

    // Construct a synthetic FeishuMessageEvent.
    // The mentions array includes the target bot so that checkBotMentioned() returns true,
    // which satisfies requireMention=true on the target account.
    const syntheticEvent = {
      sender: {
        sender_id: {
          open_id: senderBotOpenId,
        },
        sender_type: "user",
      },
      message: {
        message_id: `crossbot:${messageId}:${targetReg.accountId}`,
        chat_id: chatId,
        chat_type: "group" as const,
        message_type: "text",
        content: JSON.stringify({ text }),
        mentions: [
          {
            key: "@_crossbot_target",
            id: { open_id: targetReg.botOpenId },
            name: targetReg.botName || targetReg.accountId,
            tenant_key: "",
          },
        ],
      },
    };

    try {
      await handleFeishuMessage({
        cfg,
        event: syntheticEvent,
        botOpenId: targetReg.botOpenId,
        runtime,
        chatHistories: targetReg.chatHistories,
        accountId: targetReg.accountId,
        _crossBotDepth: crossBotDepth,
        _senderNameOverride: senderBotName,
      });
      log?.(`cross-bot-dispatch: dispatched to ${targetReg.accountId} successfully`);
    } catch (err) {
      log?.(`cross-bot-dispatch: failed to dispatch to ${targetReg.accountId}: ${String(err)}`);
    }
  }
}
