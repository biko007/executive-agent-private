import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendPromptToBikosocTmux, type TmuxRunner } from '../modules/cc-prompt-dispatch/index.js';

/**
 * /arm push — armt die Rote Zone (one-shot) UND dispatcht "push" + Enter in die
 * tmux-Session bikosoc, ueber denselben Helfer wie /do.
 *
 * "/arm" ohne Argument bleibt unveraendert. Ein unbekanntes Argument armt NICHT
 * (fail-closed) — ein Tippfehler darf die Rote Zone nicht unbemerkt scharfstellen.
 *
 * Der Handler liegt inline in index.ts und ist nicht importierbar; die Spiegelung unten
 * folgt der Konvention aus callback-suppression.test.ts. Die statischen Guards am Ende
 * halten die Spiegelung an die echte Quelle gebunden.
 */

interface Sent { role: string; text: string }
interface Dispatched { text: string }

interface Deps {
  flagPath: string;
  isOwner: boolean;
  telegram: Sent[];
  dispatched: Dispatched[];
  logs: string[];
  dispatchThrows?: string;
  order: string[];
}

// ── Spiegel des /arm-Handlers aus index.ts ─────────────────────────────────
async function armHandler(args: string | undefined, d: Deps): Promise<{ text: string }> {
  if (!d.isOwner) {
    return { text: 'Dieser Befehl ist nur fuer den Owner verfuegbar.' };
  }

  const mode = String(args || '').trim().toLowerCase();
  if (mode !== '' && mode !== 'push') {
    return { text: 'Nutzung: /arm  oder  /arm push' };
  }

  try {
    fs.writeFileSync(d.flagPath, `armed by owner at ${new Date().toISOString()}\n`);
    d.order.push('armed');

    if (mode !== 'push') {
      d.telegram.push({ role: 'operativ', text: 'Rote Zone SCHARFGESTELLT — naechste rote Aktion wird durchgelassen (one-shot).' });
      d.logs.push('[arm] Red Zone armed (one-shot)');
      return { text: 'Red Zone scharfgestellt (one-shot).' };
    }

    try {
      if (d.dispatchThrows) throw new Error(d.dispatchThrows);
      d.dispatched.push({ text: 'push' });
      d.order.push('dispatched');
    } catch (e: any) {
      d.logs.push(`[arm] push-Dispatch fehlgeschlagen: ${e.message}`);
      d.telegram.push({ role: 'operativ', text: `Armed — push-Dispatch fehlgeschlagen: ${e.message}` });
      return { text: `Armed — push-Dispatch fehlgeschlagen: ${e.message}` };
    }

    d.telegram.push({ role: 'operativ', text: 'Armed + push dispatched.' });
    d.logs.push('[arm] Red Zone armed (one-shot) + push an tmux bikosoc uebergeben');
    return { text: 'Armed + push dispatched.' };
  } catch (e: any) {
    d.logs.push(`[arm] Fehler: ${e.message}`);
    return { text: `arm Fehler: ${e.message}` };
  }
}

function makeDeps(dir: string, over: Partial<Deps> = {}): Deps {
  return {
    flagPath: path.join(dir, '.armed-bikosoc'),
    isOwner: true,
    telegram: [],
    dispatched: [],
    logs: [],
    order: [],
    ...over,
  };
}

describe('/arm ohne Argument — unveraendert', () => {
  test('armt, meldet wie bisher und dispatcht NICHT', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-push-'));
    const d = makeDeps(dir);

    const res = await armHandler(undefined, d);

    expect(res.text).toBe('Red Zone scharfgestellt (one-shot).');
    expect(fs.existsSync(d.flagPath)).toBe(true);
    expect(fs.readFileSync(d.flagPath, 'utf-8')).toContain('armed by owner at ');
    expect(d.dispatched).toEqual([]);
    expect(d.telegram).toEqual([
      { role: 'operativ', text: 'Rote Zone SCHARFGESTELLT — naechste rote Aktion wird durchgelassen (one-shot).' },
    ]);
    expect(d.logs).toEqual(['[arm] Red Zone armed (one-shot)']);
  });

  test('leerer String und Whitespace zaehlen als "ohne Argument"', async () => {
    for (const args of ['', '   ', '\t']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-push-'));
      const d = makeDeps(dir);
      const res = await armHandler(args, d);
      expect(res.text, JSON.stringify(args)).toBe('Red Zone scharfgestellt (one-shot).');
      expect(d.dispatched, JSON.stringify(args)).toEqual([]);
    }
  });
});

describe('/arm push — armt und dispatcht', () => {
  test('armt, dispatcht "push" und quittiert "Armed + push dispatched."', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-push-'));
    const d = makeDeps(dir);

    const res = await armHandler('push', d);

    expect(res.text).toBe('Armed + push dispatched.');
    expect(fs.existsSync(d.flagPath)).toBe(true);
    expect(d.dispatched).toEqual([{ text: 'push' }]);
    expect(d.telegram).toEqual([{ role: 'operativ', text: 'Armed + push dispatched.' }]);
  });

  test('Reihenfolge: erst armen, dann dispatchen', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-push-'));
    const d = makeDeps(dir);
    await armHandler('push', d);
    expect(d.order).toEqual(['armed', 'dispatched']);
  });

  test('Argument wird normalisiert (Whitespace, Grossschreibung)', async () => {
    for (const args of ['push', ' push ', 'PUSH', ' Push\t']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-push-'));
      const d = makeDeps(dir);
      const res = await armHandler(args, d);
      expect(res.text, JSON.stringify(args)).toBe('Armed + push dispatched.');
      expect(d.dispatched, JSON.stringify(args)).toEqual([{ text: 'push' }]);
    }
  });

  test('scheitert der Dispatch, bleibt das Flag gesetzt und die Quittung sagt die Wahrheit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-push-'));
    const d = makeDeps(dir, { dispatchThrows: 'no server running on /tmp/tmux-1000/default' });

    const res = await armHandler('push', d);

    expect(fs.existsSync(d.flagPath)).toBe(true);           // one-shot bleibt scharf
    expect(d.dispatched).toEqual([]);
    expect(res.text).toContain('push-Dispatch fehlgeschlagen');
    expect(res.text).not.toContain('Armed + push dispatched.');
    expect(d.telegram[0].text).toContain('push-Dispatch fehlgeschlagen');
    expect(d.logs.some(l => l.includes('[arm] push-Dispatch fehlgeschlagen'))).toBe(true);
  });
});

describe('/arm <unbekannt> — fail-closed', () => {
  test('armt NICHT und dispatcht NICHT', async () => {
    for (const args of ['pusch', 'push now', 'force', '--push', 'push;rm']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-push-'));
      const d = makeDeps(dir);
      const res = await armHandler(args, d);
      expect(res.text, args).toBe('Nutzung: /arm  oder  /arm push');
      expect(fs.existsSync(d.flagPath), args).toBe(false);
      expect(d.dispatched, args).toEqual([]);
      expect(d.telegram, args).toEqual([]);
    }
  });
});

describe('Owner-Gate gilt fuer beide Pfade', () => {
  test('Nicht-Owner armt nicht, dispatcht nicht, sendet nichts', async () => {
    for (const args of [undefined, 'push']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-push-'));
      const d = makeDeps(dir, { isOwner: false });
      const res = await armHandler(args, d);
      expect(res.text, String(args)).toBe('Dieser Befehl ist nur fuer den Owner verfuegbar.');
      expect(fs.existsSync(d.flagPath), String(args)).toBe(false);
      expect(d.dispatched, String(args)).toEqual([]);
      expect(d.telegram, String(args)).toEqual([]);
    }
  });
});

describe('Dispatch geht ueber den echten /do-Helfer', () => {
  test('sendPromptToBikosocTmux("push") ergibt exakt die tmux-argv, ohne Shell', () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const runner: TmuxRunner = (file, args) => { calls.push({ file, args }); };

    sendPromptToBikosocTmux('push', { runner });

    expect(calls).toEqual([
      { file: 'tmux', args: ['send-keys', '-t', 'bikosoc', '--', 'push', 'Enter'] },
    ]);
  });
});

describe('statische Guards gegen index.ts (Drift-Schutz fuer die Spiegelung oben)', () => {
  const ROOT = path.resolve(import.meta.dir, '../..');
  const source = fs.readFileSync(path.join(ROOT, 'index.ts'), 'utf-8');
  const armBlock = source.slice(source.indexOf("    name: 'arm',"), source.indexOf("  // ── Message Sink"));

  test('/arm nimmt Argumente und dokumentiert die push-Variante', () => {
    expect(armBlock).toContain('acceptsArgs: true');
    expect(armBlock).toContain("/arm [push]");
  });

  test('Owner-Gate steht vor jeder Wirkung', () => {
    expect(armBlock.indexOf('assertBoundOwner')).toBeLessThan(armBlock.indexOf('writeFileSync'));
  });

  test('unbekanntes Argument ist fail-closed (vor dem Armen)', () => {
    expect(armBlock).toContain("if (mode !== '' && mode !== 'push') {");
    expect(armBlock).toContain("return { text: 'Nutzung: /arm  oder  /arm push' };");
    expect(armBlock.indexOf("mode !== 'push'")).toBeLessThan(armBlock.indexOf('writeFileSync'));
  });

  test('push-Pfad nutzt den /do-Dispatch-Helfer und quittiert wie spezifiziert', () => {
    expect(armBlock).toContain("sendPromptToBikosocTmux('push');");
    expect(armBlock).toContain("'Armed + push dispatched.'");
    // Armen vor Dispatch
    expect(armBlock.indexOf('writeFileSync')).toBeLessThan(armBlock.indexOf("sendPromptToBikosocTmux('push')"));
  });

  test('der Pfad ohne Argument ist unveraendert', () => {
    expect(armBlock).toContain('Rote Zone SCHARFGESTELLT — naechste rote Aktion wird durchgelassen (one-shot).');
    expect(armBlock).toContain("return { text: 'Red Zone scharfgestellt (one-shot).' };");
  });

  test('der Dispatch-Helfer wird nicht neu implementiert, sondern importiert', () => {
    expect(source).toContain("import { sendPromptToBikosocTmux } from './src/modules/cc-prompt-dispatch/index.js';");
  });
});
