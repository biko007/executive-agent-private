/**
 * banking/encryption — AES-256-GCM encryption for banking credentials.
 * Sprint 7b Etappe c: Node crypto only, no npm packages.
 *
 * Key: BANKING_ENCRYPTION_KEY env var (64 hex chars = 32 bytes) for v1.
 * Key rotation: BANKING_ENCRYPTION_KEY_V{n} for version n.
 * AAD: UTF-8 of `${sessionId}:${fieldName}` — binds ciphertext to row+field.
 * IV: 12 random bytes per encryption call.
 */
import crypto from 'node:crypto';
import type { EncryptedPayload } from './types.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionError';
  }
}

/** Resolve the raw 32-byte key buffer for a given version. */
function resolveKey(keyVersion: number): Buffer {
  const envName = keyVersion === 1
    ? 'BANKING_ENCRYPTION_KEY'
    : `BANKING_ENCRYPTION_KEY_V${keyVersion}`;
  const hex = process.env[envName];
  if (!hex) {
    throw new EncryptionError(`Missing encryption key: ${envName} not set`);
  }
  if (hex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new EncryptionError(`Malformed encryption key: ${envName} must be 64 hex characters`);
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * @param plaintext - Cleartext string to encrypt
 * @param sessionId - Session ID for AAD binding
 * @param fieldName - Field name for AAD binding (e.g. 'pin', 'user_id', 'state')
 * @param keyVersion - Key version (default 1)
 * @returns EncryptedPayload with base64-encoded fields
 */
export function encrypt(
  plaintext: string,
  sessionId: string,
  fieldName: string,
  keyVersion = 1,
): EncryptedPayload {
  const key = resolveKey(keyVersion);
  const iv = crypto.randomBytes(IV_BYTES);
  const aad = Buffer.from(`${sessionId}:${fieldName}`, 'utf-8');

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(aad);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    keyVersion,
  };
}

/**
 * Decrypt an EncryptedPayload using AES-256-GCM.
 * @param payload - Encrypted payload with base64 fields
 * @param sessionId - Session ID for AAD verification
 * @param fieldName - Field name for AAD verification
 * @returns Decrypted plaintext string
 */
export function decrypt(
  payload: EncryptedPayload,
  sessionId: string,
  fieldName: string,
): string {
  const key = resolveKey(payload.keyVersion);
  const iv = Buffer.from(payload.iv, 'base64');
  const authTag = Buffer.from(payload.authTag, 'base64');
  const ciphertext = Buffer.from(payload.ciphertext, 'base64');
  const aad = Buffer.from(`${sessionId}:${fieldName}`, 'utf-8');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf-8');
  } catch (e: any) {
    throw new EncryptionError(`Decryption failed: ${e.message}`);
  }
}
