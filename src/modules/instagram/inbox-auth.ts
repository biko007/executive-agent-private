/**
 * inbox-auth.ts — Authentication for Instagram inbox endpoint (E2b).
 *
 * Called BEFORE any multipart body parsing.
 * Uses constant-time SHA256 comparison against INBOX_TOKEN_SHA256.
 */
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';

type AuthResult =
  | { valid: true }
  | { valid: false; statusCode: number; error: string };

export function validateInboxAuth(req: IncomingMessage): AuthResult {
  // 1. Reject tokens in query string (security: prevents token leaking in logs/referer)
  const url = req.url ?? '';
  if (/[?&](token|access_token)=/i.test(url)) {
    return {
      valid: false,
      statusCode: 400,
      error: 'Token in query string not allowed — use Authorization header',
    };
  }

  // 2. Extract Bearer token from Authorization header
  const authHeader = req.headers.authorization ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return { valid: false, statusCode: 401, error: 'Missing or invalid Authorization header' };
  }
  const token = authHeader.slice(7);
  if (!token) {
    return { valid: false, statusCode: 401, error: 'Missing or invalid Authorization header' };
  }

  // 3. Check that INBOX_TOKEN_SHA256 is configured
  const expectedHash = process.env.INBOX_TOKEN_SHA256;
  if (!expectedHash) {
    return { valid: false, statusCode: 503, error: 'Inbox not configured' };
  }

  // 4. Constant-time SHA256 comparison
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const hashBuf = Buffer.from(tokenHash, 'hex');
  const expectedBuf = Buffer.from(expectedHash, 'hex');

  if (hashBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(hashBuf, expectedBuf)) {
    return { valid: false, statusCode: 401, error: 'Invalid token' };
  }

  return { valid: true };
}
