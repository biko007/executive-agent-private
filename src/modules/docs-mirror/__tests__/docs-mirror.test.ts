/**
 * docs-mirror — Auswahl, Hash-Vergleich, Schutzschranken, Index.
 *
 * Arbeitet auf Temp-Verzeichnissen mit einem Dropbox-Attrappen-Adapter.
 * Es geht nie ein Aufruf nach aussen, und die echten Repos werden nur gelesen
 * (im letzten Block, zur Abdeckung des tatsaechlichen Bestands).
 */
import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DROPBOX_DOCS_BASE, collectDocFiles, defaultDocsMirrorRepos, dropboxTargetPath,
  findeSecretMuster, formatDocsMirrorSummary, istSensitivMarkiert, mirrorDocsOnce,
  readIndex, sha256Hex, writeIndex,
} from '../index.js';
import type { DocsMirrorRepo } from '../index.js';
import type { DropboxAdapter, DropboxUploadResult } from '../../../adapters/dropbox.js';

const verzeichnisse: string[] = [];

function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-mirror-'));
  verzeichnisse.push(d);
  return d;
}

afterEach(() => {
  while (verzeichnisse.length) fs.rmSync(verzeichnisse.pop()!, { recursive: true, force: true });
});

function schreibe(root: string, rel: string, inhalt: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, inhalt);
}

/** Adapter-Attrappe: haelt fest, was hochgeladen wurde. */
function fakeAdapter(opts: { fehlerFuer?: string[] } = {}) {
  const uploads: Array<{ path: string; body: string; contentType: string }> = [];
  const adapter = {
    uploadFile: async ({ path: p, body, contentType }: { path: string; body: Buffer; contentType: string }) => {
      if (opts.fehlerFuer?.includes(p)) throw new Error(`Dropbox sagt nein: ${p}`);
      uploads.push({ path: p, body: body.toString('utf-8'), contentType });
      return { pathDisplay: p, size: body.length, contentHash: 'x' } as DropboxUploadResult;
    },
    uploadFileStream: async () => { throw new Error('nicht benutzt'); },
    createFolder: async () => {},
    listFolder: async () => [],
    downloadFile: async () => Buffer.alloc(0),
    moveFile: async () => {},
    healthCheck: async () => true,
  } as unknown as DropboxAdapter;
  return { adapter, uploads };
}

/** Ein Repo mit dem Standardumfang auf einem Temp-Pfad. */
function repoAuf(root: string, key = 'testrepo'): DocsMirrorRepo {
  return { key, root, files: ['CLAUDE.md', 'README.md'], dirs: ['docs', 'governance'] };
}

// ── Dateiauswahl ──────────────────────────────────────────────────────────

describe('collectDocFiles', () => {
  test('nimmt die benannten Dateien und alle *.md der Verzeichnisse', () => {
    const root = tempDir();
    schreibe(root, 'CLAUDE.md', 'a');
    schreibe(root, 'README.md', 'b');
    schreibe(root, 'docs/ARCHITECTURE.md', 'c');
    schreibe(root, 'docs/INFRA.md', 'd');
    schreibe(root, 'governance/AUDIT-CHECKLIST.md', 'e');

    // Reihenfolge = Deklarationsreihenfolge: erst die benannten Dateien, dann
    // Verzeichnis fuer Verzeichnis alphabetisch.
    expect(collectDocFiles(repoAuf(root)).map((f) => f.relPath)).toEqual([
      'CLAUDE.md', 'README.md',
      'docs/ARCHITECTURE.md', 'docs/INFRA.md',
      'governance/AUDIT-CHECKLIST.md',
    ]);
  });

  test('fehlende Dateien und Verzeichnisse sind kein Fehler', () => {
    const root = tempDir();
    schreibe(root, 'CLAUDE.md', 'a');
    expect(collectDocFiles(repoAuf(root)).map((f) => f.relPath)).toEqual(['CLAUDE.md']);
  });

  test('nur .md — keine env-, json-, ts- oder Punktdateien', () => {
    const root = tempDir();
    schreibe(root, 'CLAUDE.md', 'a');
    schreibe(root, 'docs/.env', 'SECRET=1');
    schreibe(root, 'docs/settings.json', '{}');
    schreibe(root, 'docs/notes.txt', 'x');
    schreibe(root, 'docs/script.ts', 'x');
    schreibe(root, 'docs/.hidden.md', 'x');
    schreibe(root, 'docs/ECHT.md', 'ok');
    expect(collectDocFiles(repoAuf(root)).map((f) => f.relPath)).toEqual(['CLAUDE.md', 'docs/ECHT.md']);
  });

  test('nicht rekursiv — Unterordner von docs/ bleiben draussen', () => {
    const root = tempDir();
    schreibe(root, 'docs/ARCHITECTURE.md', 'a');
    schreibe(root, 'docs/workpackages/2026-10-08-x.md', 'b');
    expect(collectDocFiles(repoAuf(root)).map((f) => f.relPath)).toEqual(['docs/ARCHITECTURE.md']);
  });

  test('Laufzeitverzeichnisse stehen nicht im Umfang', () => {
    const root = tempDir();
    schreibe(root, 'CLAUDE.md', 'a');
    schreibe(root, 'memory/2026-10-08.md', 'privat');
    schreibe(root, 'DREAMS.md', 'privat');
    expect(collectDocFiles(repoAuf(root)).map((f) => f.relPath)).toEqual(['CLAUDE.md']);
  });

  test('dropboxTargetPath haengt Repo-Schluessel und Unterpfad an', () => {
    expect(dropboxTargetPath('executive-agent', 'docs/INFRA.md'))
      .toBe(`${DROPBOX_DOCS_BASE}/executive-agent/docs/INFRA.md`);
    expect(DROPBOX_DOCS_BASE).toBe('/bikosoc-reports/docs/repo');
  });

  test('defaultDocsMirrorRepos deckt genau die drei Repos ab', () => {
    const repos = defaultDocsMirrorRepos('/ws');
    expect(repos.map((r) => r.key)).toEqual(['executive-agent', 'executive-dashboard', 'workspace']);
    expect(repos[0].root).toBe('/ws/.openclaw/extensions/executive-agent');
    expect(repos[2].root).toBe('/ws');
    // Das Elternrepo bekommt bewusst keine Verzeichnisse mitgegeben.
    expect(repos[2].dirs).toEqual([]);
  });
});

// ── Schutzschranken ───────────────────────────────────────────────────────

describe('Schutzschranken', () => {
  test('sensitive-Markierung wird erkannt', () => {
    expect(istSensitivMarkiert('# Report\n\n**Datenklassifizierung:** sensitive\n')).toBe(true);
    expect(istSensitivMarkiert('Datenklassifizierung: sensitive — Bankdaten')).toBe(true);
    expect(istSensitivMarkiert('# Report\n\n**Datenklassifizierung:** internal\n')).toBe(false);
    expect(istSensitivMarkiert('Hier steht das Wort sensitive mitten im Text.')).toBe(false);
  });

  test('Secret-Muster werden erkannt', () => {
    expect(findeSecretMuster('key: sk-abcdefghijklmnopqrstuvwxyz0123')).toBe('openai/anthropic-key');
    expect(findeSecretMuster('token ghp_abcdefghijklmnopqrstuvwxyz01')).toBe('github-token');
    expect(findeSecretMuster('xoxb-1234567890-abcdefghij')).toBe('slack-token');
    expect(findeSecretMuster('855123456:AAEabcdefghijklmnopqrstuvwxyz0123456')).toBe('telegram-bot-token');
    expect(findeSecretMuster('-----BEGIN RSA PRIVATE KEY-----')).toBe('private-key');
    expect(findeSecretMuster('AKIAIOSFODNN7EXAMPLE')).toBe('aws-access-key');
  });

  test('Platzhalter in der Doku sind KEIN Treffer', () => {
    // Genau diese Schreibweisen stehen in CLAUDE.md und docs/INFRA.md.
    expect(findeSecretMuster('Dashboard: https://app.example.de/dashboard/?token=<DASHBOARD_TOKEN>')).toBeNull();
    expect(findeSecretMuster('MANUS_API_KEY=CHANGEME')).toBeNull();
    expect(findeSecretMuster('Secrets: ~/.config/openclaw/env')).toBeNull();
    expect(findeSecretMuster('Header x-manus-api-key: <api-key>')).toBeNull();
    expect(findeSecretMuster('sk-kurz')).toBeNull();
  });

  test('markierte und verdaechtige Dateien werden nicht hochgeladen', async () => {
    const root = tempDir();
    const indexPath = path.join(tempDir(), 'index.json');
    schreibe(root, 'CLAUDE.md', '# ok\n');
    schreibe(root, 'docs/GEHEIM.md', '# x\n\n**Datenklassifizierung:** sensitive\n');
    schreibe(root, 'docs/LECK.md', 'versehentlich: sk-abcdefghijklmnopqrstuvwxyz0123\n');

    const { adapter, uploads } = fakeAdapter();
    const warnungen: string[] = [];
    const res = await mirrorDocsOnce({
      adapter, repos: [repoAuf(root)], indexPath,
      logger: { info: () => {}, warn: (m) => warnungen.push(m) },
    });

    expect(uploads.map((u) => u.path)).toEqual([`${DROPBOX_DOCS_BASE}/testrepo/CLAUDE.md`]);
    expect(res.skipped.map((s) => [s.relPath, s.grund])).toEqual([
      ['docs/GEHEIM.md', 'sensitive'],
      ['docs/LECK.md', 'secret_muster'],
    ]);
    // Beides wird sichtbar protokolliert, nicht still verschluckt.
    expect(warnungen.length).toBe(2);
    expect(warnungen.some((w) => w.includes('sensitive'))).toBe(true);
    expect(warnungen.some((w) => w.includes('openai/anthropic-key'))).toBe(true);
  });
});

// ── Hash-Vergleich und Index ──────────────────────────────────────────────

describe('mirrorDocsOnce', () => {
  test('Erstlauf laedt alles hoch und schreibt den Index', async () => {
    const root = tempDir();
    const indexPath = path.join(tempDir(), 'index.json');
    schreibe(root, 'CLAUDE.md', 'erste Fassung\n');
    schreibe(root, 'docs/INFRA.md', 'infra\n');

    const { adapter, uploads } = fakeAdapter();
    const res = await mirrorDocsOnce({
      adapter, repos: [repoAuf(root)], indexPath,
      now: () => new Date('2026-10-08T12:00:00Z'),
    });

    expect(res.uploaded.map((u) => u.relPath)).toEqual(['CLAUDE.md', 'docs/INFRA.md']);
    expect(res.unchanged).toEqual([]);
    expect(uploads[0].contentType).toBe('text/markdown; charset=utf-8');
    expect(uploads[0].body).toBe('erste Fassung\n');

    const index = readIndex(indexPath);
    const key = `${DROPBOX_DOCS_BASE}/testrepo/CLAUDE.md`;
    expect(index[key].sha256).toBe(sha256Hex(Buffer.from('erste Fassung\n')));
    expect(index[key].bytes).toBe(14);
    expect(index[key].uploadedAt).toBe('2026-10-08T12:00:00.000Z');
  });

  test('zweiter Lauf ohne Aenderung laedt nichts hoch', async () => {
    const root = tempDir();
    const indexPath = path.join(tempDir(), 'index.json');
    schreibe(root, 'CLAUDE.md', 'unveraendert\n');

    const erster = fakeAdapter();
    await mirrorDocsOnce({ adapter: erster.adapter, repos: [repoAuf(root)], indexPath });
    expect(erster.uploads.length).toBe(1);

    const zweiter = fakeAdapter();
    const res = await mirrorDocsOnce({ adapter: zweiter.adapter, repos: [repoAuf(root)], indexPath });
    expect(zweiter.uploads).toEqual([]);
    expect(res.uploaded).toEqual([]);
    expect(res.unchanged.map((u) => u.relPath)).toEqual(['CLAUDE.md']);
  });

  test('geaenderter Inhalt zieht nach', async () => {
    const root = tempDir();
    const indexPath = path.join(tempDir(), 'index.json');
    schreibe(root, 'CLAUDE.md', 'alt\n');
    await mirrorDocsOnce({ adapter: fakeAdapter().adapter, repos: [repoAuf(root)], indexPath });

    schreibe(root, 'CLAUDE.md', 'neu\n');
    const { adapter, uploads } = fakeAdapter();
    const res = await mirrorDocsOnce({ adapter, repos: [repoAuf(root)], indexPath });

    expect(res.uploaded.map((u) => u.relPath)).toEqual(['CLAUDE.md']);
    expect(uploads[0].body).toBe('neu\n');
    expect(readIndex(indexPath)[`${DROPBOX_DOCS_BASE}/testrepo/CLAUDE.md`].sha256)
      .toBe(sha256Hex(Buffer.from('neu\n')));
  });

  test('eine neue Datei kommt dazu, der Rest bleibt unangetastet', async () => {
    const root = tempDir();
    const indexPath = path.join(tempDir(), 'index.json');
    schreibe(root, 'CLAUDE.md', 'a\n');
    await mirrorDocsOnce({ adapter: fakeAdapter().adapter, repos: [repoAuf(root)], indexPath });

    schreibe(root, 'docs/NEU.md', 'b\n');
    const { adapter, uploads } = fakeAdapter();
    const res = await mirrorDocsOnce({ adapter, repos: [repoAuf(root)], indexPath });
    expect(uploads.map((u) => u.path)).toEqual([`${DROPBOX_DOCS_BASE}/testrepo/docs/NEU.md`]);
    expect(res.unchanged.map((u) => u.relPath)).toEqual(['CLAUDE.md']);
  });

  test('entfernte Quelldateien verlassen den Index, Dropbox wird nicht angefasst', async () => {
    const root = tempDir();
    const indexPath = path.join(tempDir(), 'index.json');
    schreibe(root, 'CLAUDE.md', 'a\n');
    schreibe(root, 'docs/WEG.md', 'b\n');
    await mirrorDocsOnce({ adapter: fakeAdapter().adapter, repos: [repoAuf(root)], indexPath });

    fs.rmSync(path.join(root, 'docs/WEG.md'));
    const { adapter, uploads } = fakeAdapter();
    const res = await mirrorDocsOnce({ adapter, repos: [repoAuf(root)], indexPath });

    expect(res.pruned).toEqual([`${DROPBOX_DOCS_BASE}/testrepo/docs/WEG.md`]);
    expect(Object.keys(readIndex(indexPath))).toEqual([`${DROPBOX_DOCS_BASE}/testrepo/CLAUDE.md`]);
    expect(uploads).toEqual([]);
  });

  test('ein fehlgeschlagener Upload stoppt den Lauf nicht und merkt sich nichts', async () => {
    const root = tempDir();
    const indexPath = path.join(tempDir(), 'index.json');
    schreibe(root, 'CLAUDE.md', 'a\n');
    schreibe(root, 'docs/KAPUTT.md', 'b\n');
    schreibe(root, 'docs/OK.md', 'c\n');

    const ziel = `${DROPBOX_DOCS_BASE}/testrepo/docs/KAPUTT.md`;
    const { adapter, uploads } = fakeAdapter({ fehlerFuer: [ziel] });
    const res = await mirrorDocsOnce({ adapter, repos: [repoAuf(root)], indexPath });

    expect(res.errors.map((e) => e.relPath)).toEqual(['docs/KAPUTT.md']);
    expect(res.uploaded.map((u) => u.relPath)).toEqual(['CLAUDE.md', 'docs/OK.md']);
    expect(uploads.length).toBe(2);
    // Kein Index-Eintrag fuer die gescheiterte Datei → naechster Lauf probiert erneut.
    expect(readIndex(indexPath)[ziel]).toBeUndefined();
  });

  test('Trockenlauf laedt nichts hoch und schreibt keinen Index', async () => {
    const root = tempDir();
    const indexPath = path.join(tempDir(), 'index.json');
    schreibe(root, 'CLAUDE.md', 'a\n');
    const { adapter, uploads } = fakeAdapter();
    const res = await mirrorDocsOnce({ adapter, repos: [repoAuf(root)], indexPath, dryRun: true });
    expect(res.uploaded.map((u) => u.relPath)).toEqual(['CLAUDE.md']);
    expect(uploads).toEqual([]);
    expect(fs.existsSync(indexPath)).toBe(false);
  });

  test('ein defekter Index wird als leer behandelt', () => {
    const p = path.join(tempDir(), 'index.json');
    fs.writeFileSync(p, 'kein json');
    expect(readIndex(p)).toEqual({});
    fs.writeFileSync(p, '[1,2,3]');
    expect(readIndex(p)).toEqual({});
  });

  test('writeIndex schreibt mit Modus 0600 und ohne Temp-Rest', () => {
    const dir = tempDir();
    const p = path.join(dir, 'sub', 'index.json');
    writeIndex(p, { '/a': { sha256: 'x', bytes: 1, uploadedAt: 'y' } });
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(readIndex(p)['/a'].sha256).toBe('x');
    expect(fs.readdirSync(path.dirname(p)).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  test('formatDocsMirrorSummary nennt alle Zahlen', () => {
    const s = formatDocsMirrorSummary({
      uploaded: [{ repoKey: 'r', relPath: 'a', dropboxPath: '/a', bytes: 1 }],
      unchanged: [{ repoKey: 'r', relPath: 'b' }, { repoKey: 'r', relPath: 'c' }],
      skipped: [], errors: [], pruned: ['/x'],
    });
    expect(s).toBe('1 hochgeladen, 2 unveraendert, 0 uebersprungen, 0 Fehler, 1 Index-Eintraege entfernt');
  });
});

// ── Der tatsaechliche Bestand (nur lesend) ────────────────────────────────

describe('echter Repo-Bestand', () => {
  test('die Auswahl der drei Repos ist reproduzierbar und enthaelt nur .md', () => {
    const ws = path.join(process.env.HOME || '/home/biko', '.openclaw/workspace');
    if (!fs.existsSync(ws)) return; // auf fremden Maschinen nichts zu pruefen

    for (const repo of defaultDocsMirrorRepos(ws)) {
      for (const f of collectDocFiles(repo)) {
        expect(f.relPath.endsWith('.md')).toBe(true);
        expect(f.relPath.includes('..')).toBe(false);
        expect(fs.statSync(f.absPath).isFile()).toBe(true);
      }
    }

    // executive-agent fuehrt CLAUDE.md und docs/ARCHITECTURE.md — beide muessen
    // in der Auswahl landen, sonst stimmt der Umfang nicht mehr.
    const ea = defaultDocsMirrorRepos(ws)[0];
    if (fs.existsSync(ea.root)) {
      const rel = collectDocFiles(ea).map((f) => f.relPath);
      expect(rel).toContain('CLAUDE.md');
      expect(rel).toContain('docs/ARCHITECTURE.md');
      expect(rel.some((r) => r.startsWith('docs/workpackages/'))).toBe(false);
    }
  });
});
