import fs from "node:fs";
import path from "node:path";

/* ════════════════════════════════════════════════════════════════════════════
   SharePoint Store — Graph API helpers for SharePoint document management
   ════════════════════════════════════════════════════════════════════════════ */

/* ---------------- Types ---------------- */

export type SPSite = {
  id: string;
  displayName: string;
  webUrl: string;
  description?: string;
};

export type SPDrive = {
  id: string;
  name: string;
  driveType: string;
  webUrl: string;
};

export type SPFile = {
  id: string;
  name: string;
  size: number;
  webUrl: string;
  lastModifiedDateTime: string;
  createdDateTime: string;
  mimeType?: string;
  downloadUrl?: string;
  isFolder: boolean;
  childCount?: number;
};

export type SPSearchHit = {
  name: string;
  webUrl: string;
  lastModifiedDateTime: string;
  size?: number;
  summary?: string;
};

export type SPChangeEntry = {
  fileName: string;
  webUrl: string;
  lastModifiedDateTime: string;
  changeType: "created" | "modified";
};

/* ---------------- Graph helpers (own copy, matching index.ts pattern) ---- */

type GraphTokenCacheEntry = {
  accessToken: string;
  expiresAtMs: number;
};

const graphTokenCache = new Map<string, GraphTokenCacheEntry>();

function cacheKey(tenantId: string, clientId: string) {
  return `sp::${tenantId}::${clientId}`;
}

function nowMs() { return Date.now(); }
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function parseRetryAfterMs(res: Response): number | null {
  const ra = res.headers.get("retry-after");
  if (!ra) return null;
  const secs = Number(ra);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30_000);
  return null;
}

async function fetchWithTimeout(url: string, init: any, timeoutMs: number) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...(init || {}), signal: controller.signal });
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`fetch_timeout_after_${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function graphToken(tenantId: string, clientId: string, clientSecret: string): Promise<string> {
  const key = cacheKey(tenantId, clientId);
  const cached = graphTokenCache.get(key);
  if (cached && cached.expiresAtMs > nowMs()) return cached.accessToken;

  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const form = new URLSearchParams();
  form.set("client_id", clientId);
  form.set("scope", "https://graph.microsoft.com/.default");
  form.set("client_secret", clientSecret);
  form.set("grant_type", "client_credentials");

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  }, 20000);

  const text = await res.text().catch(() => "");
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    throw new Error(`sp_token_error: status=${res.status} body=${parsed ? JSON.stringify(parsed) : text || "(empty)"}`);
  }

  const json: any = parsed ?? {};
  const accessToken: string = json.access_token;
  const expiresInSec: number | undefined = json.expires_in;
  const safetyMs = 60_000;
  const ttlMs =
    typeof expiresInSec === "number" && Number.isFinite(expiresInSec) && expiresInSec > 0
      ? Math.max(expiresInSec * 1000 - safetyMs, 5_000)
      : 45 * 60_000;

  graphTokenCache.set(key, { accessToken, expiresAtMs: nowMs() + ttlMs });
  return accessToken;
}

async function graphRequest(
  tenantId: string, clientId: string, clientSecret: string,
  method: "GET" | "POST" | "PUT",
  url: string,
  body?: any,
  rawBody?: Buffer,
  contentType?: string,
): Promise<any> {
  const maxRetries = 3;

  const getToken = async (forceRefresh: boolean) => {
    if (forceRefresh) graphTokenCache.delete(cacheKey(tenantId, clientId));
    return graphToken(tenantId, clientId, clientSecret);
  };

  let token = await getToken(false);
  let didRefreshOn401 = false;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    let fetchBody: any = undefined;

    if (rawBody) {
      headers["Content-Type"] = contentType || "application/octet-stream";
      fetchBody = rawBody;
    } else if (method === "POST") {
      headers["Content-Type"] = "application/json";
      fetchBody = JSON.stringify(body ?? {});
    }

    const res = await fetchWithTimeout(url, { method, headers, body: fetchBody }, 30000);

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

    const ct = res.headers.get("content-type") || "";
    const isJson = ct.includes("application/json");

    if (!res.ok) {
      const errText = isJson ? JSON.stringify(await res.json().catch(() => ({}))) : await res.text().catch(() => "");
      throw new Error(`sp_${method.toLowerCase()}_error: status=${res.status} body=${errText}`);
    }

    if (res.status === 204) return null;
    if (isJson) return await res.json().catch(() => null);

    const text = await res.text().catch(() => "");
    try { return text ? JSON.parse(text) : null; } catch { return text || null; }
  }

  throw new Error(`sp_${method.toLowerCase()}_error: exceeded_retries`);
}

async function graphGet(t: string, c: string, s: string, url: string): Promise<any> {
  return graphRequest(t, c, s, "GET", url);
}

async function graphPost(t: string, c: string, s: string, url: string, body: any): Promise<any> {
  return graphRequest(t, c, s, "POST", url, body);
}

async function graphPut(t: string, c: string, s: string, url: string, raw: Buffer, contentType?: string): Promise<any> {
  return graphRequest(t, c, s, "PUT", url, undefined, raw, contentType);
}

/* ---------------- Poll state persistence ---------------- */

const HOME = process.env.HOME || "/root";
const POLL_STATE_DIR = path.join(HOME, ".openclaw/workspace/artifacts/personal/sharepoint");
const POLL_STATE_FILE = path.join(POLL_STATE_DIR, "poll-state.json");

interface PollState {
  lastPollIso: string;
  knownFileHashes: Record<string, string>; // fileId → lastModifiedDateTime
}

function loadPollState(): PollState {
  try {
    if (fs.existsSync(POLL_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(POLL_STATE_FILE, "utf-8"));
    }
  } catch {}
  return { lastPollIso: "", knownFileHashes: {} };
}

function savePollState(state: PollState): void {
  fs.mkdirSync(POLL_STATE_DIR, { recursive: true });
  fs.writeFileSync(POLL_STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

/* ---------------- Exported functions ---------------- */

const GRAPH = "https://graph.microsoft.com/v1.0";

export async function listSites(t: string, c: string, s: string): Promise<SPSite[]> {
  const data = await graphGet(t, c, s, `${GRAPH}/sites?search=*&$top=200`);
  const items: any[] = data?.value || [];
  return items.map((site: any) => ({
    id: site.id,
    displayName: site.displayName || site.name || "",
    webUrl: site.webUrl || "",
    description: site.description || undefined,
  }));
}

export async function listDrives(t: string, c: string, s: string, siteId: string): Promise<SPDrive[]> {
  const data = await graphGet(t, c, s, `${GRAPH}/sites/${encodeURIComponent(siteId)}/drives`);
  const items: any[] = data?.value || [];
  return items.map((d: any) => ({
    id: d.id,
    name: d.name || "",
    driveType: d.driveType || "",
    webUrl: d.webUrl || "",
  }));
}

export async function listFiles(
  t: string, c: string, s: string,
  siteId: string, driveId: string, folderId?: string,
): Promise<SPFile[]> {
  const base = `${GRAPH}/sites/${encodeURIComponent(siteId)}/drives/${encodeURIComponent(driveId)}`;
  const url = folderId
    ? `${base}/items/${encodeURIComponent(folderId)}/children?$top=200`
    : `${base}/root/children?$top=200`;

  const data = await graphGet(t, c, s, url);
  const items: any[] = data?.value || [];

  return items.map((f: any) => ({
    id: f.id,
    name: f.name || "",
    size: f.size || 0,
    webUrl: f.webUrl || "",
    lastModifiedDateTime: f.lastModifiedDateTime || "",
    createdDateTime: f.createdDateTime || "",
    mimeType: f.file?.mimeType || undefined,
    downloadUrl: f["@microsoft.graph.downloadUrl"] || undefined,
    isFolder: !!f.folder,
    childCount: f.folder?.childCount ?? undefined,
  }));
}

export async function downloadFile(downloadUrl: string): Promise<Buffer> {
  const res = await fetchWithTimeout(downloadUrl, {}, 60000);
  if (!res.ok) throw new Error(`sp_download_error: status=${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

export async function uploadFile(
  t: string, c: string, s: string,
  siteId: string, driveId: string, filePath: string, content: Buffer,
): Promise<any> {
  if (content.length > 4 * 1024 * 1024) {
    throw new Error("sp_upload_error: file exceeds 4 MB limit (use resumable upload for larger files)");
  }
  const base = `${GRAPH}/sites/${encodeURIComponent(siteId)}/drives/${encodeURIComponent(driveId)}`;
  const url = `${base}/root:/${filePath}:/content`;
  return graphPut(t, c, s, url, content, "application/octet-stream");
}

export async function searchDocuments(t: string, c: string, s: string, query: string): Promise<SPSearchHit[]> {
  const body = {
    requests: [{
      entityTypes: ["driveItem"],
      query: { queryString: query },
      from: 0,
      size: 25,
    }],
  };

  const data = await graphPost(t, c, s, `${GRAPH}/search/query`, body);
  const hits: SPSearchHit[] = [];

  const hitsContainers = data?.value?.[0]?.hitsContainers || [];
  for (const container of hitsContainers) {
    for (const hit of container.hits || []) {
      const r = hit.resource || {};
      hits.push({
        name: r.name || "",
        webUrl: r.webUrl || "",
        lastModifiedDateTime: r.lastModifiedDateTime || "",
        size: r.size || undefined,
        summary: hit.summary || undefined,
      });
    }
  }

  return hits;
}

export async function getRecentFiles(t: string, c: string, s: string): Promise<SPSearchHit[]> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const query = `lastModifiedDateTime>=${since}`;
  return searchDocuments(t, c, s, query);
}

export async function pollForChanges(t: string, c: string, s: string): Promise<SPChangeEntry[]> {
  const state = loadPollState();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const query = state.lastPollIso
    ? `lastModifiedDateTime>=${state.lastPollIso}`
    : `lastModifiedDateTime>=${since}`;

  let hits: SPSearchHit[];
  try {
    hits = await searchDocuments(t, c, s, query);
  } catch {
    return [];
  }

  const changes: SPChangeEntry[] = [];
  const newHashes: Record<string, string> = { ...state.knownFileHashes };

  for (const hit of hits) {
    const key = hit.webUrl;
    const prevMod = state.knownFileHashes[key];
    if (!prevMod) {
      changes.push({
        fileName: hit.name,
        webUrl: hit.webUrl,
        lastModifiedDateTime: hit.lastModifiedDateTime,
        changeType: "created",
      });
    } else if (prevMod !== hit.lastModifiedDateTime) {
      changes.push({
        fileName: hit.name,
        webUrl: hit.webUrl,
        lastModifiedDateTime: hit.lastModifiedDateTime,
        changeType: "modified",
      });
    }
    newHashes[key] = hit.lastModifiedDateTime;
  }

  savePollState({ lastPollIso: new Date().toISOString(), knownFileHashes: newHashes });
  return changes;
}
