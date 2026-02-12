export type WeComConfig = {
  enabled?: boolean;
  corpId?: string;
  agentId?: string | number;
  secret?: string;
  token?: string;
  encodingAesKey?: string;
  webhookPath?: string;
  webhookPort?: number;
  dmPolicy?: "open" | "pairing" | "allowlist";
  allowFrom?: (string | number)[];
  groupPolicy?: "open" | "allowlist" | "disabled";
  groupAllowFrom?: (string | number)[];
  requireMention?: boolean;
  textChunkLimit?: number;
  accounts?: Record<string, Partial<WeComConfig>>;
};

export type ResolvedWeComAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name: string;
  corpId: string;
  agentId: number;
  secret: string;
  token: string;
  encodingAesKey: string;
  config?: WeComConfig;
};

export type WeComMessageContext = {
  fromUser: string;
  senderName?: string;
  msgType: string;
  content: string;
  messageId: string;
  chatId: string;
  chatType: "direct" | "group";
  mentionedBot: boolean;
  agentId: string;
  timestamp: number;
};
