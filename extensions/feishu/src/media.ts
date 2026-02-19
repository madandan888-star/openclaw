import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { getFeishuRuntime } from "./runtime.js";
import { resolveReceiveIdType, normalizeFeishuTarget } from "./targets.js";

/** Get a logger for media operations, with fallback to console. */
function getMediaLogger() {
  try {
    return getFeishuRuntime().logging.getChildLogger({ component: "feishu-media" });
  } catch {
    // Fallback to console if runtime not ready
    return {
      debug: (msg: string) => console.debug(`[feishu-media] ${msg}`),
      info: (msg: string) => console.log(`[feishu-media] ${msg}`),
      warn: (msg: string) => console.warn(`[feishu-media] ${msg}`),
      error: (msg: string) => console.error(`[feishu-media] ${msg}`),
    };
  }
}

export type DownloadImageResult = {
  buffer: Buffer;
  contentType?: string;
};

export type DownloadMessageResourceResult = {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
};

/**
 * Download an image from Feishu using image_key.
 * Used for downloading images sent in messages.
 */
export async function downloadImageFeishu(params: {
  cfg: ClawdbotConfig;
  imageKey: string;
  accountId?: string;
}): Promise<DownloadImageResult> {
  const { cfg, imageKey, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  const response = await client.im.image.get({
    path: { image_key: imageKey },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK response type
  const responseAny = response as any;
  if (responseAny.code !== undefined && responseAny.code !== 0) {
    throw new Error(
      `Feishu image download failed: ${responseAny.msg || `code ${responseAny.code}`}`,
    );
  }

  // Handle various response formats from Feishu SDK
  let buffer: Buffer;

  if (Buffer.isBuffer(response)) {
    buffer = response;
  } else if (response instanceof ArrayBuffer) {
    buffer = Buffer.from(response);
  } else if (responseAny.data && Buffer.isBuffer(responseAny.data)) {
    buffer = responseAny.data;
  } else if (responseAny.data instanceof ArrayBuffer) {
    buffer = Buffer.from(responseAny.data);
  } else if (typeof responseAny.getReadableStream === "function") {
    // SDK provides getReadableStream method
    const stream = responseAny.getReadableStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    buffer = Buffer.concat(chunks);
  } else if (typeof responseAny.writeFile === "function") {
    // SDK provides writeFile method - use a temp file
    const tmpPath = path.join(os.tmpdir(), `feishu_img_${Date.now()}_${imageKey}`);
    await responseAny.writeFile(tmpPath);
    buffer = await fs.promises.readFile(tmpPath);
    await fs.promises.unlink(tmpPath).catch(() => {}); // cleanup
  } else if (typeof responseAny[Symbol.asyncIterator] === "function") {
    // Response is an async iterable
    const chunks: Buffer[] = [];
    for await (const chunk of responseAny) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    buffer = Buffer.concat(chunks);
  } else if (typeof responseAny.read === "function") {
    // Response is a Readable stream
    const chunks: Buffer[] = [];
    for await (const chunk of responseAny as Readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    buffer = Buffer.concat(chunks);
  } else {
    // Debug: log what we actually received
    const keys = Object.keys(responseAny);
    const types = keys.map((k) => `${k}: ${typeof responseAny[k]}`).join(", ");
    throw new Error(`Feishu image download failed: unexpected response format. Keys: [${types}]`);
  }

  return { buffer };
}

/**
 * Download a message resource (file/image/audio/video) from Feishu.
 * Used for downloading files, audio, and video from messages.
 */
export async function downloadMessageResourceFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  fileKey: string;
  type: "image" | "file";
  accountId?: string;
}): Promise<DownloadMessageResourceResult> {
  const { cfg, messageId, fileKey, type, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  const response = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK response type
  const responseAny = response as any;
  if (responseAny.code !== undefined && responseAny.code !== 0) {
    throw new Error(
      `Feishu message resource download failed: ${responseAny.msg || `code ${responseAny.code}`}`,
    );
  }

  // Handle various response formats from Feishu SDK
  let buffer: Buffer;

  if (Buffer.isBuffer(response)) {
    buffer = response;
  } else if (response instanceof ArrayBuffer) {
    buffer = Buffer.from(response);
  } else if (responseAny.data && Buffer.isBuffer(responseAny.data)) {
    buffer = responseAny.data;
  } else if (responseAny.data instanceof ArrayBuffer) {
    buffer = Buffer.from(responseAny.data);
  } else if (typeof responseAny.getReadableStream === "function") {
    // SDK provides getReadableStream method
    const stream = responseAny.getReadableStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    buffer = Buffer.concat(chunks);
  } else if (typeof responseAny.writeFile === "function") {
    // SDK provides writeFile method - use a temp file
    const tmpPath = path.join(os.tmpdir(), `feishu_${Date.now()}_${fileKey}`);
    await responseAny.writeFile(tmpPath);
    buffer = await fs.promises.readFile(tmpPath);
    await fs.promises.unlink(tmpPath).catch(() => {}); // cleanup
  } else if (typeof responseAny[Symbol.asyncIterator] === "function") {
    // Response is an async iterable
    const chunks: Buffer[] = [];
    for await (const chunk of responseAny) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    buffer = Buffer.concat(chunks);
  } else if (typeof responseAny.read === "function") {
    // Response is a Readable stream
    const chunks: Buffer[] = [];
    for await (const chunk of responseAny as Readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    buffer = Buffer.concat(chunks);
  } else {
    // Debug: log what we actually received
    const keys = Object.keys(responseAny);
    const types = keys.map((k) => `${k}: ${typeof responseAny[k]}`).join(", ");
    throw new Error(
      `Feishu message resource download failed: unexpected response format. Keys: [${types}]`,
    );
  }

  return { buffer };
}

export type UploadImageResult = {
  imageKey: string;
};

export type UploadFileResult = {
  fileKey: string;
};

export type SendMediaResult = {
  messageId: string;
  chatId: string;
};

/**
 * Upload an image to Feishu and get an image_key for sending.
 * Supports: JPEG, PNG, WEBP, GIF, TIFF, BMP, ICO
 */
export async function uploadImageFeishu(params: {
  cfg: ClawdbotConfig;
  image: Buffer | string; // Buffer or file path
  imageType?: "message" | "avatar";
  accountId?: string;
}): Promise<UploadImageResult> {
  const { cfg, image, imageType = "message", accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  // SDK accepts Buffer directly or fs.ReadStream for file paths
  // Using Readable.from(buffer) causes issues with form-data library
  // See: https://github.com/larksuite/node-sdk/issues/121
  const imageData = typeof image === "string" ? fs.createReadStream(image) : image;

  const response = await client.im.image.create({
    data: {
      image_type: imageType,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK accepts Buffer or ReadStream
      image: imageData as any,
    },
  });

  // SDK v1.30+ returns data directly without code wrapper on success
  // On error, it throws or returns { code, msg }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK response type
  const responseAny = response as any;
  if (responseAny.code !== undefined && responseAny.code !== 0) {
    throw new Error(`Feishu image upload failed: ${responseAny.msg || `code ${responseAny.code}`}`);
  }

  const imageKey = responseAny.image_key ?? responseAny.data?.image_key;
  if (!imageKey) {
    throw new Error("Feishu image upload failed: no image_key returned");
  }

  return { imageKey };
}

/**
 * Upload a file to Feishu and get a file_key for sending.
 * Max file size: 30MB
 */
export async function uploadFileFeishu(params: {
  cfg: ClawdbotConfig;
  file: Buffer | string; // Buffer or file path
  fileName: string;
  fileType: "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream";
  duration?: number; // Required for audio/video files, in milliseconds
  accountId?: string;
}): Promise<UploadFileResult> {
  const { cfg, file, fileName, fileType, duration, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  // SDK accepts Buffer directly or fs.ReadStream for file paths
  // Using Readable.from(buffer) causes issues with form-data library
  // See: https://github.com/larksuite/node-sdk/issues/121
  const fileData = typeof file === "string" ? fs.createReadStream(file) : file;

  const logger = getMediaLogger();
  logger.info(
    `uploadFileFeishu: uploading fileName=${fileName} fileType=${fileType} duration=${duration} bufferSize=${typeof file === "string" ? "path" : file.length}`,
  );

  let response;
  try {
    response = await client.im.file.create({
      data: {
        file_type: fileType,
        file_name: fileName,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK accepts Buffer or ReadStream
        file: fileData as any,
        ...(duration !== undefined && { duration: String(duration) }),
      },
    });
  } catch (uploadErr: unknown) {
    // Capture Axios response body for debugging
    const axiosErr = uploadErr as { response?: { status?: number; data?: unknown } };
    const respData = axiosErr.response?.data;
    logger.error(
      `uploadFileFeishu: HTTP ${axiosErr.response?.status ?? "?"} — response: ${JSON.stringify(respData ?? "no body")}`,
    );
    throw uploadErr;
  }

  logger.info(`uploadFileFeishu: response received`);

  // SDK v1.30+ returns data directly without code wrapper on success
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK response type
  const responseAny = response as any;
  if (responseAny.code !== undefined && responseAny.code !== 0) {
    throw new Error(`Feishu file upload failed: ${responseAny.msg || `code ${responseAny.code}`}`);
  }

  const fileKey = responseAny.file_key ?? responseAny.data?.file_key;
  if (!fileKey) {
    throw new Error("Feishu file upload failed: no file_key returned");
  }

  return { fileKey };
}

/**
 * Send an image message using an image_key
 */
export async function sendImageFeishu(params: {
  cfg: ClawdbotConfig;
  to: string;
  imageKey: string;
  replyToMessageId?: string;
  accountId?: string;
}): Promise<SendMediaResult> {
  const { cfg, to, imageKey, replyToMessageId, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);
  const receiveId = normalizeFeishuTarget(to);
  if (!receiveId) {
    throw new Error(`Invalid Feishu target: ${to}`);
  }

  const receiveIdType = resolveReceiveIdType(receiveId);
  const content = JSON.stringify({ image_key: imageKey });

  if (replyToMessageId) {
    const response = await client.im.message.reply({
      path: { message_id: replyToMessageId },
      data: {
        content,
        msg_type: "image",
      },
    });

    if (response.code !== 0) {
      throw new Error(`Feishu image reply failed: ${response.msg || `code ${response.code}`}`);
    }

    return {
      messageId: response.data?.message_id ?? "unknown",
      chatId: receiveId,
    };
  }

  const response = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      content,
      msg_type: "image",
    },
  });

  if (response.code !== 0) {
    throw new Error(`Feishu image send failed: ${response.msg || `code ${response.code}`}`);
  }

  return {
    messageId: response.data?.message_id ?? "unknown",
    chatId: receiveId,
  };
}

/**
 * Send a file message using a file_key
 */
export async function sendFileFeishu(params: {
  cfg: ClawdbotConfig;
  to: string;
  fileKey: string;
  /** Use "media" for audio/video files, "file" for documents */
  msgType?: "file" | "media";
  /** Cover image key for video messages (msg_type "media") */
  imageKey?: string;
  replyToMessageId?: string;
  accountId?: string;
}): Promise<SendMediaResult> {
  const { cfg, to, fileKey, imageKey, replyToMessageId, accountId } = params;
  const msgType = params.msgType ?? "file";
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);
  const receiveId = normalizeFeishuTarget(to);
  if (!receiveId) {
    throw new Error(`Invalid Feishu target: ${to}`);
  }

  const receiveIdType = resolveReceiveIdType(receiveId);
  // For media (video/audio), include image_key as cover if available
  const contentObj: Record<string, string> = { file_key: fileKey };
  if (imageKey && msgType === "media") {
    contentObj.image_key = imageKey;
  }
  const content = JSON.stringify(contentObj);

  if (replyToMessageId) {
    const response = await client.im.message.reply({
      path: { message_id: replyToMessageId },
      data: {
        content,
        msg_type: msgType,
      },
    });

    if (response.code !== 0) {
      throw new Error(`Feishu file reply failed: ${response.msg || `code ${response.code}`}`);
    }

    return {
      messageId: response.data?.message_id ?? "unknown",
      chatId: receiveId,
    };
  }

  const response = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      content,
      msg_type: msgType,
    },
  });

  if (response.code !== 0) {
    throw new Error(`Feishu file send failed: ${response.msg || `code ${response.code}`}`);
  }

  return {
    messageId: response.data?.message_id ?? "unknown",
    chatId: receiveId,
  };
}

/**
 * Helper to detect file type from extension
 */
export function detectFileType(
  fileName: string,
): "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream" {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case ".opus":
    case ".ogg":
      return "opus";
    case ".mp4":
    case ".mov":
    case ".avi":
      return "mp4";
    case ".pdf":
      return "pdf";
    case ".doc":
    case ".docx":
      return "doc";
    case ".xls":
    case ".xlsx":
      return "xls";
    case ".ppt":
    case ".pptx":
      return "ppt";
    default:
      return "stream";
  }
}

/**
 * Upload and send media (image or file) from URL, local path, or buffer
 */
export async function sendMediaFeishu(params: {
  cfg: ClawdbotConfig;
  to: string;
  mediaUrl?: string;
  mediaBuffer?: Buffer;
  fileName?: string;
  replyToMessageId?: string;
  accountId?: string;
}): Promise<SendMediaResult> {
  const { cfg, to, mediaUrl, mediaBuffer, fileName, replyToMessageId, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }
  const mediaMaxBytes = (account.config?.mediaMaxMb ?? 30) * 1024 * 1024;

  let buffer: Buffer | undefined;
  let localPath: string | undefined;
  let name: string;

  if (mediaBuffer) {
    buffer = mediaBuffer;
    name = fileName ?? "file";
  } else if (mediaUrl) {
    // Check if it's a local file path — use path directly for large files (avoids form-data issues)
    const isLocal =
      !mediaUrl.startsWith("http://") &&
      !mediaUrl.startsWith("https://") &&
      !mediaUrl.startsWith("data:");
    if (isLocal) {
      try {
        await fs.promises.access(mediaUrl, fs.constants.R_OK);
        const stat = await fs.promises.stat(mediaUrl);
        if (stat.size > mediaMaxBytes) {
          throw new Error(`File too large: ${stat.size} bytes (max ${mediaMaxBytes})`);
        }
        localPath = mediaUrl;
        name = fileName ?? path.basename(mediaUrl);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`Local file not found: ${mediaUrl}`);
        }
        throw e;
      }
    } else {
      const loaded = await getFeishuRuntime().media.loadWebMedia(mediaUrl, {
        maxBytes: mediaMaxBytes,
        optimizeImages: false,
        localRoots: "any",
      });
      buffer = loaded.buffer;
      name = fileName ?? loaded.fileName ?? "file";
    }
  } else {
    throw new Error("Either mediaUrl or mediaBuffer must be provided");
  }

  // Determine if it's an image based on extension
  const ext = path.extname(name).toLowerCase();
  const isImage = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".tiff"].includes(ext);

  if (isImage) {
    // For images, we need a buffer
    if (!buffer && localPath) {
      buffer = await fs.promises.readFile(localPath);
    }
    const { imageKey } = await uploadImageFeishu({ cfg, image: buffer!, accountId });
    return sendImageFeishu({ cfg, to, imageKey, replyToMessageId, accountId });
  } else {
    const fileType = detectFileType(name);
    const isMedia = fileType === "mp4" || fileType === "opus";

    // Feishu API requires duration (ms) for audio/video uploads.
    // Try to probe duration via ffprobe on the source file.
    let duration: number | undefined;
    const probePath = localPath ?? mediaUrl;
    if (isMedia && probePath && !probePath.startsWith("http")) {
      try {
        const { execSync } = await import("child_process");
        const probe = execSync(`ffprobe -v quiet -print_format json -show_format "${probePath}"`, {
          timeout: 10_000,
          encoding: "utf-8",
        });
        const parsed = JSON.parse(probe);
        const secs = parseFloat(parsed?.format?.duration);
        if (!isNaN(secs) && secs > 0) {
          duration = Math.round(secs * 1000);
        }
      } catch {
        // ffprobe unavailable or failed
      }
    }
    // Fallback: rough estimate if probe failed
    if (isMedia && !duration) {
      const fileSize = localPath ? (await fs.promises.stat(localPath)).size : (buffer?.length ?? 0);
      const bitsPerSec = fileType === "opus" ? 128_000 : 2_000_000;
      duration = Math.max(1000, Math.round(((fileSize * 8) / bitsPerSec) * 1000));
    }

    // Prefer passing file path (ReadStream) over Buffer for large files
    const fileArg: Buffer | string = localPath ?? buffer!;

    const { fileKey } = await uploadFileFeishu({
      cfg,
      file: fileArg,
      fileName: name,
      fileType,
      duration,
      accountId,
    });

    // For video files, extract a cover frame and upload as image_key
    let coverImageKey: string | undefined;
    const logger = getMediaLogger();
    logger.info(
      `sendMediaFeishu: fileType=${fileType} localPath=${localPath ?? "none"} mediaUrl=${mediaUrl ?? "none"}`,
    );
    if (fileType === "mp4" && (localPath || (mediaUrl && !mediaUrl.startsWith("http")))) {
      const videoPath = localPath ?? mediaUrl!;
      logger.info(`sendMediaFeishu: extracting cover from ${videoPath}`);
      try {
        const { execSync } = await import("child_process");
        const tmpCover = path.join(os.tmpdir(), `feishu_cover_${Date.now()}.jpg`);
        execSync(`ffmpeg -y -i "${videoPath}" -ss 00:00:01 -vframes 1 -q:v 5 "${tmpCover}"`, {
          timeout: 15_000,
          stdio: "pipe",
        });
        logger.info(`sendMediaFeishu: cover extracted, uploading image`);
        const { imageKey } = await uploadImageFeishu({ cfg, image: tmpCover, accountId });
        coverImageKey = imageKey;
        logger.info(`sendMediaFeishu: cover uploaded imageKey=${imageKey}`);
        await fs.promises.unlink(tmpCover).catch(() => {});
      } catch (coverErr) {
        const errMsg = coverErr instanceof Error ? coverErr.message : String(coverErr);
        logger.error(`sendMediaFeishu: cover extraction failed: ${errMsg}`);
      }
    }

    return sendFileFeishu({
      cfg,
      to,
      fileKey,
      imageKey: coverImageKey,
      msgType: isMedia ? "media" : "file",
      replyToMessageId,
      accountId,
    });
  }
}
