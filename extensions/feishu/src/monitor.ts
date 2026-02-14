import type { ClawdbotConfig, RuntimeEnv, HistoryEntry } from "openclaw/plugin-sdk";
import * as Lark from "@larksuiteoapi/node-sdk";
import * as http from "http";
import type { ResolvedFeishuAccount } from "./types.js";
import { resolveFeishuAccount, listEnabledFeishuAccounts } from "./accounts.js";
import {
  handleFeishuMessage,
  type FeishuMessageEvent,
  type FeishuBotAddedEvent,
  type FeishuUserMemberEvent,
} from "./bot.js";
import { createFeishuWSClient, createEventDispatcher } from "./client.js";
import {
  registerFeishuAccountHistory,
  unregisterFeishuAccountHistory,
  getRegisteredFeishuAccountIds,
} from "./cross-bot-broadcast.js";
import { probeFeishu } from "./probe.js";

export type MonitorFeishuOpts = {
  config?: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
};

// Per-account WebSocket clients, HTTP servers, and bot info
const wsClients = new Map<string, Lark.WSClient>();
const httpServers = new Map<string, http.Server>();
const botOpenIds = new Map<string, string>();

async function fetchBotInfo(
  account: ResolvedFeishuAccount,
): Promise<{ openId?: string; name?: string }> {
  try {
    const result = await probeFeishu(account);
    return result.ok ? { openId: result.botOpenId, name: result.botName } : {};
  } catch {
    return {};
  }
}

/**
 * Dispatch a group member change notification as a synthetic message to the agent session.
 */
function dispatchMemberChangeNotification(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  runtime?: RuntimeEnv;
  chatId: string;
  chatHistories: Map<string, HistoryEntry[]>;
  text: string;
  fireAndForget?: boolean;
  log: (...args: any[]) => void;
  error: (...args: any[]) => void;
}): void {
  const { cfg, accountId, runtime, chatId, chatHistories, text, fireAndForget, log, error } =
    params;

  // Build a synthetic FeishuMessageEvent so it flows through the normal message pipeline
  const syntheticEvent: FeishuMessageEvent = {
    sender: {
      sender_id: { open_id: "system" },
      sender_type: "system",
    },
    message: {
      message_id: `member_change_${chatId}_${Date.now()}`,
      chat_id: chatId,
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text }),
    },
  };

  const promise = handleFeishuMessage({
    cfg,
    event: syntheticEvent,
    botOpenId: botOpenIds.get(accountId),
    runtime,
    chatHistories,
    accountId,
    _senderNameOverride: "系统",
  });

  if (fireAndForget) {
    promise.catch((err) => {
      error(`feishu[${accountId}]: error dispatching member change notification: ${String(err)}`);
    });
  } else {
    promise.catch((err) => {
      error(`feishu[${accountId}]: error dispatching member change notification: ${String(err)}`);
    });
  }
}

/**
 * Register common event handlers on an EventDispatcher.
 * When fireAndForget is true (webhook mode), message handling is not awaited
 * to avoid blocking the HTTP response (Lark requires <3s response).
 */
function registerEventHandlers(
  eventDispatcher: Lark.EventDispatcher,
  context: {
    cfg: ClawdbotConfig;
    accountId: string;
    runtime?: RuntimeEnv;
    chatHistories: Map<string, HistoryEntry[]>;
    fireAndForget?: boolean;
  },
) {
  const { cfg, accountId, runtime, chatHistories, fireAndForget } = context;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  eventDispatcher.register({
    "im.message.receive_v1": async (data) => {
      try {
        const event = data as unknown as FeishuMessageEvent;
        const promise = handleFeishuMessage({
          cfg,
          event,
          botOpenId: botOpenIds.get(accountId),
          runtime,
          chatHistories,
          accountId,
        });
        if (fireAndForget) {
          promise.catch((err) => {
            error(`feishu[${accountId}]: error handling message: ${String(err)}`);
          });
        } else {
          await promise;
        }
      } catch (err) {
        error(`feishu[${accountId}]: error handling message: ${String(err)}`);
      }
    },
    "im.message.message_read_v1": async () => {
      // Ignore read receipts
    },
    "im.chat.member.bot.added_v1": async (data) => {
      try {
        const event = data as unknown as FeishuBotAddedEvent;
        log(`feishu[${accountId}]: bot added to chat ${event.chat_id}`);
      } catch (err) {
        error(`feishu[${accountId}]: error handling bot added event: ${String(err)}`);
      }
    },
    "im.chat.member.bot.deleted_v1": async (data) => {
      try {
        const event = data as unknown as { chat_id: string };
        log(`feishu[${accountId}]: bot removed from chat ${event.chat_id}`);
      } catch (err) {
        error(`feishu[${accountId}]: error handling bot removed event: ${String(err)}`);
      }
    },
    "im.chat.member.user.added_v1": async (data) => {
      try {
        const event = data as unknown as FeishuUserMemberEvent;
        const users = event.users ?? [];
        for (const user of users) {
          const name = user.name ?? "unknown";
          const openId = user.user_id?.open_id ?? "unknown";
          log(`feishu[${accountId}]: user ${name} (${openId}) added to chat ${event.chat_id}`);
          const text = `[系统通知] 用户 ${name} (open_id: ${openId}) 加入了群聊`;
          dispatchMemberChangeNotification({
            cfg,
            accountId,
            runtime,
            chatId: event.chat_id,
            chatHistories,
            text,
            fireAndForget,
            log,
            error,
          });
        }
      } catch (err) {
        error(`feishu[${accountId}]: error handling user added event: ${String(err)}`);
      }
    },
    "im.chat.member.user.deleted_v1": async (data) => {
      try {
        const event = data as unknown as FeishuUserMemberEvent;
        const users = event.users ?? [];
        for (const user of users) {
          const name = user.name ?? "unknown";
          const openId = user.user_id?.open_id ?? "unknown";
          log(`feishu[${accountId}]: user ${name} (${openId}) removed from chat ${event.chat_id}`);
          const text = `[系统通知] 用户 ${name} (open_id: ${openId}) 离开了群聊`;
          dispatchMemberChangeNotification({
            cfg,
            accountId,
            runtime,
            chatId: event.chat_id,
            chatHistories,
            text,
            fireAndForget,
            log,
            error,
          });
        }
      } catch (err) {
        error(`feishu[${accountId}]: error handling user deleted event: ${String(err)}`);
      }
    },
  });
}

type MonitorAccountParams = {
  cfg: ClawdbotConfig;
  account: ResolvedFeishuAccount;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
};

/**
 * Monitor a single Feishu account.
 */
async function monitorSingleAccount(params: MonitorAccountParams): Promise<void> {
  const { cfg, account, runtime, abortSignal } = params;
  const { accountId } = account;
  const log = runtime?.log ?? console.log;

  // Fetch bot open_id
  const botInfo = await fetchBotInfo(account);
  const botOpenId = botInfo.openId;
  const apiBotName = botInfo.name;
  botOpenIds.set(accountId, botOpenId ?? "");
  log(
    `feishu[${accountId}]: bot open_id resolved: ${botOpenId ?? "unknown"}, name: ${apiBotName ?? "unknown"}`,
  );

  const connectionMode = account.config.connectionMode ?? "websocket";
  const eventDispatcher = createEventDispatcher(account);
  const chatHistories = new Map<string, HistoryEntry[]>();

  // Register this account's group history map so outbound bot messages can be broadcast
  // into other accounts' session histories (Feishu does not deliver bot->bot messages).
  registerFeishuAccountHistory({
    accountId,
    chatHistories,
    botOpenId: botOpenId ?? "",
    botName: account.name ?? apiBotName ?? accountId,
  });

  registerEventHandlers(eventDispatcher, {
    cfg,
    accountId,
    runtime,
    chatHistories,
    fireAndForget: connectionMode === "webhook",
  });

  if (connectionMode === "webhook") {
    return monitorWebhook({ params, accountId, eventDispatcher });
  }

  return monitorWebSocket({ params, accountId, eventDispatcher });
}

type ConnectionParams = {
  params: MonitorAccountParams;
  accountId: string;
  eventDispatcher: Lark.EventDispatcher;
};

async function monitorWebSocket({
  params,
  accountId,
  eventDispatcher,
}: ConnectionParams): Promise<void> {
  const { account, runtime, abortSignal } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  log(`feishu[${accountId}]: starting WebSocket connection...`);

  const wsClient = createFeishuWSClient(account);
  wsClients.set(accountId, wsClient);

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      wsClients.delete(accountId);
      botOpenIds.delete(accountId);
      unregisterFeishuAccountHistory(accountId);
    };

    const handleAbort = () => {
      log(`feishu[${accountId}]: abort signal received, stopping`);
      cleanup();
      resolve();
    };

    if (abortSignal?.aborted) {
      cleanup();
      resolve();
      return;
    }

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    try {
      wsClient.start({ eventDispatcher });
      log(`feishu[${accountId}]: WebSocket client started`);
    } catch (err) {
      cleanup();
      abortSignal?.removeEventListener("abort", handleAbort);
      reject(err);
    }
  });
}

async function monitorWebhook({
  params,
  accountId,
  eventDispatcher,
}: ConnectionParams): Promise<void> {
  const { account, runtime, abortSignal } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const port = account.config.webhookPort ?? 3000;
  const path = account.config.webhookPath ?? "/feishu/events";

  log(`feishu[${accountId}]: starting Webhook server on port ${port}, path ${path}...`);

  const server = http.createServer();
  server.on("request", Lark.adaptDefault(path, eventDispatcher, { autoChallenge: true }));
  httpServers.set(accountId, server);

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.close();
      httpServers.delete(accountId);
      botOpenIds.delete(accountId);
      unregisterFeishuAccountHistory(accountId);
    };

    const handleAbort = () => {
      log(`feishu[${accountId}]: abort signal received, stopping Webhook server`);
      cleanup();
      resolve();
    };

    if (abortSignal?.aborted) {
      cleanup();
      resolve();
      return;
    }

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    server.listen(port, () => {
      log(`feishu[${accountId}]: Webhook server listening on port ${port}`);
    });

    server.on("error", (err) => {
      error(`feishu[${accountId}]: Webhook server error: ${err}`);
      abortSignal?.removeEventListener("abort", handleAbort);
      reject(err);
    });
  });
}

/**
 * Main entry: start monitoring for all enabled accounts.
 */
export async function monitorFeishuProvider(opts: MonitorFeishuOpts = {}): Promise<void> {
  const cfg = opts.config;
  if (!cfg) {
    throw new Error("Config is required for Feishu monitor");
  }

  const log = opts.runtime?.log ?? console.log;

  // If accountId is specified, only monitor that account
  if (opts.accountId) {
    const account = resolveFeishuAccount({ cfg, accountId: opts.accountId });
    if (!account.enabled || !account.configured) {
      throw new Error(`Feishu account "${opts.accountId}" not configured or disabled`);
    }
    return monitorSingleAccount({
      cfg,
      account,
      runtime: opts.runtime,
      abortSignal: opts.abortSignal,
    });
  }

  // Otherwise, start all enabled accounts
  const accounts = listEnabledFeishuAccounts(cfg);
  if (accounts.length === 0) {
    throw new Error("No enabled Feishu accounts configured");
  }

  log(
    `feishu: starting ${accounts.length} account(s): ${accounts.map((a) => a.accountId).join(", ")}`,
  );

  // Start all accounts in parallel
  await Promise.all(
    accounts.map((account) =>
      monitorSingleAccount({
        cfg,
        account,
        runtime: opts.runtime,
        abortSignal: opts.abortSignal,
      }),
    ),
  );
}

/**
 * Stop monitoring for a specific account or all accounts.
 */
export function stopFeishuMonitor(accountId?: string): void {
  if (accountId) {
    wsClients.delete(accountId);
    const server = httpServers.get(accountId);
    if (server) {
      server.close();
      httpServers.delete(accountId);
    }
    botOpenIds.delete(accountId);
    unregisterFeishuAccountHistory(accountId);
  } else {
    wsClients.clear();
    for (const server of httpServers.values()) {
      server.close();
    }
    httpServers.clear();
    botOpenIds.clear();

    // Clear all registered histories (best-effort)
    for (const id of getRegisteredFeishuAccountIds()) {
      unregisterFeishuAccountHistory(id);
    }
  }
}
