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

const httpServers = new Map<string, http.Server>();

function startWebhookServer(params: {
  cfg: ClawdbotConfig;
  account: ResolvedWeComAccount;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
}) {
  const { cfg, account, runtime, abortSignal } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const port = account.config?.webhookPort ?? 9001;
  const path = account.config?.webhookPath ?? "/wecom/callback";
  const crypto = new WeComCrypto(account.token, account.encodingAesKey, account.corpId);
  const chatHistories = new Map<string, HistoryEntry[]>();

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
      try {
        const echo = crypto.verifyUrl(msgSignature, timestamp, nonce, echostr);
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(echo);
        log(`wecom[${account.accountId}]: URL verification OK`);
      } catch (err) {
        error(`wecom[${account.accountId}]: URL verification failed: ${err}`);
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("verify failed");
      }
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

      // Process asynchronously
      try {
        const xml = crypto.decryptMessage(body, msgSignature, timestamp, nonce);
        handleWeComMessage({
          cfg,
          xml,
          runtime,
          chatHistories,
          accountId: account.accountId,
        }).catch((err) => {
          error(`wecom[${account.accountId}]: handle message error: ${err}`);
        });
      } catch (err) {
        error(`wecom[${account.accountId}]: decrypt failed: ${err}`);
      }
      return;
    }

    res.writeHead(405);
    res.end("method not allowed");
  });

  // Cleanup on abort
  abortSignal?.addEventListener("abort", () => {
    server.close();
    httpServers.delete(account.accountId);
    log(`wecom[${account.accountId}]: server stopped`);
  });

  server.listen(port, "127.0.0.1", () => {
    log(`wecom[${account.accountId}]: webhook server listening on 127.0.0.1:${port}`);
  });

  httpServers.set(account.accountId, server);
}

export async function monitorWeComProvider(opts: MonitorWeComOpts) {
  const cfg = opts.config;
  if (!cfg) return;

  const account = resolveWeComAccount({ cfg, accountId: opts.accountId });
  if (!account.configured) {
    opts.runtime?.error?.(`wecom[${account.accountId}]: not configured, skipping`);
    return;
  }

  // Stop existing server
  const existing = httpServers.get(account.accountId);
  if (existing) {
    existing.close();
    httpServers.delete(account.accountId);
  }

  startWebhookServer({
    cfg,
    account,
    runtime: opts.runtime,
    abortSignal: opts.abortSignal,
  });
}
