/**
 * banking/sidecar-client — HTTP client for the Python FinTS sidecar.
 * Sprint 7b Etappe c/f: Connects to http://127.0.0.1:18794 (default).
 *
 * Etappe f: All endpoints carry credentials + state blobs for stateless sidecar.
 */
import { fetchWithTimeout } from '../../shared/utils/index.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:18794';
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;

export class SidecarError extends Error {
  statusCode: number;
  responseBody: string;

  constructor(message: string, statusCode: number, responseBody: string) {
    super(message);
    this.name = 'SidecarError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

function getBaseUrl(): string {
  return process.env.BANKING_SIDECAR_URL || DEFAULT_BASE_URL;
}

function getToken(): string {
  return process.env.CORE_SIDECAR_TOKEN || '';
}

/**
 * Internal fetch helper with retry on 5xx/network errors.
 * No retry on 4xx — those are client errors.
 * @param maxRetries Override default MAX_RETRIES (use 0 for no retry).
 */
async function sidecarFetch(
  path: string,
  init?: RequestInit,
  maxRetries?: number,
): Promise<Response> {
  const url = `${getBaseUrl()}${path}`;
  const token = getToken();
  const retries = maxRetries ?? MAX_RETRIES;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, {
        ...init,
        headers: { ...headers, ...(init?.headers as Record<string, string> || {}) },
      }, TIMEOUT_MS);

      // No retry on 4xx
      if (res.status >= 400 && res.status < 500) {
        const body = await res.text();
        throw new SidecarError(
          `Sidecar returned ${res.status}: ${body}`,
          res.status, body,
        );
      }

      // Retry on 5xx
      if (res.status >= 500) {
        const body = await res.text();
        lastError = new SidecarError(
          `Sidecar returned ${res.status}: ${body}`,
          res.status, body,
        );
        if (attempt < retries) continue;
        throw lastError;
      }

      return res;
    } catch (e: any) {
      if (e instanceof SidecarError && e.statusCode >= 400 && e.statusCode < 500) {
        throw e; // Don't retry 4xx
      }
      lastError = e;
      if (attempt >= retries) throw lastError;
    }
  }

  throw lastError || new Error('Sidecar request failed');
}

/**
 * Health check — GET /fints/health
 */
export async function health(): Promise<{ status: string }> {
  const res = await sidecarFetch('/fints/health', { method: 'GET' });
  return res.json();
}

/**
 * Connect to bank — POST /fints/connect
 */
export async function connect(params: {
  session_id: number;
  blz: string;
  user_id: string;
  pin: string;
  fints_url: string;
  product_id?: string;
}): Promise<unknown> {
  const res = await sidecarFetch('/fints/connect', {
    method: 'POST',
    body: JSON.stringify(params),
  }, 0);
  return res.json();
}

/**
 * Complete TAN challenge — POST /fints/complete-tan
 */
export async function completeTan(params: {
  session_id: number;
  blz: string;
  fints_url: string;
  user_id: string;
  pin: string;
  product_id?: string;
  client_data: string;
  tan_data: string;
  tan: string;
}): Promise<unknown> {
  const res = await sidecarFetch('/fints/complete-tan', {
    method: 'POST',
    body: JSON.stringify(params),
  }, 0);
  return res.json();
}

/**
 * Sync account transactions — POST /fints/sync
 */
export async function sync(params: {
  session_id: number;
  blz: string;
  fints_url: string;
  user_id: string;
  pin: string;
  product_id?: string;
  client_data?: string;
  account_iban: string;
  from_date?: string;
  to_date?: string;
}): Promise<unknown> {
  const res = await sidecarFetch('/fints/sync', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  return res.json();
}

/**
 * Refresh an existing session — POST /fints/refresh-session
 */
export async function refreshSession(params: {
  session_id: number;
  blz: string;
  fints_url: string;
  user_id: string;
  pin: string;
  product_id?: string;
  client_data?: string;
}): Promise<unknown> {
  const res = await sidecarFetch('/fints/refresh-session', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  return res.json();
}

/**
 * Cancel a parked sidecar session — fire-and-forget.
 * DELETE /fints/session/:id — always 204, errors suppressed.
 */
export async function cancelSession(sessionId: number): Promise<void> {
  try {
    await sidecarFetch(`/fints/session/${sessionId}`, { method: 'DELETE' }, 0);
  } catch { /* fire-and-forget */ }
}
