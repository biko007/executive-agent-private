import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { query } from "../db/index.js";
import * as audit from "../audit/index.js";

/* ════════════════════════════════════════════════════════════════════════════
   Link Store — universale Dokumenten-Verknüpfung (Postgres-backed, Sprint 9)
   ════════════════════════════════════════════════════════════════════════════ */

const HOME = process.env.HOME || "/root";
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

/* ---------------- Row → DocumentLink mapper ---------------- */

function rowToLink(row: any): DocumentLink {
  return {
    id: row.link_code,
    entityType: row.entity_type,
    entityId: row.entity_id,
    docType: row.doc_type,
    label: row.label,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    ...(row.sp_item_id ? { spItemId: row.sp_item_id } : {}),
    ...(row.sp_drive_id ? { spDriveId: row.sp_drive_id } : {}),
    ...(row.sp_name ? { spName: row.sp_name } : {}),
    ...(row.sp_web_url ? { spWebUrl: row.sp_web_url } : {}),
    ...(row.local_path ? { localPath: row.local_path } : {}),
    ...(row.local_name ? { localName: row.local_name } : {}),
  };
}

/* ---------------- Helpers ---------------- */

function makeId(): string {
  return "lnk-" + crypto.randomBytes(3).toString("hex");
}

/* ---------------- SP index helpers (DB-backed, Sprint 10) ----------------- */

function loadSpIndex(): any[] {
  // Legacy fallback — still used as sync path for file-based operations
  try {
    if (fs.existsSync(SP_INDEX_FILE)) {
      const index = JSON.parse(fs.readFileSync(SP_INDEX_FILE, "utf-8"));
      return index?.files || [];
    }
  } catch {}
  return [];
}

/* ---------------- Exported functions (async, Postgres-backed) ------------- */

export async function getLinksForEntity(entityType: string, entityId: string): Promise<DocumentLink[]> {
  const { rows } = await query(
    `SELECT * FROM entity_links WHERE entity_type = $1 AND entity_id = $2 ORDER BY created_at DESC`,
    [entityType, entityId],
  );
  return rows.map(rowToLink);
}

export async function getAllLinks(): Promise<DocumentLink[]> {
  const { rows } = await query(`SELECT * FROM entity_links ORDER BY created_at DESC`);
  return rows.map(rowToLink);
}

export async function addSharePointLink(
  entityType: string,
  entityId: string,
  spMatch: SpSearchResult,
  label: string,
): Promise<DocumentLink> {
  const linkCode = makeId();
  const { rows } = await query(
    `INSERT INTO entity_links (link_code, entity_type, entity_id, doc_type, label,
       sp_item_id, sp_drive_id, sp_name, sp_web_url, created_at, updated_at)
     VALUES ($1, $2, $3, 'sharepoint', $4, $5, $6, $7, $8, NOW(), NOW())
     RETURNING *`,
    [linkCode, entityType, entityId, label, spMatch.itemId, spMatch.driveId, spMatch.name, spMatch.webUrl],
  );
  const link = rowToLink(rows[0]);
  await audit.log({ module: 'links', action: 'add', entityType: 'entity_link', entityId: linkCode, after: rows[0] });
  return link;
}

export async function addLocalLink(
  entityType: string,
  entityId: string,
  localPath: string,
  label: string,
): Promise<DocumentLink> {
  const linkCode = makeId();
  const localName = path.basename(localPath);
  const { rows } = await query(
    `INSERT INTO entity_links (link_code, entity_type, entity_id, doc_type, label,
       local_path, local_name, created_at, updated_at)
     VALUES ($1, $2, $3, 'local', $4, $5, $6, NOW(), NOW())
     RETURNING *`,
    [linkCode, entityType, entityId, label, localPath, localName],
  );
  const link = rowToLink(rows[0]);
  await audit.log({ module: 'links', action: 'add', entityType: 'entity_link', entityId: linkCode, after: rows[0] });
  return link;
}

export async function removeLink(linkId: string): Promise<boolean> {
  const { rows: before } = await query(`SELECT * FROM entity_links WHERE link_code = $1`, [linkId]);
  if (!before.length) return false;
  await query(`DELETE FROM entity_links WHERE link_code = $1`, [linkId]);
  await audit.log({ module: 'links', action: 'remove', entityType: 'entity_link', entityId: linkId, before: before[0] });
  return true;
}

export async function getLinkById(linkId: string): Promise<DocumentLink | undefined> {
  const { rows } = await query(`SELECT * FROM entity_links WHERE link_code = $1`, [linkId]);
  return rows.length ? rowToLink(rows[0]) : undefined;
}

export async function updateEntityId(entityType: string, oldId: string, newId: string): Promise<number> {
  const { rows: before } = await query(
    `SELECT * FROM entity_links WHERE entity_type = $1 AND entity_id = $2`,
    [entityType, oldId],
  );
  if (!before.length) return 0;
  const { rowCount } = await query(
    `UPDATE entity_links SET entity_id = $1, updated_at = NOW() WHERE entity_type = $2 AND entity_id = $3`,
    [newId, entityType, oldId],
  );
  await audit.log({
    module: 'links', action: 'update', entityType: 'entity_link',
    entityId: `${entityType}/${oldId}→${newId}`,
    before: { entity_type: entityType, old_entity_id: oldId, count: before.length },
    after: { entity_type: entityType, new_entity_id: newId, count: rowCount },
  });
  return rowCount ?? 0;
}

/* ---------------- SP search (DB-backed, Sprint 10) ----------------------- */

/**
 * Search SharePoint files for linking. Uses DB (pg_trgm) with file-based fallback.
 * Return shape identical to pre-Sprint-10 for backward compatibility.
 */
export function searchSharePointForLinking(queryStr: string): SpSearchResult[] {
  // Sync function for backward compat — uses file-based search
  // The async DB path is used by queries.ts searchFiles() for Telegram + API
  const files = loadSpIndex();
  if (!files.length) return [];

  const terms = queryStr.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = files.filter((f: any) => {
    const haystack = `${f.name} ${f.path} ${f.siteName} ${f.driveName}`.toLowerCase();
    return terms.every((term: string) => haystack.includes(term));
  });

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

/**
 * Async DB-backed search for linking (Sprint 10).
 * Used by routes.ts and can replace sync version once all callers are async.
 */
export async function searchSharePointForLinkingAsync(queryStr: string): Promise<SpSearchResult[]> {
  try {
    const { searchFiles } = await import('../../modules/sharepoint/queries.js');
    const hits = await searchFiles(queryStr, 10);
    return hits.map(h => ({
      name: h.name,
      webUrl: h.web_url,
      driveId: h.drive_id || "",
      itemId: h.sp_item_key,
      siteName: h.site_name || "",
      path: h.path || "",
      size: h.size || 0,
    }));
  } catch {
    // Fallback to file-based
    return searchSharePointForLinking(queryStr);
  }
}

/* ---------------- Pure view function (sync, unchanged) ------------------- */

export function formatLinksForTelegram(links: DocumentLink[]): string {
  if (!links.length) return "Keine verknüpften Dokumente.";

  return links.map((l) => {
    const icon = l.docType === "sharepoint" ? "☁️" : "📁";
    const name = l.docType === "sharepoint" ? l.spName : l.localName;
    const url = l.docType === "sharepoint" && l.spWebUrl ? ` — ${l.spWebUrl}` : "";
    return `📎 ${l.label} ${icon} ${name}${url}\n   ID: ${l.id}`;
  }).join("\n");
}
