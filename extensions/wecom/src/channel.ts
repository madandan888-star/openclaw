import type { ChannelMeta, ChannelPlugin, ClawdbotConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk";
import type { ResolvedWeComAccount, WeComConfig } from "./types.js";
import {
  resolveWeComAccount,
  listWeComAccountIds,
  resolveDefaultWeComAccountId,
} from "./accounts.js";
import { wecomOutbound } from "./outbound.js";
import { sendWeComText } from "./send.js";
import { normalizeWeComTarget, looksLikeWeComId } from "./targets.js";

const meta: ChannelMeta = {
  id: "wecom",
  label: "WeCom",
  selectionLabel: "WeCom (企业微信)",
  docsPath: "/channels/wecom",
  docsLabel: "wecom",
  blurb: "企业微信自建应用消息通道",
  aliases: ["wework", "wxwork"],
  order: 70,
};

export const wecomPlugin: ChannelPlugin<ResolvedWeComAccount> = {
  id: "wecom",
  meta: { ...meta },
  pairing: {
    idLabel: "wecomUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^wecom:/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      await sendWeComText({ cfg, to: id, text: PAIRING_APPROVED_MESSAGE });
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    polls: false,
    threads: false,
    media: false, // TODO: add media support later
    reactions: false,
    edit: false,
    reply: false,
  },
  agentPrompt: {
    messageToolHints: () => [
      "- WeCom targeting: omit `target` to reply to the current user. Explicit targets use WeCom user IDs.",
      "- WeCom messages have a 2048 character limit.",
    ],
  },
  reload: { configPrefixes: ["channels.wecom"] },
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        corpId: { type: "string" },
        agentId: { oneOf: [{ type: "string" }, { type: "integer" }] },
        secret: { type: "string" },
        token: { type: "string" },
        encodingAesKey: { type: "string" },
        webhookPath: { type: "string" },
        webhookPort: { type: "integer", minimum: 1 },
        dmPolicy: { type: "string", enum: ["open", "pairing", "allowlist"] },
        allowFrom: { type: "array", items: { oneOf: [{ type: "string" }, { type: "number" }] } },
        textChunkLimit: { type: "integer", minimum: 1 },
        accounts: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              corpId: { type: "string" },
              agentId: { oneOf: [{ type: "string" }, { type: "integer" }] },
              secret: { type: "string" },
              token: { type: "string" },
              encodingAesKey: { type: "string" },
            },
          },
        },
      },
    },
  },
  config: {
    listAccountIds: (cfg) => listWeComAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveWeComAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultWeComAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const isDefault = accountId === DEFAULT_ACCOUNT_ID;
      if (isDefault) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            wecom: { ...(cfg.channels as any)?.wecom, enabled },
          },
        };
      }
      const wecomCfg = (cfg.channels as any)?.wecom as WeComConfig | undefined;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          wecom: {
            ...wecomCfg,
            accounts: {
              ...wecomCfg?.accounts,
              [accountId]: { ...wecomCfg?.accounts?.[accountId], enabled },
            },
          },
        },
      };
    },
    deleteAccount: ({ cfg, accountId }) => {
      const isDefault = accountId === DEFAULT_ACCOUNT_ID;
      if (isDefault) {
        const next = { ...cfg } as ClawdbotConfig;
        const nextChannels = { ...cfg.channels };
        delete (nextChannels as Record<string, unknown>).wecom;
        if (Object.keys(nextChannels).length > 0) next.channels = nextChannels;
        else delete next.channels;
        return next;
      }
      const wecomCfg = (cfg.channels as any)?.wecom as WeComConfig | undefined;
      const accounts = { ...wecomCfg?.accounts };
      delete accounts[accountId];
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          wecom: { ...wecomCfg, accounts: Object.keys(accounts).length > 0 ? accounts : undefined },
        },
      };
    },
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      name: account.name,
      corpId: account.corpId,
      agentId: account.agentId,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = resolveWeComAccount({ cfg, accountId });
      return (account.config?.allowFrom ?? []).map((entry) => String(entry));
    },
    formatAllowFrom: ({ allowFrom }) => allowFrom.map((e) => String(e).trim()).filter(Boolean),
  },
  setup: {
    resolveAccountId: () => DEFAULT_ACCOUNT_ID,
    applyAccountConfig: ({ cfg }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        wecom: { ...(cfg.channels as any)?.wecom, enabled: true },
      },
    }),
  },
  messaging: {
    normalizeTarget: (raw) => normalizeWeComTarget(raw) ?? undefined,
    targetResolver: {
      looksLikeId: looksLikeWeComId,
      hint: "<wecomUserId>",
    },
  },
  outbound: wecomOutbound,
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      port: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      port: snapshot.port ?? null,
    }),
    probeAccount: async () => ({ ok: true }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      name: account.name,
      corpId: account.corpId,
      agentId: account.agentId,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      port: runtime?.port ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const { monitorWeComProvider } = await import("./monitor.js");
      const account = resolveWeComAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
      const port = account.config?.webhookPort ?? 9001;
      ctx.setStatus({ accountId: ctx.accountId, port });
      ctx.log?.info(`starting wecom[${ctx.accountId}] (registering on port ${port})`);
      return monitorWeComProvider({
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        accountId: ctx.accountId,
      });
    },
  },
};
