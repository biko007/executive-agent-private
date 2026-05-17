/**
 * shared/m365 — Microsoft Graph API client with token caching and retry logic.
 */
import { sleep, fetchWithTimeout, parseRetryAfterMs } from '../utils/index.js';

type GraphTokenCacheEntry = {
  accessToken: string;
  expiresAtMs: number;
};

const graphTokenCache = new Map<string, GraphTokenCacheEntry>();

function cacheKey(tenantId: string, clientId: string) {
  return `${tenantId}::${clientId}`;
}

export async function graphToken(
  tenantId: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const key = cacheKey(tenantId, clientId);
  const cached = graphTokenCache.get(key);
  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.accessToken;
  }

  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const form = new URLSearchParams();
  form.set('client_id', clientId);
  form.set('scope', 'https://graph.microsoft.com/.default');
  form.set('client_secret', clientSecret);
  form.set('grant_type', 'client_credentials');

  const res = await fetchWithTimeout(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form },
    20000,
  );

  const text = await res.text().catch(() => '');
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    throw new Error(`token_error: status=${res.status} body=${parsed ? JSON.stringify(parsed) : text || '(empty)'}`);
  }

  const json: any = parsed ?? {};
  const accessToken: string = json.access_token;
  const expiresInSec: number | undefined = json.expires_in;

  const safetyMs = 60_000;
  const ttlMs =
    typeof expiresInSec === 'number' && Number.isFinite(expiresInSec) && expiresInSec > 0
      ? Math.max(expiresInSec * 1000 - safetyMs, 5_000)
      : 45 * 60_000;

  graphTokenCache.set(key, { accessToken, expiresAtMs: Date.now() + ttlMs });
  return accessToken;
}

export function clearGraphTokenCache(tenantId: string, clientId: string): void {
  graphTokenCache.delete(cacheKey(tenantId, clientId));
}

export async function graphRequest(
  tenantId: string,
  clientId: string,
  clientSecret: string,
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  url: string,
  body?: any,
): Promise<any> {
  const maxRetries = 3;

  const getToken = async (forceRefresh: boolean) => {
    if (forceRefresh) graphTokenCache.delete(cacheKey(tenantId, clientId));
    return graphToken(tenantId, clientId, clientSecret);
  };

  let token: string;
  try {
    token = await getToken(false);
  } catch {
    await sleep(2000);
    token = await getToken(false);
  }
  let didRefreshOn401 = false;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    let fetchBody: any = undefined;

    if (method === 'POST' || method === 'PATCH') {
      headers['Content-Type'] = 'application/json';
      fetchBody = JSON.stringify(body ?? {});
    }

    let res: Response;
    try {
      res = await fetchWithTimeout(url, { method, headers, body: fetchBody }, 20000);
    } catch (e: any) {
      if (attempt < maxRetries) {
        await sleep(Math.min(2000 * Math.pow(2, attempt), 10000));
        continue;
      }
      throw new Error(`graph_${method.toLowerCase()}_network_error: ${e.message}`);
    }

    if (res.status === 401 && !didRefreshOn401) {
      didRefreshOn401 = true;
      token = await getToken(true);
      continue;
    }

    if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < maxRetries) {
      const retryAfterMs = parseRetryAfterMs(res);
      const backoffMs = retryAfterMs ?? Math.min(1000 * Math.pow(2, attempt), 8000);
      await sleep(backoffMs);
      continue;
    }

    const contentType = res.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');

    if (!res.ok) {
      const errText = isJson ? JSON.stringify(await res.json().catch(() => ({}))) : await res.text().catch(() => '');
      throw new Error(`graph_${method.toLowerCase()}_error: status=${res.status} body=${errText}`);
    }

    if (res.status === 204) return null;
    if (isJson) return await res.json().catch(() => null);

    const rText = await res.text().catch(() => '');
    try { return rText ? JSON.parse(rText) : null; } catch { return rText || null; }
  }

  throw new Error(`graph_${method.toLowerCase()}_error: exceeded_retries`);
}

export async function graphGet(
  tenantId: string, clientId: string, clientSecret: string, url: string,
): Promise<any> {
  return graphRequest(tenantId, clientId, clientSecret, 'GET', url);
}

export async function graphPost(
  tenantId: string, clientId: string, clientSecret: string, url: string, body: any,
): Promise<any> {
  return graphRequest(tenantId, clientId, clientSecret, 'POST', url, body);
}

export async function graphDelete(
  tenantId: string, clientId: string, clientSecret: string, url: string,
): Promise<any> {
  return graphRequest(tenantId, clientId, clientSecret, 'DELETE', url);
}
