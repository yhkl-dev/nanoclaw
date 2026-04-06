import { createDecipheriv } from 'crypto';

import { logger } from './logger.js';

const DOWNLOAD_TIMEOUT_MS = 15_000;
// WeCom images are never larger than 20MB
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Download a WeCom image and return it as a base64 string.
 *
 * WeCom aibot long-connection mode delivers image messages with:
 *   - url: encrypted download link (valid for 5 minutes)
 *   - aeskey: base64-encoded 32-byte AES-256-CBC key
 *
 * Encrypted format: [16-byte IV] + [AES-CBC ciphertext] with PKCS7 padding.
 * If aeskey is absent the URL is tried as-is (some deployments skip encryption).
 *
 * Returns null on any error so callers can degrade gracefully.
 */
export async function downloadWeComImage(
  url: string,
  aeskey?: string,
): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    let buffer: Buffer;
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        logger.warn(
          { status: res.status, url },
          '[wecom-image] download failed',
        );
        return null;
      }
      const ab = await res.arrayBuffer();
      buffer = Buffer.from(ab);
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }

    if (buffer.length > MAX_IMAGE_BYTES) {
      logger.warn(
        { bytes: buffer.length },
        '[wecom-image] image too large, skipping',
      );
      return null;
    }

    if (aeskey) {
      buffer = decryptWeComImage(buffer, aeskey);
    }

    return buffer.toString('base64');
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    logger.warn(
      { err: isTimeout ? 'timeout' : String(err) },
      '[wecom-image] failed to download image',
    );
    return null;
  }
}

/**
 * Decrypt a WeCom AES-256-CBC encrypted image buffer.
 * Format: first 16 bytes are the IV, remainder is ciphertext.
 */
function decryptWeComImage(encrypted: Buffer, aeskeyBase64: string): Buffer {
  const key = Buffer.from(aeskeyBase64, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `Invalid WeCom aeskey length: expected 32 bytes, got ${key.length}`,
    );
  }
  if (encrypted.length < 16) {
    throw new Error('Encrypted buffer too short to contain IV');
  }
  const iv = encrypted.subarray(0, 16);
  const ciphertext = encrypted.subarray(16);
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
