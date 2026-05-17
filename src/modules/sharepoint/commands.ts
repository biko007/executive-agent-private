/**
 * sharepoint/commands — Telegram command handlers for SharePoint + Links module.
 * Commands: /sharepoint, /spdocs, /sprecent, /spsync, /link, /linkadd, /linkdel, /triplink
 *
 * Sprint 10: DB-backed search (queries.ts), DB-backed sync (store.ts).
 * Polling removed (Q2 decision).
 */
import {
  listSites, listDrives, getRecentFiles,
} from './store.js';
import { fullSync } from './store.js';
import { searchFiles, listSitesFromDb, listDrivesFromDb } from './queries.js';
import {
  getLinksForEntity, addSharePointLink, removeLink,
  formatLinksForTelegram,
} from '../../shared/links/index.js';
import { searchSharePointForLinking } from '../../shared/links/index.js';
import type { SpSearchResult } from '../../shared/links/index.js';
import { loadSettings } from '../../shared/settings/index.js';

// ── Dependency Injection ───────────────────────────────────────────────────

export interface SharePointDeps {
  m365Enabled: boolean;
  tenantId: string;
  clientId: string;
  m365Secret: string;
  m365User: string;
  sendTelegram: (chatId: string, text: string) => Promise<any>;
  logger: { info(m: string): void; warn(m: string): void; error(m: string): void };
}

let deps: SharePointDeps;

export function initSharePointCommands(d: SharePointDeps): void {
  deps = d;
}

// ── Exported for index.ts (briefing, link display for other modules) ──────

export { getLinksForEntity, formatLinksForTelegram, searchSharePointForLinking };
export { addSharePointLink, removeLink };

// ── State ─────────────────────────────────────────────────────────────────

const pendingLinkSelections = new Map<string, {
  entityType: string;
  entityId: string;
  results: SpSearchResult[];
  label: string;
  expiresAt: number;
}>();

// ── Command Registration ──────────────────────────────────────────────────

export function registerSharePointCommands(api: any): void {
  // /sharepoint — list sites or drives (from DB)
  api.registerCommand({
    name: 'sharepoint',
    acceptsArgs: true,
    description: 'SharePoint: Ohne Arg \u2192 Sites auflisten. Mit Arg (siteId) \u2192 Drives auflisten.',
    handler: async (ctx: any) => {
      const arg = String(ctx.args || '').trim();
      try {
        if (!arg) {
          const sites = await listSitesFromDb();
          if (!sites.length) return { text: '\ud83d\udcc2 Keine SharePoint-Sites im Index.' };
          const lines = sites.map((s, i: number) => `${i + 1}. **${s.site_name}** (${s.file_count} Dateien)\n   ID: \`${s.site_id}\``);
          return { text: `\ud83d\udcc2 **SharePoint-Sites** (${sites.length}):\n\n${lines.join('\n\n')}` };
        } else {
          const drives = await listDrivesFromDb(arg);
          if (!drives.length) return { text: `\ud83d\udcc2 Keine Drives f\u00fcr diese Site im Index.` };
          const lines = drives.map((d, i: number) => `${i + 1}. **${d.drive_name}** (${d.file_count} Dateien)\n   ID: \`${d.drive_id}\``);
          return { text: `\ud83d\udcc2 **Drives** (${drives.length}):\n\n${lines.join('\n\n')}` };
        }
      } catch (e: any) {
        return { text: `\u274c /sharepoint Fehler: ${e.message}` };
      }
    },
  });

  // /spdocs — search files in DB (pg_trgm)
  api.registerCommand({
    name: 'spdocs',
    acceptsArgs: true,
    description: 'SharePoint-Suche im DB-Index: /spdocs <suchbegriff>',
    handler: async (ctx: any) => {
      const q = String(ctx.args || '').trim();
      if (!q) return { text: '\u274c Verwendung: /spdocs <suchbegriff>' };

      try {
        const hits = await searchFiles(q, 10);
        if (!hits.length) return { text: `\ud83d\udd0d Keine Ergebnisse f\u00fcr \u201e${q}\u201c.` };
        const lines = hits.map((h, i: number) => {
          const size = h.size ? ` \u00b7 ${(h.size / 1024).toFixed(0)} KB` : '';
          const date = h.last_modified_at ? ` \u00b7 ${h.last_modified_at.slice(0, 10)}` : '';
          return `${i + 1}. **${h.name}**${size}${date}\n   ${h.site_name} \u203a ${h.path}\n   ${h.web_url}`;
        });
        return { text: `\ud83d\udd0d **Ergebnisse f\u00fcr \u201e${q}\u201c** (${hits.length}):\n\n${lines.join('\n\n')}` };
      } catch (e: any) {
        return { text: `\u274c /spdocs Fehler: ${e.message}` };
      }
    },
  });

  // /sprecent — recent SP files from DB
  api.registerCommand({
    name: 'sprecent',
    description: 'K\u00fcrzlich ge\u00e4nderte SharePoint-Dateien (aus DB-Index)',
    handler: async () => {
      try {
        const { listFilesFromDb } = await import('./queries.js');
        const files = await listFilesFromDb({ orderBy: 'last_modified_at', limit: 15 });
        if (!files.length) return { text: '\ud83d\udcc2 Keine Dateien im Index.' };
        const lines = files.map((f, i: number) => {
          const date = f.last_modified_at ? f.last_modified_at.slice(0, 16).replace('T', ' ') : '';
          const size = f.size ? ` \u00b7 ${(f.size / 1024).toFixed(0)} KB` : '';
          return `${i + 1}. **${f.name}**${size}\n   ${date}\n   ${f.web_url}`;
        });
        return { text: `\ud83d\udcc2 **K\u00fcrzlich ge\u00e4ndert** (max 15):\n\n${lines.join('\n\n')}` };
      } catch (e: any) {
        return { text: `\u274c /sprecent Fehler: ${e.message}` };
      }
    },
  });

  // /spsync — full SP sync (now writes to DB)
  api.registerCommand({
    name: 'spsync',
    description: 'SharePoint-Vollsync: alle Sites/Drives/Dateien rekursiv indexieren (DB)',
    handler: async () => {
      if (!deps.m365Enabled || !deps.tenantId || !deps.clientId || !deps.m365Secret) {
        return { text: '\u274c M365-Konfiguration fehlt.' };
      }
      const s = loadSettings();
      const chatId = s.telegramChatId;

      const send = async (msg: string) => {
        if (!chatId) {
          deps.logger.warn('[executive-agent] spsync: kein telegramChatId');
          return;
        }
        await deps.sendTelegram(chatId, msg);
      };

      const syncUser = deps.m365User || process.env.M365_USER || '';

      (async () => {
        try {
          const result = await fullSync(deps.tenantId, deps.clientId, deps.m365Secret, (count: number, label?: string) => {
            if (count % 2000 === 0) {
              send(`\ud83d\udd04 Sync l\u00e4uft... ${count} Dateien ${label ? `(${label})` : ''}`).catch(() => {});
            }
          }, syncUser || undefined);

          const durSec = (result.durationMs / 1000).toFixed(1);
          let summary = `\u2705 SharePoint-Sync abgeschlossen (DB)\n\n`;
          summary += `\ud83d\udcc2 ${result.totalFiles} Dateien \u00b7 ${result.totalSites} Sites \u00b7 ${result.totalDrives} Drives\n`;
          summary += `\u23f1 ${durSec}s`;
          if (result.skippedSites?.length) {
            summary += `\n\n\u26a0\ufe0f ${result.skippedSites.length} Sites \u00fcbersprungen: ${result.skippedSites.join(', ')} (Blacklist)`;
          }
          if (result.errors.length) {
            summary += `\n\n\u26a0\ufe0f ${result.errors.length} Fehler:\n` + result.errors.slice(0, 5).map((e: string) => `\u2022 ${e}`).join('\n');
          }
          deps.logger.info(`[executive-agent] spsync: ${result.totalFiles} files, ${result.totalSites} sites, ${result.totalDrives} drives, ${durSec}s`);
          await send(summary);
        } catch (e: any) {
          const msg = e?.message || String(e);
          deps.logger.error(`[executive-agent] spsync error: ${msg}`);
          await send(`\u274c SharePoint-Sync fehlgeschlagen: ${msg}`);
        }
      })().catch(e => {
        deps.logger.error(`[executive-agent] spsync unhandled: ${e?.message || e}`);
      });

      return { text: '\ud83d\udd04 SharePoint-Vollsync gestartet (DB). Fortschritt kommt via Telegram.' };
    },
  });

  // /link — show linked documents
  api.registerCommand({
    name: 'link',
    acceptsArgs: true,
    description: 'Verkn\u00fcpfte Dokumente anzeigen: /link <entityType> <entityId>',
    handler: async (ctx: any) => {
      const parts = String(ctx.args || '').trim().split(/\s+/);
      if (parts.length < 2) return { text: '\u274c Verwendung: /link <entityType> <entityId>' };
      const [entityType, entityId] = parts;
      const links = await getLinksForEntity(entityType, entityId);
      if (!links.length) return { text: `\ud83d\udcce Keine Dokumente verkn\u00fcpft mit ${entityType} ${entityId}.` };
      return { text: `\ud83d\udcce Verkn\u00fcpfte Dokumente (${entityType} ${entityId}):\n\n${formatLinksForTelegram(links)}` };
    },
  });

  // /linkadd — add document link
  api.registerCommand({
    name: 'linkadd',
    acceptsArgs: true,
    description: 'Dokument verkn\u00fcpfen: /linkadd <entityType> <entityId> sp <suchbegriff> | /linkadd <entityType> <entityId> local <label>',
    handler: async (ctx: any) => {
      const raw = String(ctx.args || '').trim();
      const parts = raw.split(/\s+/);
      if (parts.length < 4) return { text: '\u274c Verwendung:\n/linkadd <entityType> <entityId> sp <suchbegriff>\n/linkadd <entityType> <entityId> local <label>' };

      const [entityType, entityId, docType, ...rest] = parts;

      if (docType === 'sp') {
        const q = rest.join(' ');
        if (!q) return { text: '\u274c Suchbegriff fehlt.' };
        const results = await searchSharePointForLinking(q);
        if (!results.length) return { text: `\u274c Keine Treffer f\u00fcr "${q}" im SharePoint-Index.\nTipp: /spsync falls der Index veraltet ist.` };

        const chatId = String(ctx.chatId || ctx.threadId || ctx.conversationId || ctx.senderId || '');
        pendingLinkSelections.set(chatId, {
          entityType,
          entityId,
          results,
          label: q,
          expiresAt: Date.now() + 5 * 60_000,
        });

        const lines = results.map((r: any, i: number) => `${i + 1}) ${r.name}\n   ${r.siteName} \u203a ${r.path}`);
        return { text: `\ud83d\udcc2 Gefunden (${results.length}):\n\n${lines.join('\n\n')}\n\nAntwort mit Nummer zum Verkn\u00fcpfen:` };
      }

      if (docType === 'local') {
        const label = rest.join(' ') || 'Dokument';
        return { text: `\ud83d\udcce Sende jetzt die Datei. Label: "${label}"\n(Lokaler Upload wird beim n\u00e4chsten Dateiempfang verkn\u00fcpft)` };
      }

      return { text: '\u274c Typ muss "sp" oder "local" sein.' };
    },
  });

  // /linkdel — remove link
  api.registerCommand({
    name: 'linkdel',
    acceptsArgs: true,
    description: 'Verkn\u00fcpfung entfernen: /linkdel <linkId>',
    handler: async (ctx: any) => {
      const linkId = String(ctx.args || '').trim();
      if (!linkId) return { text: '\u274c Verwendung: /linkdel <linkId>' };
      const removed = await removeLink(linkId);
      if (!removed) return { text: `\u274c Verkn\u00fcpfung "${linkId}" nicht gefunden.` };
      return { text: `\ud83d\uddd1 Verkn\u00fcpfung ${linkId} entfernt.` };
    },
  });

  // /triplink — shortcut for /link trip <id>
  api.registerCommand({
    name: 'triplink',
    acceptsArgs: true,
    description: 'Reise-Dokumente anzeigen: /triplink <id>',
    handler: async (ctx: any) => {
      const id = String(ctx.args || '').trim();
      if (!id) return { text: '\u274c Verwendung: /triplink <id>' };
      const links = await getLinksForEntity('trip', id);
      if (!links.length) return { text: `\ud83d\udcce Keine Dokumente verkn\u00fcpft mit Reise ${id}.` };
      return { text: `\ud83d\udcce Reise-Dokumente (${id}):\n\n${formatLinksForTelegram(links)}` };
    },
  });

  // Handle numeric replies for pending SP link selections
  api.on('message_received', (event: any) => {
    try {
      const chatId = String(event?.metadata?.senderId || '');
      if (!chatId) return;
      const pending = pendingLinkSelections.get(chatId);
      if (!pending || Date.now() > pending.expiresAt) {
        if (pending) pendingLinkSelections.delete(chatId);
        return;
      }

      const text = String(event?.content || '').trim();
      const num = parseInt(text, 10);
      if (isNaN(num) || num < 1 || num > pending.results.length) return;

      const selected = pending.results[num - 1];
      pendingLinkSelections.delete(chatId);

      addSharePointLink(pending.entityType, pending.entityId, selected, pending.label).then((link) => {
        const s = loadSettings();
        if (s.telegramChatId) {
          deps.sendTelegram(s.telegramChatId, `\ud83d\udcce ${selected.name} verkn\u00fcpft mit ${pending.entityType} ${pending.entityId}\nLabel: ${link.label} | ID: ${link.id}`).catch(() => {});
        }
      }).catch(() => {});
    } catch {}
  });

  // Polling removed (Sprint 10, Q2 decision)
}
