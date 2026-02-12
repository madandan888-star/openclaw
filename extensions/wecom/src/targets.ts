export function normalizeWeComTarget(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Remove wecom: prefix if present
  return trimmed.replace(/^wecom:/i, "");
}

export function looksLikeWeComId(raw: string): boolean {
  // WeCom user IDs are typically alphanumeric
  return /^[a-zA-Z0-9_-]{1,64}$/.test(raw.trim());
}

export function formatWeComTarget(userId: string): string {
  return userId;
}
