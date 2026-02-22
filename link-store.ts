import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/* ════════════════════════════════════════════════════════════════════════════
   Link Store — universale Dokumenten-Verknüpfung (entkoppelt von Modulen)
   ════════════════════════════════════════════════════════════════════════════ */

const HOME = process.env.HOME || "/root";
const LINKS_DIR = path.join(HOME, ".openclaw/workspace/artifacts/personal/links");
const LINKS_FILE = path.join(LINKS_DIR, "links.json");
const SP_INDEX_FILE = path.join(HOME, ".openclaw/workspace/artifacts/personal/sharepoint/sharepoint-index.json");

/* ---------------- Types ---------------- */

export interface DocumentLink {
  id: string;                    // "lnk-" + 6 hex chars
  entityType: string;            // "fleet" | "trip" | "draft" | "calendar" | "property" | ...
  entityId: string;
  docType: "sharepoint" | "local";
  spItemId?: string;
  spDriveId?: string;
  spName?: string;
  spWebUrl?: string;
  localPath?: string;
  localName?: string;
  label: string;                 // "Kaufvertrag", "Rechnung", etc.
  createdAt: string;
}

export interface SpSearchResult {
  name: string;
  webUrl: string;
  driveId: string;
  itemId: string;       // constructed from path for identification
  siteName: string;
  path: string;
  size: number;
}

/* ---------------- Persistence helpers ---------------- */

function loadLinks(): DocumentLink[] {
  try {
    if (fs.existsSync(LINKS_FILE)) {
      return JSON.parse(fs.readFileSync(LINKS_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

function saveLinks(links: DocumentLink[]): void {
  fs.mkdirSync(LINKS_DIR, { recursive: true });
  fs.writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2), "utf-8");
}

function makeId(): string {
  return "lnk-" + crypto.randomBytes(3).toString("hex");
}

/* ---------------- SP index helpers ---------------- */

function loadSpIndex(): any[] {
  try {
    if (fs.existsSync(SP_INDEX_FILE)) {
      const index = JSON.parse(fs.readFileSync(SP_INDEX_FILE, "utf-8"));
      return index?.files || [];
    }
  } catch {}
  return [];
}

/* ---------------- Exported functions ---------------- */

export function getLinksForEntity(entityType: string, entityId: string): DocumentLink[] {
  const links = loadLinks();
  return links.filter((l) => l.entityType === entityType && l.entityId === entityId);
}

export function getAllLinks(): DocumentLink[] {
  return loadLinks();
}

export function addSharePointLink(
  entityType: string,
  entityId: string,
  spMatch: SpSearchResult,
  label: string,
): DocumentLink {
  const links = loadLinks();
  const link: DocumentLink = {
    id: makeId(),
    entityType,
    entityId,
    docType: "sharepoint",
    spItemId: spMatch.itemId,
    spDriveId: spMatch.driveId,
    spName: spMatch.name,
    spWebUrl: spMatch.webUrl,
    label,
    createdAt: new Date().toISOString(),
  };
  links.push(link);
  saveLinks(links);
  return link;
}

export function addLocalLink(
  entityType: string,
  entityId: string,
  localPath: string,
  label: string,
): DocumentLink {
  const links = loadLinks();
  const link: DocumentLink = {
    id: makeId(),
    entityType,
    entityId,
    docType: "local",
    localPath,
    localName: path.basename(localPath),
    label,
    createdAt: new Date().toISOString(),
  };
  links.push(link);
  saveLinks(links);
  return link;
}

export function removeLink(linkId: string): boolean {
  const links = loadLinks();
  const idx = links.findIndex((l) => l.id === linkId);
  if (idx === -1) return false;
  links.splice(idx, 1);
  saveLinks(links);
  return true;
}

export function getLinkById(linkId: string): DocumentLink | undefined {
  return loadLinks().find((l) => l.id === linkId);
}

export function searchSharePointForLinking(query: string): SpSearchResult[] {
  const files = loadSpIndex();
  if (!files.length) return [];

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = files.filter((f: any) => {
    const haystack = `${f.name} ${f.path} ${f.siteName} ${f.driveName}`.toLowerCase();
    return terms.every((term: string) => haystack.includes(term));
  });

  // sort newest first
  matches.sort((a: any, b: any) => (b.lastModifiedDateTime || "").localeCompare(a.lastModifiedDateTime || ""));

  return matches.slice(0, 10).map((f: any) => ({
    name: f.name,
    webUrl: f.webUrl,
    driveId: f.driveId || "",
    itemId: f.siteId + "::" + f.driveId + "::" + f.path,
    siteName: f.siteName || "",
    path: f.path || "",
    size: f.size || 0,
  }));
}

export function formatLinksForTelegram(links: DocumentLink[]): string {
  if (!links.length) return "Keine verknüpften Dokumente.";

  return links.map((l) => {
    const icon = l.docType === "sharepoint" ? "☁️" : "📁";
    const name = l.docType === "sharepoint" ? l.spName : l.localName;
    const url = l.docType === "sharepoint" && l.spWebUrl ? ` — ${l.spWebUrl}` : "";
    return `📎 ${l.label} ${icon} ${name}${url}\n   ID: ${l.id}`;
  }).join("\n");
}
