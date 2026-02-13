import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { resolveWeComAccount } from "./accounts.js";

// Access token cache per account
const tokenCache = new Map<string, { value: string; expireAt: number }>();

export async function getAccessToken(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
}): Promise<string> {
  const account = resolveWeComAccount({ cfg: params.cfg, accountId: params.accountId });
  const cacheKey = account.accountId;
  const now = Date.now();
  const cached = tokenCache.get(cacheKey);

  if (cached && cached.expireAt - 120_000 > now) {
    return cached.value;
  }

  const url = `https://bot.youfuli.cn/wecom-api/cgi-bin/gettoken?corpid=${encodeURIComponent(account.corpId)}&corpsecret=${encodeURIComponent(account.secret)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const j = (await res.json()) as {
    errcode: number;
    errmsg: string;
    access_token: string;
    expires_in: number;
  };

  if (j.errcode !== 0) {
    throw new Error(`WeCom gettoken failed: ${j.errcode} ${j.errmsg}`);
  }

  tokenCache.set(cacheKey, {
    value: j.access_token,
    expireAt: now + j.expires_in * 1000,
  });

  return j.access_token;
}

export async function sendWeComText(params: {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  accountId?: string;
}): Promise<boolean> {
  const account = resolveWeComAccount({ cfg: params.cfg, accountId: params.accountId });
  const content = params.text.slice(0, 2048);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const token = await getAccessToken({ cfg: params.cfg, accountId: params.accountId });
      const url = `https://bot.youfuli.cn/wecom-api/cgi-bin/message/send?access_token=${token}`;
      const body = {
        touser: params.to,
        msgtype: "text",
        agentid: account.agentId,
        text: { content },
        safe: 0,
        enable_duplicate_check: 0,
        duplicate_check_interval: 0,
      };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const j = (await res.json()) as { errcode: number; errmsg: string };
      if (j.errcode === 0) return true;

      // Token expired - invalidate cache and retry
      if (j.errcode === 40014 || j.errcode === 42001) {
        tokenCache.delete(account.accountId);
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }
  return false;
}

export async function sendWeComGroupText(params: {
  cfg: ClawdbotConfig;
  chatId: string;
  text: string;
  accountId?: string;
}): Promise<boolean> {
  const content = params.text.slice(0, 2048);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const account = resolveWeComAccount({ cfg: params.cfg, accountId: params.accountId });
      const token = await getAccessToken({ cfg: params.cfg, accountId: params.accountId });
      const url = `https://bot.youfuli.cn/wecom-api/cgi-bin/appchat/send?access_token=${token}`;
      const body = {
        chatid: params.chatId,
        msgtype: "text",
        text: { content },
      };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const j = (await res.json()) as { errcode: number; errmsg: string };
      if (j.errcode === 0) return true;

      if (j.errcode === 40014 || j.errcode === 42001) {
        tokenCache.delete(account.accountId);
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }

  return false;
}

function guessImageMimeType(fileName: string, contentType?: string | null): string | undefined {
  const ct = contentType?.split(";")[0]?.trim();
  if (ct && ct.startsWith("image/")) return ct;

  switch (extname(fileName).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    case ".webp":
      return "image/webp";
    default:
      return undefined;
  }
}

function extFromImageMimeType(mimeType: string): string | undefined {
  const ct = mimeType.split(";")[0]?.trim().toLowerCase();
  switch (ct) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/bmp":
      return ".bmp";
    case "image/webp":
      return ".webp";
    default:
      return undefined;
  }
}

async function loadWeComImageSource(input: string): Promise<{
  bytes: Uint8Array;
  fileName: string;
  mimeType?: string;
}> {
  if (input.startsWith("/")) {
    const bytes = await readFile(input);
    const fileName = basename(input) || "image";
    return { bytes, fileName, mimeType: guessImageMimeType(fileName) };
  }

  const url = new URL(input);
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`Failed to download image: ${res.status} ${res.statusText}`);
  }

  const contentType = res.headers.get("content-type");
  let fileName = basename(url.pathname) || "image";
  const mimeType = guessImageMimeType(fileName, contentType);

  if (!extname(fileName) && mimeType) {
    const ext = extFromImageMimeType(mimeType);
    if (ext) fileName += ext;
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, fileName, mimeType };
}

export async function sendWeComImage(params: {
  cfg: ClawdbotConfig;
  to: string;
  mediaUrl: string;
  accountId?: string;
}): Promise<boolean> {
  const account = resolveWeComAccount({ cfg: params.cfg, accountId: params.accountId });

  let image: { bytes: Uint8Array; fileName: string; mimeType?: string };
  try {
    image = await loadWeComImageSource(params.mediaUrl);
  } catch (err) {
    console.error("[wecom] sendWeComImage: failed to load image source:", params.mediaUrl, err);
    return false;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const token = await getAccessToken({ cfg: params.cfg, accountId: params.accountId });

      const uploadUrl = `https://bot.youfuli.cn/wecom-api/cgi-bin/media/upload?access_token=${token}&type=image`;
      const form = new FormData();
      const blob = new Blob([image.bytes], image.mimeType ? { type: image.mimeType } : undefined);
      form.append("media", blob, image.fileName);

      const uploadRes = await fetch(uploadUrl, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(15_000),
      });

      const uploadJson = (await uploadRes.json()) as {
        errcode: number;
        errmsg: string;
        media_id?: string;
      };

      if (uploadJson.errcode !== 0 || !uploadJson.media_id) {
        console.error("[wecom] sendWeComImage: upload failed:", JSON.stringify(uploadJson));
        if (uploadJson.errcode === 40014 || uploadJson.errcode === 42001) {
          tokenCache.delete(account.accountId);
        }
        throw new Error(`WeCom media/upload failed: ${uploadJson.errcode} ${uploadJson.errmsg}`);
      }

      const sendUrl = `https://bot.youfuli.cn/wecom-api/cgi-bin/message/send?access_token=${token}`;
      const body = {
        touser: params.to,
        msgtype: "image",
        agentid: account.agentId,
        image: { media_id: uploadJson.media_id },
        safe: 0,
        enable_duplicate_check: 0,
        duplicate_check_interval: 0,
      };

      const sendRes = await fetch(sendUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      const sendJson = (await sendRes.json()) as { errcode: number; errmsg: string };
      if (sendJson.errcode === 0) {
        console.log("[wecom] sendWeComImage: success, mediaId=", uploadJson.media_id);
        return true;
      }
      console.error("[wecom] sendWeComImage: send failed:", JSON.stringify(sendJson));

      if (sendJson.errcode === 40014 || sendJson.errcode === 42001) {
        tokenCache.delete(account.accountId);
      }
    } catch {
      // retry
    }

    await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }

  return false;
}

export async function sendWeComVoice(params: {
  cfg: ClawdbotConfig;
  to: string;
  audioPath: string;
  accountId?: string;
}): Promise<boolean> {
  const account = resolveWeComAccount({ cfg: params.cfg, accountId: params.accountId });
  const fs = await import("fs");
  const { execSync } = await import("child_process");

  // Convert to AMR if needed
  let amrPath = params.audioPath;
  if (!params.audioPath.endsWith(".amr")) {
    amrPath = params.audioPath.replace(/\.[^.]+$/, ".amr");
    try {
      execSync(
        `ffmpeg -y -i "${params.audioPath}" -ar 8000 -ac 1 -c:a libopencore_amrnb -b:a 12200 "${amrPath}"`,
        { stdio: "pipe" },
      );
    } catch (err) {
      console.error("[wecom] sendWeComVoice: ffmpeg AMR conversion failed:", err);
      return false;
    }
  }

  if (!fs.existsSync(amrPath)) {
    console.error("[wecom] sendWeComVoice: AMR file not found:", amrPath);
    return false;
  }

  const amrBuf = fs.readFileSync(amrPath);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const token = await getAccessToken({ cfg: params.cfg, accountId: params.accountId });

      const uploadUrl = `https://bot.youfuli.cn/wecom-api/cgi-bin/media/upload?access_token=${token}&type=voice`;
      const form = new FormData();
      const blob = new Blob([amrBuf], { type: "audio/amr" });
      form.append("media", blob, "voice.amr");

      const uploadRes = await fetch(uploadUrl, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(15_000),
      });

      const uploadJson = (await uploadRes.json()) as {
        errcode: number;
        errmsg: string;
        media_id?: string;
      };

      if (uploadJson.errcode !== 0 || !uploadJson.media_id) {
        console.error("[wecom] sendWeComVoice: upload failed:", JSON.stringify(uploadJson));
        if (uploadJson.errcode === 40014 || uploadJson.errcode === 42001) {
          tokenCache.delete(account.accountId);
        }
        throw new Error(`WeCom voice upload failed: ${uploadJson.errcode} ${uploadJson.errmsg}`);
      }

      const sendUrl = `https://bot.youfuli.cn/wecom-api/cgi-bin/message/send?access_token=${token}`;
      const body = {
        touser: params.to,
        msgtype: "voice",
        agentid: account.agentId,
        voice: { media_id: uploadJson.media_id },
        safe: 0,
      };

      const sendRes = await fetch(sendUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      const sendJson = (await sendRes.json()) as { errcode: number; errmsg: string };
      if (sendJson.errcode === 0) {
        console.log("[wecom] sendWeComVoice: success, mediaId=", uploadJson.media_id);
        return true;
      }
      console.error("[wecom] sendWeComVoice: send failed:", JSON.stringify(sendJson));

      if (sendJson.errcode === 40014 || sendJson.errcode === 42001) {
        tokenCache.delete(account.accountId);
      }
    } catch {
      // retry
    }

    await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }

  return false;
}

export async function sendWeComMarkdown(params: {
  cfg: ClawdbotConfig;
  to: string;
  markdown: string;
  accountId?: string;
}): Promise<boolean> {
  const account = resolveWeComAccount({ cfg: params.cfg, accountId: params.accountId });
  const token = await getAccessToken({ cfg: params.cfg, accountId: params.accountId });
  const url = `https://bot.youfuli.cn/wecom-api/cgi-bin/message/send?access_token=${token}`;
  const body = {
    touser: params.to,
    msgtype: "markdown",
    agentid: account.agentId,
    markdown: { content: params.markdown.slice(0, 2048) },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json()) as { errcode: number };
  return j.errcode === 0;
}
