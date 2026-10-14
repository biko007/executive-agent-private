import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendPromptToBikosocTmux, type TmuxRunner } from '../modules/cc-prompt-dispatch/index.js';
import {
  freigabeGesetztText, uebertragungGestartetText, startFehlgeschlagenText, NUTZUNG_TEXT,
  ablaufZeitpunkt, knopfMarkup,
} from '../modules/arm-freigabe/index.js';

/**
 * /arm — Freigabe der Roten Zone.
 *
 *   /arm        setzt die Freigabe und sonst nichts.
 *   /arm push   setzt sie UND stoesst die wartende Uebertragung an.
 *
 * Ein unbekanntes Argument setzt NICHTS (fail-closed) — ein Tippfehler darf die
 * Rote Zone nicht unbemerkt scharfstellen.
 *
 * GEAENDERT AM 14.10.2026. Die Quittungen hiessen „Rote Zone SCHARFGESTELLT"
 * und „Armed + push dispatched." und gingen als blanker Text raus. Jetzt
 * stehen sie in src/modules/arm-freigabe, sind deutsch, tragen Symbol und
 * Fettschrift und nennen die Uhrzeit, zu der die Freigabe verfaellt. Weil sie
 * HTML sind, sendet der Handler sie selbst und gibt nichts mehr zurueck — das
 * schliesst die doppelte Quittung konstruktiv aus, um die sich der frühere
 * Guard auf `notifyRoleUnlessOrigin` kuemmern musste.
 *
 * Der Handler liegt inline in index.ts und ist nicht importierbar; die
 * Spiegelung unten folgt der Konvention aus callback-suppression.test.ts. Die
 * statischen Guards am Ende halten sie an die echte Quelle gebunden.
 */

interface Gesendet { chatId: string; text: string; mitKnopf: boolean }
interface Dispatched { text: string }

interface Deps {
  flagPath: string;
  isOwner: boolean;
  chatId: string;
  gesendet: Gesendet[];
  dispatched: Dispatched[];
  logs: string[];
  dispatchThrows?: string;
  order: string[];
  /** Wartet eine Uebertragung, deren Knopf noch unbenutzt ist? */
  knopfOffen: boolean;
  ablauf: number;
}

// ── Spiegel des /arm-Handlers aus index.ts ─────────────────────────────────
async function armHandler(args: string | undefined, d: Deps): Promise<{ text: string }> {
  if (!d.isOwner) {
    return { text: 'Dieser Befehl ist nur fuer den Owner verfuegbar.' };
  }

  const mode = String(args || '').trim().toLowerCase();
  if (mode !== '' && mode !== 'push') {
    return { text: NUTZUNG_TEXT };
  }

  try {
    fs.writeFileSync(d.flagPath, `armed by owner at ${new Date().toISOString()}\n`);
    d.order.push('armed');
    const ablauf = d.ablauf;

    if (mode !== 'push') {
      const text = freigabeGesetztText(ablauf, d.knopfOffen);
      d.logs.push('[arm] Freigabe gesetzt');
      d.gesendet.push({ chatId: d.chatId, text, mitKnopf: d.knopfOffen });
      return { text: '' };
    }

    try {
      if (d.dispatchThrows) throw new Error(d.dispatchThrows);
      d.dispatched.push({ text: 'push' });
      d.order.push('dispatched');
    } catch (e: any) {
      d.logs.push(`[arm] Anstoss fehlgeschlagen: ${e.message}`);
      d.gesendet.push({ chatId: d.chatId, text: startFehlgeschlagenText(e.message), mitKnopf: false });
      return { text: '' };
    }

    d.logs.push('[arm] Freigabe gesetzt + Anstoss');
    d.gesendet.push({ chatId: d.chatId, text: uebertragungGestartetText(ablauf), mitKnopf: false });
    return { text: '' };
  } catch (e: any) {
    d.logs.push(`[arm] Fehler: ${e.message}`);
    return { text: `arm Fehler: ${e.message}` };
  }
}

function makeDeps(dir: string, over: Partial<Deps> = {}): Deps {
  return {
    flagPath: path.join(dir, '.armed-bikosoc'),
    isOwner: true,
    chatId: 'owner-dm',
    gesendet: [],
    dispatched: [],
    logs: [],
    order: [],
    knopfOffen: false,
    ablauf: ablaufZeitpunkt(Date.parse('2026-10-14T11:44:00Z')),
    ...over,
  };
}

describe('/arm ohne Argument', () => {
  test('setzt die Freigabe, stoesst nichts an und nennt die Ablaufzeit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-push-'));
    const d = makeDeps(dir);

    const res = await armHandler(undefined, d);

    expect(res.text).toBe('');                       // selbst gesendet
    expect(fs.existsSync(d.flagPath)).toBe(true);
    expect(fs.readFileSync(d.flagPath, 'utf-8')).toContain('armed by owner at ');
    expect(d.dispatched).toEqual([]);
    expect(d.gesendet).toHaveLength(1);              // GENAU eine Nachricht
    expect(d.gesendet[0].text).toContain('Freigabe gesetzt');
    expect(d.gesendet[0].text).toContain('Freigabe aktiv bis 13:59 (einmalig)');
  });

  test('wartet eine Uebertragung, sagt die Antwort das — und traegt den Knopf', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-push-'));
    const d = makeDeps(dir, { knopfOffen: true });

    await armHandler(undefined, d);

    expect(d.gesendet[0].mitKnopf).toBe(true);
    expect(d.gesendet[0].text).toContain('Eine Übertragung wartet');
    expect(d.gesendet[0].text).toContain('/arm allein startet sie nicht');
    expect(d.dispatched).toEqual([]);                // und startet sie NICHT
  });

  test('leerer String und Leerraum zaehlen als "ohne Argument"', async () => {
    for (const args of ['', '   ', '\t']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-push-'));
      const d = makeDeps(dir);
      const res = await armHandler(args, d);
      expect(res.text, JSON.stringify(args)).toBe('');
      expect(d.gesendet[0].text, JSON.stringify(args)).toContain('Freigabe gesetzt');
      expect(d.dispatched, JSON.stringify(args)).toEqual([]);
    }
  });
});

describe('/arm push', () => {
  test('setzt die Freigabe, stoesst an und quittiert', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-push-'));
    const d = makeDeps(dir);

    const res = await armHandler('push', d);

    expect(res.text).toBe('');
    expect(fs.existsSync(d.flagPath)).toBe(true);
    expect(d.dispatched).toEqual([{ text: 'push' }]);
    expect(d.gesendet).toHaveLength(1);              // GENAU eine Nachricht
    expect(d.gesendet[0].text).toContain('Freigegeben und gestartet');
    expect(d.gesendet[0].mitKnopf).toBe(false);
  });

  test('Reihenfolge: erst freigeben, dann anstossen', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-push-'));
    const d = makeDeps(dir);
    await armHandler('push', d);
    expect(d.order).toEqual(['armed', 'dispatched']);
  });

  test('Argument wird normalisiert (Leerraum, Grossschreibung)', async () => {
    for (const args of ['push', ' push ', 'PUSH', ' Push\t']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-push-'));
      const d = makeDeps(dir);
      await armHandler(args, d);
      expect(d.dispatched, JSON.stringify(args)).toEqual([{ text: 'push' }]);
    }
  });

  test('scheitert der Anstoss, bleibt die Freigabe gesetzt und die Quittung sagt die Wahrheit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-push-'));
    const d = makeDeps(dir, { dispatchThrows: 'no server running on /tmp/tmux-1000/default' });

    await armHandler('push', d);

    expect(fs.existsSync(d.flagPath)).toBe(true);    // Freigabe bleibt
    expect(d.dispatched).toEqual([]);
    expect(d.gesendet).toHaveLength(1);
    expect(d.gesendet[0].text).toContain('Start fehlgeschlagen');
    expect(d.gesendet[0].text).toContain('in der Sitzung selbst eingeben');
    expect(d.logs.some(l => l.includes('[arm] Anstoss fehlgeschlagen'))).toBe(true);
  });
});

describe('/arm <unbekannt> — fail-closed', () => {
  test('setzt NICHTS und stoesst NICHTS an', async () => {
    for (const args of ['pusch', 'push now', 'force', '--push', 'push;rm']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-push-'));
      const d = makeDeps(dir);
      const res = await armHandler(args, d);
      expect(res.text, args).toBe(NUTZUNG_TEXT);
      expect(fs.existsSync(d.flagPath), args).toBe(false);
      expect(d.dispatched, args).toEqual([]);
      expect(d.gesendet, args).toEqual([]);
    }
  });
});

describe('Owner-Gate gilt fuer beide Pfade', () => {
  test('Nicht-Owner setzt nichts, stoesst nichts an, sendet nichts', async () => {
    for (const args of [undefined, 'push']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-push-'));
      const d = makeDeps(dir, { isOwner: false });
      const res = await armHandler(args, d);
      expect(res.text, String(args)).toBe('Dieser Befehl ist nur fuer den Owner verfuegbar.');
      expect(fs.existsSync(d.flagPath), String(args)).toBe(false);
      expect(d.dispatched, String(args)).toEqual([]);
      expect(d.gesendet, String(args)).toEqual([]);
    }
  });
});

describe('Anstoss geht ueber den echten /do-Helfer', () => {
  test('sendPromptToBikosocTmux("push") ergibt exakt die tmux-argv, ohne Shell', () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const runner: TmuxRunner = (file, args) => { calls.push({ file, args }); };

    sendPromptToBikosocTmux('push', { runner, enterDelayMs: 0 });

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
    expect(armBlock).toContain('/arm [push]');
  });

  test('Owner-Gate steht vor jeder Wirkung', () => {
    expect(armBlock.indexOf('assertBoundOwner')).toBeLessThan(armBlock.indexOf('writeFileSync'));
  });

  test('unbekanntes Argument ist fail-closed (vor dem Setzen der Freigabe)', () => {
    expect(armBlock).toContain("if (mode !== '' && mode !== 'push') {");
    expect(armBlock).toContain('return { text: NUTZUNG_TEXT };');
    expect(armBlock.indexOf("mode !== 'push'")).toBeLessThan(armBlock.indexOf('writeFileSync'));
  });

  test('push-Pfad nutzt den /do-Helfer, Freigabe vor Anstoss', () => {
    expect(armBlock).toContain("sendPromptToBikosocTmux('push');");
    expect(armBlock.indexOf('writeFileSync')).toBeLessThan(armBlock.indexOf("sendPromptToBikosocTmux('push')"));
  });

  test('die Texte kommen aus dem Modul, nicht aus index.ts', () => {
    for (const fn of ['freigabeGesetztText(', 'uebertragungGestartetText(', 'startFehlgeschlagenText(']) {
      expect(armBlock).toContain(fn);
    }
    expect(armBlock).not.toContain('SCHARFGESTELLT');
    expect(armBlock).not.toContain('dispatched');
  });

  test('jeder Zweig sendet genau einmal selbst und gibt nichts zurueck', () => {
    /* Loest den frueheren Guard auf notifyRoleUnlessOrigin ab: Die doppelte
       Quittung vom 10.10.2026 entstand, weil der Handler SENDETE und zugleich
       Text ZURUECKGAB. Jetzt tut er nur noch das eine. */
    const gesendet = armBlock.match(/sendTelegramHtmlWithMarkup\(/g) ?? [];
    const leer = armBlock.match(/return \{ text: '' \};/g) ?? [];
    expect(gesendet.length).toBe(3);
    expect(leer.length).toBe(3);
    expect(armBlock).not.toContain('notifyRoleUnlessOrigin');
    expect(armBlock).toContain('guard.chatId');
  });

  test('der Knopf wird nur angeboten, wenn eine Uebertragung wartet', () => {
    expect(armBlock).toContain('wartet && armKnopf ? knopfMarkup(armKnopf.kennung) : undefined');
  });

  test('der Dispatch-Helfer wird nicht neu implementiert, sondern importiert', () => {
    expect(source).toContain("import { sendPromptToBikosocTmux } from './src/modules/cc-prompt-dispatch/index.js';");
  });

  test('der Knopf ist im Callback-Praefixregister angemeldet', () => {
    expect(source).toContain('memdrop_\', KNOPF_PRAEFIX]');
    expect(knopfMarkup('x').inline_keyboard[0][0].callback_data.startsWith('armpush_')).toBe(true);
  });
});
