/**
 * Antworten auf getippte Befehle — keine sichtbaren Steuerzeichen, echte Umlaute.
 *
 * ANLASS (Owner, 14.10.2026): „die Nachrichten sind auch noch recht hässlich".
 * Zwei der sechs Befunde betrafen den Text selbst: sichtbare Sternchen, weil
 * Markdown nicht gerendert wird, und Umschreibungen wie „naechste" oder
 * „Eintraege" statt echter Umlaute.
 *
 * Die Meldungen, die der Bot von sich aus schickt, wurden am selben Tag
 * umgestellt; die Antworten auf getippte Befehle blieben zunaechst liegen und
 * sind am 17.10.2026 nachgezogen worden. Dieser Waechter haelt den Stand.
 *
 * WARUM STATISCH: Ein Befehl laesst sich im Test nicht aufrufen, ohne den
 * halben Gateway nachzubauen. Die Form der Antworttexte steht aber im
 * Quelltext, und genau sie war der Befund.
 *
 * WICHTIG ZUM MARKUP: Der Gateway sendet Befehlsantworten mit parse_mode HTML.
 * Markdown-Sternchen stehen dort sichtbar da. Erlaubt sind <b> und <i> — aber
 * nur um festen Text; um eingesetzte Werte herum nicht, weil ein kaufmaennisches
 * Und oder eine spitze Klammer im Wert sonst die ganze Nachricht scheitern
 * laesst.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const WURZEL = resolve(import.meta.dir, '..', '..', '..', '..');

/** Alle Dateien, die Befehlsantworten enthalten. */
function quelldateien(): string[] {
  const dateien = [join(WURZEL, 'index.ts')];
  const module = join(WURZEL, 'src', 'modules');
  for (const m of readdirSync(module)) {
    const p = join(module, m, 'commands.ts');
    if (existsSync(p)) dateien.push(p);
  }
  return dateien;
}

/** Zeilen, die dem Owner sichtbaren Text zustellen — ohne Kommentare und Logs. */
function antwortzeilen(inhalt: string): { nr: number; text: string }[] {
  const treffer: { nr: number; text: string }[] = [];
  inhalt.split('\n').forEach((z, i) => {
    const roh = z.trim();
    if (roh.startsWith('*') || roh.startsWith('//') || roh.startsWith('/*')) return;
    if (z.includes('logger.') || z.includes('console.')) return;
    if (!/text:\s*[`'"]|sendTelegram\(|message:\s*[`'"]|lines\.push\(|z\.push\(/.test(z)) return;
    treffer.push({ nr: i + 1, text: z });
  });
  return treffer;
}

const UMSCHREIBUNGEN = /\b(fuer|verfuegbar|ungueltig|Bestaetigung|bestaetigt|moeglich|naechste|Eintraege|zurueck|taeglich|Pruefung|Aenderung|Waehrung|Gebaeude|Faelligkeit|oeffnen|aehnlich|ueber|gewaehlt|laeuft|koennen|muessen)\b/i;

describe('Antworten auf getippte Befehle', () => {
  test('tragen kein sichtbares Markdown', () => {
    const fundstellen: string[] = [];
    for (const datei of quelldateien()) {
      for (const { nr, text } of antwortzeilen(readFileSync(datei, 'utf-8'))) {
        if (/\*\*[^*\n]+\*\*/.test(text)) {
          fundstellen.push(`${datei.replace(WURZEL + '/', '')}:${nr}`);
        }
      }
    }
    expect(fundstellen, fundstellen.join(', ')).toEqual([]);
  });

  test('schreiben Umlaute aus', () => {
    const fundstellen: string[] = [];
    for (const datei of quelldateien()) {
      for (const { nr, text } of antwortzeilen(readFileSync(datei, 'utf-8'))) {
        if (UMSCHREIBUNGEN.test(text)) {
          fundstellen.push(`${datei.replace(WURZEL + '/', '')}:${nr}`);
        }
      }
    }
    expect(fundstellen, fundstellen.join(', ')).toEqual([]);
  });

  test('setzen HTML nur um festen Text, nie um eingesetzte Werte', () => {
    const fundstellen: string[] = [];
    for (const datei of quelldateien()) {
      for (const { nr, text } of antwortzeilen(readFileSync(datei, 'utf-8'))) {
        for (const m of text.matchAll(/<b>(.*?)<\/b>|<i>(.*?)<\/i>/g)) {
          const inhalt = m[1] ?? m[2] ?? '';
          if (inhalt.includes('${')) fundstellen.push(`${datei.replace(WURZEL + '/', '')}:${nr}`);
        }
      }
    }
    expect(fundstellen, fundstellen.join(', ')).toEqual([]);
  });

  test('der Waechter sieht ueberhaupt etwas — sonst prueft er nichts', () => {
    const zeilen = quelldateien()
      .reduce((s, d) => s + antwortzeilen(readFileSync(d, 'utf-8')).length, 0);
    expect(zeilen).toBeGreaterThan(100);
  });
});
