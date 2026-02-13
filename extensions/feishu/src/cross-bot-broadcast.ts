import type { ClawdbotConfig } from "openclaw/plugin-sdk";
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
