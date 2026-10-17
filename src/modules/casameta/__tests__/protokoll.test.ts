/**
 * Tests der Protokollauswertung — Secret-Scan, JSONL-Einlesen, Zusammenfassung.
 *
 * Der Secret-Scan ist die wichtigste Zeile des ganzen Moduls: Er steht zwischen
 * einem Fehler des Agenten und einem Passwort in der Cloud. Er wird deshalb
 * gegen alle drei Stellen geprüft, an denen ein Wert durchrutschen könnte —
 * Dateiinhalt, Dateiname und Binärdatei.
 *
 * Getestet wird mit einem erfundenen Wert, nicht mit echten Zugangsdaten: Die
 * Funktion nimmt das Passwort als Parameter, die env-Datei ist nur die
 * Voreinstellung.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { secretScan, aktionenLesen, zusammenfassung } from '../../../../scripts/casameta-protokoll.js';

/** Frei erfunden. Kommt in keiner echten Konfiguration vor. */
const TESTWERT = 'Pr0be-Geheim-9f2c';

let ordner: string;

beforeAll(() => {
  ordner = mkdtempSync(join(tmpdir(), 'casameta-test-'));
  mkdirSync(join(ordner, 'screenshots'));
  writeFileSync(join(ordner, 'lauf.json'), JSON.stringify({
    runId: '261013-lesen-pruef', propertyCode: 'mg24', periodYear: 2025, mode: 'lesen',
  }));
  writeFileSync(join(ordner, 'aktionen.jsonl'), [
    '{"seq":1,"occurredAt":"2026-10-13T12:00:00.000Z","actionType":"lesen","fieldLabel":"Zeitraum","valueBefore":"2025"}',
    'das ist keine gültige JSON-Zeile',
    '{"seq":2,"occurredAt":"2026-10-13T12:00:05.000Z","actionType":"schreiben","fieldLabel":"Kaltwasser","valueBefore":"0,00","valueAfter":"1.214,01","verified":false}',
    '',
  ].join('\n'));
});

afterAll(() => { rmSync(ordner, { recursive: true, force: true }); });

describe('secretScan', () => {
  it('meldet einen sauberen Ordner als geprüft und ohne Treffer', () => {
    const e = secretScan(ordner, TESTWERT);
    expect(e.geprueft).toBe(true);
    expect(e.treffer).toHaveLength(0);
  });

  it('gilt ohne hinterlegtes Passwort als ungeprüft, nicht als sauber', () => {
    const e = secretScan(ordner, null);
    expect(e.geprueft).toBe(false);
    expect(e.treffer).toHaveLength(0);
  });

  it('findet den Wert im Inhalt einer Textdatei', () => {
    const d = join(ordner, 'agent-ausgabe.txt');
    writeFileSync(d, `Anmeldung mit ${TESTWERT} versucht`);
    const e = secretScan(ordner, TESTWERT);
    expect(e.treffer).toContain('agent-ausgabe.txt');
    rmSync(d);
  });

  it('findet den Wert in einem Dateinamen', () => {
    const d = join(ordner, 'screenshots', `${TESTWERT}.png`);
    writeFileSync(d, 'egal');
    const e = secretScan(ordner, TESTWERT);
    expect(e.treffer.some(t => t.includes('(Dateiname)'))).toBe(true);
    rmSync(d);
  });

  it('findet den Wert auch in einer Binärdatei', () => {
    /* trace.zip ist binär; der Scan liest Rohbytes, damit ein Klartextwert
       auch dort auffällt. */
    const d = join(ordner, 'trace.zip');
    writeFileSync(d, Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]),
      Buffer.from(TESTWERT, 'latin1'),
      Buffer.from([0x00, 0xfe]),
    ]));
    const e = secretScan(ordner, TESTWERT);
    expect(e.treffer).toContain('trace.zip');
    rmSync(d);
  });
});

describe('aktionenLesen', () => {
  it('überspringt kaputte Zeilen, statt den ganzen Lauf zu verwerfen', () => {
    const a = aktionenLesen(ordner);
    expect(a).toHaveLength(2);
    expect(a[0].fieldLabel).toBe('Zeitraum');
    expect(a[1].actionType).toBe('schreiben');
  });

  it('übernimmt verified nur als echten Wahrheitswert', () => {
    const a = aktionenLesen(ordner);
    expect(a[0].verified).toBeNull();
    expect(a[1].verified).toBe(false);
  });
});

describe('zusammenfassung', () => {
  it('hebt nicht bestätigte Schreibvorgänge hervor', () => {
    const md = zusammenfassung(
      { runId: 'r', mode: 'schreiben' } as any,
      aktionenLesen(ordner),
      { geprueft: true, treffer: [] },
    );
    expect(md).toContain('| davon nicht nachkontrolliert bestätigt | 1 |');
    expect(md).toContain('**nein**');
  });

  it('nennt einen übersprungenen Secret-Scan beim Namen', () => {
    const md = zusammenfassung(
      { runId: 'r', mode: 'lesen' } as any, [], { geprueft: false, treffer: [] });
    expect(md).toContain('übersprungen, keine Zugangsdaten hinterlegt');
  });
});

/* GESTALTUNG DER LAUF-MELDUNG (Owner-Auftrag 14.10.2026, nachgezogen am
   17.10.2026). Die Casameta-Meldung fehlte in der Inventur und ging weiter im
   alten Format hinaus. Hier stehen statische Waechter gegen das Skript — ein
   Lauf laesst sich im Test nicht nachstellen, die Form des Aufrufs schon. */
describe('Telegram-Meldung des Laufs', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const skript = fs.readFileSync(
    path.resolve(import.meta.dir, '..', '..', '..', '..', 'scripts', 'casameta-protokoll.ts'),
    'utf-8');

  it('liefert Lage, Titel und Zeilen an die Notify-Route', () => {
    expect(skript).toContain('lage: meldung.lage');
    expect(skript).toContain('titel: meldung.titel');
    expect(skript).toContain('zeilen: meldung.zeilen');
  });

  it('traegt kein eigenes Symbol im Text', () => {
    /* Das Symbol setzt systemNachricht() aus der Lage. Ein zweites im Text
       stand beim Owner doppelt da. */
    const block = skript.slice(skript.indexOf('async function telegram'));
    expect(block).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it('schreit nicht in Grossbuchstaben', () => {
    /* Nur der Code zaehlt — im Kommentar steht die alte Form als Begruendung. */
    const code = skript.split('\n')
      .filter((z: string) => !z.trimStart().startsWith('*') && !z.trimStart().startsWith('/*'))
      .join('\n');
    expect(code).not.toContain('NICHT BESTÄTIGT');
    expect(code).toContain('nicht bestätigt:');
  });

  it('ein gestoppter oder unbestaetigter Lauf ist ein Hinweis, kein Haken', () => {
    expect(skript).toContain("unbestaetigt > 0 || stopps.length > 0 ? 'hinweis' : 'ok'");
  });

  it('der Abbruch meldet sich als Fehler', () => {
    expect(skript).toContain("lage: 'fehler'");
    expect(skript).toContain("titel: 'Casameta abgebrochen'");
  });
});
