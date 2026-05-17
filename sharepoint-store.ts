import fs from "node:fs";
import path from "node:path";
import { sleep, fetchWithTimeout, parseRetryAfterMs } from './src/shared/utils/index.js';
import { graphToken, clearGraphTokenCache } from './src/shared/m365/index.js';

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

/* ---------------- Graph helpers (using shared m365 token cache) ----------- */

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
    if (forceRefresh) clearGraphTokenCache(tenantId, clientId);
    return graphToken(tenantId, clientId, clientSecret);
  };

  let token: string;
  try {
    token = await getToken(false);
  } catch {
    // Token fetch failed (network error) → one retry after 2s
    await sleep(2000);
    token = await getToken(false);
  }
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

    let res: Response;
    try {
      res = await fetchWithTimeout(url, { method, headers, body: fetchBody }, 30000);
    } catch (e: any) {
      // Network error (TypeError: fetch failed, DNS, connection reset, etc.) → retry
      if (attempt < maxRetries) {
        await sleep(Math.min(2000 * Math.pow(2, attempt), 10000));
        continue;
      }
      throw new Error(`sp_${method.toLowerCase()}_network_error: ${e.message}`);
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
  const all: SPSite[] = [];
  let url: string = `${GRAPH}/sites?search=*&$top=200`;
  while (url) {
    const data = await graphGet(t, c, s, url);
    const items: any[] = data?.value || [];
    for (const site of items) {
      all.push({
        id: site.id,
        displayName: site.displayName || site.name || "",
        webUrl: site.webUrl || "",
        description: site.description || undefined,
      });
    }
    url = data?.["@odata.nextLink"] || "";
  }
  return all;
}

export async function listDrives(t: string, c: string, s: string, siteId: string): Promise<SPDrive[]> {
  const all: SPDrive[] = [];
  let url: string = `${GRAPH}/sites/${encodeURIComponent(siteId)}/drives?$top=200`;
  while (url) {
    const data = await graphGet(t, c, s, url);
    const items: any[] = data?.value || [];
    for (const d of items) {
      all.push({
        id: d.id,
        name: d.name || "",
        driveType: d.driveType || "",
        webUrl: d.webUrl || "",
      });
    }
    url = data?.["@odata.nextLink"] || "";
  }
  return all;
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
  const sites = await listSites(t, c, s);
  const allFiles: SPSearchHit[] = [];

  for (const site of sites) {
    let drives: SPDrive[];
    try {
      drives = await listDrives(t, c, s, site.id);
    } catch { continue; }

    for (const drive of drives) {
      try {
        const url = `${GRAPH}/sites/${encodeURIComponent(site.id)}/drives/${encodeURIComponent(drive.id)}/root/children?$orderby=lastModifiedDateTime desc&$top=10`;
        const data = await graphGet(t, c, s, url);
        const items: any[] = data?.value || [];
        for (const f of items) {
          if (f.folder) continue; // skip folders
          allFiles.push({
            name: f.name || "",
            webUrl: f.webUrl || "",
            lastModifiedDateTime: f.lastModifiedDateTime || "",
            size: f.size || undefined,
          });
        }
      } catch { continue; }
    }
  }

  // sort newest first, return top 25
  allFiles.sort((a, b) => (b.lastModifiedDateTime || "").localeCompare(a.lastModifiedDateTime || ""));
  return allFiles.slice(0, 25);
}

export async function pollForChanges(t: string, c: string, s: string): Promise<SPChangeEntry[]> {
  const state = loadPollState();
  const since = state.lastPollIso || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  let hits: SPSearchHit[];
  try {
    hits = await getRecentFiles(t, c, s);
  } catch {
    return [];
  }

  const changes: SPChangeEntry[] = [];
  const newHashes: Record<string, string> = { ...state.knownFileHashes };

  for (const hit of hits) {
    // skip files older than our poll window
    if (hit.lastModifiedDateTime && hit.lastModifiedDateTime < since) continue;
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

/* ---------------- Local index search (offline, no Search API) ------------ */

export function searchLocalIndex(query: string): SPSearchHit[] | null {
  if (!fs.existsSync(INDEX_FILE)) return null;

  let index: any;
  try {
    index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));
  } catch { return null; }

  const files: SPIndexEntry[] = index?.files || [];
  if (!files.length) return null;

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = files.filter((f) => {
    const haystack = `${f.name} ${f.path} ${f.siteName} ${f.driveName}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });

  // sort newest first
  matches.sort((a, b) => (b.lastModifiedDateTime || "").localeCompare(a.lastModifiedDateTime || ""));

  return matches.slice(0, 25).map((f) => ({
    name: f.name,
    webUrl: f.webUrl,
    lastModifiedDateTime: f.lastModifiedDateTime,
    size: f.size || undefined,
    summary: `${f.siteName} › ${f.path}`,
  }));
}

export function getIndexAge(): { exists: boolean; syncedAt?: string; fileCount?: number } {
  if (!fs.existsSync(INDEX_FILE)) return { exists: false };
  try {
    const index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));
    return { exists: true, syncedAt: index.syncedAt, fileCount: index.totalFiles };
  } catch { return { exists: false }; }
}

/* ---------------- Full sync (recursive index) ---------------- */

export type SPIndexEntry = {
  name: string;
  path: string;       // e.g. "Dokumente/Subfolder/file.pdf"
  webUrl: string;
  size: number;
  lastModifiedDateTime: string;
  createdDateTime: string;
  mimeType?: string;
  siteName: string;
  siteId: string;
  driveName: string;
  driveId: string;
};

export type SPSyncResult = {
  totalFiles: number;
  totalSites: number;
  totalDrives: number;
  errors: string[];
  skippedSites: string[];
  durationMs: number;
  files?: SPIndexEntry[];
};

/* Configurable site blacklist — sites whose displayName matches are skipped during sync */
const SITE_BLACKLIST: string[] = [
  "Mein Arbeitsbereich",
  "Designer",
];

const INDEX_FILE = path.join(POLL_STATE_DIR, "sharepoint-index.json");

type ProgressFn = (current: number, siteName: string) => void;

async function crawlFolder(
  t: string, c: string, s: string,
  driveBase: string, folderId: string | null,
  parentPath: string,
  collector: SPIndexEntry[],
  meta: { siteName: string; siteId: string; driveName: string; driveId: string },
  onFile: () => void,
  errors: string[],
): Promise<void> {
  let url = folderId
    ? `${driveBase}/items/${encodeURIComponent(folderId)}/children?$top=200`
    : `${driveBase}/root/children?$top=200`;

  while (url) {
    const data = await graphGet(t, c, s, url);
    const items: any[] = data?.value || [];

    for (const item of items) {
      const itemPath = parentPath ? `${parentPath}/${item.name}` : item.name || "";

      if (item.folder) {
        try {
          await crawlFolder(t, c, s, driveBase, item.id, itemPath, collector, meta, onFile, errors);
        } catch (e: any) {
          errors.push(`Folder "${itemPath}" @ "${meta.driveName}": ${e.message}`);
        }
      } else {
        collector.push({
          name: item.name || "",
          path: itemPath,
          webUrl: item.webUrl || "",
          size: item.size || 0,
          lastModifiedDateTime: item.lastModifiedDateTime || "",
          createdDateTime: item.createdDateTime || "",
          mimeType: item.file?.mimeType || undefined,
          siteName: meta.siteName,
          siteId: meta.siteId,
          driveName: meta.driveName,
          driveId: meta.driveId,
        });
        onFile();
      }
    }

    url = data?.["@odata.nextLink"] || "";
  }
}

export async function fullSync(
  t: string, c: string, s: string,
  onProgress?: ProgressFn,
  m365User?: string,
  skipJsonWrite?: boolean,
): Promise<SPSyncResult> {
  const start = Date.now();
  const allFiles: SPIndexEntry[] = [];
  const errors: string[] = [];
  let siteCount = 0;
  let driveCount = 0;

  const allSites = await listSites(t, c, s);
  const skippedSites: string[] = [];
  const sites = allSites.filter((site) => {
    if (SITE_BLACKLIST.some((bl) => site.displayName === bl)) {
      skippedSites.push(site.displayName);
      return false;
    }
    return true;
  });
  siteCount = sites.length;

  for (const site of sites) {
    let drives: SPDrive[];
    try {
      drives = await listDrives(t, c, s, site.id);
    } catch (e: any) {
      errors.push(`Site "${site.displayName}": kein Zugriff`);
      continue;
    }
    driveCount += drives.length;

    for (const drive of drives) {
      const beforeCount = allFiles.length;
      const driveBase = `${GRAPH}/sites/${encodeURIComponent(site.id)}/drives/${encodeURIComponent(drive.id)}`;
      try {
        await crawlFolder(t, c, s, driveBase, null, "", allFiles, {
          siteName: site.displayName,
          siteId: site.id,
          driveName: drive.name,
          driveId: drive.id,
        }, () => {
          if (onProgress && allFiles.length % 50 === 0) {
            onProgress(allFiles.length, site.displayName);
          }
        }, errors);
      } catch (e: any) {
        errors.push(`Drive "${drive.name}" @ "${site.displayName}": ${e.message}`);
      }
      const driveFiles = allFiles.length - beforeCount;
      if (onProgress) onProgress(allFiles.length, `${site.displayName} / ${drive.name} (${driveFiles} Dateien)`);
    }
  }

  // Crawl personal OneDrive if M365 user is configured
  if (m365User) {
    try {
      const driveData = await graphGet(t, c, s, `${GRAPH}/users/${encodeURIComponent(m365User)}/drive`);
      if (driveData?.id) {
        driveCount += 1;
        const beforeCount = allFiles.length;
        const driveBase = `${GRAPH}/drives/${encodeURIComponent(driveData.id)}`;
        await crawlFolder(t, c, s, driveBase, null, "", allFiles, {
          siteName: "OneDrive",
          siteId: m365User,
          driveName: driveData.name || "OneDrive",
          driveId: driveData.id,
        }, () => {
          if (onProgress && allFiles.length % 50 === 0) {
            onProgress(allFiles.length, "OneDrive");
          }
        }, errors);
        const odFiles = allFiles.length - beforeCount;
        if (onProgress) onProgress(allFiles.length, `OneDrive (${odFiles} Dateien)`);
      }
    } catch (e: any) {
      errors.push(`OneDrive "${m365User}": ${e.message}`);
    }
  }

  // persist index (skipped when called from DB-backed fullSync)
  if (!skipJsonWrite) {
    fs.mkdirSync(POLL_STATE_DIR, { recursive: true });
    const index = {
      syncedAt: new Date().toISOString(),
      totalFiles: allFiles.length,
      totalSites: siteCount,
      totalDrives: driveCount,
      files: allFiles,
    };
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), "utf-8");
  }

  return {
    totalFiles: allFiles.length,
    totalSites: siteCount,
    totalDrives: driveCount,
    errors,
    skippedSites,
    durationMs: Date.now() - start,
    files: skipJsonWrite ? allFiles : undefined,
  };
}
