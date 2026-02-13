import type { ClawdbotConfig, RuntimeEnv, HistoryEntry } from "openclaw/plugin-sdk";
import * as http from "node:http";
import type { ResolvedWeComAccount } from "./types.js";
import { resolveWeComAccount } from "./accounts.js";
import { handleWeComMessage, handleWeComAiBotMessage } from "./bot.js";
import { WeComCrypto } from "./crypto.js";

export type MonitorWeComOpts = {
  config?: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
};

type AccountHandler = {
  accountId: string;
  crypto: WeComCrypto;
  account: ResolvedWeComAccount;
  chatHistories: Map<string, HistoryEntry[]>;
};

// --- AI Bot stream state ---
type AiBotStreamEntry = {
  streamId: string;
  content: string;
  finished: boolean;
  createdAt: number;
};

const aiBotStreams = new Map<string, AiBotStreamEntry>();
const AIBOT_STREAM_TTL_MS = 10 * 60 * 1000; // 10 minutes

function cleanupAiBotStreams() {
  const now = Date.now();
  for (const [id, state] of aiBotStreams) {
    if (now - state.createdAt > AIBOT_STREAM_TTL_MS) {
      aiBotStreams.delete(id);
    }
  }
}

// key = "port:path" — accounts sharing the same port+path share one HTTP server
const sharedServers = new Map<
  string,
  {
    server: http.Server;
    handlers: Map<string, AccountHandler>; // accountId → handler
    cfg: ClawdbotConfig;
    runtime?: RuntimeEnv;
  }
>();

function handleAiBotPost(params: {
  encrypted: string;
  msgSignature: string;
  timestamp: string;
  nonce: string;
  handlers: Map<string, AccountHandler>;
  cfg: ClawdbotConfig;
  runtime?: RuntimeEnv;
  res: http.ServerResponse;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}) {
  const { encrypted, msgSignature, timestamp, nonce, handlers, cfg, runtime, res, log, error } =
    params;

  // Periodic cleanup
  if (aiBotStreams.size > 50) cleanupAiBotStreams();

  for (const handler of handlers.values()) {
    if (!handler.crypto.checkSignature(msgSignature, timestamp, nonce, encrypted)) continue;

    // Decrypt
    let message: string;
    try {
      const result = handler.crypto.decrypt(encrypted);
      const expectedId = handler.account.botId || handler.account.corpId;
      if (result.corpId !== expectedId) {
        log(
          `wecom[${handler.accountId}]: AI bot appId mismatch (expected=${expectedId}, got=${result.corpId}), trying next`,
        );
        continue;
      }
      message = result.message;
    } catch (err) {
      error(`wecom[${handler.accountId}]: AI bot decrypt failed: ${err}`);
      continue;
    }

    // Parse decrypted JSON
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(message) as Record<string, unknown>;
    } catch {
      error(`wecom[${handler.accountId}]: AI bot decrypted content is not valid JSON`);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("success");
      return;
    }

    log(
      `wecom[${handler.accountId}]: AI bot recv msgtype=${msg.msgtype} from=${(msg.from as Record<string, unknown>)?.userid}`,
    );

    // --- Streaming refresh event ---
    if (msg.msgtype === "streaming") {
      const streamId = (msg.streaming as Record<string, unknown>)?.id as string | undefined;
      if (!streamId) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("success");
        return;
      }

      const state = aiBotStreams.get(streamId);
      if (!state) {
        log(`wecom[${handler.accountId}]: AI bot stream ${streamId} not found (expired?)`);
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("success");
        return;
      }

      const replyJson = JSON.stringify({
        msgtype: "stream",
        stream: {
          id: streamId,
          finish: state.finished,
          content: state.content || "思考中...",
        },
      });
      const encryptedReply = handler.crypto.encryptReply(replyJson);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(encryptedReply));

      // Delayed cleanup after finished
      if (state.finished) {
        setTimeout(() => aiBotStreams.delete(streamId), 30_000);
      }
      return;
    }

    // --- New message: start agent and respond with initial stream ---
    const streamId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const streamState: AiBotStreamEntry = {
      streamId,
      content: "",
      finished: false,
      createdAt: Date.now(),
    };
    aiBotStreams.set(streamId, streamState);

    // Start agent processing asynchronously with timeout protection
    const AIBOT_AGENT_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
    const agentTimeout = setTimeout(() => {
      if (!streamState.finished) {
        error(
          `wecom[${handler.accountId}]: AI bot agent timed out after ${AIBOT_AGENT_TIMEOUT_MS / 1000}s`,
        );
        streamState.content = streamState.content || "抱歉，AI 处理超时，请稍后再试。";
        streamState.finished = true;
      }
    }, AIBOT_AGENT_TIMEOUT_MS);

    handleWeComAiBotMessage({
      cfg,
      msg: msg as HandleWeComAiBotMsg,
      runtime,
      chatHistories: handler.chatHistories,
      accountId: handler.accountId,
      stream: streamState,
    })
      .then(() => {
        clearTimeout(agentTimeout);
      })
      .catch((err) => {
        clearTimeout(agentTimeout);
        error(`wecom[${handler.accountId}]: AI bot handle error: ${err}`);
        streamState.content = streamState.content || "抱歉，AI 处理出现异常，请稍后再试。";
        streamState.finished = true;
      });

    // Respond with initial stream
    const replyJson = JSON.stringify({
      msgtype: "stream",
      stream: {
        id: streamId,
        finish: false,
        content: "思考中...",
      },
    });
    const encryptedReply = handler.crypto.encryptReply(replyJson);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(encryptedReply));
    return;
  }

  error("wecom: AI bot POST — no account matched the signature");
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("success");
}

// Type alias for the AI bot message shape passed to handleWeComAiBotMessage
type HandleWeComAiBotMsg = {
  msgid?: string;
  aibotid?: string;
  chatid?: string;
  chattype?: string;
  from?: { userid?: string };
  response_url?: string;
  msgtype?: string;
  text?: { content?: string };
};

function createSharedServer(params: {
  key: string;
  port: number;
  path: string;
  cfg: ClawdbotConfig;
  runtime?: RuntimeEnv;
}) {
  const { key, port, path, cfg, runtime } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const handlers = new Map<string, AccountHandler>();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // Health check
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname !== path) {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    const msgSignature = url.searchParams.get("msg_signature") ?? "";
    const timestamp = url.searchParams.get("timestamp") ?? "";
    const nonce = url.searchParams.get("nonce") ?? "";

    // GET = URL verification
    if (req.method === "GET") {
      const echostr = url.searchParams.get("echostr") ?? "";
      for (const handler of handlers.values()) {
        try {
          if (!handler.crypto.checkSignature(msgSignature, timestamp, nonce, echostr)) continue;
          const echo = handler.crypto.verifyUrl(msgSignature, timestamp, nonce, echostr);
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(echo);
          log(`wecom[${handler.accountId}]: URL verification OK`);
          return;
        } catch {
          // signature didn't match or decrypt failed, try next
        }
      }
      error("wecom: URL verification failed — no account matched the signature");
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("verify failed");
      return;
    }

    // POST = message callback
    if (req.method === "POST") {
      // Read body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      const body = Buffer.concat(chunks).toString("utf-8");

      // Try AI Bot JSON format: {"encrypt": "..."}
      let aiBotEncrypted: string | null = null;
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        if (parsed && typeof parsed.encrypt === "string") {
          aiBotEncrypted = parsed.encrypt;
        }
      } catch {
        // Not JSON — continue with XML path
      }

      if (aiBotEncrypted) {
        // AI Bot JSON callback path — response handled inside
        handleAiBotPost({
          encrypted: aiBotEncrypted,
          msgSignature,
          timestamp,
          nonce,
          handlers,
          cfg,
          runtime,
          res,
          log,
          error,
        });
        return;
      }

      // === Existing self-built app XML callback path ===
      // Always respond quickly (WeCom requires <5s)
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("success");

      // Extract <Encrypt> to match signature against registered accounts
      const encryptMatch = body.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/s);
      if (!encryptMatch) {
        error("wecom: no <Encrypt> block in POST body");
        return;
      }
      const encrypted = encryptMatch[1]!;

      for (const handler of handlers.values()) {
        if (!handler.crypto.checkSignature(msgSignature, timestamp, nonce, encrypted)) continue;

        // Matched — decrypt and handle
        try {
          const xml = handler.crypto.decryptMessage(body, msgSignature, timestamp, nonce);
          handleWeComMessage({
            cfg,
            xml,
            runtime,
            chatHistories: handler.chatHistories,
            accountId: handler.accountId,
          }).catch((err) => {
            error(`wecom[${handler.accountId}]: handle message error: ${err}`);
          });
        } catch (err) {
          error(`wecom[${handler.accountId}]: decrypt failed: ${err}`);
        }
        return;
      }

      error("wecom: POST message — no account matched the signature");
      return;
    }

    res.writeHead(405);
    res.end("method not allowed");
  });

  server.listen(port, "127.0.0.1", () => {
    log(`webhook server listening on 127.0.0.1:${port}`);
  });

  const entry = { server, handlers, cfg, runtime };
  sharedServers.set(key, entry);
  return entry;
}

export async function monitorWeComProvider(opts: MonitorWeComOpts) {
  const cfg = opts.config;
  if (!cfg) return;

  const account = resolveWeComAccount({ cfg, accountId: opts.accountId });
  if (!account.configured) {
    opts.runtime?.error?.(`wecom[${account.accountId}]: not configured, skipping`);
    return;
  }

  const log = opts.runtime?.log ?? console.log;
  const port = account.config?.webhookPort ?? 9001;
  const path = account.config?.webhookPath ?? "/wecom/callback";
  const key = `${port}:${path}`;

  // Get or create the shared server for this port+path
  let entry = sharedServers.get(key);
  if (!entry) {
    entry = createSharedServer({ key, port, path, cfg, runtime: opts.runtime });
  }

  // Remove existing handler for this account (hot-reload)
  entry!.handlers.delete(account.accountId);

  // Register handler — use botId for AI bot accounts, corpId for self-built apps
  const appId = account.botId || account.corpId;
  const handler: AccountHandler = {
    accountId: account.accountId,
    crypto: new WeComCrypto(account.token, account.encodingAesKey, appId),
    account,
    chatHistories: new Map(),
  };
  entry!.handlers.set(account.accountId, handler);
  log(`wecom[${account.accountId}]: registered on port ${port}${account.botId ? " (AI bot)" : ""}`);

  // Cleanup on abort — remove handler; close server if no handlers remain
  opts.abortSignal?.addEventListener("abort", () => {
    const e = sharedServers.get(key);
    if (!e) return;
    e.handlers.delete(account.accountId);
    log(`wecom[${account.accountId}]: unregistered from port ${port}`);
    if (e.handlers.size === 0) {
      e.server.close();
      sharedServers.delete(key);
      log(`webhook server on port ${port} closed (no more accounts)`);
    }
  });
}
