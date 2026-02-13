export function normalizeWeComTarget(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Remove wecom: prefix if present
  return trimmed.replace(/^wecom:/i, "");
}

export function looksLikeWeComId(raw: string, normalized?: string): boolean {
  const candidates = [raw, normalized].filter((v): v is string => typeof v === "string");

  for (const value of candidates) {
    const trimmed = value.trim();
    if (!trimmed) continue;

    const withoutPrefix = trimmed.replace(/^wecom:/i, "");

    // Support appchat targets: chat:<chatid>
    if (/^chat:/i.test(withoutPrefix)) {
      const chatId = withoutPrefix.slice(5);
      if (/^[a-zA-Z0-9_-]{1,128}$/.test(chatId)) return true;
      continue;
    }

    // WeCom user IDs are typically alphanumeric
    if (/^[a-zA-Z0-9_-]{1,64}$/.test(withoutPrefix)) return true;
  }

  return false;
}

export function formatWeComTarget(userId: string): string {
  return userId;
}
