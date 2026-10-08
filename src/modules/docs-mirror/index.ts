/**
 * docs-mirror — Repo-Dokumentation nach Dropbox spiegeln.
 *
 * Zweck (Owner-Auftrag 08.10.2026): die aktuellen Markdown-Dokumente der drei
 * bikosoc-Repos sollen jederzeit zentral in Dropbox liegen, ohne Handgriff.
 * Ziel ist der App-Ordner des vorhandenen Report-Zugangs (EA_DROPBOX_*):
 *
 *   /bikosoc-reports/docs/repo/executive-agent/...
 *   /bikosoc-reports/docs/repo/executive-dashboard/...
 *   /bikosoc-reports/docs/repo/workspace/...
 *
 * Der Unterpfad relativ zum Repo bleibt erhalten, Dateiname 1:1.
 *
 * SICHERHEIT — drei Schranken, in dieser Reihenfolge:
 *   1. Nur eine Whitelist benannter Dateien und Verzeichnisse, und darin
 *      ausschliesslich `*.md`. Nichts wird rekursiv eingesammelt, kein `.env`,
 *      keine Laufzeitdatei, kein Verzeichnis `memory/`.
 *   2. Dateien mit einer Datenklassifizierung `sensitive` werden uebersprungen
 *      — dieselbe Regel, die der Report-Watcher fuer Reports anwendet (C5).
 *   3. Ein Inhalt, der wie ein Zugangsschluessel aussieht, wird uebersprungen
 *      und dabei WARNEND protokolliert. Lieber eine Datei sichtbar nicht
 *      spiegeln als ein Secret still hochladen.
 *
 * SPARSAMKEIT: Hochgeladen wird nur, was sich geaendert hat. Die Index-Datei
 * haelt je Dropbox-Pfad den SHA-256 des letzten Uploads — analog zu
 * `.report-sent.json` des Report-Watchers. Dropbox-Modus ist `overwrite`.
 *
 * Dieses Modul kennt weder Telegram noch systemd noch git. Es bekommt einen
 * Dropbox-Adapter und eine Repo-Liste und liefert ein Ergebnisprotokoll
 * zurueck. Aufgerufen wird es von `scripts/docs-mirror.ts`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DropboxAdapter } from '../../adapters/dropbox.js';

/** Basisordner im Dropbox-App-Ordner. */
export const DROPBOX_DOCS_BASE = '/bikosoc-reports/docs/repo';

/** Index-Datei analog `.report-sent.json`, bewusst als Punktdatei. */
export const DEFAULT_INDEX_PATH = 'bikosoc-spec/.docs-mirror-index.json';

export interface DocsMirrorRepo {
  /** Zielordner unter DROPBOX_DOCS_BASE. */
  key: string;
  /** Absoluter Pfad des Repos. */
  root: string;
  /** Einzelne Dateien relativ zum Repo-Root; fehlende werden stillschweigend ausgelassen. */
  files: string[];
  /** Verzeichnisse relativ zum Repo-Root, aus denen alle `*.md` genommen werden — NICHT rekursiv. */
  dirs: string[];
}

/**
 * Die drei Repos mit dem vom Owner festgelegten Umfang.
 *
 * Bewusst nicht rekursiv: `docs/workpackages/` und
 * `prompts/**` bleiben damit draussen, ebenso alles unter `memory/`.
 */
export function defaultDocsMirrorRepos(workspaceRoot: string): DocsMirrorRepo[] {
  const extensions = path.join(workspaceRoot, '.openclaw/extensions');
  return [
    {
      key: 'executive-agent',
      root: path.join(extensions, 'executive-agent'),
      files: ['CLAUDE.md', 'README.md'],
      dirs: ['docs', 'governance'],
    },
    {
      key: 'executive-dashboard',
      root: path.join(extensions, 'executive-dashboard'),
      files: ['CLAUDE.md', 'README.md'],
      dirs: ['docs'],
    },
    {
      key: 'workspace',
      root: workspaceRoot,
      files: ['CLAUDE.md', 'README.md'],
      dirs: [],
    },
  ];
}

export interface DocFile {
  /** Pfad relativ zum Repo-Root, mit `/` als Trenner. */
  relPath: string;
  absPath: string;
}

function istMarkdown(name: string): boolean {
  return name.toLowerCase().endsWith('.md') && !name.startsWith('.');
}

/**
 * Die zu spiegelnden Dateien eines Repos bestimmen.
 * Fehlende Dateien und Verzeichnisse sind kein Fehler — dann gibt es sie eben
 * nicht (das Dashboard fuehrt zum Beispiel kein `docs/`).
 */
export function collectDocFiles(repo: DocsMirrorRepo): DocFile[] {
  const treffer: DocFile[] = [];

  for (const rel of repo.files) {
    if (!istMarkdown(path.basename(rel))) continue;
    const abs = path.join(repo.root, rel);
    try {
      if (fs.statSync(abs).isFile()) treffer.push({ relPath: rel, absPath: abs });
    } catch { /* nicht vorhanden */ }
  }

  for (const dir of repo.dirs) {
    const absDir = path.join(repo.root, dir);
    let namen: string[];
    try {
      namen = fs.readdirSync(absDir);
    } catch {
      continue; // Verzeichnis fehlt
    }
    for (const name of namen.sort()) {
      if (!istMarkdown(name)) continue;
      const abs = path.join(absDir, name);
      try {
        if (fs.statSync(abs).isFile()) treffer.push({ relPath: `${dir}/${name}`, absPath: abs });
      } catch { /* Symlink ins Leere */ }
    }
  }

  // Keine globale Sortierung: die Reihenfolge folgt der Deklaration (erst die
  // benannten Dateien, dann Verzeichnis fuer Verzeichnis alphabetisch). Das ist
  // deterministisch und liest sich im Log wie der Umfang im Auftrag.
  return treffer;
}

/** Dropbox-Zielpfad eines Dokuments. */
export function dropboxTargetPath(repoKey: string, relPath: string): string {
  return `${DROPBOX_DOCS_BASE}/${repoKey}/${relPath}`;
}

/**
 * Traegt das Dokument eine Datenklassifizierung `sensitive`?
 * Erkennt die im Projekt genutzten Schreibweisen in den ersten Zeilen.
 */
export function istSensitivMarkiert(inhalt: string): boolean {
  const kopf = inhalt.slice(0, 4_000);
  return /^\s*(?:\*\*)?(?:Datenklassifizierung|Datenklassifikation|Classification)(?:\*\*)?\s*:\s*\**\s*sensitive/im.test(kopf);
}

/**
 * Sieht der Inhalt aus wie ein echter Zugangsschluessel?
 *
 * Absichtlich eng gefasst auf Formate, die sich nicht mit Prosa verwechseln
 * lassen. Platzhalter wie `<DASHBOARD_TOKEN>` oder `KEY=CHANGEME` sind damit
 * kein Treffer — die stehen in der Doku und sollen dort auch bleiben.
 */
const SECRET_MUSTER: Array<{ name: string; re: RegExp }> = [
  { name: 'openai/anthropic-key', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/ },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'telegram-bot-token', re: /\b\d{8,12}:[A-Za-z0-9_-]{30,}/ },
  { name: 'private-key', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
];

export function findeSecretMuster(inhalt: string): string | null {
  for (const { name, re } of SECRET_MUSTER) {
    if (re.test(inhalt)) return name;
  }
  return null;
}

// ── Index ─────────────────────────────────────────────────────────────────

export interface DocsMirrorIndexEntry {
  sha256: string;
  bytes: number;
  uploadedAt: string;
}

export type DocsMirrorIndex = Record<string, DocsMirrorIndexEntry>;

export function sha256Hex(body: Buffer): string {
  return crypto.createHash('sha256').update(body).digest('hex');
}

/** Index lesen. Eine fehlende oder defekte Datei gilt als leerer Index. */
export function readIndex(indexPath: string): DocsMirrorIndex {
  try {
    const roh = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    return roh && typeof roh === 'object' && !Array.isArray(roh) ? (roh as DocsMirrorIndex) : {};
  } catch {
    // Anders als beim Report-Watcher ist ein leerer Index hier harmlos: es
    // werden dann alle Dateien einmal neu hochgeladen (overwrite), nichts
    // geloescht und nichts doppelt zugestellt.
    return {};
  }
}

/** Index atomar schreiben. */
export function writeIndex(indexPath: string, index: DocsMirrorIndex): void {
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  const temp = `${indexPath}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, indexPath);
}

// ── Lauf ──────────────────────────────────────────────────────────────────

export type SkipGrund = 'sensitive' | 'secret_muster' | 'unlesbar';

export interface DocsMirrorResult {
  /** Hochgeladene Dokumente (geaendert oder neu). */
  uploaded: Array<{ repoKey: string; relPath: string; dropboxPath: string; bytes: number }>;
  /** Unveraenderte Dokumente — kein Upload. */
  unchanged: Array<{ repoKey: string; relPath: string }>;
  /** Bewusst ausgelassene Dokumente. */
  skipped: Array<{ repoKey: string; relPath: string; grund: SkipGrund; detail?: string }>;
  /** Fehlgeschlagene Uploads — der Lauf macht trotzdem weiter. */
  errors: Array<{ repoKey: string; relPath: string; message: string }>;
  /** Index-Einträge, deren Quelldatei es nicht mehr gibt (nur entfernt, Dropbox bleibt). */
  pruned: string[];
}

export interface MirrorDocsOptions {
  adapter: DropboxAdapter;
  repos: DocsMirrorRepo[];
  indexPath: string;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
  now?: () => Date;
  /** Trockenlauf: nichts hochladen, nichts schreiben — fuer den Selbsttest. */
  dryRun?: boolean;
}

/**
 * Einen Spiegel-Lauf ausfuehren.
 *
 * Fehler eines einzelnen Dokuments beenden den Lauf nicht: die uebrigen
 * Dokumente werden trotzdem gespiegelt, und der Index behaelt fuer das
 * gescheiterte Dokument den alten Stand — der naechste Lauf versucht es erneut.
 */
export async function mirrorDocsOnce(opts: MirrorDocsOptions): Promise<DocsMirrorResult> {
  const log = opts.logger;
  const jetzt = (opts.now ?? (() => new Date()))();
  const index = readIndex(opts.indexPath);
  const result: DocsMirrorResult = { uploaded: [], unchanged: [], skipped: [], errors: [], pruned: [] };
  const gesehen = new Set<string>();

  for (const repo of opts.repos) {
    for (const datei of collectDocFiles(repo)) {
      const dropboxPath = dropboxTargetPath(repo.key, datei.relPath);
      gesehen.add(dropboxPath);

      let body: Buffer;
      try {
        body = fs.readFileSync(datei.absPath);
      } catch (e: any) {
        result.skipped.push({ repoKey: repo.key, relPath: datei.relPath, grund: 'unlesbar', detail: e?.message });
        log?.warn(`[docs-mirror] nicht lesbar: ${repo.key}/${datei.relPath}: ${e?.message}`);
        continue;
      }

      const inhalt = body.toString('utf-8');
      if (istSensitivMarkiert(inhalt)) {
        result.skipped.push({ repoKey: repo.key, relPath: datei.relPath, grund: 'sensitive' });
        log?.warn(`[docs-mirror] uebersprungen (sensitive): ${repo.key}/${datei.relPath}`);
        continue;
      }
      const muster = findeSecretMuster(inhalt);
      if (muster) {
        result.skipped.push({ repoKey: repo.key, relPath: datei.relPath, grund: 'secret_muster', detail: muster });
        log?.warn(`[docs-mirror] uebersprungen (sieht aus wie ${muster}): ${repo.key}/${datei.relPath}`);
        continue;
      }

      const hash = sha256Hex(body);
      if (index[dropboxPath]?.sha256 === hash) {
        result.unchanged.push({ repoKey: repo.key, relPath: datei.relPath });
        continue;
      }

      if (opts.dryRun) {
        result.uploaded.push({ repoKey: repo.key, relPath: datei.relPath, dropboxPath, bytes: body.length });
        continue;
      }

      try {
        await opts.adapter.uploadFile({
          path: dropboxPath,
          body,
          contentType: 'text/markdown; charset=utf-8',
        });
        index[dropboxPath] = { sha256: hash, bytes: body.length, uploadedAt: jetzt.toISOString() };
        result.uploaded.push({ repoKey: repo.key, relPath: datei.relPath, dropboxPath, bytes: body.length });
        log?.info(`[docs-mirror] hochgeladen: ${dropboxPath} (${body.length} Bytes)`);
      } catch (e: any) {
        result.errors.push({ repoKey: repo.key, relPath: datei.relPath, message: e?.message ?? String(e) });
        log?.warn(`[docs-mirror] Upload fehlgeschlagen: ${dropboxPath}: ${e?.message}`);
      }
    }
  }

  // Index aufraeumen: Einträge ohne Quelldatei fliegen raus. Die Datei in
  // Dropbox bleibt stehen — dieses Modul loescht dort nichts.
  for (const pfad of Object.keys(index)) {
    if (!gesehen.has(pfad)) {
      delete index[pfad];
      result.pruned.push(pfad);
    }
  }

  if (!opts.dryRun) writeIndex(opts.indexPath, index);
  return result;
}

/** Einzeiler fuer Log und Report. */
export function formatDocsMirrorSummary(r: DocsMirrorResult): string {
  return `${r.uploaded.length} hochgeladen, ${r.unchanged.length} unveraendert, `
    + `${r.skipped.length} uebersprungen, ${r.errors.length} Fehler, ${r.pruned.length} Index-Eintraege entfernt`;
}
