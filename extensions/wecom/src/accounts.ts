import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { WeComConfig, ResolvedWeComAccount } from "./types.js";

function getWeComConfig(cfg: ClawdbotConfig): WeComConfig | undefined {
  return (cfg.channels as Record<string, unknown> | undefined)?.wecom as WeComConfig | undefined;
}

export function listWeComAccountIds(cfg: ClawdbotConfig): string[] {
  const wecom = getWeComConfig(cfg);
  if (!wecom) return [];
  const ids: string[] = [DEFAULT_ACCOUNT_ID];
  if (wecom.accounts) {
    for (const id of Object.keys(wecom.accounts)) {
      if (id !== DEFAULT_ACCOUNT_ID) ids.push(id);
    }
  }
  return ids;
}

export function resolveDefaultWeComAccountId(cfg: ClawdbotConfig): string {
  return DEFAULT_ACCOUNT_ID;
}

export function resolveWeComAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
}): ResolvedWeComAccount {
  const { cfg, accountId = DEFAULT_ACCOUNT_ID } = params;
  const wecom = getWeComConfig(cfg);
  const isDefault = !accountId || accountId === DEFAULT_ACCOUNT_ID;

  const acctCfg = isDefault ? wecom : { ...wecom, ...wecom?.accounts?.[accountId] };

  const corpId = acctCfg?.corpId ?? "";
  const agentId = Number(acctCfg?.agentId ?? 0);
  const secret = acctCfg?.secret ?? "";
  const token = acctCfg?.token ?? "";
  const encodingAesKey = acctCfg?.encodingAesKey ?? "";
  const botId = acctCfg?.botId ?? "";
  const enabled = acctCfg?.enabled !== false;
  const configured = !!(token && encodingAesKey && ((corpId && secret) || botId));

  return {
    accountId,
    enabled,
    configured,
    name: isDefault ? "default" : accountId,
    corpId,
    agentId,
    secret,
    token,
    encodingAesKey,
    botId,
    config: acctCfg,
  };
}

export function resolveWeComCredentials(cfg: ClawdbotConfig, accountId?: string) {
  const account = resolveWeComAccount({ cfg, accountId });
  return {
    corpId: account.corpId,
    agentId: account.agentId,
    secret: account.secret,
    token: account.token,
    encodingAesKey: account.encodingAesKey,
  };
}
