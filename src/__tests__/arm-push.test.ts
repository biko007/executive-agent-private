import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendPromptToBikosocTmux, type TmuxRunner } from '../modules/cc-prompt-dispatch/index.js';
import { targetsWithoutOrigin } from '../shared/utils/index.js';

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

interface Sent { role: string; text: string; chatId: string }
interface Dispatched { text: string }

interface Deps {
  flagPath: string;
  isOwner: boolean;
  telegram: Sent[];
  dispatched: Dispatched[];
  logs: string[];
  dispatchThrows?: string;
  order: string[];
  /** Chat, aus dem der Befehl kam. */
  originChatId: string;
  /** Aktive Ziele der Rolle "operativ". */
  operativTargets: string[];
}

/**
 * Spiegel von notifyRoleUnlessOrigin aus index.ts: meldet an die Rolle, aber
 * nicht in den Chat, aus dem der Befehl kam. Grund (Befund 2026-10-10): das
 * Framework stellt den Rueckgabetext in den Ursprungschat zu — eine
 * Eigensendung an dieselbe Stelle ergab eine zweite, bei /arm push wortgleiche
 * Nachricht.
 */
function notifyRoleUnlessOrigin(d: Deps, role: string, text: string): void {
  const rest = targetsWithoutOrigin(d.operativTargets, d.originChatId);
  for (const chatId of rest) d.telegram.push({ role, text, chatId });
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
      notifyRoleUnlessOrigin(d, 'operativ', 'Rote Zone SCHARFGESTELLT — naechste rote Aktion wird durchgelassen (one-shot).');
      d.logs.push('[arm] Red Zone armed (one-shot)');
      return { text: 'Rote Zone SCHARFGESTELLT — naechste rote Aktion wird durchgelassen (one-shot).' };
    }

    try {
      if (d.dispatchThrows) throw new Error(d.dispatchThrows);
      d.dispatched.push({ text: 'push' });
      d.order.push('dispatched');
    } catch (e: any) {
      d.logs.push(`[arm] push-Dispatch fehlgeschlagen: ${e.message}`);
      notifyRoleUnlessOrigin(d, 'operativ', `Armed — push-Dispatch fehlgeschlagen: ${e.message}`);
      return { text: `Armed — push-Dispatch fehlgeschlagen: ${e.message}` };
    }

    notifyRoleUnlessOrigin(d, 'operativ', 'Armed + push dispatched.');
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
    // Standardfall und Live-Lage: der Owner schickt den Befehl in seiner DM,
    // und die DM IST der operative Chat.
    originChatId: 'owner-dm',
    operativTargets: ['owner-dm'],
    ...over,
  };
}

describe('/arm ohne Argument — unveraendert', () => {
  test('armt, meldet wie bisher und dispatcht NICHT', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-push-'));
    const d = makeDeps(dir);

    const res = await armHandler(undefined, d);

    expect(res.text).toBe('Rote Zone SCHARFGESTELLT — naechste rote Aktion wird durchgelassen (one-shot).');
    expect(fs.existsSync(d.flagPath)).toBe(true);
    expect(fs.readFileSync(d.flagPath, 'utf-8')).toContain('armed by owner at ');
    expect(d.dispatched).toEqual([]);
    // Befehl kam aus dem operativen Chat -> keine Eigensendung, nur der
    // Rueckgabetext. Genau EINE Nachricht beim Owner.
    expect(d.telegram).toEqual([]);
    expect(d.logs).toEqual(['[arm] Red Zone armed (one-shot)']);
  });

  test('leerer String und Whitespace zaehlen als "ohne Argument"', async () => {
    for (const args of ['', '   ', '\t']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-push-'));
      const d = makeDeps(dir);
      const res = await armHandler(args, d);
      expect(res.text, JSON.stringify(args)).toBe('Rote Zone SCHARFGESTELLT — naechste rote Aktion wird durchgelassen (one-shot).');
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
    // GENAU EINE Antwort: der Befehl kam aus dem operativen Chat, also
    // entfaellt die Eigensendung. Vorher standen hier zwei wortgleiche
    // Nachrichten — der Owner-Befund vom 2026-10-10.
    expect(d.telegram).toEqual([]);
  });

  test('aus einem anderen Chat: Rolle wird informiert, Ursprungschat bekommt die Quittung', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-push-'));
    const d = makeDeps(dir, { originChatId: 'dev-gruppe' });

    const res = await armHandler('push', d);

    expect(res.text).toBe('Armed + push dispatched.');
    // Eine Meldung in den operativen Chat, die Quittung in die dev-Gruppe —
    // je Chat genau eine Nachricht.
    expect(d.telegram).toEqual([{ role: 'operativ', text: 'Armed + push dispatched.', chatId: 'owner-dm' }]);
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
    // Aus dem operativen Chat: keine Eigensendung, die Quittung traegt den Grund.
    expect(d.telegram).toEqual([]);
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

    sendPromptToBikosocTmux('push', { runner, enterDelayMs: 0 });

    // Zwei Aufrufe: Text, dann Enter (Fix 2026-10-03, siehe
    // cc-prompt-dispatch/index.ts). Ohne den Zweischritt landet "push" nur im
    // Eingabefeld und wird nicht abgeschickt.
    expect(calls).toEqual([
      { file: 'tmux', args: ['send-keys', '-t', 'bikosoc', '--', 'push'] },
      { file: 'tmux', args: ['send-keys', '-t', 'bikosoc', 'Enter'] },
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

  test('der Pfad ohne Argument armt und meldet', () => {
    expect(armBlock).toContain('Rote Zone SCHARFGESTELLT — naechste rote Aktion wird durchgelassen (one-shot).');
    expect(armBlock).toContain("return { text: 'Rote Zone SCHARFGESTELLT — naechste rote Aktion wird durchgelassen (one-shot).' };");
  });

  test('alle drei Zweige melden ueber notifyRoleUnlessOrigin — keine doppelte Quittung', () => {
    // Befund 2026-10-10: sendTelegramToRole ignorierte den Ursprungschat, der
    // Owner sah "Armed + push dispatched." zweimal. Dieser Guard haelt den Fix
    // fest: kein Zweig darf wieder direkt an die Rolle senden.
    const treffer = armBlock.match(/notifyRoleUnlessOrigin\(/g) ?? [];
    expect(treffer.length).toBe(3);
    expect(armBlock).not.toContain("sendTelegramToRole('operativ'");
    expect(armBlock).toContain('guard.chatId');
  });

  test('der Dispatch-Helfer wird nicht neu implementiert, sondern importiert', () => {
    expect(source).toContain("import { sendPromptToBikosocTmux } from './src/modules/cc-prompt-dispatch/index.js';");
  });
});
