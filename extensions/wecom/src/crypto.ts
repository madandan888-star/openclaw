/**
 * WeCom message encryption/decryption (AES-256-CBC with PKCS#7 padding).
 * Compatible with 企业微信回调加解密协议.
 */
import crypto from "node:crypto";

export class WeComCrypto {
  private token: string;
  private corpId: string;
  private aesKey: Buffer;
  private iv: Buffer;

  constructor(token: string, encodingAesKey: string, corpId: string) {
    this.token = token;
    this.corpId = corpId;
    this.aesKey = Buffer.from(encodingAesKey + "=", "base64");
    this.iv = this.aesKey.subarray(0, 16);
  }

  /** Generate signature for verification. */
  getSignature(timestamp: string, nonce: string, encrypted: string): string {
    const items = [this.token, timestamp, nonce, encrypted].sort();
    return crypto.createHash("sha1").update(items.join("")).digest("hex");
  }

  /** Verify callback signature. */
  checkSignature(
    msgSignature: string,
    timestamp: string,
    nonce: string,
    encrypted: string,
  ): boolean {
    const sig = this.getSignature(timestamp, nonce, encrypted);
    return sig === msgSignature;
  }

  /** Decrypt a message body. Returns the XML content. */
  decrypt(encrypted: string): { message: string; corpId: string } {
    const decipher = crypto.createDecipheriv("aes-256-cbc", this.aesKey, this.iv);
    decipher.setAutoPadding(false);
    const decBuf = Buffer.concat([decipher.update(encrypted, "base64"), decipher.final()]);

    // Remove PKCS#7 padding
    const pad = decBuf[decBuf.length - 1]!;
    const content = decBuf.subarray(0, decBuf.length - pad);

    // Format: random(16) + msgLen(4, big-endian) + msg + corpId
    const msgLen = content.readUInt32BE(16);
    const message = content.subarray(20, 20 + msgLen).toString("utf-8");
    const corpId = content.subarray(20 + msgLen).toString("utf-8");

    return { message, corpId };
  }

  /** Encrypt a reply message. */
  encrypt(message: string): string {
    const randomBytes = crypto.randomBytes(16);
    const msgBuf = Buffer.from(message, "utf-8");
    const corpIdBuf = Buffer.from(this.corpId, "utf-8");

    const msgLenBuf = Buffer.alloc(4);
    msgLenBuf.writeUInt32BE(msgBuf.length, 0);

    const plain = Buffer.concat([randomBytes, msgLenBuf, msgBuf, corpIdBuf]);

    // PKCS#7 padding
    const blockSize = 32;
    const padLen = blockSize - (plain.length % blockSize);
    const padBuf = Buffer.alloc(padLen, padLen);
    const padded = Buffer.concat([plain, padBuf]);

    const cipher = crypto.createCipheriv("aes-256-cbc", this.aesKey, this.iv);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
    return encrypted.toString("base64");
  }

  /** Encrypt a reply and return the full JSON response envelope. */
  encryptReply(replyJson: string): {
    encrypt: string;
    msgsignature: string;
    timestamp: string;
    nonce: string;
  } {
    const encrypted = this.encrypt(replyJson);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(8).toString("hex");
    const msgsignature = this.getSignature(timestamp, nonce, encrypted);
    return { encrypt: encrypted, msgsignature, timestamp, nonce };
  }

  /** Decrypt callback message: verify signature, extract XML. */
  decryptMessage(body: string, msgSignature: string, timestamp: string, nonce: string): string {
    // Extract <Encrypt> from XML body
    const encryptMatch = body.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/s);
    if (!encryptMatch) {
      throw new Error("No <Encrypt> found in body");
    }
    const encrypted = encryptMatch[1]!;

    if (!this.checkSignature(msgSignature, timestamp, nonce, encrypted)) {
      throw new Error("Invalid message signature");
    }

    const { message, corpId } = this.decrypt(encrypted);
    if (corpId !== this.corpId) {
      throw new Error(`CorpId mismatch: expected ${this.corpId}, got ${corpId}`);
    }
    return message;
  }

  /** Verify URL callback: decrypt echostr. */
  verifyUrl(msgSignature: string, timestamp: string, nonce: string, echostr: string): string {
    if (!this.checkSignature(msgSignature, timestamp, nonce, echostr)) {
      throw new Error("Invalid URL verification signature");
    }
    const { message } = this.decrypt(echostr);
    return message;
  }
}
