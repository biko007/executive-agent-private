import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendPromptToBikosocTmux, type TmuxRunner } from '../modules/cc-prompt-dispatch/index.js';
import {
  freigabeGesetztText, startFehlgeschlagenText, NUTZUNG_TEXT,
  ablaufZeitpunkt, knopfMarkup,
} from '../modules/arm-freigabe/index.js';
import {
  vormerkungLesen, vormerkungSchreiben, vormerkungLoeschen,
} from '../modules/arm-freigabe/vormerkung.js';

/**
 * /arm — Freigabe der Roten Zone.
 *
 * NEU AM 16.10.2026 (Owner-Auftrag „/arm vs. /arm push klären"). Vorher waren
 * es zwei Befehle mit einem Unterschied, den niemand erklären konnte: Beide
 * setzten dasselbe Flag, nur `/arm push` stieß zusätzlich die wartende Sitzung
 * an. Der Owner musste raten, welcher der richtige ist.
 *
 * Jetzt gilt:
 *
 *   /arm        gibt den nächsten roten Schritt frei und führt ihn aus.
 *   /arm push   tut exakt dasselbe — Alias für ältere Texte und den Knopf.
 *
 * Ausgeführt wird nur, was angemeldet ist: Entweder hat cc den Schritt
 * vorgemerkt, oder eine Übertragung wartet sichtbar. Ohne beides setzt der
 * Befehl die Freigabe und sonst nichts — er startet nie etwas, das niemand
 * angemeldet hat.
 *
 * Ein unbekanntes Argument setzt weiterhin NICHTS (fail-closed); ein
 * Tippfehler darf die Rote Zone nicht scharfstellen.
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
    const vorgemerkt = vormerkungLesen(d.flagPath);
    const knopfWartet = d.knopfOffen;
    const anstoss = vorgemerkt
      ? vorgemerkt.anstoss
      : (knopfWartet || mode === 'push') ? 'push' : '';

    fs.writeFileSync(d.flagPath, `armed by owner at ${new Date().toISOString()}\n`);
    d.order.push('armed');
    const ablauf = d.ablauf;

    if (anstoss) {
      try {
        if (d.dispatchThrows) throw new Error(d.dispatchThrows);
        d.dispatched.push({ text: anstoss });
        d.order.push('dispatched');
      } catch (e: any) {
        d.logs.push(`[arm] Anstoss fehlgeschlagen: ${e.message}`);
        d.gesendet.push({ chatId: d.chatId, text: startFehlgeschlagenText(e.message), mitKnopf: false });
        return { text: '' };
      }
    }

    if (vorgemerkt) vormerkungLoeschen(d.flagPath);

    const text = freigabeGesetztText(ablauf, vorgemerkt?.schritt ?? null, !!anstoss);
    d.logs.push('[arm] Freigabe gesetzt');
    d.gesendet.push({ chatId: d.chatId, text, mitKnopf: false });
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

const neu = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arm-push-'));

describe('/arm mit vorgemerktem Schritt — der Regelfall', () => {
  test('nennt den Schritt, führt ihn aus und verbraucht die Vormerkung', async () => {
    const d = makeDeps(neu());
    vormerkungSchreiben(d.flagPath, 'Migration V043 anwenden und 104 Werte schreiben', 'weiter');

    const res = await armHandler(undefined, d);

    expect(res.text).toBe('');
    expect(fs.existsSync(d.flagPath)).toBe(true);
    expect(d.dispatched).toEqual([{ text: 'weiter' }]);
    expect(d.gesendet).toHaveLength(1);
    expect(d.gesendet[0].text).toContain('Migration V043 anwenden');
    expect(d.gesendet[0].text).toContain('cc führt ihn jetzt aus');
    /* Einmalig: Das nächste /arm darf denselben Schritt nicht erneut nennen. */
    expect(vormerkungLesen(d.flagPath)).toBeNull();
  });

  test('eine Vormerkung ohne Anstoß gibt frei, startet aber nichts', async () => {
    const d = makeDeps(neu());
    vormerkungSchreiben(d.flagPath, 'Dienste neu starten', '');

    await armHandler(undefined, d);

    expect(d.dispatched).toEqual([]);
    expect(d.gesendet[0].text).toContain('Dienste neu starten');
    expect(d.gesendet[0].text).toContain('beim nächsten Schritt');
    expect(fs.existsSync(d.flagPath)).toBe(true);     // freigegeben ist trotzdem
  });

  test('/arm push verhält sich identisch — gleicher Anstoß, gleicher Text', async () => {
    const a = makeDeps(neu());
    const b = makeDeps(neu());
    vormerkungSchreiben(a.flagPath, 'vier Commits übertragen', 'push');
    vormerkungSchreiben(b.flagPath, 'vier Commits übertragen', 'push');

    await armHandler(undefined, a);
    await armHandler('push', b);

    expect(a.dispatched).toEqual(b.dispatched);
    expect(a.gesendet[0].text).toBe(b.gesendet[0].text);
  });
});

describe('/arm ohne Vormerkung', () => {
  test('ohne wartende Übertragung: freigeben, nichts anstoßen', async () => {
    const d = makeDeps(neu());

    const res = await armHandler(undefined, d);

    expect(res.text).toBe('');
    expect(fs.existsSync(d.flagPath)).toBe(true);
    expect(d.dispatched).toEqual([]);
    expect(d.gesendet).toHaveLength(1);
    expect(d.gesendet[0].text).toContain('Freigabe gesetzt');
    expect(d.gesendet[0].text).toContain('Freigabe aktiv bis 13:59 (einmalig)');
  });

  test('wartet eine Übertragung, startet /arm sie jetzt selbst', async () => {
    /* Das ist die eigentliche Änderung vom 16.10.2026: Früher sagte die
       Antwort „/arm allein startet sie nicht" und verlangte einen zweiten
       Handgriff. */
    const d = makeDeps(neu(), { knopfOffen: true });

    await armHandler(undefined, d);

    expect(d.dispatched).toEqual([{ text: 'push' }]);
    expect(d.gesendet[0].text).toContain('Freigegeben und gestartet');
    expect(d.gesendet[0].mitKnopf).toBe(false);
  });

  test('/arm push stößt auch ohne Vormerkung an — Alias für ältere Texte', async () => {
    const d = makeDeps(neu());
    await armHandler('push', d);
    expect(d.dispatched).toEqual([{ text: 'push' }]);
    expect(d.gesendet[0].text).toContain('Freigegeben und gestartet');
  });

  test('leerer String und Leerraum zählen als „ohne Argument"', async () => {
    for (const args of ['', '   ', '\t']) {
      const d = makeDeps(neu());
      const res = await armHandler(args, d);
      expect(res.text, JSON.stringify(args)).toBe('');
      expect(d.gesendet[0].text, JSON.stringify(args)).toContain('Freigabe gesetzt');
      expect(d.dispatched, JSON.stringify(args)).toEqual([]);
    }
  });

  test('Argument wird normalisiert (Leerraum, Großschreibung)', async () => {
    for (const args of ['push', ' push ', 'PUSH', ' Push\t']) {
      const d = makeDeps(neu());
      await armHandler(args, d);
      expect(d.dispatched, JSON.stringify(args)).toEqual([{ text: 'push' }]);
    }
  });
});

describe('Reihenfolge und Fehlerfall', () => {
  test('erst freigeben, dann anstoßen', async () => {
    const d = makeDeps(neu(), { knopfOffen: true });
    await armHandler(undefined, d);
    expect(d.order).toEqual(['armed', 'dispatched']);
  });

  test('scheitert der Anstoß, bleibt die Freigabe gesetzt und die Quittung sagt die Wahrheit', async () => {
    const d = makeDeps(neu(), { dispatchThrows: 'no server running on /tmp/tmux-1000/default' });
    vormerkungSchreiben(d.flagPath, 'etwas Rotes', 'weiter');

    await armHandler(undefined, d);

    expect(fs.existsSync(d.flagPath)).toBe(true);    // Freigabe bleibt
    expect(d.dispatched).toEqual([]);
    expect(d.gesendet).toHaveLength(1);
    expect(d.gesendet[0].text).toContain('Start fehlgeschlagen');
    expect(d.gesendet[0].text).toContain('in der Sitzung selbst eingeben');
    expect(d.logs.some(l => l.includes('[arm] Anstoss fehlgeschlagen'))).toBe(true);
    /* Die Vormerkung bleibt stehen: Der Schritt ist nicht gelaufen. */
    expect(vormerkungLesen(d.flagPath)?.schritt).toBe('etwas Rotes');
  });
});

describe('/arm <unbekannt> — fail-closed', () => {
  test('setzt NICHTS und stößt NICHTS an', async () => {
    for (const args of ['pusch', 'push now', 'force', '--push', 'push;rm']) {
      const d = makeDeps(neu());
      const res = await armHandler(args, d);
      expect(res.text, args).toBe(NUTZUNG_TEXT);
      expect(fs.existsSync(d.flagPath), args).toBe(false);
      expect(d.dispatched, args).toEqual([]);
      expect(d.gesendet, args).toEqual([]);
    }
  });

  test('auch mit Vormerkung bleibt ein Tippfehler wirkungslos', async () => {
    const d = makeDeps(neu());
    vormerkungSchreiben(d.flagPath, 'Migration V043', 'weiter');
    await armHandler('pusch', d);
    expect(fs.existsSync(d.flagPath)).toBe(false);
    expect(d.dispatched).toEqual([]);
    expect(vormerkungLesen(d.flagPath)?.schritt).toBe('Migration V043');  // unberührt
  });
});

describe('Owner-Gate gilt für jeden Pfad', () => {
  test('Nicht-Owner setzt nichts, stößt nichts an, sendet nichts', async () => {
    for (const args of [undefined, 'push']) {
      const d = makeDeps(neu(), { isOwner: false });
      const res = await armHandler(args, d);
      expect(res.text, String(args)).toBe('Dieser Befehl ist nur fuer den Owner verfuegbar.');
      expect(fs.existsSync(d.flagPath), String(args)).toBe(false);
      expect(d.dispatched, String(args)).toEqual([]);
      expect(d.gesendet, String(args)).toEqual([]);
    }
  });

  test('eine Vormerkung verschafft einem Fremden keine Freigabe', async () => {
    /* Der Kern: Die Vormerkung ist eine Beschriftung, kein Schlüssel. Auch
       eine perfekt angemeldete rote Aktion bleibt für jeden außer dem Owner
       gesperrt. */
    const d = makeDeps(neu(), { isOwner: false });
    vormerkungSchreiben(d.flagPath, 'Migration V043 anwenden', 'weiter');

    await armHandler(undefined, d);

    expect(fs.existsSync(d.flagPath)).toBe(false);
    expect(d.dispatched).toEqual([]);
    expect(vormerkungLesen(d.flagPath)?.schritt).toBe('Migration V043 anwenden');
  });
});

describe('Anstoß geht über den echten /do-Helfer', () => {
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

describe('statische Guards gegen index.ts (Drift-Schutz für die Spiegelung oben)', () => {
  const ROOT = path.resolve(import.meta.dir, '../..');
  const source = fs.readFileSync(path.join(ROOT, 'index.ts'), 'utf-8');
  const armBlock = source.slice(source.indexOf("    name: 'arm',"), source.indexOf("  // ── Message Sink"));

  test('/arm nimmt Argumente und dokumentiert die push-Variante', () => {
    expect(armBlock).toContain('acceptsArgs: true');
    expect(armBlock).toContain('/arm [push]');
  });

  test('Owner-Gate steht vor jeder Wirkung', () => {
    expect(armBlock.indexOf('assertBoundOwner')).toBeLessThan(armBlock.indexOf('writeFileSync'));
    expect(armBlock.indexOf('assertBoundOwner')).toBeLessThan(armBlock.indexOf('vormerkungLesen'));
  });

  test('unbekanntes Argument ist fail-closed (vor jeder Wirkung)', () => {
    expect(armBlock).toContain("if (mode !== '' && mode !== 'push') {");
    expect(armBlock).toContain('return { text: NUTZUNG_TEXT };');
    expect(armBlock.indexOf("mode !== 'push'")).toBeLessThan(armBlock.indexOf('writeFileSync'));
  });

  test('der Anstoß nutzt den /do-Helfer, Freigabe vor Anstoß', () => {
    expect(armBlock).toContain('sendPromptToBikosocTmux(anstoss);');
    expect(armBlock.indexOf('writeFileSync')).toBeLessThan(armBlock.indexOf('sendPromptToBikosocTmux(anstoss)'));
  });

  test('angestoßen wird nur ein angemeldeter Schritt', () => {
    /* Ohne Vormerkung und ohne wartende Übertragung darf `/arm` allein nichts
       starten — sonst liefe irgendwann etwas, das niemand gemeint hat. */
    expect(armBlock).toContain("(knopfWartet || mode === 'push') ? 'push' : ''");
    expect(armBlock).toContain('if (anstoss) {');
  });

  test('die Vormerkung wird verbraucht, nicht aufgehoben', () => {
    expect(armBlock).toContain('vormerkungLoeschen(flagPath)');
  });

  test('die Texte kommen aus dem Modul, nicht aus index.ts', () => {
    for (const fn of ['freigabeGesetztText(', 'startFehlgeschlagenText(']) {
      expect(armBlock).toContain(fn);
    }
    expect(armBlock).not.toContain('SCHARFGESTELLT');
    expect(armBlock).not.toContain('dispatched');
  });

  test('jeder Zweig sendet genau einmal selbst und gibt nichts zurück', () => {
    /* Löst den früheren Guard auf notifyRoleUnlessOrigin ab: Die doppelte
       Quittung vom 10.10.2026 entstand, weil der Handler SENDETE und zugleich
       Text ZURÜCKGAB. Jetzt tut er nur noch das eine. */
    const gesendet = armBlock.match(/sendTelegramHtmlWithMarkup\(/g) ?? [];
    const leer = armBlock.match(/return \{ text: '' \};/g) ?? [];
    expect(gesendet.length).toBe(2);
    expect(leer.length).toBe(2);
    expect(armBlock).not.toContain('notifyRoleUnlessOrigin');
    expect(armBlock).toContain('guard.chatId');
  });

  test('der Knopf erledigt denselben Schritt wie /arm', () => {
    /* Sonst stünde die Vormerkung nach einem Knopfdruck noch da und das
       nächste /arm nennte einen Schritt, der längst gelaufen ist. */
    const knopfBlock = source.slice(source.indexOf('const armCb = parseCallbackEvent'),
      source.indexOf("const memdropCb = parseCallbackEvent"));
    expect(knopfBlock).toContain('vormerkungLesen(knopfFlag)');
    expect(knopfBlock).toContain('vormerkungLoeschen(knopfFlag)');
    expect(knopfBlock).toContain("knopfVorgemerkt?.anstoss || 'push'");
  });

  test('der Dispatch-Helfer wird nicht neu implementiert, sondern importiert', () => {
    expect(source).toContain("import { sendPromptToBikosocTmux } from './src/modules/cc-prompt-dispatch/index.js';");
  });

  test('der Knopf ist im Callback-Präfixregister angemeldet', () => {
    expect(source).toContain('memdrop_\', KNOPF_PRAEFIX]');
    expect(knopfMarkup('x').inline_keyboard[0][0].callback_data.startsWith('armpush_')).toBe(true);
  });
});
