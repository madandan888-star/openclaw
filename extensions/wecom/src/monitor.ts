import type { ClawdbotConfig, RuntimeEnv, HistoryEntry } from "openclaw/plugin-sdk";
import * as http from "node:http";
import type { ResolvedWeComAccount } from "./types.js";
import { resolveWeComAccount } from "./accounts.js";
import { handleWeComMessage } from "./bot.js";
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

  // Register handler
  const handler: AccountHandler = {
    accountId: account.accountId,
    crypto: new WeComCrypto(account.token, account.encodingAesKey, account.corpId),
    account,
    chatHistories: new Map(),
  };
  entry!.handlers.set(account.accountId, handler);
  log(`wecom[${account.accountId}]: registered on port ${port}`);

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
