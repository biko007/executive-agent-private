/**
 * dropbox-inbox — Bruecke von Dropbox nach ~/inbox/
 *
 * Zweck (Owner-Auftrag E5, 07.10.2026): Prompts, die Claude in Dropbox unter
 * `/Apps/bikosoc-reports/bikosoc-reports/inbox/*.txt` ablegt, sollen ohne
 * weiteres Zutun in `~/inbox/` landen. Dort uebernimmt der vorhandene
 * Prompt-Inbox-Watcher wie bisher (systemd-user-Timer, 10 s, tmux `bikosoc`,
 * Telegram-Quittung). Dieses Modul holt die Datei ab — es fuehrt nichts aus.
 *
 * Zugang: derselbe Dropbox-App-Ordner-Zugang wie der Report-Watcher
 * (EA_DROPBOX_*). Gelesen und verschoben wird nur innerhalb des App-Ordners.
 *
 * Doppelverarbeitung ist ausgeschlossen, weil die Reihenfolge feststeht:
 *
 *   1. Inhalt herunterladen
 *   2. In `~/inbox/` als `.<name>.part` schreiben (fuehrender Punkt — der
 *      Prompt-Inbox-Watcher ignoriert solche Dateien)
 *   3. In Dropbox nach `inbox/done/<zeitstempel>-<name>` verschieben
 *   4. Erst danach `.part` auf den Endnamen umbenennen (rename ist atomar)
 *
 * Bricht Schritt 3 ab, wird die Teildatei geloescht und beim naechsten Durchlauf
 * neu geholt — die Datei liegt in Dropbox noch an derselben Stelle. Bricht es
 * nach Schritt 3 ab, liegt die Teildatei lokal und wird beim naechsten Lauf
 * aufgeraeumt; der Prompt ist dann verloren, aber nicht doppelt ausgefuehrt. Von
 * den beiden Fehlern ist das der harmlosere.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DropboxAdapter } from '../../adapters/dropbox.js';

/** Ordner im Dropbox-App-Ordner. Deckungsgleich mit dem Report-Ziel. */
export const DROPBOX_INBOX_DIR = '/bikosoc-reports/inbox';
export const DROPBOX_INBOX_DONE_DIR = '/bikosoc-reports/inbox/done';

export interface DropboxInboxResult {
  /** Dropbox-Pfad, von dem geholt wurde. */
  dropboxPath: string;
  /** Dropbox-Pfad nach dem Verschieben. */
  dropboxDonePath: string;
  /** Lokale Datei in ~/inbox/, die der Prompt-Inbox-Watcher findet. */
  localPath: string;
  bytes: number;
}

/** Dateinamen auf unbedenkliche Zeichen begrenzen. */
export function sanitizeInboxName(name: string): string {
  const flach = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
  return flach.length ? flach : 'prompt.txt';
}

/** Zeitstempel fuer den Zielnamen: 20261007-104512 (Europe/Berlin). */
export function berlinStamp(now: Date): string {
  const teile = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const v = (t: string) => teile.find((p) => p.type === t)?.value ?? '00';
  return `${v('year')}${v('month')}${v('day')}-${v('hour')}${v('minute')}${v('second')}`;
}

/** Liegengebliebene Teildateien eines abgebrochenen Laufs entfernen. */
function raeumeTeildateien(inboxDir: string): void {
  for (const name of fs.readdirSync(inboxDir)) {
    if (name.startsWith('.dropbox-') && name.endsWith('.part')) {
      try { fs.unlinkSync(path.join(inboxDir, name)); } catch { /* schon weg */ }
    }
  }
}

/**
 * Einen Durchlauf ausfuehren: alle `.txt` aus dem Dropbox-Inbox-Ordner holen.
 *
 * Legt die beiden Dropbox-Ordner bei Bedarf an (createFolder ist idempotent).
 */
export async function processDropboxInboxOnce(opts: {
  adapter: DropboxAdapter;
  homeDir: string;
  inboxDir?: string;
  now?: Date;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
}): Promise<DropboxInboxResult[]> {
  const inboxDir = opts.inboxDir ?? path.join(opts.homeDir, 'inbox');
  const now = opts.now ?? new Date();
  const log = opts.logger;

  fs.mkdirSync(inboxDir, { recursive: true });
  raeumeTeildateien(inboxDir);

  const einträge = await opts.adapter.listFolder(DROPBOX_INBOX_DIR);
  const dateien = einträge
    .filter((e) => e.tag === 'file')
    .filter((e) => e.name.toLowerCase().endsWith('.txt'))
    .filter((e) => !e.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!dateien.length) return [];

  // Erst anlegen, wenn tatsaechlich etwas zu verschieben ist.
  await opts.adapter.createFolder(DROPBOX_INBOX_DONE_DIR).catch(() => { /* existiert */ });

  const ergebnisse: DropboxInboxResult[] = [];

  for (const datei of dateien) {
    const sicher = sanitizeInboxName(datei.name);
    const stamp = berlinStamp(now);
    const partPath = path.join(inboxDir, `.dropbox-${stamp}-${sicher}.part`);
    const zielPath = path.join(inboxDir, `dropbox-${stamp}-${sicher}`);
    const donePath = `${DROPBOX_INBOX_DONE_DIR}/${stamp}-${sicher}`;

    try {
      const inhalt = await opts.adapter.downloadFile(datei.pathLower);
      fs.writeFileSync(partPath, inhalt);

      try {
        await opts.adapter.moveFile(datei.pathLower, donePath);
      } catch (e: any) {
        // Nicht verschoben → lokale Teildatei weg, naechster Lauf holt erneut.
        try { fs.unlinkSync(partPath); } catch { /* schon weg */ }
        throw e;
      }

      fs.renameSync(partPath, zielPath);

      log?.info(`[dropbox-inbox] ${datei.name} → ${zielPath} (${inhalt.length} Bytes)`);
      ergebnisse.push({
        dropboxPath: datei.pathDisplay || datei.pathLower,
        dropboxDonePath: donePath,
        localPath: zielPath,
        bytes: inhalt.length,
      });
    } catch (e: any) {
      log?.warn(`[dropbox-inbox] ${datei.name} nicht abgeholt: ${e.message}`);
    }
  }

  return ergebnisse;
}
