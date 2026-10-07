import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  processDropboxInboxOnce, sanitizeInboxName, berlinStamp,
  DROPBOX_INBOX_DIR, DROPBOX_INBOX_DONE_DIR,
} from '../index.js';
import type { DropboxAdapter, DropboxEntry } from '../../../adapters/dropbox.js';

/** Dropbox-Doppel: haelt Dateien im Speicher, protokolliert Aufrufe. */
function fakeDropbox(dateien: Record<string, string>, opts?: { moveFails?: boolean }) {
  const store = { ...dateien };
  const moves: { from: string; to: string }[] = [];
  const folders: string[] = [];
  const downloads: string[] = [];

  const adapter: DropboxAdapter = {
    async uploadFile() { throw new Error('nicht verwendet'); },
    async uploadFileStream() { throw new Error('nicht verwendet'); },
    async createFolder(p: string) { folders.push(p); },
    async listFolder(p: string): Promise<DropboxEntry[]> {
      if (p !== DROPBOX_INBOX_DIR) return [];
      return Object.keys(store).map((name) => ({
        tag: 'file' as const,
        pathLower: `${DROPBOX_INBOX_DIR}/${name}`.toLowerCase(),
        pathDisplay: `${DROPBOX_INBOX_DIR}/${name}`,
        name,
        size: store[name].length,
      }));
    },
    async downloadFile(p: string) {
      downloads.push(p);
      const name = Object.keys(store).find(
        (n) => `${DROPBOX_INBOX_DIR}/${n}`.toLowerCase() === p,
      );
      if (name === undefined) throw new Error('not_found');
      return Buffer.from(store[name], 'utf-8');
    },
    async moveFile(from: string, to: string) {
      if (opts?.moveFails) throw new Error('Dropbox API error 409');
      moves.push({ from, to });
      const name = Object.keys(store).find(
        (n) => `${DROPBOX_INBOX_DIR}/${n}`.toLowerCase() === from,
      );
      if (name !== undefined) delete store[name];
    },
    async healthCheck() { return true; },
  };

  return { adapter, moves, folders, downloads, store };
}

let tmpHome = '';
let inboxDir = '';

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dbinbox-'));
  inboxDir = path.join(tmpHome, 'inbox');
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('sanitizeInboxName', () => {
  test('entfernt Pfadanteile und ungueltige Zeichen', () => {
    expect(sanitizeInboxName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeInboxName('a b;shutdown now.txt')).toBe('a_b_shutdown_now.txt');
    expect(sanitizeInboxName('ok-name_1.txt')).toBe('ok-name_1.txt');
  });

  test('leerer Name faellt auf prompt.txt zurueck', () => {
    expect(sanitizeInboxName('/')).toBe('prompt.txt');
  });
});

describe('berlinStamp', () => {
  test('liefert YYYYMMDD-HHMMSS in Berliner Zeit', () => {
    // 2026-10-07T08:30:00Z = 10:30 Berliner Sommerzeit
    expect(berlinStamp(new Date('2026-10-07T08:30:00Z'))).toBe('20261007-103000');
  });
});

describe('processDropboxInboxOnce', () => {
  test('holt eine .txt ab, legt sie in ~/inbox und verschiebt sie nach done', async () => {
    const d = fakeDropbox({ 'auftrag.txt': 'echo inbox-test' });

    const res = await processDropboxInboxOnce({
      adapter: d.adapter, homeDir: tmpHome,
      now: new Date('2026-10-07T08:30:00Z'),
    });

    expect(res.length).toBe(1);
    expect(fs.readFileSync(res[0].localPath, 'utf-8')).toBe('echo inbox-test');
    expect(path.basename(res[0].localPath)).toBe('dropbox-20261007-103000-auftrag.txt');
    expect(d.moves).toEqual([{
      from: `${DROPBOX_INBOX_DIR}/auftrag.txt`.toLowerCase(),
      to: `${DROPBOX_INBOX_DONE_DIR}/20261007-103000-auftrag.txt`,
    }]);
  });

  test('die lokale Datei endet auf .txt — nur die findet der Prompt-Watcher', async () => {
    const d = fakeDropbox({ 'auftrag.txt': 'x' });
    const res = await processDropboxInboxOnce({ adapter: d.adapter, homeDir: tmpHome });
    expect(res[0].localPath.endsWith('.txt')).toBe(true);
    expect(path.basename(res[0].localPath).startsWith('.')).toBe(false);
  });

  test('zweiter Durchlauf holt nichts erneut — Datei ist in Dropbox verschoben', async () => {
    const d = fakeDropbox({ 'auftrag.txt': 'x' });
    await processDropboxInboxOnce({ adapter: d.adapter, homeDir: tmpHome });
    const zweiter = await processDropboxInboxOnce({ adapter: d.adapter, homeDir: tmpHome });
    expect(zweiter.length).toBe(0);
    expect(d.moves.length).toBe(1);
  });

  test('ignoriert alles, was nicht .txt ist', async () => {
    const d = fakeDropbox({ 'bild.png': 'x', 'notiz.md': 'y' });
    const res = await processDropboxInboxOnce({ adapter: d.adapter, homeDir: tmpHome });
    expect(res.length).toBe(0);
    expect(d.downloads.length).toBe(0);
  });

  test('scheitert das Verschieben, bleibt NICHTS in ~/inbox liegen', async () => {
    const d = fakeDropbox({ 'auftrag.txt': 'x' }, { moveFails: true });
    const res = await processDropboxInboxOnce({ adapter: d.adapter, homeDir: tmpHome });
    expect(res.length).toBe(0);
    expect(fs.readdirSync(inboxDir)).toEqual([]);
  });

  test('legt done/ nur an, wenn es etwas abzuholen gibt', async () => {
    const leer = fakeDropbox({});
    await processDropboxInboxOnce({ adapter: leer.adapter, homeDir: tmpHome });
    expect(leer.folders.length).toBe(0);

    const voll = fakeDropbox({ 'a.txt': 'x' });
    await processDropboxInboxOnce({ adapter: voll.adapter, homeDir: tmpHome });
    expect(voll.folders).toEqual([DROPBOX_INBOX_DONE_DIR]);
  });

  test('liegengebliebene Teildatei wird beim naechsten Lauf entfernt', async () => {
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(inboxDir, '.dropbox-alt.part'), 'reste');
    const d = fakeDropbox({});
    await processDropboxInboxOnce({ adapter: d.adapter, homeDir: tmpHome });
    expect(fs.existsSync(path.join(inboxDir, '.dropbox-alt.part'))).toBe(false);
  });
});
